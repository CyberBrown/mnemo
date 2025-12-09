# URL Adapter Implementation Plan

## Overview

Add support for loading arbitrary URLs into Mnemo context caches. This expands Mnemo beyond GitHub repos to support any web content including documentation sites, PDFs, and JSON APIs.

## Design Principles

1. **Readability bundled** — Use @mozilla/readability for HTML extraction, fall back to cheerio tag stripping
2. **PDF is first-class** — Required for launch
3. **Token-based crawling** — Crawl until token target reached, not depth-based
4. **Pluggable extractors** — Easy to add new content types later
5. **Respect robots.txt** — Be a good citizen
6. **Log errors, continue** — Don't fail entire load on single page failure

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        UrlAdapter                                │
│                                                                  │
│  canHandle() → matches type:'url' or any non-GitHub URL string  │
│  load() → orchestrates fetching + extraction                    │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│                     ContentExtractors                            │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌─────────┐ │
│  │    HTML      │ │     PDF      │ │     JSON     │ │  Text   │ │
│  │  Extractor   │ │  Extractor   │ │  Extractor   │ │Extractor│ │
│  ├──────────────┤ ├──────────────┤ ├──────────────┤ ├─────────┤ │
│  │ 1. Readabil. │ │  pdf-parse   │ │ pretty-print │ │  pass-  │ │
│  │ 2. Cheerio   │ │              │ │ + structure  │ │ through │ │
│  │    fallback  │ │              │ │   summary    │ │         │ │
│  └──────────────┘ └──────────────┘ └──────────────┘ └─────────┘ │
├─────────────────────────────────────────────────────────────────┤
│                    TokenTargetCrawler                            │
│                                                                  │
│  - Start with seed URL(s)                                        │
│  - Extract links from loaded pages                               │
│  - Score/prioritize links (same domain, relevant path, etc.)    │
│  - Keep loading until targetTokens reached                       │
│  - Respect minTokensPerPage threshold                            │
│  - Respect robots.txt                                            │
│  - Rate limiting between requests                                │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## File Structure

Create these new files in `packages/core/src/`:

```
packages/core/src/
├── adapters/
│   ├── base.ts                    # Existing - SourceAdapter interface
│   ├── docs-crawler.ts            # Existing - KEEP FOR NOW, may deprecate later
│   ├── url-adapter.ts             # NEW - main adapter orchestrator
│   ├── url-adapter/
│   │   ├── index.ts               # Re-exports
│   │   ├── crawler.ts             # TokenTargetCrawler implementation
│   │   ├── robots.ts              # robots.txt parser/checker
│   │   └── link-scorer.ts         # Link prioritization logic
│   └── extractors/
│       ├── index.ts               # ExtractorRegistry + exports
│       ├── types.ts               # Shared interfaces
│       ├── html-extractor.ts      # Readability + cheerio fallback
│       ├── pdf-extractor.ts       # pdf-parse wrapper
│       ├── json-extractor.ts      # Pretty-print + structure summary
│       └── text-extractor.ts      # Passthrough for plain text
```

---

## Interfaces

### Extractor Types

```typescript
// packages/core/src/adapters/extractors/types.ts

export interface ContentExtractor {
  /** Unique identifier */
  readonly name: string;
  
  /** MIME types this extractor handles */
  readonly mimeTypes: string[];
  
  /** Extract text content from raw response */
  extract(content: Buffer, url: string): Promise<ExtractedContent>;
}

export interface ExtractedContent {
  /** Extracted text content */
  text: string;
  
  /** Page/document title if available */
  title?: string;
  
  /** Links found in content (for crawling) */
  links?: string[];
  
  /** Additional metadata */
  metadata?: {
    author?: string;
    publishedDate?: string;
    description?: string;
    [key: string]: unknown;
  };
}

export class ExtractorRegistry {
  private extractors: ContentExtractor[] = [];
  
  register(extractor: ContentExtractor): void {
    this.extractors.push(extractor);
  }
  
  findForMimeType(mimeType: string): ContentExtractor | undefined {
    // Normalize mime type (strip charset, etc.)
    const normalized = mimeType.split(';')[0].trim().toLowerCase();
    return this.extractors.find(e => 
      e.mimeTypes.some(mt => normalized.includes(mt))
    );
  }
  
  getDefault(): ContentExtractor {
    // Return text extractor as fallback
  }
}
```

### URL Adapter Config

```typescript
// packages/core/src/adapters/url-adapter.ts

import type { SourceAdapter, SourceConfig, AdapterLoadOptions } from './base';
import type { LoadedSource } from '../types';

export interface UrlAdapterConfig extends SourceConfig {
  type: 'url';
  
  /** Single URL to load */
  url?: string;
  
  /** Multiple seed URLs */
  urls?: string[];
  
  /** Stop crawling when this token count reached (default: 100000) */
  targetTokens?: number;
  
  /** Skip pages with fewer tokens than this (default: 500) */
  minTokensPerPage?: number;
  
  /** Hard cap on pages to load (default: 50) */
  maxPages?: number;
  
  /** Only follow links on same domain (default: true) */
  sameDomainOnly?: boolean;
  
  /** Delay between requests in ms (default: 100) */
  delayMs?: number;
  
  /** Respect robots.txt (default: true) */
  respectRobotsTxt?: boolean;
}

export class UrlAdapter implements SourceAdapter {
  readonly type = 'url';
  readonly name = 'URL Loader';
  
  private extractorRegistry: ExtractorRegistry;
  private userAgent = 'Mnemo/0.1.0 (https://github.com/CyberBrown/mnemo; context-loader)';
  
  constructor(extractorRegistry?: ExtractorRegistry) {
    this.extractorRegistry = extractorRegistry ?? createDefaultRegistry();
  }
  
  canHandle(source: SourceConfig): boolean {
    return source.type === 'url' && !!(source.url || source.urls);
  }
  
  async load(source: UrlAdapterConfig, options?: AdapterLoadOptions): Promise<LoadedSource> {
    const config = this.normalizeConfig(source, options);
    const crawler = new TokenTargetCrawler(config, this.extractorRegistry, this.userAgent);
    return crawler.crawl();
  }
  
  private normalizeConfig(source: UrlAdapterConfig, options?: AdapterLoadOptions): NormalizedCrawlConfig {
    return {
      seedUrls: source.urls ?? (source.url ? [source.url] : []),
      targetTokens: source.targetTokens ?? options?.maxTokens ?? 100000,
      minTokensPerPage: source.minTokensPerPage ?? 500,
      maxPages: source.maxPages ?? 50,
      sameDomainOnly: source.sameDomainOnly ?? true,
      delayMs: source.delayMs ?? 100,
      respectRobotsTxt: source.respectRobotsTxt ?? true,
    };
  }
}
```

### Crawler Implementation

```typescript
// packages/core/src/adapters/url-adapter/crawler.ts

export interface NormalizedCrawlConfig {
  seedUrls: string[];
  targetTokens: number;
  minTokensPerPage: number;
  maxPages: number;
  sameDomainOnly: boolean;
  delayMs: number;
  respectRobotsTxt: boolean;
}

interface PrioritizedUrl {
  url: string;
  score: number;
  depth: number;
  referrer: string;
}

interface CrawlError {
  url: string;
  error: string;
  timestamp: Date;
}

export class TokenTargetCrawler {
  private visited = new Set<string>();
  private queue: PrioritizedUrl[] = [];
  private loadedContent: FileInfo[] = [];
  private errors: CrawlError[] = [];
  private currentTokens = 0;
  private robotsCache = new Map<string, RobotsChecker>();
  
  constructor(
    private config: NormalizedCrawlConfig,
    private extractorRegistry: ExtractorRegistry,
    private userAgent: string
  ) {}
  
  async crawl(): Promise<LoadedSource> {
    // 1. Seed queue with initial URLs
    for (const url of this.config.seedUrls) {
      this.queue.push({ url, score: 100, depth: 0, referrer: '' });
    }
    
    // 2. Crawl until target reached or queue empty
    while (
      this.currentTokens < this.config.targetTokens &&
      this.queue.length > 0 &&
      this.loadedContent.length < this.config.maxPages
    ) {
      // Sort by score (highest first)
      this.queue.sort((a, b) => b.score - a.score);
      const next = this.queue.shift()!;
      
      if (this.visited.has(next.url)) continue;
      this.visited.add(next.url);
      
      // Check robots.txt
      if (this.config.respectRobotsTxt) {
        const allowed = await this.checkRobots(next.url);
        if (!allowed) {
          this.errors.push({ url: next.url, error: 'Blocked by robots.txt', timestamp: new Date() });
          continue;
        }
      }
      
      try {
        const result = await this.loadPage(next.url);
        
        if (result.tokenEstimate >= this.config.minTokensPerPage) {
          this.loadedContent.push(result);
          this.currentTokens += result.tokenEstimate;
          
          // Extract and queue links
          if (result.links) {
            this.queueLinks(result.links, next.url, next.depth);
          }
        }
      } catch (error) {
        this.errors.push({
          url: next.url,
          error: error instanceof Error ? error.message : String(error),
          timestamp: new Date(),
        });
      }
      
      // Rate limiting
      if (this.queue.length > 0) {
        await this.delay(this.config.delayMs);
      }
    }
    
    // 3. Combine results
    return this.buildResult();
  }
  
  private async loadPage(url: string): Promise<FileInfo & { links?: string[] }> {
    const response = await fetch(url, {
      headers: { 'User-Agent': this.userAgent },
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const contentType = response.headers.get('content-type') || 'text/plain';
    const buffer = Buffer.from(await response.arrayBuffer());
    
    const extractor = this.extractorRegistry.findForMimeType(contentType) 
      ?? this.extractorRegistry.getDefault();
    
    const extracted = await extractor.extract(buffer, url);
    const tokenEstimate = this.estimateTokens(extracted.text);
    
    return {
      path: url,
      content: extracted.text,
      size: buffer.length,
      tokenEstimate,
      links: extracted.links,
      metadata: {
        title: extracted.title,
        contentType,
        ...extracted.metadata,
      },
    };
  }
  
  private queueLinks(links: string[], sourceUrl: string, sourceDepth: number): void {
    const sourceOrigin = new URL(sourceUrl).origin;
    
    for (const link of links) {
      try {
        const resolved = new URL(link, sourceUrl).href;
        
        // Skip if already visited or queued
        if (this.visited.has(resolved)) continue;
        if (this.queue.some(q => q.url === resolved)) continue;
        
        // Skip external if sameDomainOnly
        const linkOrigin = new URL(resolved).origin;
        if (this.config.sameDomainOnly && linkOrigin !== sourceOrigin) continue;
        
        // Score the link
        const score = this.scoreLink(resolved, sourceUrl);
        
        this.queue.push({
          url: resolved,
          score,
          depth: sourceDepth + 1,
          referrer: sourceUrl,
        });
      } catch {
        // Invalid URL, skip
      }
    }
  }
  
  private scoreLink(link: string, sourceUrl: string): number {
    let score = 50; // Base score
    
    const linkUrl = new URL(link);
    const sourceUrlObj = new URL(sourceUrl);
    
    // Same domain boost
    if (linkUrl.origin === sourceUrlObj.origin) {
      score += 20;
    }
    
    // Similar path prefix boost
    if (linkUrl.pathname.startsWith(sourceUrlObj.pathname.split('/').slice(0, -1).join('/'))) {
      score += 10;
    }
    
    // Documentation-like paths boost
    const docPatterns = ['/docs', '/guide', '/reference', '/api', '/tutorial', '/learn'];
    if (docPatterns.some(p => linkUrl.pathname.includes(p))) {
      score += 15;
    }
    
    // Penalize likely non-content pages
    const skipPatterns = ['/login', '/signup', '/auth', '/admin', '/cart', '/checkout'];
    if (skipPatterns.some(p => linkUrl.pathname.includes(p))) {
      score -= 30;
    }
    
    // Penalize anchors to same page
    if (linkUrl.pathname === sourceUrlObj.pathname && linkUrl.hash) {
      score -= 40;
    }
    
    return score;
  }
  
  private async checkRobots(url: string): Promise<boolean> {
    const origin = new URL(url).origin;
    
    if (!this.robotsCache.has(origin)) {
      const checker = new RobotsChecker(origin, this.userAgent);
      await checker.load();
      this.robotsCache.set(origin, checker);
    }
    
    return this.robotsCache.get(origin)!.isAllowed(url);
  }
  
  private estimateTokens(text: string): number {
    // Rough estimate: ~4 chars per token for English
    return Math.ceil(text.length / 4);
  }
  
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  private buildResult(): LoadedSource {
    const content = this.loadedContent.map(f => {
      const title = f.metadata?.title || f.path;
      return `# ${title}\nSource: ${f.path}\n\n${f.content}\n\n---\n`;
    }).join('\n');
    
    return {
      content,
      totalTokens: this.currentTokens,
      fileCount: this.loadedContent.length,
      files: this.loadedContent,
      metadata: {
        source: this.config.seedUrls.join(' + '),
        loadedAt: new Date(),
        pagesLoaded: this.loadedContent.length,
        pagesSkipped: this.visited.size - this.loadedContent.length,
        errors: this.errors,
        targetTokens: this.config.targetTokens,
        actualTokens: this.currentTokens,
      },
    };
  }
}
```

---

## Extractor Implementations

### HTML Extractor

```typescript
// packages/core/src/adapters/extractors/html-extractor.ts

import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import * as cheerio from 'cheerio';
import type { ContentExtractor, ExtractedContent } from './types';

export class HtmlExtractor implements ContentExtractor {
  readonly name = 'html';
  readonly mimeTypes = ['text/html', 'application/xhtml+xml'];
  
  async extract(content: Buffer, url: string): Promise<ExtractedContent> {
    const html = content.toString('utf-8');
    
    // Try Readability first
    try {
      const result = this.extractWithReadability(html, url);
      if (result.text.length > 100) {
        return result;
      }
    } catch {
      // Fall through to cheerio
    }
    
    // Fallback to cheerio tag stripping
    return this.extractWithCheerio(html, url);
  }
  
  private extractWithReadability(html: string, url: string): ExtractedContent {
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    
    if (!article) {
      throw new Error('Readability failed to parse');
    }
    
    // Extract links from original HTML
    const links = this.extractLinks(html, url);
    
    return {
      text: article.textContent,
      title: article.title,
      links,
      metadata: {
        author: article.byline,
        excerpt: article.excerpt,
        siteName: article.siteName,
      },
    };
  }
  
  private extractWithCheerio(html: string, url: string): ExtractedContent {
    const $ = cheerio.load(html);
    
    // Remove non-content elements
    $('script, style, nav, header, footer, aside, iframe, noscript').remove();
    
    // Extract title
    const title = $('title').text() || $('h1').first().text() || undefined;
    
    // Extract links before getting text
    const links = this.extractLinks(html, url);
    
    // Get text content
    const text = $('body').text()
      .replace(/\s+/g, ' ')
      .trim();
    
    // Extract metadata
    const description = $('meta[name="description"]').attr('content');
    const author = $('meta[name="author"]').attr('content');
    
    return {
      text,
      title,
      links,
      metadata: {
        description,
        author,
      },
    };
  }
  
  private extractLinks(html: string, baseUrl: string): string[] {
    const $ = cheerio.load(html);
    const links: string[] = [];
    
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
        try {
          const resolved = new URL(href, baseUrl).href;
          if (resolved.startsWith('http')) {
            links.push(resolved);
          }
        } catch {
          // Invalid URL, skip
        }
      }
    });
    
    return [...new Set(links)]; // Dedupe
  }
}
```

### PDF Extractor

```typescript
// packages/core/src/adapters/extractors/pdf-extractor.ts

import pdf from 'pdf-parse';
import type { ContentExtractor, ExtractedContent } from './types';

export class PdfExtractor implements ContentExtractor {
  readonly name = 'pdf';
  readonly mimeTypes = ['application/pdf'];
  
  async extract(content: Buffer, url: string): Promise<ExtractedContent> {
    const data = await pdf(content);
    
    return {
      text: data.text,
      title: data.info?.Title,
      metadata: {
        author: data.info?.Author,
        creator: data.info?.Creator,
        producer: data.info?.Producer,
        pageCount: data.numpages,
        pdfVersion: data.info?.PDFFormatVersion,
      },
    };
  }
}
```

### JSON Extractor

```typescript
// packages/core/src/adapters/extractors/json-extractor.ts

import type { ContentExtractor, ExtractedContent } from './types';

export class JsonExtractor implements ContentExtractor {
  readonly name = 'json';
  readonly mimeTypes = ['application/json', 'text/json'];
  
  async extract(content: Buffer, url: string): Promise<ExtractedContent> {
    const text = content.toString('utf-8');
    const parsed = JSON.parse(text);
    
    // Pretty print for readability
    const prettyJson = JSON.stringify(parsed, null, 2);
    
    // Generate structure summary
    const summary = this.summarizeStructure(parsed);
    
    return {
      text: `${summary}\n\n${prettyJson}`,
      title: this.extractTitle(parsed, url),
      metadata: {
        type: Array.isArray(parsed) ? 'array' : 'object',
        topLevelKeys: Array.isArray(parsed) ? undefined : Object.keys(parsed),
        arrayLength: Array.isArray(parsed) ? parsed.length : undefined,
      },
    };
  }
  
  private summarizeStructure(obj: unknown, depth = 0, maxDepth = 2): string {
    if (depth > maxDepth) return '...';
    
    if (Array.isArray(obj)) {
      if (obj.length === 0) return '[]';
      const itemSummary = this.summarizeStructure(obj[0], depth + 1, maxDepth);
      return `Array[${obj.length}] of ${itemSummary}`;
    }
    
    if (obj && typeof obj === 'object') {
      const keys = Object.keys(obj);
      if (keys.length === 0) return '{}';
      if (depth === maxDepth) return `{${keys.join(', ')}}`;
      
      const entries = keys.slice(0, 5).map(k => 
        `${k}: ${this.summarizeStructure((obj as Record<string, unknown>)[k], depth + 1, maxDepth)}`
      );
      if (keys.length > 5) entries.push(`... +${keys.length - 5} more`);
      return `{ ${entries.join(', ')} }`;
    }
    
    return typeof obj;
  }
  
  private extractTitle(parsed: unknown, url: string): string {
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      return String(obj.title || obj.name || obj.id || new URL(url).pathname);
    }
    return new URL(url).pathname;
  }
}
```

### Text Extractor

```typescript
// packages/core/src/adapters/extractors/text-extractor.ts

import type { ContentExtractor, ExtractedContent } from './types';

export class TextExtractor implements ContentExtractor {
  readonly name = 'text';
  readonly mimeTypes = ['text/plain', 'text/markdown', 'text/csv'];
  
  async extract(content: Buffer, url: string): Promise<ExtractedContent> {
    return {
      text: content.toString('utf-8'),
      title: new URL(url).pathname.split('/').pop() || url,
    };
  }
}
```

### Extractor Registry

```typescript
// packages/core/src/adapters/extractors/index.ts

export * from './types';
export * from './html-extractor';
export * from './pdf-extractor';
export * from './json-extractor';
export * from './text-extractor';

import { ExtractorRegistry } from './types';
import { HtmlExtractor } from './html-extractor';
import { PdfExtractor } from './pdf-extractor';
import { JsonExtractor } from './json-extractor';
import { TextExtractor } from './text-extractor';

export function createDefaultRegistry(): ExtractorRegistry {
  const registry = new ExtractorRegistry();
  
  registry.register(new HtmlExtractor());
  registry.register(new PdfExtractor());
  registry.register(new JsonExtractor());
  registry.register(new TextExtractor()); // Default fallback
  
  return registry;
}
```

---

## Robots.txt Handler

```typescript
// packages/core/src/adapters/url-adapter/robots.ts

export class RobotsChecker {
  private rules: RobotsRule[] = [];
  private loaded = false;
  
  constructor(
    private origin: string,
    private userAgent: string
  ) {}
  
  async load(): Promise<void> {
    try {
      const response = await fetch(`${this.origin}/robots.txt`, {
        headers: { 'User-Agent': this.userAgent },
      });
      
      if (response.ok) {
        const text = await response.text();
        this.rules = this.parse(text);
      }
    } catch {
      // No robots.txt or fetch failed - allow all
    }
    this.loaded = true;
  }
  
  isAllowed(url: string): boolean {
    if (!this.loaded) return true;
    
    const pathname = new URL(url).pathname;
    
    // Find applicable rules (matching our user agent or *)
    const applicableRules = this.rules.filter(r => 
      r.userAgent === '*' || 
      this.userAgent.toLowerCase().includes(r.userAgent.toLowerCase())
    );
    
    // Check disallow rules
    for (const rule of applicableRules) {
      for (const disallow of rule.disallow) {
        if (pathname.startsWith(disallow)) {
          // Check if there's an allow that's more specific
          const allowed = rule.allow.some(a => 
            pathname.startsWith(a) && a.length > disallow.length
          );
          if (!allowed) return false;
        }
      }
    }
    
    return true;
  }
  
  private parse(text: string): RobotsRule[] {
    const rules: RobotsRule[] = [];
    let currentRule: RobotsRule | null = null;
    
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      
      const [directive, ...valueParts] = trimmed.split(':');
      const value = valueParts.join(':').trim();
      
      switch (directive.toLowerCase()) {
        case 'user-agent':
          if (currentRule) rules.push(currentRule);
          currentRule = { userAgent: value, allow: [], disallow: [] };
          break;
        case 'allow':
          if (currentRule) currentRule.allow.push(value);
          break;
        case 'disallow':
          if (currentRule) currentRule.disallow.push(value);
          break;
      }
    }
    
    if (currentRule) rules.push(currentRule);
    return rules;
  }
}

interface RobotsRule {
  userAgent: string;
  allow: string[];
  disallow: string[];
}
```

---

## Integration with loadSingleSource

Update `packages/mcp-server/src/tools/handlers.ts`:

```typescript
import { UrlAdapter } from '@mnemo/core';

// Add to ToolHandlerDeps
export interface ToolHandlerDeps {
  geminiClient: GeminiClient;
  storage: CacheStorage;
  repoLoader: RepoLoader;
  sourceLoader: SourceLoader;
  urlAdapter: UrlAdapter;  // NEW
  usageLogger?: UsageLogger;
}

// Update loadSingleSource
async function loadSingleSource(
  source: string,
  deps: ToolHandlerDeps,
  githubToken?: string
): Promise<LoadedSource> {
  const { repoLoader, sourceLoader, urlAdapter } = deps;

  if (isGitHubUrl(source)) {
    return loadGitHubRepoViaAPI(source, { githubToken });
  } else if (isUrl(source)) {
    // NEW: Use URL adapter for any non-GitHub URL
    return urlAdapter.load({ type: 'url', url: source });
  } else {
    const stats = await stat(source);
    if (stats.isDirectory()) {
      return repoLoader.loadDirectory(source);
    } else {
      return sourceLoader.loadFile(source);
    }
  }
}
```

---

## Dependencies to Add

```json
{
  "dependencies": {
    "@mozilla/readability": "^0.5.0",
    "jsdom": "^24.0.0",
    "cheerio": "^1.0.0",
    "pdf-parse": "^1.1.1"
  },
  "devDependencies": {
    "@types/jsdom": "^21.1.6"
  }
}
```

---

## Default Configuration Values

| Parameter | Default | Rationale |
|-----------|---------|-----------|
| `targetTokens` | 100,000 | Reasonable context size, ~$0.45/hr cache cost |
| `minTokensPerPage` | 500 | Skip tiny pages (navs, redirects, etc.) |
| `maxPages` | 50 | Safety cap to prevent runaway crawls |
| `sameDomainOnly` | true | Don't wander off-site by default |
| `delayMs` | 100 | Be respectful to servers |
| `respectRobotsTxt` | true | Good citizenship |

---

## Test Cases to Implement

### Unit Tests

1. **HtmlExtractor**
   - Readability extraction works on article-style page
   - Falls back to cheerio when Readability fails
   - Extracts links correctly
   - Handles malformed HTML gracefully

2. **PdfExtractor**
   - Extracts text from valid PDF
   - Extracts metadata (title, author, page count)
   - Handles corrupted PDF gracefully

3. **JsonExtractor**
   - Pretty prints JSON
   - Generates correct structure summary
   - Handles arrays and objects
   - Handles nested structures

4. **RobotsChecker**
   - Parses standard robots.txt
   - Respects disallow rules
   - Handles allow overrides
   - Works when robots.txt missing

5. **TokenTargetCrawler**
   - Stops at target token count
   - Respects minTokensPerPage
   - Respects maxPages limit
   - Scores links correctly
   - Handles errors without failing

### Integration Tests

1. Load single HTML page
2. Load single PDF
3. Load single JSON endpoint
4. Token-based crawl of documentation site
5. Verify robots.txt respected
6. Verify rate limiting works

---

## Export Updates

Update `packages/core/src/index.ts` to export:

```typescript
// Adapters
export { UrlAdapter, type UrlAdapterConfig } from './adapters/url-adapter';
export { 
  createDefaultRegistry,
  ExtractorRegistry,
  HtmlExtractor,
  PdfExtractor,
  JsonExtractor,
  TextExtractor,
  type ContentExtractor,
  type ExtractedContent,
} from './adapters/extractors';
```

---

## Future Enhancements (Not for this PR)

1. **DirectoryAdapter** - Local filesystem crawling with same token-based approach
2. **Predictive crawling** - Use LLM to score link relevance
3. **Incremental updates** - Only reload changed pages
4. **Parallel fetching** - Configurable concurrency for faster crawls
5. **Custom extractors** - Plugin system for user-defined content types
