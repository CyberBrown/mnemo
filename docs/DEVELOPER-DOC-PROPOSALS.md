# Proposed Revisions to Developer Documentation

> Generated: 2025-12-05
> Purpose: Suggestions for improving developer MCP guides based on Mnemo development experience

---

## 1. Add Glossary Section for Project Abbreviations

**Rationale**: Multiple projects (DE, Mnemo, Nexus, Bridge) reference each other. A central glossary prevents confusion.

**Proposed Addition** (to main developer guide):

```markdown
## Project Glossary

| Abbreviation | Full Name | Description | Repository |
|--------------|-----------|-------------|------------|
| **DE** | Distributed Elections | Queue and priority system for managing LLM requests; routes to optimal models | [link] |
| **Mnemo** | - | Short-term working memory component via Gemini context caching | github.com/[org]/mnemo |
| **Nexus** | - | Backend for individual communication/time management | [link] |
| **Bridge** | - | Frontend UI for accessing services | [link] |
| **MCP** | Model Context Protocol | Protocol for AI assistant context management | anthropic.com/mcp |
```

---

## 2. Database Selection Decision Tree

**Rationale**: "Use D1 by default" is stated, but lacks concrete decision framework.

**Proposed Addition** (to infrastructure guide):

```markdown
## Database Selection Framework

### Default: D1

Use D1 unless you have a **documented reason** requiring an alternative.

**Decision Tree**:

1. **Is it application data?** (metadata, logs, config)
   - Yes → D1
   - No → Continue

2. **Does it need TTL/expiration?**
   - Yes, short-lived (< 1 day) → KV with expiration
   - Yes, long-lived → D1 with cleanup job
   - No → Continue

3. **Is it a large binary file?** (>1MB)
   - Yes → R2
   - No → Continue

4. **Does it require real-time coordination across Workers?**
   - Yes → Durable Objects storage
   - No → D1

5. **Is it transient state for a single request?**
   - Yes → In-memory (Map, object)
   - No → D1

**Before choosing non-D1, document**:
- Why D1 is insufficient (with benchmarks if performance-related)
- What you gain with the alternative
- What you lose (consistency, query capabilities, durability)
```

---

## 3. LLM Tier Processing Pattern

**Rationale**: DE implements Tier 1 (fast/cheap) and Tier 2 (deep analysis). This pattern will be reused across services.

**Proposed Addition** (to architecture patterns guide):

```markdown
## LLM Tier Processing Pattern

**Use Case**: Reduce costs by routing lightweight requests to fast models, complex requests to capable models.

### Architecture

```
Request → Tier 1 (Rules + Light ML)
            ↓ (if simple) → Execute + Log
            ↓ (if complex) → Escalate to Tier 2
                              ↓
                        Tier 2 (Full LLM with context)
                              ↓ (auto-execute | notify user | escalate)
```

### Tier 1: Triage (Fast/Cheap)

**Model**: DeepSeek, Gemini Flash, or custom fine-tuned model on CF AI
**Cost Target**: <$0.01 per request
**Capabilities**:
- Rules-based classification
- Pattern matching (regex, heuristics)
- Light ML (spam detection, entity recognition)

**Implementation**:
- Workers (30s-5min CPU limit is sufficient)
- D1 for rules storage
- KV for pattern caching

**When to escalate to Tier 2**:
- Requires semantic understanding beyond keywords
- Needs historical context
- Involves decision-making
- Matches escalation rules

### Tier 2: Analysis (LLM-powered)

**Model**: Gemini Pro, Claude, GPT-4 (routed by DE)
**Context Source**: Mnemo (short-term memory with up to 1M tokens)
**Capabilities**:
- Deep semantic analysis
- Context-aware decisions
- Pattern synthesis from history

**Implementation**:
- Workers orchestrate request to DE
- DE routes to appropriate model based on:
  - Request complexity
  - Available quota
  - Cost constraints
  - Required capabilities

**Outcomes**:
1. **Auto-Execute**: High confidence, safe action
2. **Notify User**: Recap in hourly/daily digest
3. **Needs Attention**: Escalate with priority (1-3)

### Cost Optimization

| Tier | Cost/Request | Use Case | % of Traffic |
|------|--------------|----------|--------------|
| Tier 1 | <$0.01 | Simple classification | 70-80% |
| Tier 2 | $0.05-$0.20 | Requires reasoning | 20-30% |

**Goal**: 80% of requests handled by Tier 1, only 20% escalate to Tier 2.
```

---

## 4. Multi-Account OAuth Pattern

**Rationale**: Nexus needs multi-account Gmail, Drive, Calendar. Pattern should be documented.

**Proposed Addition** (to authentication guide):

```markdown
## Multi-Account OAuth Pattern

**Use Case**: Users authenticate multiple accounts (e.g., work + personal Gmail).

### Architecture

```
User
  ├─ Account 1 (work@company.com)
  │   ├─ Gmail OAuth token
  │   ├─ Drive OAuth token
  │   └─ Calendar OAuth token
  └─ Account 2 (personal@gmail.com)
      ├─ Gmail OAuth token
      └─ Drive OAuth token
```

### Database Schema (D1)

```sql
-- Users table
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

-- Connected accounts
CREATE TABLE user_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,  -- 'google', 'microsoft', 'zoom'
  account_email TEXT NOT NULL,
  account_name TEXT,
  access_token TEXT NOT NULL,  -- Encrypted
  refresh_token TEXT,          -- Encrypted
  token_expiry INTEGER,
  scopes TEXT,                 -- JSON array
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Index for lookups
CREATE INDEX idx_user_accounts_user_provider
  ON user_accounts(user_id, provider);
```

### OAuth Flow

1. **User initiates**: "Connect Google account"
2. **Worker generates**: OAuth URL with PKCE challenge (via `workers-oauth-provider`)
3. **User authorizes**: In Google consent screen
4. **Callback**: Worker receives code, exchanges for tokens
5. **Storage**: Encrypt and store in `user_accounts` table
6. **Multi-account**: Repeat flow for each account

### Token Refresh

```typescript
async function refreshTokenIfNeeded(accountId: string) {
  const account = await db.prepare(
    'SELECT * FROM user_accounts WHERE id = ?'
  ).bind(accountId).first();

  if (account.token_expiry < Date.now()) {
    const newTokens = await oauth.refreshToken(account.refresh_token);
    await db.prepare(
      'UPDATE user_accounts SET access_token = ?, token_expiry = ? WHERE id = ?'
    ).bind(newTokens.access_token, newTokens.expiry, accountId).run();
  }
}
```

### Service Integration

When Nexus needs to fetch email:

```typescript
// 1. Get all user's Gmail accounts
const accounts = await db.prepare(
  'SELECT * FROM user_accounts WHERE user_id = ? AND provider = ?'
).bind(userId, 'google').all();

// 2. For each account, fetch emails
for (const account of accounts) {
  await refreshTokenIfNeeded(account.id);
  const emails = await fetchGmailEmails(account.access_token);
  // Process emails...
}
```
```

---

## 5. Email Routing Through Workers

**Rationale**: Nexus needs to process emails in real-time. Document email-to-Worker patterns.

**Proposed Addition** (to integration patterns guide):

```markdown
## Email Routing to Workers

**Use Case**: Process incoming emails through Tier 1/2 pipeline before delivering to user.

### Architecture Options

#### Option A: Email Forwarding to Worker Endpoint

```
Email Provider → Forward to → https://your-worker.dev/ingest/email
                                ↓
                          Parse & Process (Tier 1)
                                ↓
                          Store in D1 + R2
                                ↓
                          Deliver to user inbox
```

**Setup**:
1. Create catch-all email forwarding rule (Gmail filter, email service webhook)
2. Forward to Worker endpoint with email as JSON
3. Worker parses email (use `mailparser` library)
4. Tier 1 classification
5. Store in D1, attachments in R2

**Providers**:
- Gmail: Use Email Forwarding + Apps Script (limited)
- Cloudflare Email Routing: Native integration with Workers ✅
- SendGrid Inbound Parse: Webhook to Worker
- Postmark: Inbound webhook

#### Option B: SMTP/POP3 Polling (Legacy)

```
Worker (scheduled via Cron Triggers)
    ↓ (every 5 minutes)
POP3/IMAP fetch from provider
    ↓
Parse & Process
    ↓
Mark as read / delete from server
```

**Caveats**:
- Not real-time (polling delay)
- Requires SMTP credentials (less secure than OAuth)
- More complex to manage

**Recommendation**: Use **Cloudflare Email Routing** for native integration, fallback to SendGrid/Postmark webhooks.

### Cloudflare Email Routing Example

```typescript
// Worker handles inbound emails
export default {
  async email(message, env, ctx) {
    // message.from, message.to, message.raw (MIME)
    const parsed = await parseEmail(message.raw);

    // Tier 1 triage
    const classification = await triageEmail(parsed, env);

    // Store in D1
    await env.DB.prepare(
      'INSERT INTO emails (from, subject, body, classification) VALUES (?, ?, ?, ?)'
    ).bind(parsed.from, parsed.subject, parsed.text, classification).run();

    // Escalate to Tier 2 if needed
    if (classification.escalate) {
      await env.DE_QUEUE.send({
        type: 'email_analysis',
        emailId: parsed.messageId
      });
    }
  }
}
```

**Resources**:
- [Cloudflare Email Routing Docs](https://developers.cloudflare.com/email-routing/)
- [Email Workers Guide](https://developers.cloudflare.com/email-routing/email-workers/)
```

---

## 6. Frontend Deployment Guidance

**Rationale**: Bridge (frontend) needs tech stack recommendation. Developer guide should have clear guidance.

**Proposed Addition** (to frontend deployment guide):

```markdown
## Frontend Deployment Recommendations

### Tech Stack

| Framework | Status | Use Case |
|-----------|--------|----------|
| **SvelteKit** | ✅ Recommended | Full-stack apps with SSR, best DX |
| **React** | ✅ Fully Supported | Large teams, existing React ecosystem |
| **SolidStart** | 🚧 Coming Q2 2025 | Performance-critical apps |
| **Vite** | ✅ General Purpose | Static sites, SPAs |

**Deployment Target**: **Cloudflare Pages**

### Architecture Pattern (2025 Best Practice)

```
┌──────────────────────────────────────┐
│   SvelteKit/React on Pages           │  ← User-facing UI
│   • Static assets (HTML, CSS, JS)    │
│   • Server-side rendering (optional) │
└─────────────┬────────────────────────┘
              ↓
┌──────────────────────────────────────┐
│   Pages Functions (/functions dir)   │  ← API layer (Node.js-like)
│   • Serverless API endpoints         │
│   • Middleware, auth, validation     │
└─────────────┬────────────────────────┘
              ↓
┌──────────────────────────────────────┐
│   Workers (heavy lifting)            │  ← Business logic
│   • DE routing                       │
│   • Mnemo queries                    │
│   • External API calls               │
└─────────────┬────────────────────────┘
              ↓
┌──────────────────────────────────────┐
│   D1 + R2 + Durable Objects          │  ← Data layer
└──────────────────────────────────────┘
```

### Setup Example (SvelteKit)

```bash
# Create new SvelteKit app
npm create cloudflare@latest bridge-ui -- --framework=svelte

cd bridge-ui
npm install

# Add Cloudflare adapter
npm install -D @sveltejs/adapter-cloudflare

# Update svelte.config.js
import adapter from '@sveltejs/adapter-cloudflare';

export default {
  kit: {
    adapter: adapter()
  }
};
```

### Pages Functions Integration

```typescript
// functions/api/mnemo/query.ts
export async function onRequestPost(context) {
  const { request, env } = context;
  const { alias, query } = await request.json();

  // Call Mnemo Worker
  const response = await fetch('https://mnemo.logosflux.io/tools/context_query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ alias, query })
  });

  return response;
}
```

### Deployment

```bash
# Automatic via git push
git add .
git commit -m "feat: add Mnemo query UI"
git push origin main

# Cloudflare Pages auto-deploys from main branch
# Preview deployments created for PRs
```

**Benefits**:
- Automatic CI/CD
- Preview deployments on PRs
- Global CDN distribution
- Integrated with Workers ecosystem (D1, R2, Durable Objects)
```

---

## 7. Service Interdependencies Map

**Rationale**: Multiple services reference each other. A dependency map prevents circular dependencies and clarifies boundaries.

**Proposed Addition** (to architecture overview):

```markdown
## Service Interdependencies

```
┌─────────────────────────────────────────────────────────┐
│                    Application Layer                     │
│  ┌─────────┐  ┌─────────┐  ┌────────────┐  ┌─────────┐ │
│  │ Nexus   │  │ Bridge  │  │Claude Code │  │ Other   │ │
│  │ (email, │  │ (UI)    │  │ (local)    │  │ Apps    │ │
│  │calendar)│  │         │  │            │  │         │ │
│  └────┬────┘  └────┬────┘  └─────┬──────┘  └────┬────┘ │
└───────┼────────────┼─────────────┼──────────────┼──────┘
        │            │             │              │
        └────────────┴─────────────┴──────────────┘
                              ↓
┌─────────────────────────────────────────────────────────┐
│              DE (Distributed Elections)                  │
│  • Request routing & queuing                             │
│  • Model selection (DeepSeek, Gemini, Claude)            │
│  • Rate limiting across all apps                         │
│  • Tier 1/2 processing orchestration                     │
└──────────────────────┬──────────────────────────────────┘
                       │
        ┌──────────────┴──────────────┐
        ↓                             ↓
┌───────────────┐            ┌────────────────┐
│    Mnemo      │            │   LLM Layer    │
│ (Short-term   │            │  • DeepSeek    │
│  memory)      │←───────────│  • Gemini      │
│               │  queries   │  • Claude      │
│ • 1M token    │            │                │
│   context     │            └────────────────┘
│ • Fast query  │
│ • TTL cache   │
└───────────────┘
```

### Dependency Rules

1. **Mnemo** depends on:
   - Gemini API (external)
   - D1 for metadata
   - R2 for file staging (optional)

2. **DE** depends on:
   - Mnemo (for Tier 2 context)
   - LLM providers (DeepSeek, Gemini, Claude)
   - D1 for request logs

3. **Nexus** depends on:
   - DE (for LLM routing)
   - Mnemo (for context loading)
   - Gmail/Calendar APIs (external)
   - D1 for email/calendar storage

4. **Bridge** depends on:
   - Nexus (for data)
   - Mnemo (optional, for cache status)
   - None of: DE (direct access not allowed)

5. **Claude Code** depends on:
   - Mnemo (via MCP, optional)
   - No dependencies on: DE, Nexus, Bridge (runs locally)

### Anti-Patterns (Forbidden)

- ❌ Bridge → DE (direct calls)
- ❌ Mnemo → Nexus (Mnemo should be generic)
- ❌ Mnemo → DE (avoid circular dependency)
- ❌ Claude Code → Nexus (local vs cloud boundary)
```

---

## Summary of Proposed Changes

| Section | Guide | Priority | Rationale |
|---------|-------|----------|-----------|
| Project Glossary | Main Guide | High | Prevents confusion across services |
| Database Decision Tree | Infrastructure | High | Clarifies "D1 by default" policy |
| LLM Tier Pattern | Architecture | Medium | Reusable pattern for cost optimization |
| Multi-Account OAuth | Auth | High | Required for Nexus Gmail integration |
| Email Routing | Integration | High | Nexus needs email processing |
| Frontend Deploy | Deployment | Medium | Bridge needs tech stack guidance |
| Service Dependencies | Architecture | High | Prevents circular dependencies |

---

**Next Steps**:
1. Review with team leads
2. Prioritize additions (High priority first)
3. Update official developer guides
4. Create code examples for each pattern
5. Add to developer MCP server knowledge base
