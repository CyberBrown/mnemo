/**
 * Tiered Query Handler
 *
 * Implements a two-tier RAG strategy:
 * 1. Layer 1: CF AI Search → Nemotron synthesis (fast, cheap)
 * 2. Layer 2: Full context load via FallbackLLMClient (slower, more capable)
 *
 * The goal is to minimize expensive Gemini calls by using:
 * - AI Search for relevant chunk retrieval (auto-indexed from R2)
 * - Nemotron for synthesis when RAG confidence is high
 * - Only escalate to full context when RAG can't answer confidently
 */

import { z } from 'zod';
import type { AISearchClient, AISearchResult, AISearchChunk } from './ai-search-client';
import type { LLMClient } from './llm-client';
import type { QueryResult } from './types';

// ============================================================================
// Types
// ============================================================================

export const TieredQueryOptionsSchema = z.object({
  /** Confidence threshold for RAG (0-1, default 0.7) */
  confidenceThreshold: z.number().min(0).max(1).optional(),
  /** Force full context load (skip RAG) */
  forceFullContext: z.boolean().optional(),
  /** Max chunks to retrieve for RAG */
  maxRagChunks: z.number().min(1).max(50).optional(),
  /** Max tokens in response */
  maxOutputTokens: z.number().optional(),
  /** Temperature for generation */
  temperature: z.number().min(0).max(2).optional(),
  /** System prompt for RAG synthesis */
  systemPrompt: z.string().optional(),
});

export type TieredQueryOptions = z.infer<typeof TieredQueryOptionsSchema>;

export const TieredQueryResultSchema = z.object({
  /** The response text */
  response: z.string(),
  /** Which tier handled the query */
  source: z.enum(['rag', 'context', 'fallback']),
  /** Model used for synthesis */
  model: z.string(),
  /** RAG confidence (if applicable) */
  ragConfidence: z.number().optional(),
  /** Chunks used for RAG (if applicable) */
  ragChunks: z.number().optional(),
  /** Total tokens used */
  tokensUsed: z.number(),
  /** Cached tokens used (for full context) */
  cachedTokensUsed: z.number().optional(),
});

export type TieredQueryResult = z.infer<typeof TieredQueryResultSchema>;

// ============================================================================
// Tiered Query Handler
// ============================================================================

export interface TieredQueryConfig {
  /** AI Search client for Layer 1 */
  aiSearch: AISearchClient;
  /** LLM client for Layer 2 (FallbackLLMClient or similar) */
  llmClient: LLMClient;
  /** Nemotron endpoint URL for RAG synthesis */
  localModelUrl: string;
  /** Nemotron model name */
  localModelName?: string;
  /** Default confidence threshold */
  defaultConfidenceThreshold?: number;
  /** Request timeout in ms */
  timeout?: number;
}

/**
 * TieredQueryHandler implements a two-tier RAG strategy:
 *
 * ```
 * Query
 *   │
 *   ▼
 * ┌─────────────────────────────┐
 * │ Layer 1: CF AI Search       │
 * │ - Returns ranked chunks     │
 * │ - Calculates confidence     │
 * └─────────────────────────────┘
 *   │
 *   ├── Confidence >= threshold?
 *   │   │
 *   │   YES → Synthesize with Nemotron → Return (source: 'rag')
 *   │
 *   └── NO → Escalate to Layer 2
 *             │
 *             ▼
 *       ┌─────────────────────────────┐
 *       │ Layer 2: Full Context Load  │
 *       │ - Primary: Nemotron         │
 *       │ - Fallback: Gemini          │
 *       └─────────────────────────────┘
 *             │
 *             ▼
 *       Return (source: 'context' or 'fallback')
 * ```
 */
export class TieredQueryHandler {
  private aiSearch: AISearchClient;
  private llmClient: LLMClient;
  private localModelUrl: string;
  private localModelName: string;
  private defaultConfidenceThreshold: number;
  private timeout: number;

  constructor(config: TieredQueryConfig) {
    this.aiSearch = config.aiSearch;
    this.llmClient = config.llmClient;
    this.localModelUrl = config.localModelUrl;
    this.localModelName = config.localModelName ?? 'nemotron-3-nano';
    this.defaultConfidenceThreshold = config.defaultConfidenceThreshold ?? 0.7;
    this.timeout = config.timeout ?? 120000;
  }

  /**
   * Query with tiered RAG strategy
   * @param alias Cache alias (used as folder scope in AI Search)
   * @param query Natural language query
   * @param options Query options
   */
  async query(
    alias: string,
    query: string,
    options: TieredQueryOptions = {}
  ): Promise<TieredQueryResult> {
    const {
      confidenceThreshold = this.defaultConfidenceThreshold,
      forceFullContext = false,
      maxRagChunks = 10,
      maxOutputTokens = 2000,
      temperature = 0.3,
      systemPrompt,
    } = options;

    // Skip RAG if forced to full context
    if (forceFullContext) {
      return this.queryFullContext(alias, query, { maxOutputTokens, temperature });
    }

    // Layer 1: Try AI Search RAG
    try {
      const ragResult = await this.aiSearch.search(query, {
        folder: alias,
        maxResults: maxRagChunks,
        rewriteQuery: true,
        reranking: true,
      });

      // Check if we have confident results
      if (ragResult.confidence >= confidenceThreshold && ragResult.chunks.length > 0) {
        // Synthesize with Nemotron (fast, cheap)
        const response = await this.synthesizeWithNemotron(
          query,
          ragResult.chunks,
          { maxOutputTokens, temperature, systemPrompt }
        );

        return {
          response,
          source: 'rag',
          model: this.localModelName,
          ragConfidence: ragResult.confidence,
          ragChunks: ragResult.chunks.length,
          tokensUsed: this.estimateTokens(ragResult.chunks, response),
        };
      }

      // Confidence too low, escalate to Layer 2
      console.log(
        `RAG confidence ${ragResult.confidence.toFixed(2)} < ${confidenceThreshold}, escalating to full context`
      );
    } catch (error) {
      // AI Search unavailable, fall through to Layer 2
      console.warn('AI Search unavailable, falling back to full context:', error);
    }

    // Layer 2: Full context load
    return this.queryFullContext(alias, query, { maxOutputTokens, temperature });
  }

  /**
   * Synthesize response from RAG chunks using Nemotron
   */
  private async synthesizeWithNemotron(
    query: string,
    chunks: AISearchChunk[],
    options: { maxOutputTokens?: number; temperature?: number; systemPrompt?: string }
  ): Promise<string> {
    // Build context from chunks
    const context = chunks
      .map((chunk, i) => `[Source ${i + 1}: ${chunk.filename}]\n${chunk.content}`)
      .join('\n\n---\n\n');

    const systemMessage = options.systemPrompt ??
      `You are a helpful assistant answering questions based on the provided context.
Be concise, accurate, and cite sources when relevant.
If the context doesn't contain enough information to answer fully, say so.`;

    const userMessage = `Context:
${context}

Question: ${query}

Answer based on the context above:`;

    const response = await fetch(`${this.localModelUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.localModelName,
        messages: [
          { role: 'system', content: systemMessage },
          { role: 'user', content: userMessage },
        ],
        max_tokens: options.maxOutputTokens ?? 2000,
        temperature: options.temperature ?? 0.3,
      }),
      signal: AbortSignal.timeout(this.timeout),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Nemotron synthesis failed: ${response.status} - ${error}`);
    }

    const data = await response.json() as {
      choices: Array<{
        message: {
          content?: string;
          reasoning_content?: string;
        };
      }>;
    };

    // Handle Nemotron's response format (may use reasoning_content)
    const message = data.choices[0]?.message;
    return message?.content ?? message?.reasoning_content ?? '';
  }

  /**
   * Query using full context load (Layer 2)
   */
  private async queryFullContext(
    alias: string,
    query: string,
    options: { maxOutputTokens?: number; temperature?: number }
  ): Promise<TieredQueryResult> {
    const result = await this.llmClient.queryCache(alias, query, {
      maxOutputTokens: options.maxOutputTokens,
      temperature: options.temperature,
    });

    // Determine source based on model used
    const source = this.isGeminiModel(result.model) ? 'fallback' : 'context';

    return {
      response: result.response,
      source,
      model: result.model,
      tokensUsed: result.tokensUsed,
      cachedTokensUsed: result.cachedTokensUsed,
    };
  }

  /**
   * Check if model is a Gemini model (indicates fallback was used)
   */
  private isGeminiModel(model: string): boolean {
    return model.toLowerCase().includes('gemini');
  }

  /**
   * Estimate tokens used for RAG query
   */
  private estimateTokens(chunks: AISearchChunk[], response: string): number {
    // Rough estimate: 4 chars = 1 token
    const contextTokens = chunks.reduce(
      (sum, chunk) => sum + Math.ceil(chunk.content.length / 4),
      0
    );
    const responseTokens = Math.ceil(response.length / 4);
    return contextTokens + responseTokens;
  }

  /**
   * Check if AI Search is available for this handler
   */
  async isAISearchAvailable(): Promise<boolean> {
    return this.aiSearch.isAvailable();
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a TieredQueryHandler with default configuration
 */
export function createTieredQueryHandler(
  aiSearch: AISearchClient,
  llmClient: LLMClient,
  localModelUrl: string,
  options?: Partial<TieredQueryConfig>
): TieredQueryHandler {
  return new TieredQueryHandler({
    aiSearch,
    llmClient,
    localModelUrl,
    ...options,
  });
}
