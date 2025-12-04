import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { GeminiClient, type CacheStorage, type CacheMetadata, type CacheListItem, MnemoConfigSchema } from '@mnemo/core';
import { MnemoMCPServer, toolDefinitions } from '@mnemo/mcp-server';

// Cloudflare bindings type
interface Env {
  DB: D1Database;
  STORAGE: R2Bucket;
  GEMINI_API_KEY: string;
  MNEMO_AUTH_TOKEN?: string;
  ENVIRONMENT: string;
}

// Create app with bindings type
const app = new Hono<{ Bindings: Env }>();

// Middleware
app.use('*', cors());
app.use('*', logger());

// Optional auth middleware
app.use('*', async (c, next) => {
  const authToken = c.env.MNEMO_AUTH_TOKEN;
  if (authToken) {
    const header = c.req.header('Authorization');
    const token = header?.replace('Bearer ', '');
    if (token !== authToken) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
  }
  await next();
});

// ============================================================================
// Routes
// ============================================================================

// Health check
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'mnemo',
    version: '0.1.0',
    environment: c.env.ENVIRONMENT,
  });
});

// Service info
app.get('/', (c) => {
  return c.json({
    name: 'mnemo',
    version: '0.1.0',
    description: 'Extended memory for AI assistants via Gemini context caching',
    endpoints: {
      health: 'GET /health',
      tools: 'GET /tools',
      mcp: 'POST /mcp',
    },
  });
});

// List available tools
app.get('/tools', (c) => {
  return c.json({ tools: toolDefinitions });
});

// MCP protocol endpoint
app.post('/mcp', async (c) => {
  const server = createMCPServer(c.env);
  
  try {
    const request = await c.req.json();
    const response = await server.handleRequest(request);
    return c.json(response);
  } catch (error) {
    return c.json({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32700,
        message: 'Parse error',
      },
    }, 400);
  }
});

// Direct tool invocation (convenience endpoints)
app.post('/tools/:toolName', async (c) => {
  const toolName = c.req.param('toolName');
  const server = createMCPServer(c.env);
  
  try {
    const args = await c.req.json();
    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: args,
      },
    });
    
    // Extract result from MCP response
    if ('result' in response && response.result) {
      return c.json(response.result);
    }
    if ('error' in response && response.error) {
      return c.json({ error: response.error.message }, 400);
    }
    return c.json(response);
  } catch (error) {
    return c.json({ error: 'Invalid request' }, 400);
  }
});

// ============================================================================
// Helpers
// ============================================================================

function createMCPServer(env: Env): MnemoMCPServer {
  const config = MnemoConfigSchema.parse({
    geminiApiKey: env.GEMINI_API_KEY,
  });
  
  const geminiClient = new GeminiClient(config);
  const storage = new D1CacheStorage(env.DB);
  
  return new MnemoMCPServer({
    geminiClient,
    storage,
  });
}

// ============================================================================
// D1 Storage Implementation
// ============================================================================

class D1CacheStorage implements CacheStorage {
  constructor(private db: D1Database) {}

  async save(metadata: CacheMetadata): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO caches (id, alias, gemini_cache_name, source, token_count, model, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(alias) DO UPDATE SET
           gemini_cache_name = excluded.gemini_cache_name,
           source = excluded.source,
           token_count = excluded.token_count,
           model = excluded.model,
           expires_at = excluded.expires_at`
      )
      .bind(
        crypto.randomUUID(),
        metadata.alias,
        metadata.name,
        metadata.source,
        metadata.tokenCount,
        metadata.model ?? null,
        metadata.expiresAt.toISOString()
      )
      .run();
  }

  async getByAlias(alias: string): Promise<CacheMetadata | null> {
    const result = await this.db
      .prepare('SELECT * FROM caches WHERE alias = ?')
      .bind(alias)
      .first<{
        id: string;
        alias: string;
        gemini_cache_name: string;
        source: string;
        token_count: number;
        model: string | null;
        created_at: string;
        expires_at: string;
      }>();

    if (!result) return null;

    return {
      name: result.gemini_cache_name,
      alias: result.alias,
      tokenCount: result.token_count,
      createdAt: new Date(result.created_at),
      expiresAt: new Date(result.expires_at),
      source: result.source,
      model: result.model ?? undefined,
    };
  }

  async getByName(name: string): Promise<CacheMetadata | null> {
    const result = await this.db
      .prepare('SELECT * FROM caches WHERE gemini_cache_name = ?')
      .bind(name)
      .first<{
        id: string;
        alias: string;
        gemini_cache_name: string;
        source: string;
        token_count: number;
        model: string | null;
        created_at: string;
        expires_at: string;
      }>();

    if (!result) return null;

    return {
      name: result.gemini_cache_name,
      alias: result.alias,
      tokenCount: result.token_count,
      createdAt: new Date(result.created_at),
      expiresAt: new Date(result.expires_at),
      source: result.source,
      model: result.model ?? undefined,
    };
  }

  async list(): Promise<CacheListItem[]> {
    const results = await this.db
      .prepare('SELECT alias, token_count, expires_at, source FROM caches ORDER BY created_at DESC')
      .all<{
        alias: string;
        token_count: number;
        expires_at: string;
        source: string;
      }>();

    return (results.results ?? []).map((row) => ({
      alias: row.alias,
      tokenCount: row.token_count,
      expiresAt: new Date(row.expires_at),
      source: row.source,
    }));
  }

  async deleteByAlias(alias: string): Promise<boolean> {
    const result = await this.db
      .prepare('DELETE FROM caches WHERE alias = ?')
      .bind(alias)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  async update(alias: string, updates: Partial<CacheMetadata>): Promise<void> {
    const sets: string[] = [];
    const values: unknown[] = [];

    if (updates.expiresAt) {
      sets.push('expires_at = ?');
      values.push(updates.expiresAt.toISOString());
    }
    if (updates.tokenCount !== undefined) {
      sets.push('token_count = ?');
      values.push(updates.tokenCount);
    }

    if (sets.length === 0) return;

    values.push(alias);
    await this.db
      .prepare(`UPDATE caches SET ${sets.join(', ')} WHERE alias = ?`)
      .bind(...values)
      .run();
  }
}

export default app;
