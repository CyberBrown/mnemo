#!/bin/bash
# Deploy Mnemo CF Worker with D1 migration
# Run this after wrangler login

set -e

echo "Running D1 migration for cache_content table..."
bunx wrangler d1 execute mnemo-cache --remote --command "CREATE TABLE IF NOT EXISTS cache_content (cache_name TEXT PRIMARY KEY, content TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);"

bunx wrangler d1 execute mnemo-cache --remote --command "CREATE INDEX IF NOT EXISTS idx_cache_content_expires ON cache_content(expires_at);"

echo "Running D1 migration for async_jobs table..."
bunx wrangler d1 execute mnemo-cache --remote --command "CREATE TABLE IF NOT EXISTS async_jobs (id TEXT PRIMARY KEY, cache_alias TEXT NOT NULL, query TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', result TEXT, error TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, expires_at TEXT NOT NULL);"

bunx wrangler d1 execute mnemo-cache --remote --command "CREATE INDEX IF NOT EXISTS idx_async_jobs_status ON async_jobs(status);"

bunx wrangler d1 execute mnemo-cache --remote --command "CREATE INDEX IF NOT EXISTS idx_async_jobs_expires ON async_jobs(expires_at);"

echo "Running D1 migration for repo_indexes table (Vectorize RAG)..."
bunx wrangler d1 execute mnemo-cache --remote --command "CREATE TABLE IF NOT EXISTS repo_indexes (id TEXT PRIMARY KEY, alias TEXT UNIQUE NOT NULL, source TEXT NOT NULL, chunk_count INTEGER DEFAULT 0, total_tokens INTEGER DEFAULT 0, file_count INTEGER DEFAULT 0, indexed_at TEXT DEFAULT CURRENT_TIMESTAMP, expires_at TEXT, status TEXT DEFAULT 'active');"

bunx wrangler d1 execute mnemo-cache --remote --command "CREATE INDEX IF NOT EXISTS idx_repo_indexes_alias ON repo_indexes(alias);"

bunx wrangler d1 execute mnemo-cache --remote --command "CREATE INDEX IF NOT EXISTS idx_repo_indexes_status ON repo_indexes(status);"

bunx wrangler d1 execute mnemo-cache --remote --command "CREATE INDEX IF NOT EXISTS idx_repo_indexes_expires ON repo_indexes(expires_at);"

echo "Running D1 migration for repo_chunks table (RAG chunk storage)..."
bunx wrangler d1 execute mnemo-cache --remote --command "CREATE TABLE IF NOT EXISTS repo_chunks (id TEXT PRIMARY KEY, repo_alias TEXT NOT NULL, file_path TEXT NOT NULL, chunk_index INTEGER NOT NULL, content TEXT NOT NULL, start_line INTEGER, end_line INTEGER, token_count INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP);"

bunx wrangler d1 execute mnemo-cache --remote --command "CREATE INDEX IF NOT EXISTS idx_repo_chunks_alias ON repo_chunks(repo_alias);"

bunx wrangler d1 execute mnemo-cache --remote --command "CREATE INDEX IF NOT EXISTS idx_repo_chunks_file ON repo_chunks(repo_alias, file_path);"

echo "Migration complete. Deploying to Cloudflare..."
bun run deploy

echo "Done! Test with:"
echo "  curl https://mnemo.solamp.workers.dev/health"
