/**
 * AI Search Client Interface
 *
 * Abstracts Cloudflare AI Search (AutoRAG) operations for tiered RAG queries.
 * AI Search provides automatic indexing from R2 with built-in reranking.
 *
 * Key difference from Vectorize:
 * - AI Search auto-indexes R2 content (no manual chunking/embedding needed)
 * - Built-in query rewriting and reranking
 * - Higher-level abstraction for RAG
 */

import { z } from 'zod';

// ============================================================================
// Types
// ============================================================================

export const AISearchChunkSchema = z.object({
  /** Chunk content */
  content: z.string(),
  /** Relevance score (0-1) */
  score: z.number(),
  /** File name/path in R2 */
  filename: z.string(),
  /** Folder path in R2 (for multitenancy) */
  folder: z.string().optional(),
  /** Custom metadata from R2 object */
  metadata: z.record(z.unknown()).optional(),
});

export type AISearchChunk = z.infer<typeof AISearchChunkSchema>;

export const AISearchResultSchema = z.object({
  /** Retrieved chunks with scores */
  chunks: z.array(AISearchChunkSchema),
  /** Aggregated confidence score (0-1) based on top chunks */
  confidence: z.number(),
  /** Number of results returned */
  count: z.number(),
  /** The (optionally rewritten) query used for search */
  rewrittenQuery: z.string().optional(),
});

export type AISearchResult = z.infer<typeof AISearchResultSchema>;

export const AISearchOptionsSchema = z.object({
  /** Maximum chunks to return (1-50, default 10) */
  maxResults: z.number().min(1).max(50).optional(),
  /** Minimum score threshold (0-1, default 0) */
  scoreThreshold: z.number().min(0).max(1).optional(),
  /** Enable query rewriting for better retrieval */
  rewriteQuery: z.boolean().optional(),
  /** Enable reranking with BGE model */
  reranking: z.boolean().optional(),
  /** Filter by folder (for multitenancy/alias scoping) */
  folder: z.string().optional(),
  /** Filter by custom metadata */
  filter: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
});

export type AISearchOptions = z.infer<typeof AISearchOptionsSchema>;

// ============================================================================
// AI Search Client Interface
// ============================================================================

export interface AISearchClient {
  /**
   * Search for relevant chunks using AI Search
   * @param query Natural language query
   * @param options Search options
   */
  search(query: string, options?: AISearchOptions): Promise<AISearchResult>;

  /**
   * Search and generate a response (full RAG pipeline)
   * Uses AI Search's built-in LLM for synthesis
   * @param query Natural language query
   * @param options Search options
   */
  aiSearch?(query: string, options?: AISearchOptions): Promise<{
    response: string;
    sources: AISearchChunk[];
  }>;

  /**
   * Check if the AI Search instance is available
   */
  isAvailable(): Promise<boolean>;
}

// ============================================================================
// Cloudflare AI Search Adapter
// ============================================================================

/**
 * Response format from CF AI Search search() method
 */
interface CFAISearchResponse {
  data: Array<{
    content: string;
    filename: string;
    score: number;
    metadata?: Record<string, unknown>;
  }>;
}

/**
 * Cloudflare AI Search adapter
 *
 * Usage:
 * ```typescript
 * const aiSearch = new CloudflareAISearchAdapter(env.AI, 'mnemo-search');
 * const results = await aiSearch.search('How does authentication work?', {
 *   folder: 'my-alias', // scope to specific cache alias
 *   maxResults: 10,
 * });
 * ```
 */
export class CloudflareAISearchAdapter implements AISearchClient {
  private ai: Ai;
  private instanceName: string;

  constructor(ai: Ai, instanceName: string) {
    this.ai = ai;
    this.instanceName = instanceName;
  }

  async search(query: string, options: AISearchOptions = {}): Promise<AISearchResult> {
    const {
      maxResults = 10,
      scoreThreshold = 0,
      rewriteQuery = true,
      reranking = true,
      folder,
      filter,
    } = options;

    // Build filter for folder-based scoping (multitenancy)
    let searchFilter: Record<string, unknown> | undefined;
    if (folder) {
      searchFilter = {
        type: 'eq',
        key: 'folder',
        value: folder,
      };
    } else if (filter) {
      // Support custom filters
      const filterKeys = Object.keys(filter);
      if (filterKeys.length === 1) {
        searchFilter = {
          type: 'eq',
          key: filterKeys[0],
          value: filter[filterKeys[0]],
        };
      }
    }

    try {
      // Access AutoRAG via AI binding
      // @ts-expect-error - AI Search types not yet in @cloudflare/workers-types
      const autorag = this.ai.autorag(this.instanceName);

      const response: CFAISearchResponse = await autorag.search({
        query,
        rewrite_query: rewriteQuery,
        max_num_results: maxResults,
        ranking_options: {
          score_threshold: scoreThreshold,
        },
        reranking: {
          enabled: reranking,
          model: '@cf/baai/bge-reranker-base',
        },
        ...(searchFilter && { filters: searchFilter }),
      });

      // Transform response to our schema
      const chunks: AISearchChunk[] = (response.data || []).map((item) => ({
        content: item.content,
        score: item.score,
        filename: item.filename,
        folder: this.extractFolder(item.filename),
        metadata: item.metadata,
      }));

      // Calculate confidence from top results
      const confidence = this.calculateConfidence(chunks);

      return {
        chunks,
        confidence,
        count: chunks.length,
      };
    } catch (error) {
      // Handle case where AI Search is not configured
      if (error instanceof Error && error.message.includes('not found')) {
        console.warn(`AI Search instance '${this.instanceName}' not found`);
        return {
          chunks: [],
          confidence: 0,
          count: 0,
        };
      }
      throw error;
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      // Try a minimal search to check availability
      await this.search('test', { maxResults: 1 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Calculate confidence score from top results
   * Uses weighted average of top 3 scores
   */
  private calculateConfidence(chunks: AISearchChunk[]): number {
    if (chunks.length === 0) return 0;

    // Take top 3 scores with weights [0.5, 0.3, 0.2]
    const weights = [0.5, 0.3, 0.2];
    const topChunks = chunks.slice(0, 3);

    let weightedSum = 0;
    let weightSum = 0;

    topChunks.forEach((chunk, i) => {
      const weight = weights[i] || 0.1;
      weightedSum += chunk.score * weight;
      weightSum += weight;
    });

    return weightSum > 0 ? weightedSum / weightSum : 0;
  }

  /**
   * Extract folder path from filename
   * e.g., "my-alias/content.md" -> "my-alias"
   */
  private extractFolder(filename: string): string | undefined {
    const parts = filename.split('/');
    if (parts.length > 1) {
      return parts.slice(0, -1).join('/');
    }
    return undefined;
  }
}

// ============================================================================
// Mock AI Search Client (for testing/local development)
// ============================================================================

/**
 * Mock AI Search client for testing and local development
 */
export class MockAISearchClient implements AISearchClient {
  private mockData: Map<string, AISearchChunk[]> = new Map();

  /**
   * Add mock data for a folder/alias
   */
  addMockData(folder: string, chunks: AISearchChunk[]): void {
    this.mockData.set(folder, chunks);
  }

  async search(query: string, options: AISearchOptions = {}): Promise<AISearchResult> {
    const { folder, maxResults = 10 } = options;

    // Get mock data for folder or all data
    let chunks: AISearchChunk[] = [];
    if (folder && this.mockData.has(folder)) {
      chunks = this.mockData.get(folder)!;
    } else if (!folder) {
      // Return all mock data
      for (const data of this.mockData.values()) {
        chunks.push(...data);
      }
    }

    // Simple keyword matching for mock search
    const queryWords = query.toLowerCase().split(/\s+/);
    const matches = chunks
      .map((chunk) => {
        const contentLower = chunk.content.toLowerCase();
        const matchCount = queryWords.filter((word) => contentLower.includes(word)).length;
        const score = matchCount / queryWords.length;
        return { ...chunk, score };
      })
      .filter((chunk) => chunk.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);

    const confidence = matches.length > 0 ? matches[0].score : 0;

    return {
      chunks: matches,
      confidence,
      count: matches.length,
    };
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}
