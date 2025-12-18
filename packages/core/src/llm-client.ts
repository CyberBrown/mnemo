import { z } from 'zod';
import type { CacheMetadata, QueryResult, QueryOptions } from './types';
import { MnemoError } from './types';

// ============================================================================
// LLM Client Interface
// ============================================================================

/**
 * Abstract interface for LLM providers (Gemini, local models, etc.)
 * Provides a unified API for context caching and querying
 */
export interface LLMClient {
  /** Provider name (e.g., 'gemini', 'local', 'nemotron') */
  readonly provider: string;

  /** Model name being used */
  readonly model: string;

  /** Maximum context window size in tokens */
  readonly maxContextTokens: number;

  /**
   * Create a new context cache
   * @param content - The content to cache
   * @param alias - User-friendly name for this cache
   * @param options - Cache options
   * @returns Cache metadata
   */
  createCache(
    content: string,
    alias: string,
    options?: CacheCreateOptions
  ): Promise<CacheMetadata>;

  /**
   * Query a cached context
   * @param cacheNameOrContent - Cache identifier or raw content (provider-specific)
   * @param query - The question or instruction
   * @param options - Query options
   * @returns Query result with response and token usage
   */
  queryCache(
    cacheNameOrContent: string,
    query: string,
    options?: QueryOptions
  ): Promise<QueryResult>;

  /**
   * Delete a cache
   * @param cacheName - Cache identifier
   */
  deleteCache(cacheName: string): Promise<void>;

  /**
   * Estimate token count for content
   */
  estimateTokens(content: string): number;

  /**
   * Check if provider is available/healthy
   */
  isAvailable(): Promise<boolean>;
}

export interface CacheCreateOptions {
  ttl?: number;
  systemInstruction?: string;
  model?: string;
}

// ============================================================================
// Local LLM Configuration
// ============================================================================

export const LocalLLMConfigSchema = z.object({
  /** Base URL for the local LLM API (e.g., http://localhost:8000) */
  baseUrl: z.string().url(),
  /** Model name/ID to use */
  model: z.string(),
  /** API key if required */
  apiKey: z.string().optional(),
  /** Maximum context window tokens */
  maxContextTokens: z.number().default(131072), // 131K for Nemotron
  /** Request timeout in ms */
  timeout: z.number().default(120000), // 2 minutes
});

export type LocalLLMConfig = z.infer<typeof LocalLLMConfigSchema>;

// ============================================================================
// Model Pricing (for cost estimation)
// ============================================================================

export const MODEL_PRICING: Record<string, { input: number; cachedInput: number; output: number }> = {
  // Gemini pricing
  'gemini-2.0-flash-001': {
    input: 0.10,
    cachedInput: 0.025,
    output: 0.40,
  },
  // Local models are essentially free (electricity cost negligible)
  'local': {
    input: 0,
    cachedInput: 0,
    output: 0,
  },
  'nemotron-3-nano': {
    input: 0,
    cachedInput: 0,
    output: 0,
  },
  default: {
    input: 0.10,
    cachedInput: 0.025,
    output: 0.40,
  },
};

/**
 * Calculate cost for a given model
 */
export function calculateModelCost(
  tokensUsed: number,
  cachedTokensUsed: number,
  model: string
): number {
  const pricing = MODEL_PRICING[model] ?? MODEL_PRICING.default;
  const regularTokens = tokensUsed - cachedTokensUsed;
  const cost =
    (regularTokens / 1_000_000) * pricing.input +
    (cachedTokensUsed / 1_000_000) * pricing.cachedInput;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

// ============================================================================
// Fallback Strategy
// ============================================================================

export type FallbackReason =
  | 'local_unavailable'
  | 'context_too_large'
  | 'local_error'
  | 'timeout';

export interface FallbackEvent {
  reason: FallbackReason;
  localModel: string;
  fallbackModel: string;
  details?: string;
}

/**
 * Callback for when fallback to Gemini is needed
 * Return true to allow fallback, false to reject
 */
export type FallbackPermissionCallback = (event: FallbackEvent) => Promise<boolean>;

// ============================================================================
// Error Types
// ============================================================================

export class LocalLLMError extends MnemoError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'LOCAL_LLM_ERROR', details);
    this.name = 'LocalLLMError';
  }
}

export class FallbackDeniedError extends MnemoError {
  constructor(reason: FallbackReason) {
    super(
      `Fallback to Gemini was denied. Reason: ${reason}`,
      'FALLBACK_DENIED',
      { reason }
    );
    this.name = 'FallbackDeniedError';
  }
}
