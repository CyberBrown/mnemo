#!/bin/bash
# Deploy Mnemo CF Worker with D1 migration
# Run this after wrangler login

set -e

echo "Running D1 migration for cache_content table..."
bunx wrangler d1 execute mnemo-cache --remote --command "CREATE TABLE IF NOT EXISTS cache_content (cache_name TEXT PRIMARY KEY, content TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);"

bunx wrangler d1 execute mnemo-cache --remote --command "CREATE INDEX IF NOT EXISTS idx_cache_content_expires ON cache_content(expires_at);"

echo "Migration complete. Deploying to Cloudflare..."
bun run deploy

echo "Done! Test with:"
echo "  curl https://mnemo.logosflux.io/health"
