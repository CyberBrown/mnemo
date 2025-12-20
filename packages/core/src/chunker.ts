/**
 * Smart Chunking Utilities for RAG-based Context Indexing
 *
 * Breaks down files into semantically meaningful chunks for vector storage.
 * Each chunk is designed to:
 * - Stay within ~400 tokens (leaving room for query + response)
 * - Respect code boundaries (functions, classes, sections)
 * - Include context (file path header)
 * - Have slight overlap for continuity
 */

import { z } from 'zod';

// ============================================================================
// Types
// ============================================================================

export const CodeChunkSchema = z.object({
  /** Unique chunk identifier (UUID) */
  id: z.string(),
  /** Repo/index alias */
  repoAlias: z.string(),
  /** Relative file path */
  filePath: z.string(),
  /** File type for filtering */
  fileType: z.string(),
  /** Position in file (0, 1, 2...) */
  chunkIndex: z.number(),
  /** Actual code/text content */
  content: z.string(),
  /** Starting line number */
  startLine: z.number(),
  /** Ending line number */
  endLine: z.number(),
  /** Estimated token count */
  tokenEstimate: z.number(),
  /** Exported symbols (for code files) */
  exports: z.array(z.string()).optional(),
});

export type CodeChunk = z.infer<typeof CodeChunkSchema>;

export const VectorMetadataSchema = z.object({
  /** Repo alias for filtering */
  repo_alias: z.string(),
  /** File path for filtering */
  file_path: z.string(),
  /** File type for filtering */
  file_type: z.string(),
  /** Chunk index for ordering */
  chunk_index: z.number(),
  /** Starting line number */
  start_line: z.number(),
  /** Ending line number */
  end_line: z.number(),
});

export type VectorMetadata = z.infer<typeof VectorMetadataSchema>;

export interface ChunkingOptions {
  /** Target chunk size in tokens (default: 400) */
  targetTokens?: number;
  /** Overlap between chunks in tokens (default: 50) */
  overlapTokens?: number;
  /** Maximum chunk size in tokens (default: 600) */
  maxTokens?: number;
  /** Always include these files in full (patterns) */
  alwaysInclude?: string[];
}

const DEFAULT_OPTIONS: Required<ChunkingOptions> = {
  targetTokens: 400,
  overlapTokens: 50,
  maxTokens: 600,
  alwaysInclude: [
    'CLAUDE.md',
    'README.md',
    'readme.md',
    'package.json',
    'wrangler.toml',
    'wrangler.jsonc',
    'pyproject.toml',
    'Cargo.toml',
    'go.mod',
  ],
};

// ============================================================================
// Token Estimation
// ============================================================================

/**
 * Estimate token count for a string.
 * Uses ~4 characters per token as a rough estimate.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ============================================================================
// File Type Detection
// ============================================================================

const FILE_TYPE_MAP: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.py': 'python',
  '.md': 'markdown',
  '.mdx': 'markdown',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.kt': 'kotlin',
  '.swift': 'swift',
  '.c': 'c',
  '.cpp': 'cpp',
  '.h': 'c',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.rb': 'ruby',
  '.php': 'php',
  '.sql': 'sql',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less',
  '.html': 'html',
  '.vue': 'vue',
  '.svelte': 'svelte',
};

export function detectFileType(filePath: string): string {
  const ext = filePath.substring(filePath.lastIndexOf('.'));
  return FILE_TYPE_MAP[ext] ?? 'text';
}

// ============================================================================
// Code Boundary Detection
// ============================================================================

interface CodeBoundary {
  type: 'function' | 'class' | 'interface' | 'type' | 'import' | 'export' | 'section';
  startLine: number;
  endLine: number;
  name?: string;
}

/**
 * Find code boundaries in TypeScript/JavaScript files
 */
function findTsJsBoundaries(lines: string[]): CodeBoundary[] {
  const boundaries: CodeBoundary[] = [];
  let currentBoundary: CodeBoundary | null = null;
  let braceDepth = 0;
  let importBlock: { startLine: number } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Track import blocks
    if (trimmed.startsWith('import ') && !importBlock) {
      importBlock = { startLine: i };
    }

    // End import block on first non-import line (excluding empty lines)
    if (importBlock && trimmed && !trimmed.startsWith('import ') && !trimmed.startsWith('//')) {
      if (i > importBlock.startLine) {
        boundaries.push({
          type: 'import',
          startLine: importBlock.startLine,
          endLine: i - 1,
        });
      }
      importBlock = null;
    }

    // Detect function/class/interface declarations
    const functionMatch = trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/);
    const classMatch = trimmed.match(/^(?:export\s+)?class\s+(\w+)/);
    const interfaceMatch = trimmed.match(/^(?:export\s+)?interface\s+(\w+)/);
    const typeMatch = trimmed.match(/^(?:export\s+)?type\s+(\w+)/);
    const constFnMatch = trimmed.match(/^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(/);
    const arrowFnMatch = trimmed.match(/^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::\s*\w+)?\s*=>/);

    if (functionMatch || classMatch || interfaceMatch || constFnMatch || arrowFnMatch) {
      // Save previous boundary if exists
      if (currentBoundary && braceDepth === 0) {
        currentBoundary.endLine = i - 1;
        if (currentBoundary.endLine >= currentBoundary.startLine) {
          boundaries.push(currentBoundary);
        }
      }

      const type = classMatch
        ? 'class'
        : interfaceMatch
          ? 'interface'
          : 'function';
      const name =
        functionMatch?.[1] ||
        classMatch?.[1] ||
        interfaceMatch?.[1] ||
        constFnMatch?.[1] ||
        arrowFnMatch?.[1];

      currentBoundary = {
        type,
        startLine: i,
        endLine: i, // Will be updated
        name,
      };
      braceDepth = 0;
    }

    if (typeMatch && braceDepth === 0) {
      // Type definitions are usually single-line or end with semicolon
      boundaries.push({
        type: 'type',
        startLine: i,
        endLine: i,
        name: typeMatch[1],
      });
    }

    // Track brace depth for current boundary
    if (currentBoundary) {
      for (const char of line) {
        if (char === '{') braceDepth++;
        if (char === '}') braceDepth--;
      }

      if (braceDepth === 0 && line.includes('}')) {
        currentBoundary.endLine = i;
        boundaries.push(currentBoundary);
        currentBoundary = null;
      }
    }
  }

  // Handle trailing import block
  if (importBlock) {
    boundaries.push({
      type: 'import',
      startLine: importBlock.startLine,
      endLine: lines.length - 1,
    });
  }

  // Handle unclosed boundary
  if (currentBoundary) {
    currentBoundary.endLine = lines.length - 1;
    boundaries.push(currentBoundary);
  }

  return boundaries.sort((a, b) => a.startLine - b.startLine);
}

/**
 * Find code boundaries in Python files
 */
function findPythonBoundaries(lines: string[]): CodeBoundary[] {
  const boundaries: CodeBoundary[] = [];
  let currentBoundary: CodeBoundary | null = null;
  let currentIndent = 0;
  let importStart: number | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip empty lines and comments within blocks
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    // Calculate indentation
    const indent = line.length - line.trimStart().length;

    // Track import blocks
    if (trimmed.startsWith('import ') || trimmed.startsWith('from ')) {
      if (importStart === null) {
        importStart = i;
      }
    } else if (importStart !== null) {
      boundaries.push({
        type: 'import',
        startLine: importStart,
        endLine: i - 1,
      });
      importStart = null;
    }

    // Detect function/class definitions
    const funcMatch = trimmed.match(/^(?:async\s+)?def\s+(\w+)/);
    const classMatch = trimmed.match(/^class\s+(\w+)/);

    if (funcMatch || classMatch) {
      // Close previous boundary if at same or lower indent
      if (currentBoundary && indent <= currentIndent) {
        currentBoundary.endLine = i - 1;
        boundaries.push(currentBoundary);
      }

      currentBoundary = {
        type: classMatch ? 'class' : 'function',
        startLine: i,
        endLine: i,
        name: funcMatch?.[1] || classMatch?.[1],
      };
      currentIndent = indent;
    } else if (currentBoundary && indent <= currentIndent && trimmed) {
      // End of block (back to same indent level)
      currentBoundary.endLine = i - 1;
      boundaries.push(currentBoundary);
      currentBoundary = null;
    }
  }

  // Handle trailing import block
  if (importStart !== null) {
    boundaries.push({
      type: 'import',
      startLine: importStart,
      endLine: lines.length - 1,
    });
  }

  // Handle unclosed boundary
  if (currentBoundary) {
    currentBoundary.endLine = lines.length - 1;
    boundaries.push(currentBoundary);
  }

  return boundaries.sort((a, b) => a.startLine - b.startLine);
}

/**
 * Find section boundaries in Markdown files
 */
function findMarkdownBoundaries(lines: string[]): CodeBoundary[] {
  const boundaries: CodeBoundary[] = [];
  let currentSection: { startLine: number; name: string } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);

    if (headingMatch) {
      // Close previous section
      if (currentSection) {
        boundaries.push({
          type: 'section',
          startLine: currentSection.startLine,
          endLine: i - 1,
          name: currentSection.name,
        });
      }

      currentSection = {
        startLine: i,
        name: headingMatch[2],
      };
    }
  }

  // Handle last section
  if (currentSection) {
    boundaries.push({
      type: 'section',
      startLine: currentSection.startLine,
      endLine: lines.length - 1,
      name: currentSection.name,
    });
  }

  return boundaries;
}

// ============================================================================
// Chunking Functions
// ============================================================================

/**
 * Chunk a file by respecting code boundaries
 */
function chunkByBoundaries(
  lines: string[],
  boundaries: CodeBoundary[],
  options: Required<ChunkingOptions>
): Array<{ startLine: number; endLine: number; content: string }> {
  const chunks: Array<{ startLine: number; endLine: number; content: string }> = [];

  if (boundaries.length === 0) {
    // No boundaries found, fall back to simple chunking
    return chunkByLines(lines, options);
  }

  let currentChunk: { startLine: number; endLine: number; lines: string[] } | null = null;

  for (const boundary of boundaries) {
    const boundaryLines = lines.slice(boundary.startLine, boundary.endLine + 1);
    const boundaryContent = boundaryLines.join('\n');
    const boundaryTokens = estimateTokens(boundaryContent);

    // If boundary fits in current chunk, add it
    if (currentChunk) {
      const currentContent = currentChunk.lines.join('\n');
      const currentTokens = estimateTokens(currentContent);

      if (currentTokens + boundaryTokens <= options.maxTokens) {
        currentChunk.lines.push(...boundaryLines);
        currentChunk.endLine = boundary.endLine;
        continue;
      } else {
        // Save current chunk and start new one
        chunks.push({
          startLine: currentChunk.startLine,
          endLine: currentChunk.endLine,
          content: currentChunk.lines.join('\n'),
        });
        currentChunk = null;
      }
    }

    // If boundary is too large, split it
    if (boundaryTokens > options.maxTokens) {
      const subChunks = chunkByLines(boundaryLines, options);
      for (const sub of subChunks) {
        chunks.push({
          startLine: boundary.startLine + sub.startLine,
          endLine: boundary.startLine + sub.endLine,
          content: sub.content,
        });
      }
    } else {
      // Start new chunk with this boundary
      currentChunk = {
        startLine: boundary.startLine,
        endLine: boundary.endLine,
        lines: [...boundaryLines],
      };
    }
  }

  // Save final chunk
  if (currentChunk) {
    chunks.push({
      startLine: currentChunk.startLine,
      endLine: currentChunk.endLine,
      content: currentChunk.lines.join('\n'),
    });
  }

  return chunks;
}

/**
 * Simple line-based chunking for files without clear boundaries
 */
function chunkByLines(
  lines: string[],
  options: Required<ChunkingOptions>
): Array<{ startLine: number; endLine: number; content: string }> {
  const chunks: Array<{ startLine: number; endLine: number; content: string }> = [];
  let currentChunk: string[] = [];
  let startLine = 0;

  for (let i = 0; i < lines.length; i++) {
    currentChunk.push(lines[i]);
    const content = currentChunk.join('\n');
    const tokens = estimateTokens(content);

    if (tokens >= options.targetTokens) {
      chunks.push({
        startLine,
        endLine: i,
        content,
      });

      // Start new chunk with overlap
      const overlapLines = Math.ceil(options.overlapTokens / 10); // ~10 chars per line estimate
      const overlapStart = Math.max(0, currentChunk.length - overlapLines);
      currentChunk = currentChunk.slice(overlapStart);
      startLine = i - currentChunk.length + 1;
    }
  }

  // Save remaining content
  if (currentChunk.length > 0) {
    chunks.push({
      startLine,
      endLine: lines.length - 1,
      content: currentChunk.join('\n'),
    });
  }

  return chunks;
}

// ============================================================================
// Main Chunking Function
// ============================================================================

/**
 * Chunk a single file into semantically meaningful pieces
 */
export function chunkFile(
  filePath: string,
  content: string,
  repoAlias: string,
  options?: ChunkingOptions
): CodeChunk[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const fileType = detectFileType(filePath);
  const lines = content.split('\n');

  // Check if file should be kept whole
  const shouldKeepWhole =
    opts.alwaysInclude.some((pattern) => filePath.endsWith(pattern)) ||
    estimateTokens(content) <= opts.maxTokens;

  if (shouldKeepWhole) {
    return [
      {
        id: crypto.randomUUID(),
        repoAlias,
        filePath,
        fileType,
        chunkIndex: 0,
        content,
        startLine: 1, // 1-indexed for user display
        endLine: lines.length,
        tokenEstimate: estimateTokens(content),
      },
    ];
  }

  // Find boundaries based on file type
  let boundaries: CodeBoundary[] = [];
  switch (fileType) {
    case 'typescript':
    case 'javascript':
      boundaries = findTsJsBoundaries(lines);
      break;
    case 'python':
      boundaries = findPythonBoundaries(lines);
      break;
    case 'markdown':
      boundaries = findMarkdownBoundaries(lines);
      break;
    default:
      // Use simple line-based chunking
      break;
  }

  // Chunk the file
  const rawChunks = chunkByBoundaries(lines, boundaries, opts);

  // Convert to CodeChunk format
  return rawChunks.map((chunk, index) => ({
    id: crypto.randomUUID(),
    repoAlias,
    filePath,
    fileType,
    chunkIndex: index,
    content: chunk.content,
    startLine: chunk.startLine + 1, // 1-indexed
    endLine: chunk.endLine + 1, // 1-indexed
    tokenEstimate: estimateTokens(chunk.content),
  }));
}

/**
 * Chunk multiple files from a loaded source
 */
export function chunkLoadedSource(
  files: Array<{ path: string; content: string }>,
  repoAlias: string,
  options?: ChunkingOptions
): CodeChunk[] {
  const allChunks: CodeChunk[] = [];

  for (const file of files) {
    const chunks = chunkFile(file.path, file.content, repoAlias, options);
    allChunks.push(...chunks);
  }

  return allChunks;
}

/**
 * Convert a CodeChunk to Vectorize-compatible metadata
 */
export function chunkToVectorMetadata(chunk: CodeChunk): VectorMetadata {
  return {
    repo_alias: chunk.repoAlias,
    file_path: chunk.filePath,
    file_type: chunk.fileType,
    chunk_index: chunk.chunkIndex,
    start_line: chunk.startLine,
    end_line: chunk.endLine,
  };
}

/**
 * Create context header for a chunk (included in vector content)
 */
export function createChunkHeader(chunk: CodeChunk): string {
  return `### ${chunk.filePath} (lines ${chunk.startLine}-${chunk.endLine})\n\n`;
}

/**
 * Prepare chunk content for embedding (includes header for context)
 */
export function prepareChunkForEmbedding(chunk: CodeChunk): string {
  return createChunkHeader(chunk) + chunk.content;
}
