import { z } from 'zod';
import type { MCPToolDefinition } from '../protocol';

// ============================================================================
// Tool Input Schemas
// ============================================================================

export const contextLoadSchema = z.object({
  source: z.string().optional().describe('Path to local directory, file, or GitHub URL to load'),
  sources: z.array(z.string()).optional().describe('Multiple sources to load into a single cache'),
  alias: z.string().min(1).max(64).describe('Friendly name for this cache'),
  // TTL: Default 1 hour (3600s) for Gemini compatibility.
  // With local Nemotron (no Gemini 1-hour minimum billing), we can use much longer TTLs.
  // Future: Consider 24h+ TTLs (604800 = 1 week) when running purely on local models.
  ttl: z.number().min(60).max(604800).optional().describe('Time to live in seconds (default: 3600, max: 604800/1 week)'),
  systemInstruction: z.string().optional().describe('System instruction for queries against this cache'),
  githubToken: z.string().optional().describe('GitHub personal access token for private repositories'),
  passphrase: z.string().optional().describe('Passphrase for write operations (required when WRITE_PASSPHRASE is configured)'),
}).refine(
  (data) => data.source || (data.sources && data.sources.length > 0),
  { message: 'Either source or sources must be provided' }
);

export type ContextLoadInput = z.infer<typeof contextLoadSchema>;

export const contextQuerySchema = z.object({
  alias: z.string().describe('Cache alias to query'),
  query: z.string().describe('Question or instruction'),
  maxTokens: z.number().default(1024).describe('Maximum tokens in response (default: 1024)'),
  temperature: z.number().min(0).max(2).optional().describe('Temperature for generation'),
  forceFullContext: z.boolean().optional().describe('Skip RAG/AI Search and force full context load (slower but more comprehensive)'),
});

export type ContextQueryInput = z.infer<typeof contextQuerySchema>;

export const contextListSchema = z.object({}).describe('No parameters required');

export type ContextListInput = z.infer<typeof contextListSchema>;

export const contextEvictSchema = z.object({
  alias: z.string().describe('Cache alias to evict'),
  passphrase: z.string().optional().describe('Passphrase for write operations (required when WRITE_PASSPHRASE is configured)'),
});

export type ContextEvictInput = z.infer<typeof contextEvictSchema>;

export const contextStatsSchema = z.object({
  alias: z.string().optional().describe('Cache alias (omit for global stats)'),
});

export type ContextStatsInput = z.infer<typeof contextStatsSchema>;

export const contextRefreshSchema = z.object({
  alias: z.string().describe('Cache alias to refresh'),
  // TTL: See contextLoadSchema for notes on extended TTLs with local models
  ttl: z.number().min(60).max(604800).optional().describe('New time to live in seconds (optional, uses previous TTL if not specified, max: 604800/1 week)'),
  systemInstruction: z.string().optional().describe('System instruction for queries (optional, uses previous instruction if not specified)'),
  githubToken: z.string().optional().describe('GitHub personal access token for private repositories'),
  passphrase: z.string().optional().describe('Passphrase for write operations (required when WRITE_PASSPHRASE is configured)'),
});

export type ContextRefreshInput = z.infer<typeof contextRefreshSchema>;

export const contextIndexSchema = z.object({
  source: z.string().optional().describe('Path to local directory, file, or GitHub URL to index'),
  sources: z.array(z.string()).optional().describe('Multiple sources to index together'),
  alias: z.string().min(1).max(64).describe('Unique name for this index'),
  githubToken: z.string().optional().describe('GitHub personal access token for private repositories'),
  passphrase: z.string().optional().describe('Passphrase for write operations (required when WRITE_PASSPHRASE is configured)'),
}).refine(
  (data) => data.source || (data.sources && data.sources.length > 0),
  { message: 'Either source or sources must be provided' }
);

export type ContextIndexInput = z.infer<typeof contextIndexSchema>;

// ============================================================================
// Tool Definitions (MCP format)
// ============================================================================

export const toolDefinitions: MCPToolDefinition[] = [
  {
    name: 'context_load',
    description: 'Load sources into the Gemini context cache. Supports local directories, files, and GitHub repos (public/private). Use "sources" array to combine multiple sources into one cache.',
    inputSchema: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          description: 'Single source: local path or GitHub URL (e.g., https://github.com/owner/repo)',
        },
        sources: {
          type: 'array',
          items: { type: 'string' },
          description: 'Multiple sources to combine into one cache',
        },
        alias: {
          type: 'string',
          description: 'Friendly name for this cache (1-64 chars)',
        },
        ttl: {
          type: 'number',
          description: 'Time to live in seconds (60-604800, default: 3600). Longer TTLs available with local models.',
        },
        systemInstruction: {
          type: 'string',
          description: 'System instruction for queries against this cache',
        },
        githubToken: {
          type: 'string',
          description: 'GitHub personal access token for private repositories',
        },
        passphrase: {
          type: 'string',
          description: 'Passphrase for write operations (required when WRITE_PASSPHRASE is configured)',
        },
      },
      required: ['alias'],
    },
  },
  {
    name: 'context_query',
    description: 'Query a cached context. Uses tiered routing: AI Search (fast RAG) → Nemotron synthesis → Gemini fallback. The cache must have been created with context_load first.',
    inputSchema: {
      type: 'object',
      properties: {
        alias: {
          type: 'string',
          description: 'Cache alias to query',
        },
        query: {
          type: 'string',
          description: 'Question or instruction',
        },
        maxTokens: {
          type: 'number',
          description: 'Maximum tokens in response',
        },
        temperature: {
          type: 'number',
          description: 'Temperature for generation (0-2)',
        },
        forceFullContext: {
          type: 'boolean',
          description: 'Skip RAG/AI Search and force full context load (slower but more comprehensive)',
        },
      },
      required: ['alias', 'query'],
    },
  },
  {
    name: 'context_list',
    description: 'List all active context caches with their metadata (alias, token count, expiry).',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'context_evict',
    description: 'Remove a context cache. Frees resources and stops billing for that cache.',
    inputSchema: {
      type: 'object',
      properties: {
        alias: {
          type: 'string',
          description: 'Cache alias to evict',
        },
        passphrase: {
          type: 'string',
          description: 'Passphrase for write operations (required when WRITE_PASSPHRASE is configured)',
        },
      },
      required: ['alias'],
    },
  },
  {
    name: 'context_stats',
    description: 'Get usage statistics for caches. Shows token usage, costs, and cache hit rates.',
    inputSchema: {
      type: 'object',
      properties: {
        alias: {
          type: 'string',
          description: 'Cache alias (omit for global stats)',
        },
      },
      required: [],
    },
  },
  {
    name: 'context_refresh',
    description: 'Refresh an existing cache by re-fetching the source content and creating a new Gemini cache. Preserves the alias and optionally updates TTL or system instruction.',
    inputSchema: {
      type: 'object',
      properties: {
        alias: {
          type: 'string',
          description: 'Cache alias to refresh',
        },
        ttl: {
          type: 'number',
          description: 'New time to live in seconds (60-604800, optional). Longer TTLs available with local models.',
        },
        systemInstruction: {
          type: 'string',
          description: 'System instruction for queries (optional)',
        },
        githubToken: {
          type: 'string',
          description: 'GitHub personal access token for private repositories',
        },
        passphrase: {
          type: 'string',
          description: 'Passphrase for write operations (required when WRITE_PASSPHRASE is configured)',
        },
      },
      required: ['alias'],
    },
  },
  {
    name: 'context_index',
    description: 'Index a source into Vectorize for RAG-based querying. Chunks the source into semantic pieces, generates embeddings, and stores in Cloudflare Vectorize. Use this for large repos to enable fast, targeted queries without loading full context.',
    inputSchema: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          description: 'Single source: local path or GitHub URL (e.g., https://github.com/owner/repo)',
        },
        sources: {
          type: 'array',
          items: { type: 'string' },
          description: 'Multiple sources to index together',
        },
        alias: {
          type: 'string',
          description: 'Unique name for this index (1-64 chars)',
        },
        githubToken: {
          type: 'string',
          description: 'GitHub personal access token for private repositories',
        },
        passphrase: {
          type: 'string',
          description: 'Passphrase for write operations (required when WRITE_PASSPHRASE is configured)',
        },
      },
      required: ['alias'],
    },
  },
];
