# Mnemo v0.4 - AI Search Setup Guide

This guide covers setting up Cloudflare AI Search for tiered RAG queries in Mnemo.

## Overview

Mnemo v0.4 introduces a tiered query architecture:

```
Query
  │
  ▼
┌─────────────────────────────┐
│ Layer 1: CF AI Search       │ ← Auto-indexed from R2
│ - Returns ranked chunks     │
│ - Calculates confidence     │
└─────────────────────────────┘
  │
  ├── Confidence >= threshold?
  │   │
  │   YES → Synthesize with Nemotron → Return (fast, free)
  │
  └── NO → Escalate to Layer 2
            │
            ▼
      ┌─────────────────────────────┐
      │ Layer 2: Full Context Load  │
      │ - Primary: Nemotron         │
      │ - Fallback: Gemini          │
      └─────────────────────────────┘
            │
            ▼
      Return (slower, may cost $)
```

## Prerequisites

- Cloudflare account with Workers, R2, and AI Search access
- Wrangler CLI installed (`bun install -g wrangler`)
- Authenticated with Cloudflare (`wrangler login`)

## Step 1: Create R2 Bucket (if not exists)

The existing `mnemo-files` bucket is already configured in wrangler.jsonc:

```bash
# Check if bucket exists
wrangler r2 bucket list

# If not, create it
wrangler r2 bucket create mnemo-files
```

## Step 2: Create AI Search Instance

AI Search must be created via the Cloudflare Dashboard:

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com)
2. Navigate to **AI** → **AI Search (AutoRAG)**
3. Click **Create AI Search**
4. Configure:
   - **Name**: `mnemo-knowledge`
   - **Data Source**: Select `mnemo-files` R2 bucket
   - **Embedding Model**: Default (recommended)
   - **LLM**: Default (we override this with Nemotron)
   - **AI Gateway**: Create or select one for monitoring

5. Click **Create**

AI Search will automatically:
- Create a Vectorize index
- Begin indexing content from the R2 bucket
- Re-index on content changes

## Step 3: Verify Configuration

Check that wrangler.jsonc has the AI Search configuration:

```jsonc
{
  "ai": {
    "binding": "AI"
  },
  "r2_buckets": [
    {
      "binding": "STORAGE",
      "bucket_name": "mnemo-files"
    }
  ],
  "vars": {
    "AI_SEARCH_NAME": "mnemo-knowledge",
    "AI_SEARCH_CONFIDENCE_THRESHOLD": "0.7",
    "AI_SEARCH_MAX_RESULTS": "10"
  }
}
```

## Step 4: Deploy

```bash
# Deploy the updated worker
bun run deploy
```

## Usage

### Loading Content

When you use `context_load`, content is automatically synced to R2:

```bash
# Via API
curl -X POST https://mnemo.logosflux.io/tools/context_load \
  -H "Content-Type: application/json" \
  -d '{
    "source": "https://github.com/owner/repo",
    "alias": "my-repo",
    "passphrase": "your-passphrase"
  }'
```

The content is stored in R2 at:
- `{alias}/content.md` - Combined content
- `{alias}/files/{path}` - Individual files

### Querying

Queries automatically use the tiered approach:

```bash
curl -X POST https://mnemo.logosflux.io/tools/context_query \
  -H "Content-Type: application/json" \
  -d '{
    "alias": "my-repo",
    "query": "How does authentication work?"
  }'
```

Response includes the query source:
- `source: "rag"` - AI Search + Nemotron synthesis (fast, free)
- `source: "context"` - Full context with Nemotron
- `source: "fallback"` - Full context with Gemini

### Forcing Full Context

Skip AI Search for comprehensive queries:

```bash
curl -X POST https://mnemo.logosflux.io/tools/context_query \
  -H "Content-Type: application/json" \
  -d '{
    "alias": "my-repo",
    "query": "Give me a comprehensive overview of the architecture",
    "forceFullContext": true
  }'
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AI_SEARCH_NAME` | `mnemo-knowledge` | AI Search instance name |
| `AI_SEARCH_CONFIDENCE_THRESHOLD` | `0.7` | Minimum confidence for RAG (0-1) |
| `AI_SEARCH_MAX_RESULTS` | `10` | Max chunks to retrieve |

### Tuning Confidence Threshold

- **0.5-0.6**: More queries use RAG (faster, cheaper, may miss context)
- **0.7** (default): Balanced approach
- **0.8-0.9**: More queries escalate to full context (slower, more comprehensive)

## Monitoring

### AI Gateway

Monitor AI Search usage through AI Gateway:
1. Go to **AI** → **AI Gateway** in dashboard
2. View request logs, latency, and error rates

### Health Check

```bash
curl https://mnemo.logosflux.io/health
```

Response includes AI Search availability:
```json
{
  "status": "ok",
  "models": {
    "primary": { "name": "nemotron-3-nano", "available": true },
    "fallback": { "name": "gemini-2.0-flash-001", "available": true }
  }
}
```

## Troubleshooting

### AI Search Not Indexing

1. Check R2 bucket has content:
   ```bash
   wrangler r2 object list mnemo-files
   ```

2. Check AI Search status in dashboard
3. Manually trigger re-index if needed

### Low Confidence Scores

1. Check content format (markdown works best)
2. Increase `AI_SEARCH_MAX_RESULTS` for more context
3. Enable reranking (enabled by default)

### Fallback Too Frequent

1. Lower `AI_SEARCH_CONFIDENCE_THRESHOLD`
2. Check if content is properly indexed
3. Review query complexity

## Architecture Details

### Files Created

- `packages/core/src/ai-search-client.ts` - AI Search adapter
- `packages/core/src/tiered-query.ts` - Tiered query handler
- `docs/ai-search-setup.md` - This guide

### Files Modified

- `packages/cf-worker/wrangler.jsonc` - AI Search config
- `packages/cf-worker/src/index.ts` - Tiered handler wiring
- `packages/mcp-server/src/tools/handlers.ts` - R2 sync, tiered query
- `packages/mcp-server/src/tools/schemas.ts` - forceFullContext param
- `packages/mcp-server/src/server.ts` - New dependencies
- `packages/core/src/index.ts` - Exports

## Cost Implications

| Tier | Cost | When Used |
|------|------|-----------|
| AI Search + Nemotron | Free* | High confidence RAG |
| Nemotron Full Context | Free* | Low confidence, fits 256K |
| Gemini Full Context | $$$ | Large context, Nemotron unavailable |

*Free = just electricity (self-hosted Nemotron)
