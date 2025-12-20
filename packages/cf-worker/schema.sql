-- Mnemo D1 Schema
-- Stores cache metadata and usage logs

-- Cache metadata table
CREATE TABLE IF NOT EXISTS caches (
  id TEXT PRIMARY KEY,
  alias TEXT UNIQUE NOT NULL,
  gemini_cache_name TEXT NOT NULL,
  source TEXT NOT NULL,
  token_count INTEGER DEFAULT 0,
  model TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  user_id TEXT,
  system_instruction TEXT
);

-- Index for alias lookups (most common)
CREATE INDEX IF NOT EXISTS idx_caches_alias ON caches(alias);

-- Index for expiry cleanup
CREATE INDEX IF NOT EXISTS idx_caches_expires ON caches(expires_at);

-- Index for user isolation (if multi-tenant)
CREATE INDEX IF NOT EXISTS idx_caches_user ON caches(user_id);

-- Usage logs table
-- Note: cache_id stores the Gemini cache name, not foreign key to caches.id
CREATE TABLE IF NOT EXISTS usage_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cache_id TEXT,
  operation TEXT NOT NULL, -- 'load', 'query', 'evict'
  tokens_used INTEGER DEFAULT 0,
  cached_tokens_used INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Index for cache usage aggregation
CREATE INDEX IF NOT EXISTS idx_usage_cache ON usage_logs(cache_id);

-- Index for time-based queries
CREATE INDEX IF NOT EXISTS idx_usage_time ON usage_logs(created_at);

-- Cache content table for local model storage
-- Stores actual content for local models (unlike Gemini which stores on their servers)
CREATE TABLE IF NOT EXISTS cache_content (
  cache_name TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Index for expiry cleanup
CREATE INDEX IF NOT EXISTS idx_cache_content_expires ON cache_content(expires_at);

-- Async query jobs table
-- Stores pending/completed async query jobs for long-running queries
CREATE TABLE IF NOT EXISTS async_jobs (
  id TEXT PRIMARY KEY,
  cache_alias TEXT NOT NULL,
  query TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'processing', 'complete', 'failed'
  result TEXT, -- JSON-encoded QueryResult on success
  error TEXT, -- Error message on failure
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL -- Auto-cleanup after TTL
);

-- Index for status polling
CREATE INDEX IF NOT EXISTS idx_async_jobs_status ON async_jobs(status);

-- Index for expiry cleanup
CREATE INDEX IF NOT EXISTS idx_async_jobs_expires ON async_jobs(expires_at);
