#!/usr/bin/env bun

/**
 * Seed Claude Code conversation history into Mnemo's R2 bucket for AI Search indexing.
 *
 * Reads ~/.claude/projects/ locally, formats sessions as Markdown,
 * and uploads to R2 via the Cloudflare API. AI Search auto-indexes from R2.
 * Tracks last sync time for incremental updates.
 *
 * For a standalone version (no monorepo install needed), see:
 *   scripts/mnemo-sync-history.ts
 *
 * Usage:
 *   bun run packages/local/src/seed-history.ts [options]
 *
 * Options:
 *   --path <path>        Path to .claude/projects/ (default: ~/.claude/projects)
 *   --alias <name>       R2 prefix alias (default: claude-history-<hostname>)
 *   --full               Ignore last sync time, re-upload everything
 *   --dry-run            Show what would be uploaded without uploading
 *   --include-agents     Include agent sub-conversations
 *   --include-temp       Include -tmp project directory
 *
 * Environment:
 *   CLOUDFLARE_ACCOUNT_ID  - Required
 *   CLOUDFLARE_API_TOKEN   - Required
 *   R2_BUCKET_NAME         - R2 bucket (default: mnemo-content)
 *   MNEMO_SYNC_DIR         - State directory (default: ~/.mnemo)
 */

import { homedir, hostname } from 'os';
import { join } from 'path';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { ClaudeHistoryAdapter } from '@mnemo/core';

// Parse CLI args
const args = process.argv.slice(2);
function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}
function hasFlag(name: string): boolean {
  return args.includes(`--${name}`);
}

const sourcePath = getArg('path') ?? join(homedir(), '.claude', 'projects');
const alias = getArg('alias') ?? `claude-history-${hostname()}`;
const fullSync = hasFlag('full');
const dryRun = hasFlag('dry-run');
const includeAgents = hasFlag('include-agents');
const includeTemp = hasFlag('include-temp');

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const BUCKET_NAME = process.env.R2_BUCKET_NAME ?? 'mnemo-content';
const SYNC_DIR = process.env.MNEMO_SYNC_DIR ?? join(homedir(), '.mnemo');
const STATE_FILE = join(SYNC_DIR, 'sync-state.json');

interface SyncState {
  lastSyncAt: string;
  lastSessionCount: number;
  totalSyncs: number;
}

async function loadState(): Promise<SyncState | null> {
  try {
    const raw = await readFile(STATE_FILE, 'utf-8');
    return JSON.parse(raw) as SyncState;
  } catch {
    return null;
  }
}

async function saveState(state: SyncState): Promise<void> {
  await mkdir(SYNC_DIR, { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

if (!dryRun && (!ACCOUNT_ID || !API_TOKEN)) {
  console.error('Error: CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required');
  console.error('Set them in your environment or use --dry-run to preview');
  process.exit(1);
}

async function uploadToR2(key: string, content: string, metadata: Record<string, string>): Promise<void> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/r2/buckets/${BUCKET_NAME}/objects/${encodeURIComponent(key)}`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${API_TOKEN}`,
    'Content-Type': 'text/markdown',
  };

  for (const [k, v] of Object.entries(metadata)) {
    headers[`cf-r2-meta-${k}`] = v;
  }

  const response = await fetch(url, { method: 'PUT', headers, body: content });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`R2 upload failed for ${key}: ${response.status} ${text}`);
  }
}

async function main() {
  // Determine since date for incremental sync
  let since: string | undefined;
  const state = await loadState();

  if (!fullSync && state) {
    since = state.lastSyncAt;
    console.log(`Incremental sync since: ${since}`);
  } else {
    console.log('Full sync (no previous state or --full flag)');
  }

  console.log(`Source: ${sourcePath}`);
  console.log(`Alias: ${alias}`);
  if (dryRun) console.log('(dry run)');
  console.log('');

  const syncStartTime = new Date();
  const adapter = new ClaudeHistoryAdapter();
  const result = await adapter.load({
    type: 'claude-history',
    path: sourcePath,
    options: { includeAgents, includeTemp, since },
  });

  console.log(`Found ${result.fileCount} sessions across ${result.metadata.projectCount} projects`);
  console.log(`Total tokens: ~${result.totalTokens.toLocaleString()}`);
  console.log('');

  if (result.fileCount === 0) {
    console.log('No new sessions to sync.');
    if (!dryRun) {
      await saveState({
        lastSyncAt: syncStartTime.toISOString(),
        lastSessionCount: 0,
        totalSyncs: (state?.totalSyncs ?? 0) + 1,
      });
    }
    return;
  }

  if (dryRun) {
    console.log('Sessions that would be uploaded:');
    for (const file of result.files) {
      console.log(`  ${file.path} (~${file.tokenEstimate.toLocaleString()} tokens)`);
    }
    return;
  }

  // Upload individual session files
  let uploaded = 0;
  for (const file of result.files) {
    const key = `${alias}/files/${file.path}.md`;
    await uploadToR2(key, file.content, {
      alias,
      filePath: file.path,
      tokenEstimate: String(file.tokenEstimate),
      syncedAt: syncStartTime.toISOString(),
    });
    uploaded++;
    if (uploaded % 10 === 0) {
      console.log(`  Uploaded ${uploaded}/${result.fileCount} sessions...`);
    }
  }

  // Save state
  await saveState({
    lastSyncAt: syncStartTime.toISOString(),
    lastSessionCount: result.fileCount,
    totalSyncs: (state?.totalSyncs ?? 0) + 1,
  });

  console.log(`\nSynced ${uploaded} sessions to R2 "${BUCKET_NAME}/${alias}/"`);
  console.log(`State saved to ${STATE_FILE}`);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
