import {
  GeminiClient,
  RepoLoader,
  SourceLoader,
  type CacheMetadata,
  type CacheStorage,
  type QueryResult,
  CacheNotFoundError,
  isUrl,
  isGitHubUrl,
  loadGitHubRepoViaAPI,
} from '@mnemo/core';
import {
  contextLoadSchema,
  contextQuerySchema,
  contextEvictSchema,
  contextStatsSchema,
  type ContextLoadInput,
  type ContextQueryInput,
  type ContextEvictInput,
  type ContextStatsInput,
} from './schemas';
import { stat } from 'node:fs/promises';

export interface ToolHandlerDeps {
  geminiClient: GeminiClient;
  storage: CacheStorage;
  repoLoader: RepoLoader;
  sourceLoader: SourceLoader;
}

/**
 * Load a source into the context cache
 */
export async function handleContextLoad(
  deps: ToolHandlerDeps,
  rawInput: unknown
): Promise<{ success: true; cache: CacheMetadata }> {
  const input = contextLoadSchema.parse(rawInput);
  const { geminiClient, storage, repoLoader, sourceLoader } = deps;

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

  // Determine source type and load accordingly
  let loadedSource;
  try {
    if (isGitHubUrl(input.source)) {
      // Load from GitHub URL via API (works in CF Workers)
      loadedSource = await loadGitHubRepoViaAPI(input.source);
    } else if (isUrl(input.source)) {
      // Other URLs not yet supported
      throw new Error('Only GitHub URLs are currently supported for remote loading');
    } else {
      // Local path - check if directory or file
      const stats = await stat(input.source);
      if (stats.isDirectory()) {
        loadedSource = await repoLoader.loadDirectory(input.source);
      } else {
        loadedSource = await sourceLoader.loadFile(input.source);
      }
    }
  } catch (error) {
    throw new Error(`Failed to load source: ${(error as Error).message}`);
  }

  // Create Gemini cache
  const cacheMetadata = await geminiClient.createCache(
    loadedSource.content,
    input.alias,
    {
      ttl: input.ttl,
      systemInstruction: input.systemInstruction,
    }
  );

  // Update with actual source info
  cacheMetadata.source = input.source;
  cacheMetadata.tokenCount = loadedSource.totalTokens;

  // Store in local storage
  await storage.save(cacheMetadata);

  return { success: true, cache: cacheMetadata };
}

/**
 * Query a cached context
 */
export async function handleContextQuery(
  deps: ToolHandlerDeps,
  rawInput: unknown
): Promise<QueryResult> {
  const input = contextQuerySchema.parse(rawInput);
  const { geminiClient, storage } = deps;

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

  // Query the cache
  const result = await geminiClient.queryCache(cache.name, input.query, {
    maxOutputTokens: input.maxTokens,
    temperature: input.temperature,
  });

  return result;
}

/**
 * List all active caches
 */
export async function handleContextList(
  deps: ToolHandlerDeps
): Promise<{ caches: Array<{ alias: string; tokenCount: number; expiresAt: string; source: string }> }> {
  const { storage } = deps;
  const caches = await storage.list();

  return {
    caches: caches.map((c) => ({
      alias: c.alias,
      tokenCount: c.tokenCount,
      expiresAt: c.expiresAt.toISOString(),
      source: c.source,
    })),
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
  caches?: Array<{ alias: string; tokenCount: number; queriesCount?: number }>;
}> {
  const input = contextStatsSchema.parse(rawInput);
  const { storage } = deps;

  const allCaches = await storage.list();

  if (input.alias) {
    // Stats for specific cache
    const cache = allCaches.find((c) => c.alias === input.alias);
    if (!cache) {
      throw new CacheNotFoundError(input.alias);
    }
    return {
      totalCaches: 1,
      totalTokens: cache.tokenCount,
      caches: [{ alias: cache.alias, tokenCount: cache.tokenCount }],
    };
  }

  // Global stats
  const totalTokens = allCaches.reduce((sum, c) => sum + c.tokenCount, 0);

  return {
    totalCaches: allCaches.length,
    totalTokens,
    caches: allCaches.map((c) => ({
      alias: c.alias,
      tokenCount: c.tokenCount,
    })),
  };
}
