/**
 * Vectorize Client Interface
 *
 * Abstracts Cloudflare Vectorize operations for RAG-based context querying.
 * This allows the MCP server to work with Vectorize when running on CF Workers,
 * while also supporting alternative implementations for local development.
 */

import { z } from 'zod';

// ============================================================================
// Types
// ============================================================================

export const VectorSchema = z.object({
  id: z.string(),
  values: z.array(z.number()),
  metadata: z.record(z.unknown()).optional(),
});

export type Vector = z.infer<typeof VectorSchema>;

export const VectorMatchSchema = z.object({
  id: z.string(),
  score: z.number(),
  metadata: z.record(z.unknown()).optional(),
});

export type VectorMatch = z.infer<typeof VectorMatchSchema>;

export const VectorQueryResultSchema = z.object({
  matches: z.array(VectorMatchSchema),
  count: z.number(),
});

export type VectorQueryResult = z.infer<typeof VectorQueryResultSchema>;

export interface VectorizeQueryOptions {
  topK?: number;
  filter?: Record<string, string | number>;
  returnMetadata?: boolean;
  returnValues?: boolean;
}

// ============================================================================
// Vectorize Client Interface
// ============================================================================

export interface VectorizeClient {
  /**
   * Insert vectors into the index
   * @param vectors Array of vectors to insert (max 1000 per batch)
   */
  insert(vectors: Vector[]): Promise<{ count: number }>;

  /**
   * Query the index for similar vectors
   * @param vector Query vector
   * @param options Query options
   */
  query(vector: number[], options?: VectorizeQueryOptions): Promise<VectorQueryResult>;

  /**
   * Delete vectors by ID
   * @param ids Array of vector IDs to delete
   */
  deleteByIds(ids: string[]): Promise<{ count: number }>;

  /**
   * Delete vectors by metadata filter
   * @param filter Metadata filter (e.g., { repo_alias: 'my-repo' })
   */
  deleteByFilter(filter: Record<string, string | number>): Promise<{ count: number }>;
}

// ============================================================================
// Embedding Client Interface
// ============================================================================

export interface EmbeddingClient {
  /**
   * Generate embeddings for text
   * @param texts Array of texts to embed
   * @returns Array of embedding vectors (768 dimensions for bge-base-en-v1.5)
   */
  embed(texts: string[]): Promise<number[][]>;
}

// ============================================================================
// Repo Index Storage Interface
// ============================================================================

export interface RepoIndexMetadata {
  id: string;
  alias: string;
  source: string;
  chunkCount: number;
  totalTokens: number;
  fileCount: number;
  indexedAt: Date;
  expiresAt?: Date;
  status: 'active' | 'indexing' | 'failed';
}

export interface RepoIndexStorage {
  save(metadata: RepoIndexMetadata): Promise<void>;
  getByAlias(alias: string): Promise<RepoIndexMetadata | null>;
  list(): Promise<RepoIndexMetadata[]>;
  deleteByAlias(alias: string): Promise<boolean>;
  updateStatus(alias: string, status: 'active' | 'indexing' | 'failed'): Promise<void>;
}

// ============================================================================
// Chunk Content Storage Interface
// ============================================================================

export interface StoredChunk {
  id: string;
  repoAlias: string;
  filePath: string;
  chunkIndex: number;
  content: string;
  startLine?: number;
  endLine?: number;
  tokenCount: number;
}

export interface ChunkStorage {
  /**
   * Save chunks to storage (batch insert)
   * @param chunks Array of chunks to store
   */
  saveChunks(chunks: StoredChunk[]): Promise<void>;

  /**
   * Get chunks by their IDs (for RAG retrieval)
   * @param ids Array of chunk IDs (same as vector IDs)
   */
  getChunksByIds(ids: string[]): Promise<StoredChunk[]>;

  /**
   * Delete all chunks for a repo
   * @param repoAlias The repo alias to delete chunks for
   */
  deleteByRepoAlias(repoAlias: string): Promise<number>;
}
