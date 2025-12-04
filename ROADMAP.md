# Mnemo Roadmap

## Current: v0.1 - Static Context Cache
Manual load/query/evict of repo and document sources via MCP tools.

---

## v0.2 - Source Adapters

Extensible loader architecture for diverse context sources:

```
sources/
  repo.ts        # ✓ Git repositories
  docs.ts        # Doc site crawler (Cloudflare docs, MDN, etc)
  notion.ts      # Notion API workspace export
  slack.ts       # Slack channel/thread export
  gdrive.ts      # Google Drive folder
  obsidian.ts    # Obsidian vault
  transcript.ts  # Meeting transcripts (Otter, Fireflies)
  email.ts       # Gmail/email thread exports
```

Composite loading - multiple sources into single cache:
```typescript
context_load({
  sources: [
    { type: "repo", path: "./my-project" },
    { type: "docs", url: "https://docs.example.com" },
    { type: "slack", channel: "project-x" }
  ],
  alias: "full-project-context"
})
```

---

## v0.3 - Active Memory Manager

**The big idea**: Instead of manual cache management, an always-running layer that actively manages context in real-time based on what Claude is doing.

### Core Concepts

**Session Awareness**
- Detects current project/task from conversation flow
- Understands working context ("I'm debugging the auth module")
- Tracks topic transitions

**Proactive Loading**
- Pre-loads relevant context before it's needed
- File mentioned? Load the repo it's in
- Error message? Load relevant docs
- Client name? Load their project folder

**Relevance Scoring**
- Scores cached content by current relevance
- Recently queried = high relevance
- Mentioned in conversation = boosted
- Time decay for unused context

**Memory Tiers**
```
┌─────────────────────────────────────┐
│  HOT CACHE (Gemini)                 │
│  Active working context             │
│  Full fidelity, instant query       │
│  ~500k-900k tokens                  │
├─────────────────────────────────────┤
│  WARM CACHE (Summarized)            │
│  Recently used, compressed          │
│  Key facts + structure preserved    │
│  Can be re-expanded on demand       │
├─────────────────────────────────────┤
│  COLD STORAGE (Indexed)             │
│  Historical context                 │
│  Embeddings + metadata only         │
│  Requires explicit retrieval        │
└─────────────────────────────────────┘
```

**Automatic Lifecycle**
- New context → HOT
- Unused for N queries → compress to WARM
- Unused for N hours → demote to COLD
- Re-referenced → promote back up

### Architecture

```
┌──────────────────────────────────────────────────┐
│                 Memory Orchestrator               │
│  ┌────────────┐ ┌────────────┐ ┌──────────────┐  │
│  │  Session   │ │  Loader    │ │   Eviction   │  │
│  │  Tracker   │ │  Manager   │ │   Policy     │  │
│  └─────┬──────┘ └──────┬─────┘ └──────┬───────┘  │
│        │               │              │          │
│        └───────────────┼──────────────┘          │
│                        ▼                         │
│              ┌─────────────────┐                 │
│              │  Cache Router   │                 │
│              └────────┬────────┘                 │
└───────────────────────┼──────────────────────────┘
                        │
        ┌───────────────┼───────────────┐
        ▼               ▼               ▼
   ┌─────────┐    ┌──────────┐    ┌──────────┐
   │ Gemini  │    │ Summary  │    │ Vector   │
   │ Cache   │    │ Store    │    │ Store    │
   │ (HOT)   │    │ (WARM)   │    │ (COLD)   │
   └─────────┘    └──────────┘    └──────────┘
```

### New MCP Tools

```typescript
// Passive tools (orchestrator decides what to load)
context_hint(topic: string)     // "I'm working on auth"
context_focus(alias: string)    // Prioritize this cache
context_blur(alias: string)     // Deprioritize

// Introspection
context_status()                // What's loaded, relevance scores
context_history()               // What was queried, when

// Override when needed
context_pin(alias: string)      // Never auto-evict
context_unpin(alias: string)
```

### Trigger Patterns

The orchestrator watches for signals:

| Signal | Action |
|--------|--------|
| File path mentioned | Load containing repo |
| Error/stack trace | Load relevant docs + repo |
| "Working on X project" | Load X's context |
| API mentioned | Load API docs |
| Client/project name | Load associated folder |
| Long silence | Compress to WARM |
| Session end | Demote all to COLD |

### Compression Strategies

When moving HOT → WARM:
- **Code**: Keep types, interfaces, function signatures. Summarize implementations.
- **Docs**: Keep headings, key concepts, examples. Drop verbose explanations.
- **Conversations**: Keep decisions, action items. Drop chit-chat.
- **Data**: Keep schema, sample rows. Drop bulk content.

---

## v0.4 - Multi-Model Routing

Use the right model for the right query:

| Query Type | Route To |
|------------|----------|
| "What does X do?" | Gemini Flash (fast, cheap) |
| "Analyze this architecture" | Gemini Pro (deeper reasoning) |
| "Find the bug in..." | Claude (superior code reasoning) |
| "Summarize for compression" | Flash (bulk processing) |

---

## v0.5 - Persistent Memory Layer

Integration with long-term memory systems:
- Sync with OpenMemory for persistent facts
- Session summaries → long-term storage
- Cross-session context ("last time we worked on X...")
- User preference learning

---

## Future Explorations

**Collaborative Memory**
- Shared team caches
- "Load what Sarah was working on"
- Project handoff context

**Self-Improving Context**
- Track which cached content actually gets used
- Prune rarely-accessed sections
- Learn optimal loading patterns per project type

**Streaming Context**
- Real-time file watchers
- Auto-reload on file changes
- Live doc sync

**Context Diff**
- "What changed since I last looked at this?"
- Highlight new/modified sections
- Git-aware change tracking
