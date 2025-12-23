import {
  type LLMClient,
  RepoLoader,
  SourceLoader,
  type CacheMetadata,
  type CacheStorage,
  type QueryResult,
  type UsageLogger,
  type UsageStats,
  type LoadedSource,
  type CacheExpiredResponse,
  CacheNotFoundError,
  isUrl,
  isGitHubUrl,
  loadGitHubRepoViaAPI,
  calculateCost,
  UrlAdapter,
  isGenericUrl,
  MnemoError,
  // RAG support
  chunkLoadedSource,
  prepareChunkForEmbedding,
  chunkToVectorMetadata,
  type CodeChunk,
  type VectorizeClient,
  type EmbeddingClient,
  type RepoIndexStorage,
  type RepoIndexMetadata,
  type ChunkStorage,
  type StoredChunk,
} from '@mnemo/core';
import {
  contextLoadSchema,
  contextQuerySchema,
  contextEvictSchema,
  contextStatsSchema,
  contextRefreshSchema,
  contextIndexSchema,
  type ContextLoadInput,
  type ContextQueryInput,
  type ContextEvictInput,
  type ContextStatsInput,
  type ContextRefreshInput,
  type ContextIndexInput,
} from './schemas';
import { stat } from 'node:fs/promises';

/**
 * Default system instruction for code analysis caches
 */
const DEFAULT_SYSTEM_INSTRUCTION =
  'Be extremely concise. Answer in 1-3 sentences maximum. No markdown formatting, no bullet points, no headers. Just the direct answer.';

/**
 * Configuration for async query polling
 */
export interface AsyncQueryConfig {
  /** Base URL for async endpoints (e.g., https://mnemo.logosflux.io) */
  baseUrl: string;
  /** Polling interval in ms (default: 1500) */
  pollIntervalMs?: number;
  /** Maximum wait time in ms (default: 300000 = 5 minutes) */
  maxWaitMs?: number;
  /** Optional auth token */
  authToken?: string;
}

export interface ToolHandlerDeps {
  geminiClient: LLMClient;
  storage: CacheStorage;
  repoLoader: RepoLoader;
  sourceLoader: SourceLoader;
  urlAdapter?: UrlAdapter;
  usageLogger?: UsageLogger;
  writePassphrase?: string;
  /** If set, context_query uses async polling instead of direct LLM calls */
  asyncQueryConfig?: AsyncQueryConfig;
  // RAG support (v0.3)
  /** Vectorize client for vector storage */
  vectorizeClient?: VectorizeClient;
  /** Embedding client for generating embeddings */
  embeddingClient?: EmbeddingClient;
  /** Storage for repo index metadata */
  repoIndexStorage?: RepoIndexStorage;
  /** Storage for chunk content */
  chunkStorage?: ChunkStorage;
}

/**
 * Validate passphrase for write operations
 * Throws an error if WRITE_PASSPHRASE is configured but passphrase doesn't match
 */
function validateWritePassphrase(deps: ToolHandlerDeps, passphrase?: string): void {
  if (deps.writePassphrase) {
    if (!passphrase) {
      throw new Error('Passphrase required for write operations');
    }
    if (passphrase !== deps.writePassphrase) {
      throw new Error('Invalid passphrase');
    }
  }
}

/**
 * Load a single source (helper for composite loading)
 * Supports: GitHub repos, generic URLs (via UrlAdapter), local files/directories
 */
async function loadSingleSource(
  source: string,
  deps: ToolHandlerDeps,
  githubToken?: string
): Promise<LoadedSource> {
  const { repoLoader, sourceLoader, urlAdapter } = deps;

  if (isGitHubUrl(source)) {
    return loadGitHubRepoViaAPI(source, { githubToken });
  } else if (isGenericUrl(source)) {
    // Use URL adapter for non-GitHub URLs
    if (!urlAdapter) {
      throw new Error('URL adapter not configured. Cannot load generic URLs.');
    }
    return urlAdapter.load({ type: 'url', url: source });
  } else if (isUrl(source)) {
    // Fallback for other URL types (shouldn't normally hit this)
    throw new Error('Only GitHub URLs and HTTP/HTTPS URLs are supported for remote loading');
  } else {
    const stats = await stat(source);
    if (stats.isDirectory()) {
      return repoLoader.loadDirectory(source);
    } else {
      return sourceLoader.loadFile(source);
    }
  }
}

/**
 * Combine multiple loaded sources into one
 */
function combineLoadedSources(sources: LoadedSource[], sourceNames: string[]): LoadedSource {
  const allFiles = sources.flatMap((s) => s.files);
  const totalTokens = sources.reduce((sum, s) => sum + s.totalTokens, 0);
  const fileCount = sources.reduce((sum, s) => sum + s.fileCount, 0);

  // Build combined content
  const lines: string[] = [];
  lines.push('# Combined Context');
  lines.push(`# Sources: ${sourceNames.join(', ')}`);
  lines.push(`# Total Files: ${fileCount}`);
  lines.push(`# Generated: ${new Date().toISOString()}`);
  lines.push('');

  for (let i = 0; i < sources.length; i++) {
    lines.push(`## Source ${i + 1}: ${sourceNames[i]}`);
    lines.push('');
    lines.push(sources[i].content);
    lines.push('');
  }

  return {
    content: lines.join('\n'),
    totalTokens,
    fileCount,
    files: allFiles,
    metadata: {
      source: sourceNames.join(' + '),
      loadedAt: new Date(),
    },
  };
}

/** Timing metrics for context_load */
export interface LoadTiming {
  loadMs: number;
  tokensLoaded: number;
  tokensPerSecond: number;
}

/**
 * Load a source into the context cache
 */
export async function handleContextLoad(
  deps: ToolHandlerDeps,
  rawInput: unknown
): Promise<{ success: true; cache: CacheMetadata; sourcesLoaded: number; timing: LoadTiming }> {
  const startTime = Date.now();
  const input = contextLoadSchema.parse(rawInput);
  validateWritePassphrase(deps, input.passphrase);
  const { geminiClient, storage } = deps;

  // Check if alias already exists
  const existing = await storage.getByAlias(input.alias);
  if (existing) {
    // Evict existing cache first
    try {
      await geminiClient.deleteCache(existing.name);
    } catch {
      // Ignore if already expired
    }
    await storage.deleteByAlias(input.alias);
  }

  // Get list of sources to load
  const sourcesToLoad = input.sources ?? (input.source ? [input.source] : []);
  if (sourcesToLoad.length === 0) {
    throw new Error('No sources provided');
  }

  // Load all sources
  let loadedSource: LoadedSource;
  try {
    if (sourcesToLoad.length === 1) {
      loadedSource = await loadSingleSource(sourcesToLoad[0], deps, input.githubToken);
    } else {
      // Composite loading - load all and combine
      const loadedSources = await Promise.all(
        sourcesToLoad.map((s) => loadSingleSource(s, deps, input.githubToken))
      );
      loadedSource = combineLoadedSources(loadedSources, sourcesToLoad);
    }
  } catch (error) {
    throw new Error(`Failed to load source: ${(error as Error).message}`);
  }

  // Create Gemini cache
  // Note: TTL defaults to 1 hour (3600s) for Gemini compatibility.
  // With local Nemotron (no Gemini 1-hour cache limit), we can extend this significantly in the future.
  // Consider 24h+ TTLs when running purely on local models.
  const cacheMetadata = await geminiClient.createCache(
    loadedSource.content,
    input.alias,
    {
      ttl: input.ttl,
      systemInstruction: input.systemInstruction ?? DEFAULT_SYSTEM_INSTRUCTION,
    }
  );

  // Update with actual source info
  cacheMetadata.source = loadedSource.metadata.source;
  cacheMetadata.tokenCount = loadedSource.totalTokens;

  // Store in local storage
  await storage.save(cacheMetadata);

  // Log usage
  if (deps.usageLogger) {
    await deps.usageLogger.log({
      cacheId: cacheMetadata.name,
      operation: 'load',
      tokensUsed: loadedSource.totalTokens,
      cachedTokensUsed: 0, // Initial load isn't cached yet
    });
  }

  // Calculate timing metrics
  const loadMs = Date.now() - startTime;
  const tokensLoaded = loadedSource.totalTokens;
  const tokensPerSecond = loadMs > 0 ? Math.round((tokensLoaded / loadMs) * 1000) : 0;

  return {
    success: true,
    cache: cacheMetadata,
    sourcesLoaded: sourcesToLoad.length,
    timing: { loadMs, tokensLoaded, tokensPerSecond },
  };
}

/** Timing metrics for context_query */
export interface QueryTiming {
  queryMs: number;
  contextTokens: number;
  outputTokens: number;
  tokensPerSecond: number;
}

/** Extended query result with timing */
export interface QueryResultWithTiming extends QueryResult {
  timing: QueryTiming;
}

/**
 * Response from async status endpoint
 */
interface AsyncStatusResponse {
  jobId: string;
  status: 'pending' | 'processing' | 'complete' | 'failed';
  createdAt: string;
  updatedAt: string;
  result?: QueryResultWithTiming;
  error?: string;
}

/**
 * Query using async HTTP polling
 */
async function queryViaAsyncEndpoint(
  config: AsyncQueryConfig,
  alias: string,
  query: string,
  options: { maxTokens?: number; temperature?: number }
): Promise<QueryResultWithTiming> {
  const baseUrl = config.baseUrl.replace(/\/$/, '');
  const pollInterval = config.pollIntervalMs ?? 1500;
  const maxWait = config.maxWaitMs ?? 300000;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  if (config.authToken) {
    headers['Authorization'] = `Bearer ${config.authToken}`;
  }

  // Submit async query with wait=true for reliable completion
  // This keeps the HTTP connection open until the query completes
  const submitResponse = await fetch(`${baseUrl}/query/async`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      alias,
      query,
      maxTokens: options.maxTokens,
      temperature: options.temperature,
      wait: true, // Wait for result instead of polling
    }),
  });

  if (!submitResponse.ok) {
    const errorText = await submitResponse.text();
    throw new MnemoError(
      `Failed to submit async query: ${submitResponse.status} - ${errorText}`,
      'ASYNC_SUBMIT_ERROR'
    );
  }

  // With wait=true, the response contains the result directly
  const response = await submitResponse.json() as AsyncStatusResponse;

  // Check if we got an immediate result (wait=true mode)
  if (response.status === 'complete' && response.result) {
    return response.result;
  }

  if (response.status === 'failed') {
    throw new MnemoError(response.error ?? 'Query failed', 'ASYNC_QUERY_FAILED');
  }

  // Fallback to polling if status is pending/processing (shouldn't happen with wait=true)
  const jobId = response.jobId;
  const startTime = Date.now();

  while (Date.now() - startTime < maxWait) {
    const statusResponse = await fetch(`${baseUrl}/query/status/${jobId}`, { headers });

    if (!statusResponse.ok) {
      const errorText = await statusResponse.text();
      throw new MnemoError(
        `Failed to check job status: ${statusResponse.status} - ${errorText}`,
        'ASYNC_STATUS_ERROR'
      );
    }

    const status = await statusResponse.json() as AsyncStatusResponse;

    switch (status.status) {
      case 'complete':
        if (!status.result) {
          throw new MnemoError('Job completed but no result returned', 'ASYNC_RESULT_ERROR');
        }
        return status.result;

      case 'failed':
        throw new MnemoError(status.error ?? 'Query failed', 'ASYNC_QUERY_FAILED');

      case 'pending':
      case 'processing':
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
        break;
    }
  }

  throw new MnemoError(
    `Query timed out after ${maxWait}ms`,
    'ASYNC_TIMEOUT',
    { jobId, maxWaitMs: maxWait }
  );
}

/** Response type for expired caches with timing info */
export interface CacheExpiredResponseWithTiming extends CacheExpiredResponse {
  timing: QueryTiming;
}

/** Extended query result with RAG info */
export interface RAGQueryResult {
  response: string;
  chunksUsed: number;
  filesReferenced: string[];
  timing: {
    searchMs: number;
    llmMs: number;
    totalMs: number;
  };
}

/**
 * Query using vector search (RAG mode)
 */
async function queryViaVectorSearch(
  deps: ToolHandlerDeps,
  alias: string,
  query: string,
  options: { maxTokens?: number; temperature?: number; topK?: number }
): Promise<RAGQueryResult> {
  const { vectorizeClient, embeddingClient, geminiClient, chunkStorage } = deps;
  const startTime = Date.now();

  if (!vectorizeClient || !embeddingClient) {
    throw new MnemoError('Vector search not available', 'VECTORIZE_NOT_CONFIGURED');
  }

  // Generate embedding for query
  const [queryEmbedding] = await embeddingClient.embed([query]);
  const searchStartTime = Date.now();

  // Search for relevant chunks
  const topK = options.topK ?? 5;
  const searchResult = await vectorizeClient.query(queryEmbedding, {
    topK,
    filter: { repo_alias: alias },
    returnMetadata: true,
  });

  const searchMs = Date.now() - searchStartTime;

  if (searchResult.matches.length === 0) {
    return {
      response: `No relevant content found for query in index '${alias}'.`,
      chunksUsed: 0,
      filesReferenced: [],
      timing: { searchMs, llmMs: 0, totalMs: Date.now() - startTime },
    };
  }

  // Build context from retrieved chunks
  const contextParts: string[] = [];
  const filesReferenced = new Set<string>();

  // Try to get actual chunk content from storage
  const chunkIds = searchResult.matches.map((m) => m.id);
  const storedChunks = chunkStorage
    ? await chunkStorage.getChunksByIds(chunkIds)
    : [];
  const chunkContentMap = new Map(storedChunks.map((c) => [c.id, c]));

  for (const match of searchResult.matches) {
    const meta = match.metadata as {
      file_path?: string;
      start_line?: number;
      end_line?: number;
    };
    const filePath = meta.file_path ?? 'unknown';
    filesReferenced.add(filePath);

    // Try to get actual content
    const storedChunk = chunkContentMap.get(match.id);
    if (storedChunk) {
      // Include actual chunk content
      contextParts.push(
        `### ${filePath} (lines ${meta.start_line ?? '?'}-${meta.end_line ?? '?'}) [score: ${match.score.toFixed(3)}]\n\`\`\`\n${storedChunk.content}\n\`\`\``
      );
    } else {
      // Fallback to just file reference
      contextParts.push(
        `### ${filePath} (lines ${meta.start_line ?? '?'}-${meta.end_line ?? '?'}) [score: ${match.score.toFixed(3)}]\n(content not available)`
      );
    }
  }

  // Build system prompt with context
  const hasContent = storedChunks.length > 0;
  const systemPrompt = hasContent
    ? `You are answering questions about a codebase. Use the following context from the most relevant code chunks:

${contextParts.join('\n\n')}

Answer the user's question based on the code context above. Be specific and reference the relevant files/lines when applicable.`
    : `You are answering questions about a codebase. The following files are most relevant to the query, ranked by similarity:

${contextParts.join('\n')}

Answer the user's question based on your knowledge of common code patterns and the file structure hints above. If you need more specific content, suggest which files to examine.`;

  const llmStartTime = Date.now();

  // Query the LLM directly (not via cache since we're doing RAG)
  const result = await geminiClient.query(query, {
    systemInstruction: systemPrompt,
    maxOutputTokens: options.maxTokens,
    temperature: options.temperature,
  });

  const llmMs = Date.now() - llmStartTime;

  return {
    response: result.response,
    chunksUsed: searchResult.matches.length,
    filesReferenced: Array.from(filesReferenced),
    timing: {
      searchMs,
      llmMs,
      totalMs: Date.now() - startTime,
    },
  };
}

/**
 * Query a cached context
 */
export async function handleContextQuery(
  deps: ToolHandlerDeps,
  rawInput: unknown
): Promise<QueryResultWithTiming | CacheExpiredResponseWithTiming | RAGQueryResult> {
  const startTime = Date.now();
  const input = contextQuerySchema.parse(rawInput);
  const { geminiClient, storage, asyncQueryConfig, repoIndexStorage, vectorizeClient, embeddingClient } = deps;

  // Check if there's a vector index for this alias
  if (repoIndexStorage && vectorizeClient && embeddingClient) {
    const repoIndex = await repoIndexStorage.getByAlias(input.alias);
    if (repoIndex && repoIndex.status === 'active') {
      // Use RAG-based query
      return queryViaVectorSearch(deps, input.alias, input.query, {
        maxTokens: input.maxTokens,
        temperature: input.temperature,
      });
    }
  }

  // Fall back to cache-based query
  const cache = await storage.getByAlias(input.alias);
  if (!cache) {
    throw new CacheNotFoundError(input.alias);
  }

  // Check if expired - return structured response instead of throwing
  if (new Date() > cache.expiresAt) {
    // Do NOT delete metadata - keep it so context_refresh knows the source
    const queryMs = Date.now() - startTime;
    return {
      status: 'expired',
      action_required: 'context_refresh',
      alias: input.alias,
      message: `Cache '${input.alias}' has expired. Call context_refresh("${input.alias}") to reload it. DO NOT attempt to load content directly.`,
      expired_at: cache.expiresAt.toISOString(),
      timing: {
        queryMs,
        contextTokens: 0,
        outputTokens: 0,
        tokensPerSecond: 0,
      },
    };
  }

  let result: QueryResult;

  // Use async polling if configured, otherwise direct query
  if (asyncQueryConfig) {
    // Async polling mode - for external MCP clients
    const asyncResult = await queryViaAsyncEndpoint(
      asyncQueryConfig,
      input.alias,
      input.query,
      { maxTokens: input.maxTokens, temperature: input.temperature }
    );

    // Log usage
    if (deps.usageLogger) {
      await deps.usageLogger.log({
        cacheId: cache.name,
        operation: 'query',
        tokensUsed: asyncResult.tokensUsed,
        cachedTokensUsed: asyncResult.cachedTokensUsed,
      });
    }

    return asyncResult;
  }

  // Direct query mode - for internal use
  result = await geminiClient.queryCache(cache.name, input.query, {
    maxOutputTokens: input.maxTokens,
    temperature: input.temperature,
  });

  // Log usage
  if (deps.usageLogger) {
    await deps.usageLogger.log({
      cacheId: cache.name,
      operation: 'query',
      tokensUsed: result.tokensUsed,
      cachedTokensUsed: result.cachedTokensUsed,
    });
  }

  // Calculate timing metrics
  const queryMs = Date.now() - startTime;
  const contextTokens = result.cachedTokensUsed;
  const outputTokens = result.tokensUsed - result.cachedTokensUsed;
  const tokensPerSecond = queryMs > 0 ? Math.round((outputTokens / queryMs) * 1000) : 0;

  return {
    ...result,
    timing: { queryMs, contextTokens, outputTokens, tokensPerSecond },
  };
}

/**
 * List all caches (includes expired caches with flag for context_refresh)
 */
interface CacheListItem {
  alias: string;
  tokenCount: number;
  expiresAt: string;
  source: string;
  expired: boolean;
}

interface IndexListItem {
  alias: string;
  chunkCount: number;
  totalTokens: number;
  fileCount: number;
  indexedAt: string;
  source: string;
  status: 'active' | 'indexing' | 'failed';
}

export async function handleContextList(
  deps: ToolHandlerDeps
): Promise<{ caches: CacheListItem[]; indexes?: IndexListItem[] }> {
  const { storage, repoIndexStorage } = deps;
  const allCaches = await storage.list();
  const now = new Date();

  const result: { caches: CacheListItem[]; indexes?: IndexListItem[] } = {
    caches: allCaches.map((c) => ({
      alias: c.alias,
      tokenCount: c.tokenCount,
      expiresAt: c.expiresAt.toISOString(),
      source: c.source,
      expired: c.expiresAt <= now,
    })),
  };

  // Include indexed repos if storage is available
  if (repoIndexStorage) {
    const allIndexes = await repoIndexStorage.list();
    result.indexes = allIndexes.map((idx) => ({
      alias: idx.alias,
      chunkCount: idx.chunkCount,
      totalTokens: idx.totalTokens,
      fileCount: idx.fileCount,
      indexedAt: idx.indexedAt.toISOString(),
      source: idx.source,
      status: idx.status,
    }));
  }

  return result;
}

/**
 * Evict a cache and/or vector index
 */
export async function handleContextEvict(
  deps: ToolHandlerDeps,
  rawInput: unknown
): Promise<{ success: true; alias: string; evicted: { cache?: boolean; index?: boolean; chunks?: number } }> {
  const input = contextEvictSchema.parse(rawInput);
  validateWritePassphrase(deps, input.passphrase);
  const { geminiClient, storage, repoIndexStorage, vectorizeClient, chunkStorage } = deps;

  const evicted: { cache?: boolean; index?: boolean; chunks?: number } = {};

  // Try to delete cache
  const cache = await storage.getByAlias(input.alias);
  if (cache) {
    // Delete from Gemini
    try {
      await geminiClient.deleteCache(cache.name);
    } catch {
      // Might already be expired, that's ok
    }

    // Log usage before deleting
    if (deps.usageLogger) {
      await deps.usageLogger.log({
        cacheId: cache.name,
        operation: 'evict',
        tokensUsed: 0,
        cachedTokensUsed: 0,
      });
    }

    // Delete from local storage
    await storage.deleteByAlias(input.alias);
    evicted.cache = true;
  }

  // Try to delete vector index
  if (repoIndexStorage) {
    const repoIndex = await repoIndexStorage.getByAlias(input.alias);
    if (repoIndex) {
      // Delete vectors from Vectorize
      if (vectorizeClient) {
        try {
          await vectorizeClient.deleteByFilter({ repo_alias: input.alias });
        } catch (error) {
          console.warn(`Failed to delete vectors for ${input.alias}: ${(error as Error).message}`);
        }
      }

      // Delete chunks from D1
      if (chunkStorage) {
        try {
          const deletedChunks = await chunkStorage.deleteByRepoAlias(input.alias);
          evicted.chunks = deletedChunks;
        } catch (error) {
          console.warn(`Failed to delete chunks for ${input.alias}: ${(error as Error).message}`);
        }
      }

      // Delete index metadata
      await repoIndexStorage.deleteByAlias(input.alias);
      evicted.index = true;
    }
  }

  // If neither cache nor index was found, throw error
  if (!evicted.cache && !evicted.index) {
    throw new CacheNotFoundError(input.alias);
  }

  return { success: true, alias: input.alias, evicted };
}

/**
 * Get usage statistics
 */
export async function handleContextStats(
  deps: ToolHandlerDeps,
  rawInput: unknown
): Promise<{
  totalCaches: number;
  totalTokens: number;
  usage?: UsageStats;
  caches?: Array<{ alias: string; tokenCount: number }>;
}> {
  const input = contextStatsSchema.parse(rawInput);
  const { storage, usageLogger } = deps;

  const allCaches = await storage.list();

  // Get usage stats if logger is available
  const usage = usageLogger ? await usageLogger.getStats() : undefined;

  if (input.alias) {
    // Stats for specific cache
    const cache = allCaches.find((c) => c.alias === input.alias);
    if (!cache) {
      throw new CacheNotFoundError(input.alias);
    }
    return {
      totalCaches: 1,
      totalTokens: cache.tokenCount,
      usage,
      caches: [{ alias: cache.alias, tokenCount: cache.tokenCount }],
    };
  }

  // Global stats
  const totalTokens = allCaches.reduce((sum, c) => sum + c.tokenCount, 0);

  return {
    totalCaches: allCaches.length,
    totalTokens,
    usage,
    caches: allCaches.map((c) => ({
      alias: c.alias,
      tokenCount: c.tokenCount,
    })),
  };
}

/**
 * Refresh an existing cache by re-fetching source content
 */
export async function handleContextRefresh(
  deps: ToolHandlerDeps,
  rawInput: unknown
): Promise<{ success: true; cache: CacheMetadata; previousTokenCount: number; newTokenCount: number }> {
  const input = contextRefreshSchema.parse(rawInput);
  validateWritePassphrase(deps, input.passphrase);
  const { geminiClient, storage } = deps;

  // Get existing cache
  const existingCache = await storage.getByAlias(input.alias);
  if (!existingCache) {
    throw new CacheNotFoundError(input.alias);
  }

  // Store previous metadata
  const previousTokenCount = existingCache.tokenCount;
  const previousSource = existingCache.source;

  // Determine sources to load (parse the source field for composite caches)
  const sourcesToLoad = previousSource.includes(' + ')
    ? previousSource.split(' + ')
    : [previousSource];

  // Use previous TTL if not specified, otherwise use new TTL
  const ttl = input.ttl ?? Math.floor((existingCache.expiresAt.getTime() - existingCache.createdAt.getTime()) / 1000);

  // Re-load all sources
  let loadedSource: LoadedSource;
  try {
    if (sourcesToLoad.length === 1) {
      loadedSource = await loadSingleSource(sourcesToLoad[0], deps, input.githubToken);
    } else {
      // Composite loading - load all and combine
      const loadedSources = await Promise.all(
        sourcesToLoad.map((s) => loadSingleSource(s, deps, input.githubToken))
      );
      loadedSource = combineLoadedSources(loadedSources, sourcesToLoad);
    }
  } catch (error) {
    throw new Error(`Failed to refresh source: ${(error as Error).message}`);
  }

  // Delete old cache from Gemini
  try {
    await geminiClient.deleteCache(existingCache.name);
  } catch {
    // Ignore if already expired
  }

  // Create new Gemini cache with refreshed content
  const cacheMetadata = await geminiClient.createCache(
    loadedSource.content,
    input.alias,
    {
      ttl,
      systemInstruction: input.systemInstruction ?? DEFAULT_SYSTEM_INSTRUCTION,
    }
  );

  // Update with actual source info
  cacheMetadata.source = loadedSource.metadata.source;
  cacheMetadata.tokenCount = loadedSource.totalTokens;

  // Store updated metadata
  await storage.save(cacheMetadata);

  // Log usage
  if (deps.usageLogger) {
    await deps.usageLogger.log({
      cacheId: cacheMetadata.name,
      operation: 'refresh',
      tokensUsed: loadedSource.totalTokens,
      cachedTokensUsed: 0, // Refresh creates new cache, no cached tokens yet
    });
  }

  return {
    success: true,
    cache: cacheMetadata,
    previousTokenCount,
    newTokenCount: loadedSource.totalTokens,
  };
}

// ============================================================================
// RAG-based Indexing (v0.3)
// ============================================================================

/** Timing metrics for context_index */
export interface IndexTiming {
  loadMs: number;
  chunkMs: number;
  embedMs: number;
  indexMs: number;
  totalMs: number;
}

/** Result of context_index operation */
export interface ContextIndexResult {
  success: true;
  alias: string;
  chunksCreated: number;
  filesIndexed: number;
  totalTokens: number;
  timing: IndexTiming;
}

/**
 * Index a source into Vectorize for RAG-based querying
 */
export async function handleContextIndex(
  deps: ToolHandlerDeps,
  rawInput: unknown
): Promise<ContextIndexResult> {
  const totalStartTime = Date.now();
  const input = contextIndexSchema.parse(rawInput);
  validateWritePassphrase(deps, input.passphrase);

  const { vectorizeClient, embeddingClient, repoIndexStorage } = deps;

  // Validate RAG dependencies are available
  if (!vectorizeClient) {
    throw new MnemoError(
      'Vectorize client not configured. context_index requires Cloudflare Vectorize.',
      'VECTORIZE_NOT_CONFIGURED'
    );
  }
  if (!embeddingClient) {
    throw new MnemoError(
      'Embedding client not configured. context_index requires Workers AI.',
      'EMBEDDINGS_NOT_CONFIGURED'
    );
  }
  if (!repoIndexStorage) {
    throw new MnemoError(
      'Repo index storage not configured. context_index requires D1 database.',
      'INDEX_STORAGE_NOT_CONFIGURED'
    );
  }

  // Check if alias already exists
  const existing = await repoIndexStorage.getByAlias(input.alias);
  if (existing) {
    // Delete existing vectors first
    // We need to query and delete by IDs since Vectorize doesn't support delete by filter
    // For now, just update status and overwrite
    await repoIndexStorage.updateStatus(input.alias, 'indexing');
  } else {
    // Create initial record with indexing status
    await repoIndexStorage.save({
      id: crypto.randomUUID(),
      alias: input.alias,
      source: '',
      chunkCount: 0,
      totalTokens: 0,
      fileCount: 0,
      indexedAt: new Date(),
      status: 'indexing',
    });
  }

  // Get list of sources to load
  const sourcesToLoad = input.sources ?? (input.source ? [input.source] : []);
  if (sourcesToLoad.length === 0) {
    throw new Error('No sources provided');
  }

  // Load all sources
  const loadStartTime = Date.now();
  let loadedSource: LoadedSource;
  try {
    if (sourcesToLoad.length === 1) {
      loadedSource = await loadSingleSource(sourcesToLoad[0], deps, input.githubToken);
    } else {
      const loadedSources = await Promise.all(
        sourcesToLoad.map((s) => loadSingleSource(s, deps, input.githubToken))
      );
      loadedSource = combineLoadedSources(loadedSources, sourcesToLoad);
    }
  } catch (error) {
    await repoIndexStorage.updateStatus(input.alias, 'failed');
    throw new Error(`Failed to load source: ${(error as Error).message}`);
  }
  const loadMs = Date.now() - loadStartTime;

  // Chunk the loaded source
  const chunkStartTime = Date.now();
  const files = loadedSource.files.map((f) => ({
    path: f.path,
    content: f.content,
  }));
  const chunks = chunkLoadedSource(files, input.alias);
  const chunkMs = Date.now() - chunkStartTime;

  // Generate embeddings
  const embedStartTime = Date.now();
  const textsToEmbed = chunks.map((chunk) => prepareChunkForEmbedding(chunk));
  let embeddings: number[][];
  try {
    embeddings = await embeddingClient.embed(textsToEmbed);
  } catch (error) {
    await repoIndexStorage.updateStatus(input.alias, 'failed');
    throw new MnemoError(
      `Failed to generate embeddings: ${(error as Error).message}`,
      'EMBEDDING_ERROR'
    );
  }
  const embedMs = Date.now() - embedStartTime;

  // Insert vectors into Vectorize
  const indexStartTime = Date.now();
  const vectors = chunks.map((chunk, i) => ({
    id: chunk.id,
    values: embeddings[i],
    metadata: chunkToVectorMetadata(chunk) as Record<string, unknown>,
  }));

  try {
    await vectorizeClient.insert(vectors);
  } catch (error) {
    await repoIndexStorage.updateStatus(input.alias, 'failed');
    throw new MnemoError(
      `Failed to insert vectors: ${(error as Error).message}`,
      'VECTORIZE_INSERT_ERROR'
    );
  }
  const indexMs = Date.now() - indexStartTime;

  // Save chunk content to D1 (for retrieval during queries)
  const { chunkStorage } = deps;
  if (chunkStorage) {
    const storedChunks: StoredChunk[] = chunks.map((chunk) => ({
      id: chunk.id,
      repoAlias: chunk.repoAlias,
      filePath: chunk.filePath,
      chunkIndex: chunk.chunkIndex,
      content: chunk.content,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      tokenCount: chunk.tokenEstimate,
    }));
    try {
      await chunkStorage.saveChunks(storedChunks);
    } catch (error) {
      // Non-fatal - vectors are already stored, just log warning
      console.warn(`Failed to save chunk content: ${(error as Error).message}`);
    }
  }

  // Calculate total tokens
  const totalTokens = chunks.reduce((sum, c) => sum + c.tokenEstimate, 0);

  // Update index metadata
  await repoIndexStorage.save({
    id: existing?.id ?? crypto.randomUUID(),
    alias: input.alias,
    source: loadedSource.metadata.source,
    chunkCount: chunks.length,
    totalTokens,
    fileCount: loadedSource.fileCount,
    indexedAt: new Date(),
    status: 'active',
  });

  const totalMs = Date.now() - totalStartTime;

  return {
    success: true,
    alias: input.alias,
    chunksCreated: chunks.length,
    filesIndexed: loadedSource.fileCount,
    totalTokens,
    timing: {
      loadMs,
      chunkMs,
      embedMs,
      indexMs,
      totalMs,
    },
  };
}
