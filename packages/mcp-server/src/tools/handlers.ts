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
  CacheNotFoundError,
  isUrl,
  isGitHubUrl,
  loadGitHubRepoViaAPI,
  calculateCost,
  UrlAdapter,
  isGenericUrl,
  MnemoError,
} from '@mnemo/core';
import {
  contextLoadSchema,
  contextQuerySchema,
  contextEvictSchema,
  contextStatsSchema,
  contextRefreshSchema,
  type ContextLoadInput,
  type ContextQueryInput,
  type ContextEvictInput,
  type ContextStatsInput,
  type ContextRefreshInput,
} from './schemas';
import { stat } from 'node:fs/promises';

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
      systemInstruction: input.systemInstruction,
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

/**
 * Query a cached context
 */
export async function handleContextQuery(
  deps: ToolHandlerDeps,
  rawInput: unknown
): Promise<QueryResultWithTiming> {
  const startTime = Date.now();
  const input = contextQuerySchema.parse(rawInput);
  const { geminiClient, storage, asyncQueryConfig } = deps;

  // Get cache by alias
  const cache = await storage.getByAlias(input.alias);
  if (!cache) {
    throw new CacheNotFoundError(input.alias);
  }

  // Check if expired
  if (new Date() > cache.expiresAt) {
    await storage.deleteByAlias(input.alias);
    throw new CacheNotFoundError(input.alias);
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
 * List all active caches (filters out expired caches and cleans them up)
 */
export async function handleContextList(
  deps: ToolHandlerDeps
): Promise<{ caches: Array<{ alias: string; tokenCount: number; expiresAt: string; source: string }>; expiredCount: number }> {
  const { storage } = deps;
  const allCaches = await storage.list();
  const now = new Date();

  // Separate active and expired caches
  const activeCaches = allCaches.filter((c) => c.expiresAt > now);
  const expiredCaches = allCaches.filter((c) => c.expiresAt <= now);

  // Clean up expired caches in background (don't await to avoid slowing response)
  if (expiredCaches.length > 0) {
    Promise.all(expiredCaches.map((c) => storage.deleteByAlias(c.alias))).catch((err) =>
      console.error('Failed to clean up expired caches:', err)
    );
  }

  return {
    caches: activeCaches.map((c) => ({
      alias: c.alias,
      tokenCount: c.tokenCount,
      expiresAt: c.expiresAt.toISOString(),
      source: c.source,
    })),
    expiredCount: expiredCaches.length,
  };
}

/**
 * Evict a cache
 */
export async function handleContextEvict(
  deps: ToolHandlerDeps,
  rawInput: unknown
): Promise<{ success: true; alias: string }> {
  const input = contextEvictSchema.parse(rawInput);
  validateWritePassphrase(deps, input.passphrase);
  const { geminiClient, storage } = deps;

  // Get cache by alias
  const cache = await storage.getByAlias(input.alias);
  if (!cache) {
    throw new CacheNotFoundError(input.alias);
  }

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

  return { success: true, alias: input.alias };
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
      systemInstruction: input.systemInstruction,
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
