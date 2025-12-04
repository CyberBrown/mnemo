# Mnemo - Parallel Agent Deployment Guide

## Repository Ready

The Mnemo scaffolding is complete. Here's how to deploy parallel agents.

## Repo Location

Copy from outputs or initialize fresh:
```bash
# From outputs
cp -r /path/to/outputs/mnemo ~/projects/mnemo

# Or clone (once pushed)
git clone https://github.com/CyberBrown/mnemo
cd mnemo
```

## Initial Setup (Run Once)

```bash
cd mnemo
bun install
```

## Parallel Agent Assignments

### Agent 1: @mnemo/core - POLISH & TEST
**Status:** 90% Complete
**Directory:** `packages/core/`

Tasks:
- [ ] Add unit tests for RepoLoader (mock filesystem)
- [ ] Add unit tests for GeminiClient (mock API responses)
- [ ] Test token estimation accuracy
- [ ] Add GitHub repo loading (clone to temp dir)
- [ ] Polish error messages

```bash
cd packages/core
bun test
```

---

### Agent 2: @mnemo/mcp-server - POLISH & TEST
**Status:** 85% Complete
**Directory:** `packages/mcp-server/`

Tasks:
- [ ] Add integration tests
- [ ] Test MCP protocol compliance
- [ ] Add streaming support for large responses
- [ ] Validate tool schemas match MCP spec
- [ ] Add request validation middleware

```bash
cd packages/mcp-server
bun test
```

---

### Agent 3: @mnemo/cf-worker - DEPLOY & TEST
**Status:** 80% Complete
**Directory:** `packages/cf-worker/`

Tasks:
- [ ] Create D1 database: `wrangler d1 create mnemo-metadata`
- [ ] Update wrangler.jsonc with database_id
- [ ] Create R2 bucket: `wrangler r2 bucket create mnemo-files`
- [ ] Set secrets: `wrangler secret put GEMINI_API_KEY`
- [ ] Deploy: `wrangler deploy`
- [ ] Test all endpoints
- [ ] Add R2 file staging for remote sources

```bash
cd packages/cf-worker
wrangler dev
# Test: curl http://localhost:8787/health
```

---

### Agent 4: @mnemo/local - TEST & POLISH
**Status:** 90% Complete
**Directory:** `packages/local/`

Tasks:
- [ ] Test full workflow (load → query → evict)
- [ ] Test CLI commands
- [ ] Add `--json` output flag to CLI
- [ ] Add config file support (~/.mnemo/config.json)
- [ ] Test with real Gemini API
- [ ] Add progress indicators for large loads

```bash
cd packages/local
GEMINI_API_KEY=your_key bun run dev
# Test: curl http://localhost:8080/health
```

---

## Integration Testing Sequence

Once individual packages are tested:

1. **Agent 4 runs local server**
   ```bash
   cd packages/local
   GEMINI_API_KEY=xxx bun run dev
   ```

2. **Any agent tests MCP**
   ```bash
   # Initialize
   curl -X POST http://localhost:8080/mcp -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":1,"method":"initialize"}'
   
   # List tools
   curl -X POST http://localhost:8080/mcp -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
   
   # Load a test dir
   curl -X POST http://localhost:8080/mcp -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"context_load","arguments":{"source":"./sources/examples","alias":"test"}}}'
   
   # Query
   curl -X POST http://localhost:8080/mcp -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"context_query","arguments":{"alias":"test","query":"What is this?"}}}'
   ```

3. **Test MCP in Claude Code**
   Add to `~/.claude.json`:
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

## Git Worktrees for Parallel Work

```bash
# Main repo
cd mnemo
git init
git add .
git commit -m "Initial scaffolding"

# Create worktrees for each agent
git worktree add ../mnemo-core packages/core
git worktree add ../mnemo-mcp packages/mcp-server
git worktree add ../mnemo-cf packages/cf-worker
git worktree add ../mnemo-local packages/local

# Each agent works in their worktree
cd ../mnemo-core
# ... make changes ...
git add . && git commit -m "Add tests for RepoLoader"
```

## Sync Points

Create `SYNC.md` in root when you need to coordinate:

```markdown
# Sync Status

## Agent 1 (core)
- [x] Types exported
- [x] GeminiClient working
- [ ] Tests passing

## Agent 2 (mcp-server)
- [x] Tool definitions complete
- [ ] Integration tests
- Blocked: Waiting on core tests

## Agent 3 (cf-worker)
- [ ] D1 created
- [ ] Deployed
- Blocked: Need wrangler access

## Agent 4 (local)
- [x] Server running
- [x] CLI working
- Ready for integration test
```

## Priority Order

1. **Agent 4 (local)** - Get this working first for rapid iteration
2. **Agent 1 (core)** - Ensure foundation is solid
3. **Agent 2 (mcp-server)** - MCP compliance
4. **Agent 3 (cf-worker)** - Production deployment

## Environment Variables Needed

```bash
# All agents
export GEMINI_API_KEY=your_key

# Agent 3 (cf-worker)
export CLOUDFLARE_ACCOUNT_ID=xxx
export CLOUDFLARE_API_TOKEN=xxx
```

## Questions?

Reference:
- `CLAUDE.md` - Agent coding instructions
- `PARALLEL_TASKS.md` - Detailed task breakdown
- `README.md` - User documentation
