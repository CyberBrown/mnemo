# Mnemo - Agent Instructions

## Project Overview

Mnemo is an MCP server that provides extended context/memory for AI assistants by leveraging Gemini's large context window (1M tokens) and context caching features.

**Core concept:** Instead of RAG with embeddings, we load entire codebases/documents into Gemini's context cache, then query it. Claude orchestrates, Gemini holds the context.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         Mnemo                                │
├─────────────────────────────────────────────────────────────┤
│  MCP Tools                                                   │
│  • context_load(source, alias)   - Load into Gemini cache   │
│  • context_query(alias, query)   - Query cached context     │
│  • context_list()                - Show active caches       │
│  • context_evict(alias)          - Remove cache             │
│  • context_stats()               - Token usage, costs       │
├─────────────────────────────────────────────────────────────┤
│  Packages                                                    │
│  • @mnemo/core      - Gemini client, repo loader, types     │
│  • @mnemo/mcp-server - MCP protocol handling                │
│  • @mnemo/cf-worker - Cloudflare Workers deployment         │
│  • @mnemo/local     - Bun-based local server                │
└─────────────────────────────────────────────────────────────┘
```

## Tech Stack

- **Runtime:** Bun (NOT npm/npx)
- **Language:** TypeScript (strict mode)
- **Framework:** Hono (for HTTP handling)
- **Gemini SDK:** @google/genai
- **MCP:** Custom implementation following MCP spec
- **Deployment:** Cloudflare Workers (primary), Local Bun server (secondary)

## Key Dependencies

```json
{
  "@google/genai": "latest",
  "hono": "^4.0.0",
  "zod": "^3.23.0"
}
```

## Coding Standards

1. **Use Bun** - Always `bun install`, `bun run`, `bunx`
2. **TypeScript strict mode** - No `any` types, proper error handling
3. **Zod for validation** - All external inputs validated with Zod schemas
4. **Functional style** - Prefer pure functions, minimize side effects
5. **Error handling** - Use Result types or explicit error returns, not try/catch everywhere
6. **JSDoc comments** - Document all public functions (needed for MCP tool generation)

## Package Responsibilities

### @mnemo/core
- `GeminiClient` - Wrapper around @google/genai with caching methods
- `RepoLoader` - Load local/remote repos into text format
- `SourceLoader` - Load markdown files, PDFs, etc.
- `TokenCounter` - Estimate tokens before loading
- Types and interfaces shared across packages

### @mnemo/mcp-server
- MCP protocol implementation (JSON-RPC 2.0)
- Tool definitions with Zod schemas
- Request/response handling
- Transport-agnostic (used by both cf-worker and local)

### @mnemo/cf-worker
- Cloudflare Workers entry point
- Hono routes for `/mcp`, `/health`, `/tools`
- D1 for cache metadata persistence
- R2 for optional file staging
- Wrangler configuration

### @mnemo/local
- Bun server entry point
- Local filesystem access
- SQLite for cache metadata
- Simpler setup for personal use

## Environment Variables

```bash
# Required
GEMINI_API_KEY=your_gemini_api_key

# Optional (CF Worker)
CLOUDFLARE_ACCOUNT_ID=your_account_id
CLOUDFLARE_API_TOKEN=your_api_token

# Optional (Auth)
MNEMO_AUTH_TOKEN=optional_auth_token
```

## MCP Tool Schemas

Tools must follow this pattern for MCP compatibility:

```typescript
/**
 * Load a source into the Gemini context cache
 * @param source - Path to local directory, GitHub URL, or file path
 * @param alias - Friendly name for this cache (used in queries)
 * @param ttl - Time to live in seconds (default: 3600)
 * @returns Cache metadata including token count and expiry
 */
export async function context_load(
  source: string,
  alias: string,
  ttl?: number
): Promise<CacheMetadata> {
  // Implementation
}
```

## Testing

- Unit tests with `bun test`
- Integration tests require GEMINI_API_KEY
- Mock Gemini responses for unit tests

## Commands

```bash
# Development
bun install                    # Install all deps
bun run dev                    # Run local server
bun run dev:cf                 # Run CF worker locally

# Building
bun run build                  # Build all packages
bun run typecheck              # TypeScript check

# Deployment
bun run deploy                 # Deploy to Cloudflare

# Testing
bun test                       # Run all tests
bun test packages/core         # Test specific package
```

## Reference Projects

- Repomix: https://github.com/yamadashy/repomix (repo loading patterns)
- mcp-ts-template: https://github.com/cyanheads/mcp-ts-template (MCP patterns)
- workers-mcp: https://github.com/cloudflare/workers-mcp (CF MCP patterns)
- @google/genai: https://github.com/googleapis/js-genai (Gemini SDK)
