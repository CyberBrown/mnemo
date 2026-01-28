#!/usr/bin/env bun

/**
 * mnemo-sync-history — Standalone script to sync Claude Code conversation
 * history to Mnemo's R2 bucket for AI Search indexing.
 *
 * Zero dependencies beyond Bun. No monorepo install needed.
 * Tracks last sync time for incremental updates.
 *
 * Install on any machine:
 *   curl -fsSL https://raw.githubusercontent.com/CyberBrown/mnemo/main/scripts/mnemo-sync-history.ts -o ~/.local/bin/mnemo-sync-history.ts
 *   chmod +x ~/.local/bin/mnemo-sync-history.ts
 *
 * Setup:
 *   export CLOUDFLARE_ACCOUNT_ID=your_account_id
 *   export CLOUDFLARE_API_TOKEN=your_api_token
 *
 * Usage:
 *   bun run mnemo-sync-history.ts              # Incremental sync (only new/updated sessions)
 *   bun run mnemo-sync-history.ts --full       # Full re-sync of all sessions
 *   bun run mnemo-sync-history.ts --dry-run    # Preview without uploading
 *   bun run mnemo-sync-history.ts --cron       # Install as hourly cron job
 *
 * Options:
 *   --path <path>        Path to .claude/projects/ (default: ~/.claude/projects)
 *   --alias <name>       R2 prefix (default: claude-history-<hostname>)
 *   --full               Ignore last sync time, re-upload everything
 *   --dry-run            Show what would be uploaded
 *   --cron               Install/update cron job for hourly sync
 *   --include-agents     Include agent sub-conversations
 *   --include-temp       Include -tmp project directory
 *   --max-content <n>    Max chars per message (default: 2000)
 *
 * Environment:
 *   CLOUDFLARE_ACCOUNT_ID  - Required
 *   CLOUDFLARE_API_TOKEN   - Required
 *   R2_BUCKET_NAME         - R2 bucket (default: mnemo-content)
 *   MNEMO_SYNC_DIR         - State directory (default: ~/.mnemo)
 */

import { readdir, readFile, stat, mkdir, writeFile } from 'fs/promises';
import { join, basename, resolve } from 'path';
import { homedir, hostname } from 'os';
import { execSync } from 'child_process';

// ============================================================================
// CLI Argument Parsing
// ============================================================================

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
const installCron = hasFlag('cron');
const includeAgents = hasFlag('include-agents');
const includeTemp = hasFlag('include-temp');
const maxContent = parseInt(getArg('max-content') ?? '2000');

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const BUCKET_NAME = process.env.R2_BUCKET_NAME ?? 'mnemo-files';
const SYNC_DIR = process.env.MNEMO_SYNC_DIR ?? join(homedir(), '.mnemo');
const STATE_FILE = join(SYNC_DIR, 'sync-state.json');

// ============================================================================
// State Management
// ============================================================================

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

// ============================================================================
// Cron Installation
// ============================================================================

function installCronJob(): void {
  const scriptPath = resolve(process.argv[1]);
  const cronLine = `0 * * * * CLOUDFLARE_ACCOUNT_ID=${ACCOUNT_ID} CLOUDFLARE_API_TOKEN=${API_TOKEN} ${process.argv[0]} ${scriptPath} >> ${join(SYNC_DIR, 'sync.log')} 2>&1`;

  try {
    let existing = '';
    try {
      existing = execSync('crontab -l 2>/dev/null', { encoding: 'utf-8' });
    } catch {
      // No existing crontab
    }

    // Remove any existing mnemo-sync-history entries
    const filtered = existing
      .split('\n')
      .filter((line) => !line.includes('mnemo-sync-history'))
      .join('\n')
      .trim();

    const newCrontab = filtered ? `${filtered}\n${cronLine}\n` : `${cronLine}\n`;
    execSync(`echo ${JSON.stringify(newCrontab)} | crontab -`, { encoding: 'utf-8' });

    console.log('Installed hourly cron job for mnemo-sync-history');
    console.log(`Logs: ${join(SYNC_DIR, 'sync.log')}`);
    console.log(`Cron entry: ${cronLine}`);
  } catch (err) {
    console.error('Failed to install cron:', (err as Error).message);
    process.exit(1);
  }
}

// ============================================================================
// R2 Upload
// ============================================================================

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

// ============================================================================
// Claude History Parser (self-contained, no @mnemo/core dependency)
// ============================================================================

interface SessionIndexEntry {
  sessionId: string;
  firstPrompt?: string;
  summary?: string;
  created?: string;
  modified?: string;
  gitBranch?: string;
  projectPath?: string;
  isSidechain?: boolean;
}

interface ParsedFile {
  path: string;
  content: string;
  size: number;
  tokenEstimate: number;
}

async function hasJsonlFiles(dirPath: string): Promise<boolean> {
  try {
    const entries = await readdir(dirPath);
    return entries.some((e) => e.endsWith('.jsonl') && !e.startsWith('agent-'));
  } catch {
    return false;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '\n[...truncated]';
}

function extractUserText(parsed: Record<string, unknown>): string | null {
  const message = parsed.message as Record<string, unknown> | undefined;
  if (!message) return null;
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const block of content) {
      if (typeof block === 'object' && block !== null) {
        const b = block as Record<string, unknown>;
        if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text);
      }
    }
    return texts.length > 0 ? texts.join('\n') : null;
  }
  return null;
}

function extractAssistantText(parsed: Record<string, unknown>): string | null {
  const message = parsed.message as Record<string, unknown> | undefined;
  if (!message) return null;
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const block of content) {
      if (typeof block === 'object' && block !== null) {
        const b = block as Record<string, unknown>;
        if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text);
      }
    }
    return texts.length > 0 ? texts.join('\n') : null;
  }
  return null;
}

async function parseSession(
  filePath: string,
  entry: SessionIndexEntry,
  projectName: string
): Promise<string | null> {
  const raw = await readFile(filePath, 'utf-8');
  const lines = raw.trim().split('\n');

  const header = `# Session: ${entry.summary || entry.firstPrompt || 'Unknown'}
Project: ${projectName} | Path: ${entry.projectPath || 'unknown'}${entry.gitBranch ? ` | Branch: ${entry.gitBranch}` : ''}
Date: ${entry.created || 'unknown'} - ${entry.modified || 'unknown'}`;

  const turns: string[] = [];
  for (const line of lines) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const type = parsed.type as string;
    if (type === 'summary' || type === 'file-history-snapshot') continue;
    if (type === 'user') {
      const text = extractUserText(parsed);
      if (text) turns.push(`## User\n${truncate(text, maxContent)}`);
    } else if (type === 'assistant') {
      const text = extractAssistantText(parsed);
      if (text) turns.push(`## Assistant\n${truncate(text, maxContent)}`);
    }
  }
  if (turns.length === 0) return null;
  return `${header}\n\n${turns.join('\n\n')}`;
}

async function parseAgentSession(
  filePath: string,
  agentId: string,
  projectName: string
): Promise<string | null> {
  const raw = await readFile(filePath, 'utf-8');
  const lines = raw.trim().split('\n');
  const header = `# Agent Session: ${agentId}\nProject: ${projectName}`;
  const turns: string[] = [];
  for (const line of lines) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const type = parsed.type as string;
    if (type === 'summary' || type === 'file-history-snapshot') continue;
    if (type === 'user') {
      const text = extractUserText(parsed);
      if (text) turns.push(`## User\n${truncate(text, maxContent)}`);
    } else if (type === 'assistant') {
      const text = extractAssistantText(parsed);
      if (text) turns.push(`## Assistant\n${truncate(text, maxContent)}`);
    }
  }
  if (turns.length === 0) return null;
  return `${header}\n\n${turns.join('\n\n')}`;
}

async function loadHistory(sinceDate?: Date): Promise<{ files: ParsedFile[]; projectCount: number }> {
  const files: ParsedFile[] = [];

  const rootStats = await stat(sourcePath);
  if (!rootStats.isDirectory()) throw new Error(`Not a directory: ${sourcePath}`);

  // Find project dirs
  const hasIndex = await fileExists(join(sourcePath, 'sessions-index.json'));
  const projectDirs: { name: string; path: string }[] = [];

  if (hasIndex) {
    projectDirs.push({ name: basename(sourcePath), path: sourcePath });
  } else {
    const entries = await readdir(sourcePath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!includeTemp && entry.name === '-tmp') continue;
      const dirPath = join(sourcePath, entry.name);
      if (await fileExists(join(dirPath, 'sessions-index.json'))) {
        projectDirs.push({ name: entry.name, path: dirPath });
      } else if (await hasJsonlFiles(dirPath)) {
        projectDirs.push({ name: entry.name, path: dirPath });
      }
    }
  }

  for (const project of projectDirs) {
    let index: { entries: SessionIndexEntry[] } | null = null;
    try {
      const raw = await readFile(join(project.path, 'sessions-index.json'), 'utf-8');
      index = JSON.parse(raw);
    } catch {
      // No index — will scan .jsonl files directly
    }

    if (index) {
      for (const entry of index.entries) {
        if (sinceDate && entry.modified && new Date(entry.modified) < sinceDate) continue;
        if (entry.isSidechain) continue;

        const sessionFile = join(project.path, `${entry.sessionId}.jsonl`);
        if (!(await fileExists(sessionFile))) continue;

        try {
          const content = await parseSession(sessionFile, entry, project.name);
          if (!content) continue;
          const size = Buffer.byteLength(content, 'utf-8');
          files.push({ path: `${project.name}/${entry.sessionId}`, content, size, tokenEstimate: Math.ceil(size / 4) });
        } catch {
          // Skip malformed
        }
      }

      if (includeAgents) {
        const dirEntries = await readdir(project.path);
        for (const fname of dirEntries) {
          if (!fname.startsWith('agent-') || !fname.endsWith('.jsonl')) continue;
          const agentId = fname.replace('.jsonl', '');
          try {
            const content = await parseAgentSession(join(project.path, fname), agentId, project.name);
            if (!content) continue;
            const size = Buffer.byteLength(content, 'utf-8');
            files.push({ path: `${project.name}/${agentId}`, content, size, tokenEstimate: Math.ceil(size / 4) });
          } catch { /* Skip */ }
        }
      }
    } else {
      // No index — discover sessions from .jsonl files
      const dirEntries = await readdir(project.path);
      for (const fname of dirEntries) {
        if (!fname.endsWith('.jsonl')) continue;
        if (fname.startsWith('agent-') && !includeAgents) continue;

        const filePath = join(project.path, fname);
        const sessionId = fname.replace('.jsonl', '');

        if (sinceDate) {
          const fstat = await stat(filePath);
          if (fstat.mtime < sinceDate) continue;
        }

        try {
          const entry: SessionIndexEntry = { sessionId, projectPath: project.name };
          // Try to extract summary from first line
          const raw = await readFile(filePath, 'utf-8');
          const firstLine = raw.split('\n')[0];
          try {
            const parsed = JSON.parse(firstLine);
            if (parsed.type === 'summary' && parsed.summary) entry.summary = parsed.summary;
          } catch { /* ignore */ }

          const isAgent = fname.startsWith('agent-');
          const content = isAgent
            ? await parseAgentSession(filePath, sessionId, project.name)
            : await parseSession(filePath, entry, project.name);
          if (!content) continue;

          const size = Buffer.byteLength(content, 'utf-8');
          files.push({ path: `${project.name}/${sessionId}`, content, size, tokenEstimate: Math.ceil(size / 4) });
        } catch { /* Skip */ }
      }
    }
  }

  return { files, projectCount: projectDirs.length };
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  if (installCron) {
    if (!ACCOUNT_ID || !API_TOKEN) {
      console.error('Error: CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be set to install cron');
      process.exit(1);
    }
    await mkdir(SYNC_DIR, { recursive: true });
    installCronJob();
    return;
  }

  if (!dryRun && (!ACCOUNT_ID || !API_TOKEN)) {
    console.error('Error: CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required');
    console.error('Set them in your environment or use --dry-run to preview');
    process.exit(1);
  }

  // Determine since date for incremental sync
  let sinceDate: Date | undefined;
  const state = await loadState();

  if (!fullSync && state) {
    sinceDate = new Date(state.lastSyncAt);
    console.log(`Incremental sync since: ${sinceDate.toISOString()}`);
  } else {
    console.log('Full sync (no previous state or --full flag)');
  }

  console.log(`Source: ${sourcePath}`);
  console.log(`Alias: ${alias}`);
  if (dryRun) console.log('(dry run)');
  console.log('');

  const syncStartTime = new Date();
  const { files, projectCount } = await loadHistory(sinceDate);
  const totalTokens = files.reduce((sum, f) => sum + f.tokenEstimate, 0);

  console.log(`Found ${files.length} sessions across ${projectCount} projects`);
  console.log(`Total tokens: ~${totalTokens.toLocaleString()}`);
  console.log('');

  if (files.length === 0) {
    console.log('No new sessions to sync.');
    // Still update timestamp so next run skips these
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
    for (const file of files) {
      console.log(`  ${file.path} (~${file.tokenEstimate.toLocaleString()} tokens)`);
    }
    return;
  }

  // Upload individual session files (skip combined content.md for incremental — AI Search works better with individual files)
  let uploaded = 0;
  for (const file of files) {
    const key = `${alias}/files/${file.path}.md`;
    await uploadToR2(key, file.content, {
      alias,
      filePath: file.path,
      tokenEstimate: String(file.tokenEstimate),
      syncedAt: syncStartTime.toISOString(),
    });
    uploaded++;
    if (uploaded % 10 === 0) {
      console.log(`  Uploaded ${uploaded}/${files.length} sessions...`);
    }
  }

  // Save state for next incremental run
  await saveState({
    lastSyncAt: syncStartTime.toISOString(),
    lastSessionCount: files.length,
    totalSyncs: (state?.totalSyncs ?? 0) + 1,
  });

  console.log(`\nSynced ${uploaded} sessions to R2 "${BUCKET_NAME}/${alias}/"`);
  console.log(`State saved to ${STATE_FILE}`);
}

main().catch((err) => {
  console.error(`[${new Date().toISOString()}] Error:`, err.message);
  process.exit(1);
});
