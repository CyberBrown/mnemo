# Mnemo - Parallel Task Breakdown

## Workstream Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    PARALLEL WORKSTREAMS                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Agent 1: @mnemo/core          Agent 2: @mnemo/mcp-server       │
│  ──────────────────            ────────────────────────          │
│  • GeminiClient                • MCP protocol handler            │
│  • RepoLoader                  • Tool definitions                │
│  • SourceLoader                • JSON-RPC 2.0                    │
│  • Types & interfaces          • Request/response                │
│                                                                  │
│  Agent 3: @mnemo/cf-worker     Agent 4: @mnemo/local            │
│  ─────────────────────         ────────────────────              │
│  • Hono routes                 • Bun server                      │
│  • D1/R2 bindings              • Local filesystem                │
│  • Wrangler config             • SQLite metadata                 │
│  • Auth middleware             • CLI interface                   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Agent 1: @mnemo/core

**Directory:** `packages/core/`

### Tasks

1. **Create package.json**
   ```json
   {
     "name": "@mnemo/core",
     "version": "0.1.0",
     "main": "src/index.ts",
     "types": "src/index.ts",
     "dependencies": {
       "@google/genai": "latest",
       "zod": "^3.23.0"
     }
   }
   ```

2. **Implement GeminiClient** (`src/gemini-client.ts`)
   - Wrap `@google/genai` SDK
   - `createCache(contents, options)` - Create context cache
   - `queryCache(cacheName, query)` - Query existing cache
   - `listCaches()` - List all caches
   - `deleteCache(cacheName)` - Delete cache
   - `getCacheStats(cacheName)` - Get token counts, TTL

3. **Implement RepoLoader** (`src/repo-loader.ts`)
   - Load local directory into text format
   - Clone and load remote GitHub repos
   - Respect `.gitignore` patterns
   - Add file metadata (path, size, type)
   - Token counting per file
   - Reference Repomix patterns

4. **Implement SourceLoader** (`src/source-loader.ts`)
   - Load markdown files
   - Load text files
   - Basic PDF text extraction (optional)
   - Combine multiple sources

5. **Define Types** (`src/types.ts`)
   ```typescript
   export interface CacheMetadata {
     name: string;
     alias: string;
     tokenCount: number;
     createdAt: Date;
     expiresAt: Date;
     source: string;
   }
   
   export interface LoadOptions {
     alias: string;
     ttl?: number;
     includePatterns?: string[];
     excludePatterns?: string[];
   }
   
   export interface QueryResult {
     response: string;
     tokensUsed: number;
     cachedTokensUsed: number;
   }
   ```

6. **Export barrel** (`src/index.ts`)

### Acceptance Criteria
- [ ] Can create Gemini cache from string content
- [ ] Can load local directory respecting .gitignore
- [ ] Can query cached content
- [ ] Types exported and documented
- [ ] Unit tests for RepoLoader (mock fs)

---

## Agent 2: @mnemo/mcp-server

**Directory:** `packages/mcp-server/`

### Tasks

1. **Create package.json**
   ```json
   {
     "name": "@mnemo/mcp-server",
     "version": "0.1.0",
     "main": "src/index.ts",
     "types": "src/index.ts",
     "dependencies": {
       "@mnemo/core": "workspace:*",
       "zod": "^3.23.0"
     }
   }
   ```

2. **Implement MCP Protocol Handler** (`src/protocol.ts`)
   - JSON-RPC 2.0 request/response handling
   - Method routing
   - Error formatting per MCP spec

3. **Define Tool Schemas** (`src/tools/schemas.ts`)
   ```typescript
   export const contextLoadSchema = z.object({
     source: z.string().describe("Path or URL to load"),
     alias: z.string().describe("Name for this cache"),
     ttl: z.number().optional().describe("TTL in seconds")
   });
   
   export const contextQuerySchema = z.object({
     alias: z.string().describe("Cache alias to query"),
     query: z.string().describe("Question or instruction")
   });
   
   // etc.
   ```

4. **Implement Tool Handlers** (`src/tools/handlers.ts`)
   - `context_load` - Load source into cache
   - `context_query` - Query a cache
   - `context_list` - List all caches
   - `context_evict` - Remove a cache
   - `context_stats` - Get usage stats

5. **Implement MCP Server Class** (`src/server.ts`)
   ```typescript
   export class MnemoMCPServer {
     constructor(private geminiClient: GeminiClient, private storage: Storage)
     
     async handleRequest(request: MCPRequest): Promise<MCPResponse>
     getToolDefinitions(): ToolDefinition[]
   }
   ```

6. **Export barrel** (`src/index.ts`)

### Acceptance Criteria
- [ ] Valid MCP tool definitions exportable
- [ ] JSON-RPC 2.0 compliant request handling
- [ ] All 5 tools implemented
- [ ] Zod validation on all inputs
- [ ] Error responses follow MCP spec

---

## Agent 3: @mnemo/cf-worker

**Directory:** `packages/cf-worker/`

### Tasks

1. **Create package.json**
   ```json
   {
     "name": "@mnemo/cf-worker",
     "version": "0.1.0",
     "main": "src/index.ts",
     "scripts": {
       "dev": "wrangler dev",
       "deploy": "wrangler deploy"
     },
     "dependencies": {
       "@mnemo/core": "workspace:*",
       "@mnemo/mcp-server": "workspace:*",
       "hono": "^4.0.0"
     },
     "devDependencies": {
       "wrangler": "^3.0.0"
     }
   }
   ```

2. **Create wrangler.jsonc**
   ```jsonc
   {
     "name": "mnemo",
     "main": "src/index.ts",
     "compatibility_date": "2024-12-01",
     "d1_databases": [
       { "binding": "DB", "database_name": "mnemo-metadata" }
     ],
     "r2_buckets": [
       { "binding": "STORAGE", "bucket_name": "mnemo-files" }
     ],
     "vars": {
       "ENVIRONMENT": "production"
     }
   }
   ```

3. **Implement Hono Routes** (`src/index.ts`)
   - `GET /` - Service info
   - `GET /health` - Health check
   - `GET /tools` - List MCP tools
   - `POST /mcp` - MCP protocol endpoint (Streamable HTTP)
   - `POST /tools/:toolName` - Direct tool invocation

4. **Implement D1 Storage** (`src/storage.ts`)
   - Store cache metadata (alias → Gemini cache name mapping)
   - Track usage statistics
   - User isolation (if multi-tenant)

5. **Auth Middleware** (`src/middleware/auth.ts`)
   - Optional bearer token auth
   - Rate limiting (optional)

6. **D1 Schema** (`schema.sql`)
   ```sql
   CREATE TABLE caches (
     id TEXT PRIMARY KEY,
     alias TEXT UNIQUE NOT NULL,
     gemini_cache_name TEXT NOT NULL,
     source TEXT NOT NULL,
     token_count INTEGER,
     created_at TEXT DEFAULT CURRENT_TIMESTAMP,
     expires_at TEXT,
     user_id TEXT
   );
   
   CREATE TABLE usage_logs (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     cache_id TEXT,
     tokens_used INTEGER,
     cached_tokens_used INTEGER,
     created_at TEXT DEFAULT CURRENT_TIMESTAMP
   );
   ```

### Acceptance Criteria
- [ ] `wrangler dev` runs successfully
- [ ] `/health` returns 200
- [ ] `/mcp` accepts MCP requests
- [ ] D1 schema applied
- [ ] Auth middleware working (optional)

---

## Agent 4: @mnemo/local

**Directory:** `packages/local/`

### Tasks

1. **Create package.json**
   ```json
   {
     "name": "@mnemo/local",
     "version": "0.1.0",
     "main": "src/index.ts",
     "bin": {
       "mnemo": "./src/cli.ts"
     },
     "scripts": {
       "dev": "bun run src/index.ts",
       "start": "bun run src/index.ts"
     },
     "dependencies": {
       "@mnemo/core": "workspace:*",
       "@mnemo/mcp-server": "workspace:*",
       "hono": "^4.0.0"
     }
   }
   ```

2. **Implement Bun Server** (`src/index.ts`)
   - Same routes as cf-worker
   - Direct filesystem access
   - SQLite for metadata (bun:sqlite)

3. **Implement Local Storage** (`src/storage.ts`)
   - SQLite database in `~/.mnemo/`
   - Same schema as D1

4. **Implement CLI** (`src/cli.ts`)
   ```bash
   mnemo serve              # Start server
   mnemo load <path> <alias> # Load source
   mnemo query <alias> "question"
   mnemo list               # List caches
   mnemo evict <alias>      # Remove cache
   ```

5. **Setup script** (`src/setup.ts`)
   - Create `~/.mnemo/` directory
   - Initialize SQLite database
   - Check for GEMINI_API_KEY

### Acceptance Criteria
- [ ] `bun run dev` starts server on localhost:8080
- [ ] CLI commands work
- [ ] SQLite persistence working
- [ ] Can load local files directly

---

## Integration Points

### Core → MCP Server
```typescript
// MCP Server imports from Core
import { GeminiClient, RepoLoader, type CacheMetadata } from '@mnemo/core';
```

### MCP Server → Workers
```typescript
// Both cf-worker and local import MCP server
import { MnemoMCPServer } from '@mnemo/mcp-server';
```

### Shared Types
All types defined in `@mnemo/core/src/types.ts` and re-exported.

---

## Coordination Notes

1. **Agent 1 (core) should complete first** - Others depend on types and GeminiClient
2. **Agent 2 (mcp-server) can start with mock GeminiClient** - Define interfaces early
3. **Agents 3 & 4 can work in parallel** - Same pattern, different runtimes
4. **Use workspace protocol** - `"@mnemo/core": "workspace:*"`

## Communication

If you need to coordinate:
1. Create `SYNC.md` in root with status updates
2. Export interfaces as early as possible
3. Use TODO comments for cross-package dependencies

---

## Quick Start Commands

```bash
# Agent 1
cd packages/core && bun init && bun add @google/genai zod

# Agent 2  
cd packages/mcp-server && bun init && bun add zod

# Agent 3
cd packages/cf-worker && bun init && bun add hono && bun add -d wrangler

# Agent 4
cd packages/local && bun init && bun add hono
```
