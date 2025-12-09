# Mnemo: Team Leader Summary

> **Audience**: Team leaders for DE, Nexus, Bridge, and other services
> **Generated**: 2025-12-05
> **Purpose**: Understanding Mnemo's role and how to integrate with it

---

## Executive Summary

**Mnemo** is the **short-term working memory component** for the entire ecosystem. It provides a huge context window (1M tokens via Gemini) with fast query capabilities, enabling AI-powered services to access recent history, patterns, and staged data without expensive embeddings or vector search.

**Think of Mnemo as**: Short-term RAM for AI agents. Services load data into Mnemo (repos, docs, emails, calendar events), then query it for context-aware decision-making.

---

## What Mnemo Does

### Core Capabilities

1. **Context Loading**
   - Load entire codebases, documentation sites, email threads, calendar events
   - Combine multiple sources into a single cache
   - Support diverse formats (Git repos, HTML docs, PDFs, markdown)
   - Handle up to 1M tokens per cache (equivalent to ~750k words)

2. **Fast Querying**
   - Query cached content via natural language
   - Return results in <2 seconds (Gemini Flash inference)
   - Track token usage and costs

3. **Automatic Management**
   - TTL-based expiration (default: 1 hour, configurable)
   - Token counting and limits
   - Usage logging for cost tracking

4. **MCP Interface**
   - Accessible via Model Context Protocol
   - Tools: `context_load()`, `context_query()`, `context_list()`, `context_evict()`, `context_stats()`
   - Compatible with Claude Code, Claude Desktop, and custom integrations

### What Mnemo Does NOT Do

- ❌ Long-term storage (use persistent DB for that)
- ❌ Decision-making (that's DE's job)
- ❌ UI rendering (that's Bridge's job)
- ❌ Real-time sync (use Durable Objects for that)
- ❌ Embedding generation or vector search (not needed with 1M context)

---

## How Your Service Interacts with Mnemo

### For DE (Distributed Elections)

**Your role**: Route LLM requests, manage queues, select optimal models

**How you use Mnemo**:
- **Tier 2 Analysis**: When escalating from Tier 1 to Tier 2, query Mnemo for context
  - Example: Email classification needs past interaction history → query Mnemo
  - Example: Task prioritization needs project context → query Mnemo

**Integration pattern**:
```typescript
// DE Tier 2 handler
async function tier2Analysis(request: Request) {
  // 1. Check if relevant context exists in Mnemo
  const caches = await mnemo.listCaches();
  const relevantCache = caches.find(c => c.alias.includes('email-history'));

  // 2. If exists, query for context
  let context = '';
  if (relevantCache) {
    const result = await mnemo.query(relevantCache.alias,
      `What is the user's typical response pattern for ${request.sender}?`
    );
    context = result.response;
  }

  // 3. Use context in LLM prompt
  const llmResponse = await routeToModel({
    model: 'claude',
    prompt: `${context}\n\nNew email: ${request.body}\nClassify and suggest action.`
  });

  return llmResponse;
}
```

**Key considerations**:
- Mnemo queries count toward your LLM budget (though cached tokens are 75% cheaper)
- Check cache existence before querying to avoid errors
- Consider caching Mnemo results in KV for frequently accessed patterns

---

### For Nexus (Email/Calendar/Tasks Backend)

**Your role**: Process emails, manage calendar, organize tasks

**How you use Mnemo**:
- **Email Context Loading**: Load recent email threads for pattern analysis
  - Example: Load past 30 days of emails from important senders
  - Example: Load project-related email threads when user mentions project

- **Decision Making**: Query Mnemo for historical patterns
  - Example: "How have I handled similar requests from this client?"
  - Example: "What are my usual meeting patterns with this person?"

- **Stage Management**: Use Mnemo to track multi-step processing
  - Example: When processing 1000 emails, log progress/findings to Mnemo
  - Example: When analyzing calendar conflicts, cache intermediate results

**Integration pattern**:
```typescript
// Nexus email processor
async function processNewEmail(email: Email) {
  // 1. Load relevant context
  const alias = `email-history-${email.from}`;

  // Check if already loaded
  let cache = await mnemo.getCacheByAlias(alias);
  if (!cache) {
    // Load email history for this sender
    const history = await fetchEmailHistory(email.from, 30); // 30 days
    cache = await mnemo.load({
      sources: [
        { type: 'email', threads: history }
      ],
      alias,
      ttl: 3600 // 1 hour
    });
  }

  // 2. Query for context
  const analysis = await mnemo.query(alias,
    `Based on past interactions, how should I prioritize this email: "${email.subject}"?`
  );

  // 3. Use analysis for Tier 1 classification
  return {
    priority: analysis.priority,
    suggestedAction: analysis.action,
    reasoning: analysis.reasoning
  };
}
```

**Key considerations**:
- Load context proactively (when user starts working on a project)
- Use TTL wisely (email context: 1 hour, project context: 8 hours)
- Combine multiple sources (emails + calendar + tasks) for rich context
- Don't overload caches (stay under 900k tokens to leave room for queries)

---

### For Bridge (Frontend UI)

**Your role**: Display information to users, handle user interactions

**How you use Mnemo**:
- **Cache Status Display**: Show what's currently in working memory
  - Example: "Working memory: Project X repo, last 100 emails, this week's calendar"

- **Optional Direct Query**: Let power users query working memory directly
  - Example: Search bar that queries Mnemo caches

- **Cache Management UI**: Let users manually load/evict caches
  - Example: "Load my emails for the past week" button

**Integration pattern**:
```typescript
// Bridge component
async function WorkingMemoryStatus() {
  const caches = await mnemo.list();

  return (
    <div>
      <h2>Working Memory</h2>
      {caches.map(cache => (
        <CacheCard key={cache.alias}>
          <h3>{cache.alias}</h3>
          <p>{cache.tokenCount.toLocaleString()} tokens</p>
          <p>Expires: {cache.expiresAt}</p>
          <button onClick={() => mnemo.evict(cache.alias)}>
            Clear
          </button>
        </CacheCard>
      ))}
    </div>
  );
}
```

**Key considerations**:
- MCP access might require different auth flow (TBD - see open questions)
- Don't query Mnemo for every UI render (cache the list)
- Consider WebSocket for real-time cache updates
- Provide user controls for manual cache management

---

### For Claude Code (Local Development)

**Your role**: Local code editing and autonomous development

**How you use Mnemo**:
- **Project Context Loading**: Load codebase into Mnemo for quick reference
  - Example: User says "load this project" → Claude Code calls Mnemo to cache it

- **Query During Development**: Ask questions about the codebase
  - Example: "Where is the authentication logic?" → Query Mnemo instead of grepping

**Integration pattern**:
```typescript
// Claude Code MCP integration
// User command: /load-project
async function loadProject(path: string) {
  await mnemo.load({
    sources: [
      { type: 'repo', path }
    ],
    alias: path.split('/').pop(), // Use folder name as alias
    ttl: 28800 // 8 hours
  });

  return `Loaded ${path} into working memory. You can now query it with /query.`;
}

// User command: /query <question>
async function queryProject(question: string) {
  const alias = currentProject; // Track current project
  const result = await mnemo.query(alias, question);
  return result.response;
}
```

**Key considerations**:
- Claude Code runs locally but queries Mnemo over network
- Consider caching for offline mode
- Respect user's network/cost preferences

---

## Current Status (as of 2025-12-05)

### ✅ Completed (v0.1)

- Core MCP server with 5 tools (`load`, `query`, `list`, `evict`, `stats`)
- Git repository loading (local + GitHub, public + private)
- Documentation crawler (HTML sites)
- PDF and Markdown support
- Composite loading (multiple sources in one cache)
- Authentication (Bearer token)
- Rate limiting (30 req/min per IP)
- Usage tracking with cost estimation
- Cloudflare Workers deployment (production: https://mnemo.logosflux.io)
- D1 database for cache metadata
- 220 passing tests

### 🚧 In Progress (v0.2)

- **Extensible adapter system**: Base architecture complete
  - `SourceAdapter` interface
  - `AdapterRegistry` for managing adapters
  - `DocsCrawlerAdapter` as reference implementation

- **Next adapters** (not started):
  - Email adapter (for Nexus Gmail integration) ← **PRIORITY**
  - Calendar adapter (for Nexus calendar integration)
  - File adapter (for generic file loading)

### 📋 Roadmap

**v0.3 - Active Memory Manager** (future):
- Automatic loading based on usage patterns
- Relevance scoring and auto-eviction
- Multi-tier caching (HOT/WARM/COLD)
- Proactive context loading

**v0.4 - Multi-Model Routing** (future):
- Support multiple LLM providers
- Cost-aware routing
- Fallback chains

---

## Technical Details

### Architecture

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
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                         MNEMO                                │
│                  Short-Term Working Memory                   │
│   • Provides 1M token context window (Gemini)               │
│   • Fast queries (<2s response time)                         │
│   • TTL-based cache management                               │
│   • MCP interface for tool access                            │
└─────────────────────────────────────────────────────────────┘
```

### Infrastructure

| Component | Technology |
|-----------|------------|
| Runtime | Bun (development), Cloudflare Workers (production) |
| Framework | Hono |
| LLM Provider | Google Gemini (Flash for queries, Pro for deep analysis) |
| Database | D1 (cache metadata, usage logs) |
| Storage | R2 (optional file staging) |
| Auth | Bearer token (planned: OAuth via `workers-oauth-provider`) |
| Deployment | Cloudflare Workers (serverless) |

### API Endpoints

**Production**: `https://mnemo.logosflux.io`

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/mcp` | POST | MCP JSON-RPC 2.0 requests |
| `/tools/:toolName` | POST | Direct tool invocation |
| `/health` | GET | Health check |

### Performance Characteristics

| Metric | Value |
|--------|-------|
| Cache creation time | 10-60s (depends on source size) |
| Query response time | 1-3s (Gemini Flash) |
| Max cache size | 900k tokens (~675k words) |
| Max caches | Unlimited (subject to D1 limits) |
| Cache TTL | 1 hour (default, configurable 60s-24h) |
| Cost per query | ~$0.001-0.01 (mostly cached tokens @ 75% discount) |

---

## Integration Checklist

When integrating your service with Mnemo:

### Before Development

- [ ] Read `/home/chris/mnemo/CLAUDE.md` (project instructions)
- [ ] Review `/home/chris/mnemo/ROADMAP.md` (understand vision)
- [ ] Check existing adapters in `packages/core/src/adapters/`
- [ ] Understand MCP protocol (if building new tools)

### During Development

- [ ] Use D1 for any new storage needs (see CLAUDE.md for decision tree)
- [ ] Follow TypeScript strict mode (no `any` types)
- [ ] Use Zod for validation
- [ ] Add unit tests (use Bun test runner)
- [ ] Document new tools with JSDoc (required for MCP tool generation)
- [ ] Consider cost implications (Gemini pricing in `types.ts`)

### Integration Points

- [ ] Determine when your service loads context into Mnemo
  - On user action? Proactively? Periodically?
- [ ] Determine when your service queries Mnemo
  - For every request? Only for Tier 2? On-demand?
- [ ] Decide on cache aliases (naming convention)
  - Suggest: `{service}-{type}-{identifier}` (e.g., `nexus-email-user@example.com`)
- [ ] Decide on TTL values
  - Short-lived (1 hour): Email threads, calendar events
  - Long-lived (8 hours): Project repos, documentation
- [ ] Plan for cache invalidation
  - When source data changes, call `context_evict()` and reload

### Authentication

- [ ] Get MNEMO_AUTH_TOKEN (for production access)
- [ ] Store securely (environment variable, secrets manager)
- [ ] Pass in `Authorization: Bearer <token>` header

### Error Handling

- [ ] Handle `CacheNotFoundError` (cache expired or doesn't exist)
- [ ] Handle `TokenLimitError` (cache too large)
- [ ] Handle `LoadError` (source loading failed)
- [ ] Retry logic for transient failures
- [ ] Logging for debugging

---

## Open Questions / TBD

These questions require cross-team discussion:

1. **Bridge MCP Access**: Should Bridge access Mnemo via MCP, or REST API?
   - MCP designed for AI agents, not web UIs
   - Consider creating REST wrapper for Bridge-specific needs

2. **Cache Naming Convention**: Should we enforce a naming scheme?
   - Proposal: `{service}-{type}-{identifier}`
   - Prevents collisions, enables service-specific queries

3. **Proactive Loading**: Which service decides when to load context?
   - Option A: Nexus loads email context when user starts work
   - Option B: DE detects email-related queries and triggers loading
   - Option C: User manually loads via Bridge

4. **Cache Sharing**: Can multiple services query the same cache?
   - Example: Nexus loads email context, DE queries it
   - Answer: Yes (by design), just use the same alias

5. **Cost Allocation**: How do we attribute Mnemo costs to services?
   - Currently tracked in `usage_logs` table
   - Need to add `service_id` field for per-service billing

6. **Real-Time Updates**: Should Mnemo support cache streaming/updates?
   - Use case: Email arrives → update cache without full reload
   - Potential solution: Use Durable Objects for stateful caches

---

## Key Contacts

| Role | Contact | Repository |
|------|---------|------------|
| **Mnemo Lead** | (your team) | github.com/[org]/mnemo |
| **DE Lead** | TBD | TBD |
| **Nexus Lead** | TBD | TBD |
| **Bridge Lead** | TBD | TBD |

---

## Quick Start for Integration

### 1. Install MCP Client (if using MCP protocol)

```bash
npm install @modelcontextprotocol/sdk
```

### 2. Example: Load and Query

```typescript
import { MCPClient } from '@modelcontextprotocol/sdk';

const client = new MCPClient({
  endpoint: 'https://mnemo.logosflux.io/mcp',
  auth: { bearer: process.env.MNEMO_AUTH_TOKEN }
});

// Load context
const loadResult = await client.callTool('context_load', {
  source: 'https://github.com/owner/repo',
  alias: 'my-project',
  ttl: 3600
});

console.log(`Loaded ${loadResult.tokenCount} tokens`);

// Query context
const queryResult = await client.callTool('context_query', {
  alias: 'my-project',
  query: 'What is the main architecture pattern used?'
});

console.log(queryResult.response);
```

### 3. Example: Direct REST (for simple cases)

```bash
# Load
curl -X POST https://mnemo.logosflux.io/tools/context_load \
  -H "Authorization: Bearer $MNEMO_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "source": "https://github.com/owner/repo",
    "alias": "my-project"
  }'

# Query
curl -X POST https://mnemo.logosflux.io/tools/context_query \
  -H "Authorization: Bearer $MNEMO_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "alias": "my-project",
    "query": "What is the main architecture?"
  }'
```

---

## Resources

- **Repository**: `/home/chris/mnemo`
- **Production**: https://mnemo.logosflux.io
- **Documentation**:
  - `/home/chris/mnemo/CLAUDE.md` (project instructions)
  - `/home/chris/mnemo/ROADMAP.md` (vision and roadmap)
  - `/home/chris/mnemo/docs/DEVELOPER-DOC-PROPOSALS.md` (infrastructure patterns)
- **Tests**: `bun test` (220 passing tests)
- **Developer Guides**: Use MCP server `mcp__developer-guides__*` tools

---

## Summary

**Mnemo is your team's short-term memory.**

- Load context from any source (repos, docs, emails, calendar)
- Query it in natural language
- Get fast responses (<2s)
- Pay only for what you use (cached tokens are 75% cheaper)
- Access via MCP or REST API
- Automatic TTL management

**When to use Mnemo**:
- ✅ Need recent context for decision-making (past 30 days of emails)
- ✅ Want to avoid expensive vector search
- ✅ Need to ask questions about large datasets (repos, docs)
- ✅ Implementing Tier 2 analysis that needs historical patterns

**When NOT to use Mnemo**:
- ❌ Long-term storage (use D1/R2)
- ❌ Real-time updates (use Durable Objects)
- ❌ Low-latency lookups (use KV cache)
- ❌ Structured data queries (use D1 with SQL)

---

**Questions?** Contact the Mnemo team or refer to the documentation in `/home/chris/mnemo/`.
