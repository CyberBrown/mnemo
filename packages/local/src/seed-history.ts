#!/usr/bin/env bun

/**
 * Seed Claude Code conversation history into Mnemo's R2 bucket for AI Search indexing.
 *
 * Reads ~/.claude/projects/ locally, formats sessions as Markdown,
 * and uploads to R2 via the Cloudflare API. AI Search auto-indexes from R2.
 *
 * Usage:
 *   bun run packages/local/src/seed-history.ts [options]
 *
 * Options:
 *   --path <path>        Path to .claude/projects/ (default: ~/.claude/projects)
 *   --alias <name>       R2 prefix alias (default: claude-history-<hostname>)
 *   --since <date>       Only index sessions after this ISO date
 *   --include-agents     Include agent sub-conversations
 *   --include-temp       Include -tmp project directory
 *   --dry-run            Show what would be uploaded without uploading
 *
 * Environment:
 *   CLOUDFLARE_ACCOUNT_ID  - Required
 *   CLOUDFLARE_API_TOKEN   - Required
 *   R2_BUCKET_NAME         - R2 bucket (default: mnemo-content)
 */

import { homedir, hostname } from 'os';
import { join } from 'path';
import { ClaudeHistoryAdapter } from '@mnemo/core';

// Parse CLI args
const args = process.argv.slice(2);
function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  return args[idx + 1];
}
function hasFlag(name: string): boolean {
  return args.includes(`--${name}`);
}

const sourcePath = getArg('path') ?? join(homedir(), '.claude', 'projects');
const alias = getArg('alias') ?? `claude-history-${hostname()}`;
const since = getArg('since');
const includeAgents = hasFlag('include-agents');
const includeTemp = hasFlag('include-temp');
const dryRun = hasFlag('dry-run');

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const BUCKET_NAME = process.env.R2_BUCKET_NAME ?? 'mnemo-content';

if (!dryRun && (!ACCOUNT_ID || !API_TOKEN)) {
  console.error('Error: CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required');
  console.error('Set them in your environment or use --dry-run to preview');
  process.exit(1);
}

async function uploadToR2(key: string, content: string, metadata: Record<string, string>): Promise<void> {
  // Cloudflare R2 S3-compatible API
  // Using the Cloudflare API directly since we need custom metadata
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/r2/buckets/${BUCKET_NAME}/objects/${encodeURIComponent(key)}`;

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${API_TOKEN}`,
    'Content-Type': 'text/markdown',
  };

  // R2 custom metadata via cf-r2-meta- headers
  for (const [k, v] of Object.entries(metadata)) {
    headers[`cf-r2-meta-${k}`] = v;
  }

  const response = await fetch(url, {
    method: 'PUT',
    headers,
    body: content,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`R2 upload failed for ${key}: ${response.status} ${text}`);
  }
}

async function main() {
  console.log(`Reading Claude history from: ${sourcePath}`);
  console.log(`Alias: ${alias}`);
  if (since) console.log(`Since: ${since}`);
  if (dryRun) console.log('(dry run - no uploads)');
  console.log('');

  const adapter = new ClaudeHistoryAdapter();
  const result = await adapter.load({
    type: 'claude-history',
    path: sourcePath,
    options: {
      includeAgents,
      includeTemp,
      since,
    },
  });

  console.log(`Found ${result.fileCount} sessions across ${result.metadata.projectCount} projects`);
  console.log(`Total tokens: ~${result.totalTokens.toLocaleString()}`);
  console.log('');

  if (result.fileCount === 0) {
    console.log('No sessions to upload.');
    return;
  }

  if (dryRun) {
    console.log('Sessions that would be uploaded:');
    for (const file of result.files) {
      console.log(`  ${file.path} (~${file.tokenEstimate.toLocaleString()} tokens)`);
    }
    return;
  }

  // Upload combined content.md
  console.log('Uploading combined content...');
  await uploadToR2(`${alias}/content.md`, result.content, {
    alias,
    source: sourcePath,
    fileCount: String(result.fileCount),
    totalTokens: String(result.totalTokens),
    indexedAt: new Date().toISOString(),
    hostname: hostname(),
  });

  // Upload individual session files for better AI Search chunking
  let uploaded = 0;
  for (const file of result.files) {
    const key = `${alias}/files/${file.path}.md`;
    await uploadToR2(key, file.content, {
      alias,
      filePath: file.path,
      tokenEstimate: String(file.tokenEstimate),
    });
    uploaded++;
    if (uploaded % 10 === 0) {
      console.log(`  Uploaded ${uploaded}/${result.fileCount} sessions...`);
    }
  }

  console.log(`\nDone! Uploaded ${uploaded} sessions to R2 bucket "${BUCKET_NAME}" under "${alias}/"`);
  console.log('AI Search will auto-index the content.');
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
