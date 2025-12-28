import type { LLMClient, CacheCreateOptions } from './llm-client';
import type { CacheMetadata, QueryResult, QueryOptions } from './types';
import { MnemoError } from './types';

/**
 * Configuration for the async query client
 */
export interface AsyncQueryConfig {
  /** Base URL for the async query API (e.g., https://mnemo.solamp.workers.dev) */
  baseUrl: string;
  /** Polling interval in milliseconds (default: 1500ms) */
  pollIntervalMs?: number;
  /** Maximum time to wait for result in milliseconds (default: 300000ms = 5 minutes) */
  maxWaitMs?: number;
  /** Optional auth token */
  authToken?: string;
}

/**
 * Response from POST /query/async
 */
interface AsyncSubmitResponse {
  jobId: string;
  status: 'pending';
  statusUrl: string;
}

/**
 * Response from GET /query/status/:jobId
 */
interface AsyncStatusResponse {
  jobId: string;
  status: 'pending' | 'processing' | 'complete' | 'failed';
  createdAt: string;
  updatedAt: string;
  result?: QueryResult & { timing?: unknown };
  error?: string;
}

/**
 * An LLMClient wrapper that uses async HTTP polling for queries.
 * Wraps any LLMClient and overrides queryCache to use the async workflow,
 * avoiding timeouts on large context queries.
 */
export class AsyncLLMClient implements LLMClient {
  private wrapped: LLMClient;
  private config: Required<AsyncQueryConfig>;

  constructor(wrapped: LLMClient, config: AsyncQueryConfig) {
    this.wrapped = wrapped;
    this.config = {
      baseUrl: config.baseUrl.replace(/\/$/, ''), // Remove trailing slash
      pollIntervalMs: config.pollIntervalMs ?? 1500,
      maxWaitMs: config.maxWaitMs ?? 300000, // 5 minutes default
      authToken: config.authToken ?? '',
    };
  }

  // Delegate properties to wrapped client
  get provider(): string {
    return this.wrapped.provider;
  }

  get model(): string {
    return this.wrapped.model;
  }

  get maxContextTokens(): number {
    return this.wrapped.maxContextTokens;
  }

  // Delegate non-query methods to wrapped client
  createCache(
    content: string,
    alias: string,
    options?: CacheCreateOptions
  ): Promise<CacheMetadata> {
    return this.wrapped.createCache(content, alias, options);
  }

  deleteCache(cacheName: string): Promise<void> {
    return this.wrapped.deleteCache(cacheName);
  }

  estimateTokens(content: string): number {
    return this.wrapped.estimateTokens(content);
  }

  isAvailable(): Promise<boolean> {
    return this.wrapped.isAvailable();
  }

  /**
   * Query without a cache (for RAG-style queries with custom context)
   * Delegates to wrapped client
   */
  query(
    query: string,
    options?: QueryOptions & { systemInstruction?: string; context?: string }
  ): Promise<QueryResult> {
    return this.wrapped.query(query, options);
  }

  /**
   * Query cache using async HTTP polling
   * This avoids timeouts on large context queries by:
   * 1. Submitting the query to POST /query/async
   * 2. Polling GET /query/status/:jobId until complete/failed
   */
  async queryCache(
    cacheNameOrAlias: string,
    query: string,
    options?: QueryOptions
  ): Promise<QueryResult> {
    const startTime = Date.now();

    // Submit async query
    const submitResponse = await this.submitAsyncQuery(cacheNameOrAlias, query, options);
    const { jobId } = submitResponse;

    // Poll for result
    while (Date.now() - startTime < this.config.maxWaitMs) {
      const status = await this.checkJobStatus(jobId);

      switch (status.status) {
        case 'complete':
          if (!status.result) {
            throw new AsyncQueryError('Job completed but no result returned', { jobId });
          }
          // Return the result, stripping timing info if present (we add our own in handler)
          return {
            response: status.result.response,
            tokensUsed: status.result.tokensUsed,
            cachedTokensUsed: status.result.cachedTokensUsed,
            model: status.result.model,
          };

        case 'failed':
          throw new AsyncQueryError(status.error ?? 'Query failed', { jobId });

        case 'pending':
        case 'processing':
          // Wait before polling again
          await this.sleep(this.config.pollIntervalMs);
          break;
      }
    }

    throw new AsyncQueryError('Query timed out waiting for result', {
      jobId,
      maxWaitMs: this.config.maxWaitMs,
      elapsedMs: Date.now() - startTime,
    });
  }

  /**
   * Submit an async query
   */
  private async submitAsyncQuery(
    alias: string,
    query: string,
    options?: QueryOptions
  ): Promise<AsyncSubmitResponse> {
    const url = `${this.config.baseUrl}/query/async`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.config.authToken) {
      headers['Authorization'] = `Bearer ${this.config.authToken}`;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        alias,
        query,
        maxTokens: options?.maxOutputTokens,
        temperature: options?.temperature,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new AsyncQueryError(`Failed to submit async query: ${response.status}`, {
        status: response.status,
        body: errorText,
      });
    }

    return response.json() as Promise<AsyncSubmitResponse>;
  }

  /**
   * Check job status
   */
  private async checkJobStatus(jobId: string): Promise<AsyncStatusResponse> {
    const url = `${this.config.baseUrl}/query/status/${jobId}`;
    const headers: Record<string, string> = {};

    if (this.config.authToken) {
      headers['Authorization'] = `Bearer ${this.config.authToken}`;
    }

    const response = await fetch(url, { headers });

    if (!response.ok) {
      const errorText = await response.text();
      throw new AsyncQueryError(`Failed to check job status: ${response.status}`, {
        jobId,
        status: response.status,
        body: errorText,
      });
    }

    return response.json() as Promise<AsyncStatusResponse>;
  }

  /**
   * Sleep for a specified duration
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Error type for async query failures
 */
export class AsyncQueryError extends MnemoError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'ASYNC_QUERY_ERROR', details);
    this.name = 'AsyncQueryError';
  }
}
