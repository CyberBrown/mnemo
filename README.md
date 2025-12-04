# 🧠 Mnemo

Extended memory for AI assistants via Gemini context caching.

**Mnemo** (Greek: memory) gives AI assistants like Claude access to large codebases and document collections by leveraging Gemini's 1M token context window and context caching features.

## Why Mnemo?

Instead of complex RAG pipelines with embeddings and retrieval, Mnemo takes a simpler approach:
- Load your entire codebase into Gemini's context cache
- Query it with natural language
- Let Claude orchestrate while Gemini holds the context

This gives you:
- **Perfect recall** - no chunking or retrieval means no lost context
- **Lower latency** - cached context is served quickly
- **Cost savings** - cached tokens cost 75-90% less than regular input tokens
- **Simplicity** - no vector databases, embeddings, or complex retrieval logic

## Quick Start

### Local Server (Bun)

```bash
# Clone and install
git clone https://github.com/CyberBrown/mnemo
cd mnemo
bun install

# Set your Gemini API key
export GEMINI_API_KEY=your_key_here

# Start the server
bun run dev
```

### Usage

```bash
# Load a codebase
curl -X POST http://localhost:8080/tools/context_load \
  -H "Content-Type: application/json" \
  -d '{"source": "/path/to/your/repo", "alias": "my-project"}'

# Query it
curl -X POST http://localhost:8080/tools/context_query \
  -H "Content-Type: application/json" \
  -d '{"alias": "my-project", "query": "What does this codebase do?"}'

# List caches
curl http://localhost:8080/tools/context_list

# Evict when done
curl -X POST http://localhost:8080/tools/context_evict \
  -H "Content-Type: application/json" \
  -d '{"alias": "my-project"}'
```

### CLI

```bash
# Start server
mnemo serve

# Load a project
mnemo load ./my-project my-proj

# Query
mnemo query my-proj "What's the main entry point?"

# List caches
mnemo list

# Remove cache
mnemo evict my-proj
```

### MCP Integration (Claude Code)

Add Mnemo to your Claude Code MCP config:

```json
{
  "mcpServers": {
    "mnemo": {
      "type": "http",
      "url": "http://localhost:8080/mcp"
    }
  }
}
```

Now Claude can use Mnemo tools directly in your conversations.

## Deployment Options

### 1. Local (Bun)
Best for personal use. Data stored in `~/.mnemo/`.

```bash
bun run dev
```

### 2. Cloudflare Workers
Best for teams and production. Uses D1 for metadata, R2 for file staging.

```bash
cd packages/cf-worker
wrangler secret put GEMINI_API_KEY
wrangler d1 create mnemo-metadata
wrangler deploy
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `context_load` | Load a directory or file into Gemini cache |
| `context_query` | Query a cached context |
| `context_list` | List all active caches |
| `context_evict` | Remove a cache |
| `context_stats` | Get usage statistics |

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `GEMINI_API_KEY` | Your Gemini API key | Required |
| `MNEMO_PORT` | Server port | 8080 |
| `MNEMO_DIR` | Data directory | ~/.mnemo |
| `MNEMO_AUTH_TOKEN` | Optional auth token | None |

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

## Costs

Gemini context caching pricing:
- Cache storage: ~$4.50 per 1M tokens per hour
- Cached input: 75-90% discount vs regular input
- Regular input: ~$0.075 per 1M tokens (Flash)

For a 100k token codebase cached for 1 hour:
- Storage: ~$0.45
- 10 queries: ~$0.02 (vs ~$0.08 without caching)
- **Total: ~$0.47 vs ~$0.83 without caching**

The more queries you make, the more you save.

## License

MIT

## Credits

Built by [Voltage Labs](https://voltagelabs.dev)
