/**
 * Claude Code history adapter
 * Loads conversation history from ~/.claude/projects/ for indexing
 */

import { readdir, readFile, stat } from 'fs/promises';
import { join, basename } from 'path';
import type { LoadedSource, FileInfo } from '../types';
import { LoadError } from '../types';
import type { SourceAdapter, SourceConfig, AdapterLoadOptions } from './base';

export interface ClaudeHistoryOptions {
  /** Include agent-*.jsonl sub-conversations (default: false) */
  includeAgents?: boolean;
  /** Include -tmp project directory (default: false) */
  includeTemp?: boolean;
  /** Only index specific project directories */
  projectFilter?: string[];
  /** Only index sessions modified after this ISO date */
  since?: string;
  /** Truncate long assistant messages (default: 2000 chars) */
  maxContentPerMessage?: number;
}

interface SessionIndexEntry {
  sessionId: string;
  fullPath: string;
  fileMtime: number;
  firstPrompt?: string;
  summary?: string;
  messageCount?: number;
  created?: string;
  modified?: string;
  gitBranch?: string;
  projectPath?: string;
  isSidechain?: boolean;
}

interface SessionsIndex {
  version: number;
  entries: SessionIndexEntry[];
}

/**
 * Adapter for loading Claude Code conversation history
 * Parses JSONL session files from ~/.claude/projects/
 */
export class ClaudeHistoryAdapter implements SourceAdapter {
  readonly type = 'claude-history';
  readonly name = 'Claude Code History';

  canHandle(source: SourceConfig): boolean {
    return (
      source.type === 'claude-history' ||
      (!!source.path && source.path.includes('.claude/projects'))
    );
  }

  async load(source: SourceConfig, options?: AdapterLoadOptions): Promise<LoadedSource> {
    const sourcePath = source.path;
    if (!sourcePath) {
      throw new LoadError('claude-history', 'No path provided');
    }

    const opts: ClaudeHistoryOptions = (source.options ?? {}) as ClaudeHistoryOptions;
    const maxContent = opts.maxContentPerMessage ?? 2000;
    const sinceDate = opts.since ? new Date(opts.since) : undefined;

    try {
      const stats = await stat(sourcePath);
      if (!stats.isDirectory()) {
        throw new LoadError(sourcePath, 'Path must be a directory');
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new LoadError(sourcePath, 'Directory not found');
      }
      throw e;
    }

    const files: FileInfo[] = [];

    // Determine if this is the root projects dir or a single project dir
    const hasSessionsIndex = await fileExists(join(sourcePath, 'sessions-index.json'));
    const projectDirs: { name: string; path: string }[] = [];

    if (hasSessionsIndex) {
      // Single project directory
      projectDirs.push({ name: basename(sourcePath), path: sourcePath });
    } else {
      // Root projects directory - enumerate subdirs
      const entries = await readdir(sourcePath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (!opts.includeTemp && entry.name === '-tmp') continue;
        if (opts.projectFilter && !opts.projectFilter.includes(entry.name)) continue;
        const dirPath = join(sourcePath, entry.name);
        // Include dirs with sessions-index.json OR any .jsonl files
        if (await fileExists(join(dirPath, 'sessions-index.json'))) {
          projectDirs.push({ name: entry.name, path: dirPath });
        } else if (await hasJsonlFiles(dirPath)) {
          projectDirs.push({ name: entry.name, path: dirPath });
        }
      }
    }

    for (const project of projectDirs) {
      const projectFiles = await this.loadProject(project, opts, maxContent, sinceDate);
      files.push(...projectFiles);
    }

    const totalTokens = files.reduce((sum, f) => sum + f.tokenEstimate, 0);
    const content = files.map((f) => f.content).join('\n\n---\n\n');

    return {
      content,
      totalTokens,
      fileCount: files.length,
      files,
      metadata: {
        source: sourcePath,
        loadedAt: new Date(),
        projectCount: projectDirs.length,
        sessionCount: files.length,
      },
    };
  }

  private async loadProject(
    project: { name: string; path: string },
    opts: ClaudeHistoryOptions,
    maxContent: number,
    sinceDate?: Date
  ): Promise<FileInfo[]> {
    const files: FileInfo[] = [];

    let index: SessionsIndex | null = null;
    try {
      const raw = await readFile(join(project.path, 'sessions-index.json'), 'utf-8');
      index = JSON.parse(raw) as SessionsIndex;
    } catch {
      // No index file — will fall back to scanning .jsonl files
    }

    if (index) {
      // Use index for rich metadata
      for (const entry of index.entries) {
        if (sinceDate && entry.modified) {
          if (new Date(entry.modified) < sinceDate) continue;
        }
        if (entry.isSidechain) continue;

        const sessionFile = join(project.path, `${entry.sessionId}.jsonl`);
        if (!(await fileExists(sessionFile))) continue;

        try {
          const content = await this.parseSession(sessionFile, entry, project.name, maxContent);
          if (!content) continue;
          const size = Buffer.byteLength(content, 'utf-8');
          files.push({
            path: `${project.name}/${entry.sessionId}`,
            content,
            size,
            tokenEstimate: Math.ceil(size / 4),
          });
        } catch {
          // Skip malformed sessions
        }
      }
    } else {
      // No index — discover sessions from .jsonl files directly
      const dirEntries = await readdir(project.path);
      for (const fname of dirEntries) {
        if (!fname.endsWith('.jsonl')) continue;
        if (fname.startsWith('agent-') && !opts.includeAgents) continue;

        const filePath = join(project.path, fname);
        const sessionId = fname.replace('.jsonl', '');

        // Filter by file mtime if sinceDate is set
        if (sinceDate) {
          const fstat = await stat(filePath);
          if (fstat.mtime < sinceDate) continue;
        }

        try {
          // Build minimal metadata from the file itself
          const entry: SessionIndexEntry = {
            sessionId,
            fullPath: filePath,
            fileMtime: Date.now(),
            projectPath: project.name,
          };
          // Extract summary from first summary line if present
          const raw = await readFile(filePath, 'utf-8');
          const firstLine = raw.split('\n')[0];
          try {
            const parsed = JSON.parse(firstLine);
            if (parsed.type === 'summary' && parsed.summary) {
              entry.summary = parsed.summary;
            }
          } catch { /* ignore */ }

          const isAgent = fname.startsWith('agent-');
          const content = isAgent
            ? await this.parseAgentSession(filePath, sessionId, project.name, maxContent)
            : await this.parseSession(filePath, entry, project.name, maxContent);
          if (!content) continue;

          const size = Buffer.byteLength(content, 'utf-8');
          files.push({
            path: `${project.name}/${sessionId}`,
            content,
            size,
            tokenEstimate: Math.ceil(size / 4),
          });
        } catch {
          // Skip malformed
        }
      }
    }

    // Optionally load agent files
    if (opts.includeAgents) {
      const dirEntries = await readdir(project.path);
      for (const fname of dirEntries) {
        if (!fname.startsWith('agent-') || !fname.endsWith('.jsonl')) continue;
        const agentId = fname.replace('.jsonl', '');
        const agentFile = join(project.path, fname);
        try {
          const content = await this.parseAgentSession(agentFile, agentId, project.name, maxContent);
          if (!content) continue;
          const size = Buffer.byteLength(content, 'utf-8');
          files.push({
            path: `${project.name}/${agentId}`,
            content,
            size,
            tokenEstimate: Math.ceil(size / 4),
          });
        } catch {
          // Skip malformed agent files
        }
      }
    }

    return files;
  }

  private async parseSession(
    filePath: string,
    entry: SessionIndexEntry,
    projectName: string,
    maxContent: number
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
        if (text) {
          turns.push(`## User\n${truncate(text, maxContent)}`);
        }
      } else if (type === 'assistant') {
        const text = extractAssistantText(parsed);
        if (text) {
          turns.push(`## Assistant\n${truncate(text, maxContent)}`);
        }
      }
    }

    if (turns.length === 0) return null;
    return `${header}\n\n${turns.join('\n\n')}`;
  }

  private async parseAgentSession(
    filePath: string,
    agentId: string,
    projectName: string,
    maxContent: number
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
}

/**
 * Extract text content from a user message line
 */
function extractUserText(parsed: Record<string, unknown>): string | null {
  const message = parsed.message as Record<string, unknown> | undefined;
  if (!message) return null;

  const content = message.content;
  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    // Filter to text blocks, skip tool_result blocks
    const texts: string[] = [];
    for (const block of content) {
      if (typeof block === 'object' && block !== null) {
        const b = block as Record<string, unknown>;
        if (b.type === 'text' && typeof b.text === 'string') {
          texts.push(b.text);
        }
        // Skip tool_result blocks - they're tool output, not user intent
      }
    }
    return texts.length > 0 ? texts.join('\n') : null;
  }

  return null;
}

/**
 * Extract text content from an assistant message line
 * Skips tool_use and thinking blocks
 */
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
        if (b.type === 'text' && typeof b.text === 'string') {
          texts.push(b.text);
        }
        // Skip tool_use, thinking blocks
      }
    }
    return texts.length > 0 ? texts.join('\n') : null;
  }

  return null;
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '\n[...truncated]';
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
