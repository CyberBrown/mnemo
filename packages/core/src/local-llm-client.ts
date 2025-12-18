import type { CacheMetadata, QueryResult, QueryOptions } from './types';
import { MnemoError } from './types';
import type { LLMClient, CacheCreateOptions, LocalLLMConfig } from './llm-client';
import { LocalLLMError } from './llm-client';

/**
 * Interface for storing cached context content
 * Required because local models don't have native caching like Gemini
 */
export interface ContentStore {
  /** Store content with a key */
  set(key: string, content: string, ttl?: number): Promise<void>;
  /** Retrieve content by key */
  get(key: string): Promise<string | null>;
  /** Delete content by key */
  delete(key: string): Promise<boolean>;
}

/**
 * Simple in-memory content store (for local server)
 */
export class InMemoryContentStore implements ContentStore {
  private store = new Map<string, { content: string; expiresAt: number }>();

  async set(key: string, content: string, ttl = 3600): Promise<void> {
    this.store.set(key, {
      content,
      expiresAt: Date.now() + ttl * 1000,
    });
  }

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.content;
  }

  async delete(key: string): Promise<boolean> {
    return this.store.delete(key);
  }
}

// OpenAI-compatible API types
interface ChatCompletionRequest {
  model: string;
  messages: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string;
  }>;
  max_tokens?: number;
  temperature?: number;
  stop?: string[];
}

interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * LLM Client for local models via OpenAI-compatible API (vLLM, Ollama, etc.)
 *
 * Unlike Gemini, local models don't have native context caching.
 * We store context in a ContentStore and send it with each query.
 */
export class LocalLLMClient implements LLMClient {
  readonly provider = 'local';
  readonly model: string;
  readonly maxContextTokens: number;

  private config: LocalLLMConfig;
  private contentStore: ContentStore;

  constructor(config: LocalLLMConfig, contentStore?: ContentStore) {
    this.config = config;
    this.model = config.model;
    this.maxContextTokens = config.maxContextTokens;
    this.contentStore = contentStore ?? new InMemoryContentStore();
  }

  /**
   * Create a "cache" by storing content locally
   * Returns a local cache ID (not a Gemini cache name)
   */
  async createCache(
    content: string,
    alias: string,
    options: CacheCreateOptions = {}
  ): Promise<CacheMetadata> {
    const ttl = options.ttl ?? 3600;
    const tokenCount = this.estimateTokens(content);

    // Check if content fits in context window
    if (tokenCount > this.maxContextTokens * 0.9) {
      throw new LocalLLMError(
        `Content too large for local model: ${tokenCount} tokens exceeds ${Math.floor(this.maxContextTokens * 0.9)} limit`,
        { tokenCount, limit: this.maxContextTokens }
      );
    }

    // Generate a local cache ID
    const cacheId = `local:${alias}:${Date.now()}`;

    // Store the content with optional system instruction prepended
    const storedContent = options.systemInstruction
      ? `<system>\n${options.systemInstruction}\n</system>\n\n${content}`
      : content;

    await this.contentStore.set(cacheId, storedContent, ttl);

    const now = new Date();
    return {
      name: cacheId,
      alias,
      tokenCount,
      createdAt: now,
      expiresAt: new Date(now.getTime() + ttl * 1000),
      source: alias,
      model: this.model,
    };
  }

  /**
   * Query using cached context
   * Retrieves stored content and sends it with the query
   */
  async queryCache(
    cacheName: string,
    query: string,
    options: QueryOptions = {}
  ): Promise<QueryResult> {
    // Retrieve stored content
    const cachedContent = await this.contentStore.get(cacheName);
    if (!cachedContent) {
      throw new MnemoError(
        `Local cache not found or expired: ${cacheName}`,
        'CACHE_NOT_FOUND',
        { cacheName }
      );
    }

    // Build messages for the chat completion
    const messages: ChatCompletionRequest['messages'] = [
      {
        role: 'system',
        content: `You are a helpful assistant. The user has provided the following context for you to reference:\n\n${cachedContent}`,
      },
      {
        role: 'user',
        content: query,
      },
    ];

    const requestBody: ChatCompletionRequest = {
      model: this.model,
      messages,
      max_tokens: options.maxOutputTokens ?? 4096,
      temperature: options.temperature ?? 0.7,
      stop: options.stopSequences,
    };

    try {
      const response = await fetch(`${this.config.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.apiKey && { Authorization: `Bearer ${this.config.apiKey}` }),
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(this.config.timeout),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new LocalLLMError(
          `Local LLM API error: ${response.status} ${response.statusText}`,
          { status: response.status, error: errorText }
        );
      }

      const data: ChatCompletionResponse = await response.json();

      const responseText = data.choices[0]?.message?.content ?? '';
      const promptTokens = data.usage?.prompt_tokens ?? this.estimateTokens(cachedContent + query);
      const completionTokens = data.usage?.completion_tokens ?? this.estimateTokens(responseText);

      return {
        response: responseText,
        tokensUsed: promptTokens + completionTokens,
        cachedTokensUsed: this.estimateTokens(cachedContent), // All context tokens are "cached" (stored locally)
        model: this.model,
      };
    } catch (error) {
      if (error instanceof LocalLLMError) throw error;
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new LocalLLMError('Local LLM request timed out', {
          timeout: this.config.timeout,
        });
      }
      throw new LocalLLMError(
        `Local LLM request failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        { error: String(error) }
      );
    }
  }

  /**
   * Delete cached content
   */
  async deleteCache(cacheName: string): Promise<void> {
    const deleted = await this.contentStore.delete(cacheName);
    if (!deleted) {
      throw new MnemoError(
        `Local cache not found: ${cacheName}`,
        'CACHE_NOT_FOUND',
        { cacheName }
      );
    }
  }

  /**
   * Estimate token count for content
   * Uses rough approximation: ~3.5 characters per token for code/mixed content
   */
  estimateTokens(content: string): number {
    return Math.ceil(content.length / 3.5);
  }

  /**
   * Check if local LLM is available
   */
  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.baseUrl}/v1/models`, {
        method: 'GET',
        headers: {
          ...(this.config.apiKey && { Authorization: `Bearer ${this.config.apiKey}` }),
        },
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Query without using cache (direct query with context in request)
   * Useful for one-off queries or when cache isn't needed
   */
  async queryDirect(
    context: string,
    query: string,
    options: QueryOptions & { systemInstruction?: string } = {}
  ): Promise<QueryResult> {
    const messages: ChatCompletionRequest['messages'] = [];

    // Add system instruction if provided
    if (options.systemInstruction) {
      messages.push({
        role: 'system',
        content: options.systemInstruction,
      });
    }

    // Add context and query
    messages.push({
      role: 'user',
      content: context ? `Context:\n${context}\n\nQuestion: ${query}` : query,
    });

    const requestBody: ChatCompletionRequest = {
      model: this.model,
      messages,
      max_tokens: options.maxOutputTokens ?? 4096,
      temperature: options.temperature ?? 0.7,
      stop: options.stopSequences,
    };

    try {
      const response = await fetch(`${this.config.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.apiKey && { Authorization: `Bearer ${this.config.apiKey}` }),
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(this.config.timeout),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new LocalLLMError(
          `Local LLM API error: ${response.status} ${response.statusText}`,
          { status: response.status, error: errorText }
        );
      }

      const data: ChatCompletionResponse = await response.json();

      const responseText = data.choices[0]?.message?.content ?? '';
      const promptTokens = data.usage?.prompt_tokens ?? this.estimateTokens(context + query);
      const completionTokens = data.usage?.completion_tokens ?? this.estimateTokens(responseText);

      return {
        response: responseText,
        tokensUsed: promptTokens + completionTokens,
        cachedTokensUsed: 0, // No caching for direct queries
        model: this.model,
      };
    } catch (error) {
      if (error instanceof LocalLLMError) throw error;
      throw new LocalLLMError(
        `Local LLM request failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        { error: String(error) }
      );
    }
  }
}
