# Mnemo - Agent Instructions

<!-- Developer Guides MCP Setup v1.1.0 - Check for updates: docs/CLAUDE-MD-SETUP.md -->

## Project Overview

Mnemo is an MCP server that provides **short-term working memory** for AI assistants and autonomous systems by leveraging Gemini's large context window (1M tokens) and context caching features.

**Core concept:** Instead of RAG with embeddings, we load entire codebases/documents into Gemini's context cache, then query it. Mnemo serves as the memory layer for DE (Distributed Elections) and other services.

## Glossary

| Term | Full Name | Description |
|------|-----------|-------------|
| **DE** | Distributed Elections | Queue and priority system for managing LLM requests across multiple apps; routes requests to optimal models |
| **Mnemo** | - | Short-term working memory component; provides context caching for DE and other services |
| **Nexus** | - | Backend service for individual communication/time management (email, calendar, tasks, strategy) |
| **Bridge** | - | Frontend UI for accessing Nexus and other services |
| **MCP** | Model Context Protocol | Protocol for AI assistant context management |

## Mnemo's Role in the Ecosystem

```
┌─────────────────────────────────────────────────────────────┐
│                     Applications Layer                       │
│   Nexus    │    Bridge    │  Claude Code  │   Other Apps    │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                  DE (Distributed Elections)                  │
│              Request Router & Priority Queue                 │
│         • Manages LLM request limits across apps             │
│         • Routes to optimal model (DeepSeek, Gemini, Claude) │
│         • Handles tier-based processing (Tier 1/2)           │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                         MNEMO                                │
│                  Short-Term Working Memory                   │
│   • Provides huge context window (1M tokens via Gemini)     │
│   • Caches stage management and logging for agent chains    │
│   • Enables fast queries for active processing              │
│   • Used by DE Tier 2 for semantic analysis                 │
└─────────────────────────────────────────────────────────────┘
```

**Key Integration Points:**

1. **DE → Mnemo**: Tier 2 analysis queries Mnemo for past interactions, patterns, and context
2. **Nexus → Mnemo**: Loads email threads, calendar events, task history into working memory
3. **Claude Code → Mnemo**: Operates independently (local), but can query Mnemo via MCP for project context
4. **Bridge → Mnemo**: May access via MCP for displaying cached context status

**Mnemo's Responsibilities:**
- Load context from diverse sources (repos, docs, emails, etc.)
- Maintain short-term cache with TTL
- Provide fast query interface
- Track token usage and costs
- **NOT responsible for**: Long-term storage, decision-making, UI rendering

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

| Component | Technology |
|-----------|------------|
| Runtime | Bun (NOT npm/npx) |
| Language | TypeScript (strict mode) |
| Framework | Hono |
| Gemini SDK | @google/genai |
| Validation | Zod |
| Deployment | Cloudflare Workers (primary), Local Bun (secondary) |
| Database | D1 (CF), SQLite (local) - **Default for all storage** |
| Storage | R2 (optional file staging) |
| Auth | `workers-oauth-provider` (OAuth 2.1 with PKCE) |

## Infrastructure Patterns

### Database Strategy

**Default: D1 for all storage**

Use D1 unless you have a **documented reason** not to. Before choosing an alternative, create a pros/cons analysis documenting why D1 is insufficient.

**When D1 is appropriate** (most cases):
- Application data (cache metadata, usage logs)
- Multi-tenant architectures
- Read-heavy workloads (with read replication)
- Session management

**Consider alternatives when**:
- Need for real-time updates across instances (use Durable Objects)
- Temporary data with TTL (use KV with expiration)
- Large binary files (use R2)

**Performance notes**:
- Use parameterized queries (security + performance)
- Enable read replication for reduced latency
- Consider KV as cache layer for hot paths

### Cloudflare Workers Limits

**CPU Time**:
- Default: 30 seconds
- Maximum: 5 minutes (configurable via `cpu_ms` in wrangler.toml)
- CPU time = actual compute time (waiting for subrequests doesn't count)

**Implications for Mnemo**:
- ✅ Perfect for: Request routing, rate limiting, cache orchestration, token counting
- ⚠️ Delegate to Gemini: Large model inference (too CPU-intensive)
- ✅ Consider Durable Objects for: Webhook retries, real-time sync, WebSocket connections

**Configuration example**:
```toml
# wrangler.toml
cpu_ms = 300000  # 5-minute CPU limit
```

### Authentication Patterns

**Use `workers-oauth-provider` library** for OAuth 2.1 flows:
- Google/GitHub OAuth
- PKCE automatically handled
- Multi-account support built-in
- Token storage managed by provider

**Storage**:
- OAuth tokens: D1 (via provider library)
- Session data: KV or D1 (depends on access patterns)
- User metadata: D1

### Real-Time & Webhooks

**Use Durable Objects when you need**:
- Webhook delivery with retries (use Alarms for scheduling)
- WebSocket connections
- Stateful processing
- Guaranteed execution

**Use Workers when you need**:
- Stateless request handling
- Fast ephemeral processing
- Cost-sensitive endpoints

## Developer Guidelines (MCP Server)

### Required: Check Before Implementing

ALWAYS search the developer guides before:
- Writing new functions or modules
- Implementing error handling
- Adding validation logic
- Creating API endpoints
- Writing database queries
- Adding authentication or security features

### Quick Reference

| Task | Search Query |
|------|-------------|
| Input validation | `query="zod validation"` |
| Error handling | `query="error classes"` |
| API security | `query="authentication middleware"` |
| Database queries | `query="parameterized queries"` |
| Testing patterns | `query="unit test"` |
| CF Workers | `query="cloudflare workers"` |

### Relevant Guides for Mnemo

| Guide | Use For |
|-------|---------|
| `cloudflare-workers-guide` | Workers patterns, D1, R2, bindings |
| `guide-01-fundamentals` | Code organization, naming, error handling, types |
| `guide-07-security` | Validation, auth, secrets, CORS |
| `guide-05-10-db-perf` | D1 queries, caching, performance |
| `guide-09-testing` | Unit, integration testing with Bun |

### How to Access

```
mcp__developer-guides__search_developer_guides query="validation"
mcp__developer-guides__get_guide guideId="cloudflare-workers-guide"
mcp__developer-guides__list_guides
```

## Coding Standards

1. **Use Bun** - Always `bun install`, `bun run`, `bunx`
2. **TypeScript strict mode** - No `any` types, proper error handling
3. **Zod for validation** - All external inputs validated with Zod schemas
4. **Functional style** - Prefer pure functions, minimize side effects
5. **Error handling** - Use Result types or explicit error returns
6. **JSDoc comments** - Document all public functions (needed for MCP tool generation)

## Package Responsibilities

### @mnemo/core
- `GeminiClient` - Wrapper around @google/genai with caching methods
- `RepoLoader` - Load local/remote repos into text format
- `SourceLoader` - Load markdown files, PDFs, etc.
- `TokenCounter` - Estimate tokens before loading
- `Adapters` (v0.2+) - Extensible source adapter system
  - `SourceAdapter` - Base interface for source adapters
  - `DocsCrawlerAdapter` - Crawl documentation websites
  - `AdapterRegistry` - Registry for managing adapters
- Types and interfaces shared across packages

### @mnemo/mcp-server
- MCP protocol implementation (JSON-RPC 2.0)
- Tool definitions with Zod schemas
- Request/response handling
- Transport-agnostic (used by both cf-worker and local)

### @mnemo/cf-worker
- Cloudflare Workers entry point
- Hono routes for `/mcp`, `/health`, `/tools`
- Authentication middleware (Bearer token via MNEMO_AUTH_TOKEN)
- Rate limiting middleware (30 req/min per IP, in-memory)
- D1 for cache metadata persistence
- R2 for optional file staging
- Wrangler configuration

### @mnemo/local
- Bun server entry point
- Local filesystem access
- SQLite for cache metadata

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

## MCP Tool Pattern

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

## Infrastructure

| Resource | Value |
|----------|-------|
| Live URL | https://mnemo.solamp.workers.dev |
| D1 Database | `mnemo-cache` (1bf57f2d-d380-475f-8faa-b9f791d14662) |
| R2 Bucket | `mnemo-files` |

## Testing

- Unit tests with `bun test`
- Integration tests require GEMINI_API_KEY
- Mock Gemini responses for unit tests
- 98 tests passing (as of 2025-12-04)

## API Examples

```bash
# Load a repo
curl -X POST https://mnemo.solamp.workers.dev/tools/context_load \
  -H "Content-Type: application/json" \
  -d '{"source": "https://github.com/owner/repo", "alias": "myrepo"}'

# Query it
curl -X POST https://mnemo.solamp.workers.dev/tools/context_query \
  -H "Content-Type: application/json" \
  -d '{"alias": "myrepo", "query": "What is this project?"}'
```

## Roadmap

### v0.1 - Complete ✅
- [x] MCP stdio transport for Claude Desktop integration (see `docs/claude-desktop-setup.md`)
- [x] Wire up usage_logs table (cost tracking with Gemini pricing)
- [x] Composite loading (multiple sources into one cache via `sources` array)
- [x] Private repo support (GitHub token via `githubToken` parameter)
- [x] Authentication middleware (Bearer token)
- [x] Rate limiting (30 req/min per IP)
- [x] PDF and Markdown support
- [x] Cache refresh functionality

### v0.2 - Source Adapters ✅
- [x] Extensible source adapter interface
- [x] Documentation site crawler
- [ ] Notion API integration
- [ ] Slack export
- [ ] Google Drive
- [ ] Obsidian vault
- [ ] Meeting transcripts
- [ ] Email exports

### v0.3 - RAG Support ✅
- [x] Chunking system for large codebases
- [x] Vectorize integration for vector storage
- [x] Workers AI embeddings (bge-base-en-v1.5)
- [x] context_index tool for indexing repos
- [x] RAG-based query flow

### v0.4 - Tiered Query with AI Search (In Progress)
- [x] Cloudflare AI Search integration (auto-indexes from R2)
- [x] TieredQueryHandler (AI Search → Nemotron → Gemini)
- [x] R2 sync on context_load for AI Search indexing
- [x] Confidence-based routing (threshold: 0.7)
- [x] forceFullContext parameter for comprehensive queries
- [ ] AI Search instance creation (manual via dashboard)
- [ ] Production testing and tuning

## References

- [Repomix](https://github.com/yamadashy/repomix) - Repo loading patterns
- [mcp-ts-template](https://github.com/cyanheads/mcp-ts-template) - MCP patterns
- [workers-mcp](https://github.com/cloudflare/workers-mcp) - CF MCP patterns
- [@google/genai](https://github.com/googleapis/js-genai) - Gemini SDK
