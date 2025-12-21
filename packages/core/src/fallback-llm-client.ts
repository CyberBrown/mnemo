import type { CacheMetadata, QueryResult, QueryOptions } from './types';
import type {
  LLMClient,
  CacheCreateOptions,
  FallbackPermissionCallback,
  FallbackReason,
} from './llm-client';
import { FallbackDeniedError, LocalLLMError } from './llm-client';

export interface FallbackLLMClientConfig {
  /** Primary LLM client (local model) */
  primary: LLMClient;
  /** Fallback LLM client (Gemini) */
  fallback: LLMClient;
  /**
   * Callback to request permission for fallback
   * If not provided, fallback is always allowed
   */
  onFallbackNeeded?: FallbackPermissionCallback;
  /**
   * Whether to auto-fallback for context that's too large
   * Default: true (will still call permission callback)
   */
  autoFallbackForLargeContext?: boolean;
}

/**
 * LLM Client that tries a primary (local) model first,
 * then falls back to a secondary (Gemini) model with permission
 */
export class FallbackLLMClient implements LLMClient {
  readonly provider: string;
  readonly model: string;
  readonly maxContextTokens: number;

  private primary: LLMClient;
  private fallback: LLMClient;
  private onFallbackNeeded?: FallbackPermissionCallback;
  private autoFallbackForLargeContext: boolean;

  // Track which caches were created with which provider
  private cacheProviderMap = new Map<string, 'primary' | 'fallback'>();

  constructor(config: FallbackLLMClientConfig) {
    this.primary = config.primary;
    this.fallback = config.fallback;
    this.onFallbackNeeded = config.onFallbackNeeded;
    this.autoFallbackForLargeContext = config.autoFallbackForLargeContext ?? true;

    // Report as primary model with fallback capability
    this.provider = `${this.primary.provider}+${this.fallback.provider}`;
    this.model = this.primary.model;
    this.maxContextTokens = this.fallback.maxContextTokens; // Use higher limit
  }

  /**
   * Request permission to use fallback
   * Returns true if permission granted or no callback configured
   */
  private async requestFallbackPermission(reason: FallbackReason, details?: string): Promise<boolean> {
    if (!this.onFallbackNeeded) {
      return true; // No callback = always allow
    }

    return this.onFallbackNeeded({
      reason,
      localModel: this.primary.model,
      fallbackModel: this.fallback.model,
      details,
    });
  }

  /**
   * Create a cache, using primary or fallback based on content size
   */
  async createCache(
    content: string,
    alias: string,
    options: CacheCreateOptions = {}
  ): Promise<CacheMetadata> {
    const estimatedTokens = this.primary.estimateTokens(content);

    // Check if content fits in primary model's context
    const primaryLimit = this.primary.maxContextTokens * 0.9; // 90% to leave room for queries
    if (estimatedTokens > primaryLimit) {
      // Content too large for primary
      if (!this.autoFallbackForLargeContext) {
        throw new LocalLLMError(
          `Content too large for local model (${estimatedTokens} tokens > ${primaryLimit} limit)`,
          { estimatedTokens, limit: primaryLimit }
        );
      }

      // Request permission to use fallback
      const permitted = await this.requestFallbackPermission(
        'context_too_large',
        `Content has ~${estimatedTokens} tokens, exceeds local model limit of ${primaryLimit}. Gemini can handle up to ${this.fallback.maxContextTokens} tokens.`
      );

      if (!permitted) {
        throw new FallbackDeniedError('context_too_large');
      }

      // Use fallback for large context
      const metadata = await this.fallback.createCache(content, alias, options);
      this.cacheProviderMap.set(metadata.name, 'fallback');
      return metadata;
    }

    // Check if primary is available
    const primaryAvailable = await this.primary.isAvailable();
    if (!primaryAvailable) {
      const permitted = await this.requestFallbackPermission(
        'local_unavailable',
        `Local model at ${this.primary.provider} is not responding`
      );

      if (!permitted) {
        throw new FallbackDeniedError('local_unavailable');
      }

      const metadata = await this.fallback.createCache(content, alias, options);
      this.cacheProviderMap.set(metadata.name, 'fallback');
      return metadata;
    }

    // Try primary
    try {
      const metadata = await this.primary.createCache(content, alias, options);
      this.cacheProviderMap.set(metadata.name, 'primary');
      return metadata;
    } catch (error) {
      // Primary failed, request fallback permission
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const permitted = await this.requestFallbackPermission(
        'local_error',
        `Local model error: ${errorMessage}`
      );

      if (!permitted) {
        throw new FallbackDeniedError('local_error');
      }

      const metadata = await this.fallback.createCache(content, alias, options);
      this.cacheProviderMap.set(metadata.name, 'fallback');
      return metadata;
    }
  }

  /**
   * Query a cache using the appropriate provider
   */
  async queryCache(
    cacheName: string,
    query: string,
    options: QueryOptions = {}
  ): Promise<QueryResult> {
    // Determine which provider created this cache
    const provider = this.cacheProviderMap.get(cacheName);

    // If we know the provider, use it directly
    if (provider === 'fallback') {
      return this.fallback.queryCache(cacheName, query, options);
    }

    if (provider === 'primary') {
      try {
        return await this.primary.queryCache(cacheName, query, options);
      } catch (error) {
        // Primary query failed, request fallback permission
        // Note: Can't fallback for queries since cache is provider-specific
        throw error;
      }
    }

    // Unknown cache - try primary first (might be from previous session)
    // Check cache name prefix to determine provider
    if (cacheName.startsWith('local:')) {
      return this.primary.queryCache(cacheName, query, options);
    }

    // Assume Gemini cache format
    return this.fallback.queryCache(cacheName, query, options);
  }

  /**
   * Delete a cache from the appropriate provider
   */
  async deleteCache(cacheName: string): Promise<void> {
    const provider = this.cacheProviderMap.get(cacheName);

    if (provider === 'fallback' || !cacheName.startsWith('local:')) {
      await this.fallback.deleteCache(cacheName);
    } else {
      await this.primary.deleteCache(cacheName);
    }

    this.cacheProviderMap.delete(cacheName);
  }

  /**
   * Estimate tokens using primary model's estimation
   */
  estimateTokens(content: string): number {
    return this.primary.estimateTokens(content);
  }

  /**
   * Check if either primary or fallback is available
   */
  async isAvailable(): Promise<boolean> {
    const [primaryAvailable, fallbackAvailable] = await Promise.all([
      this.primary.isAvailable(),
      this.fallback.isAvailable(),
    ]);
    return primaryAvailable || fallbackAvailable;
  }

  /**
   * Query without a cache (for RAG-style queries)
   * Uses primary model with fallback on error
   */
  async query(
    query: string,
    options: QueryOptions & { systemInstruction?: string; context?: string } = {}
  ): Promise<QueryResult> {
    // Check if primary is available
    const primaryAvailable = await this.primary.isAvailable();
    if (!primaryAvailable) {
      const permitted = await this.requestFallbackPermission(
        'local_unavailable',
        'Local model not responding for RAG query'
      );
      if (!permitted) {
        throw new FallbackDeniedError('local_unavailable');
      }
      return this.fallback.query(query, options);
    }

    // Try primary
    try {
      return await this.primary.query(query, options);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const permitted = await this.requestFallbackPermission(
        'local_error',
        `RAG query error: ${errorMessage}`
      );
      if (!permitted) {
        throw new FallbackDeniedError('local_error');
      }
      return this.fallback.query(query, options);
    }
  }

  /**
   * Get status of both providers
   */
  async getProviderStatus(): Promise<{
    primary: { available: boolean; model: string; maxTokens: number };
    fallback: { available: boolean; model: string; maxTokens: number };
  }> {
    const [primaryAvailable, fallbackAvailable] = await Promise.all([
      this.primary.isAvailable(),
      this.fallback.isAvailable(),
    ]);

    return {
      primary: {
        available: primaryAvailable,
        model: this.primary.model,
        maxTokens: this.primary.maxContextTokens,
      },
      fallback: {
        available: fallbackAvailable,
        model: this.fallback.model,
        maxTokens: this.fallback.maxContextTokens,
      },
    };
  }
}
