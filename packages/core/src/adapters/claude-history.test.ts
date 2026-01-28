import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { ClaudeHistoryAdapter } from './claude-history';
import { mkdtemp, writeFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

describe('ClaudeHistoryAdapter', () => {
  let tmpDir: string;
  let projectDir: string;
  const adapter = new ClaudeHistoryAdapter();

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'claude-history-test-'));

    // Create a fake project directory
    projectDir = join(tmpDir, '-home-user-projects-myapp');
    await mkdir(projectDir, { recursive: true });

    // Create sessions-index.json
    const sessionsIndex = {
      version: 1,
      entries: [
        {
          sessionId: 'abc-123',
          fullPath: join(projectDir, 'abc-123.jsonl'),
          fileMtime: Date.now(),
          firstPrompt: 'fix the bug in auth',
          summary: 'Fixed auth token refresh bug',
          messageCount: 6,
          created: '2025-12-01T10:00:00.000Z',
          modified: '2025-12-01T11:00:00.000Z',
          gitBranch: 'main',
          projectPath: '/home/user/projects/myapp',
          isSidechain: false,
        },
        {
          sessionId: 'def-456',
          fullPath: join(projectDir, 'def-456.jsonl'),
          fileMtime: Date.now(),
          firstPrompt: 'old session',
          summary: 'Old session',
          messageCount: 2,
          created: '2025-01-01T10:00:00.000Z',
          modified: '2025-01-01T11:00:00.000Z',
          gitBranch: 'main',
          projectPath: '/home/user/projects/myapp',
          isSidechain: false,
        },
        {
          sessionId: 'side-789',
          fullPath: join(projectDir, 'side-789.jsonl'),
          fileMtime: Date.now(),
          firstPrompt: 'sidechain session',
          summary: 'Sidechain',
          messageCount: 2,
          created: '2025-12-01T10:00:00.000Z',
          modified: '2025-12-01T11:00:00.000Z',
          isSidechain: true,
        },
      ],
    };
    await writeFile(join(projectDir, 'sessions-index.json'), JSON.stringify(sessionsIndex));

    // Create session JSONL
    const sessionLines = [
      JSON.stringify({ type: 'summary', summary: 'Fixed auth token refresh bug' }),
      JSON.stringify({
        type: 'file-history-snapshot',
        messageId: 'msg-1',
        snapshot: { messageId: 'msg-1', trackedFileBackups: {}, timestamp: '2025-12-01T10:00:00.000Z' },
      }),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'fix the bug in auth' },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', text: 'Let me think about this...' },
            { type: 'text', text: 'I found the auth bug. The token refresh was not handling expired tokens correctly.' },
            { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/src/auth.ts' } },
          ],
        },
      }),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { tool_use_id: 'tool-1', type: 'tool_result', content: 'file contents here' },
          ],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'I have fixed the token refresh logic.' }],
        },
      }),
    ];
    await writeFile(join(projectDir, 'abc-123.jsonl'), sessionLines.join('\n'));

    // Create old session
    const oldSessionLines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }),
    ];
    await writeFile(join(projectDir, 'def-456.jsonl'), oldSessionLines.join('\n'));

    // Create an agent file
    const agentLines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'agent task' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }),
    ];
    await writeFile(join(projectDir, 'agent-abc123.jsonl'), agentLines.join('\n'));

    // Create -tmp directory
    const tmpProject = join(tmpDir, '-tmp');
    await mkdir(tmpProject, { recursive: true });
    await writeFile(join(tmpProject, 'sessions-index.json'), JSON.stringify({ version: 1, entries: [] }));

    // Create a project directory WITHOUT sessions-index.json (index-less)
    const noIndexDir = join(tmpDir, '-home-user-projects-other');
    await mkdir(noIndexDir, { recursive: true });
    const noIndexSession = [
      JSON.stringify({ type: 'summary', summary: 'Worked on indexless project' }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'help with indexless' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Sure, here is help.' }] } }),
    ];
    await writeFile(join(noIndexDir, 'session-no-idx.jsonl'), noIndexSession.join('\n'));
    await writeFile(join(noIndexDir, 'agent-xyz.jsonl'), noIndexSession.join('\n'));
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('canHandle detects claude-history type', () => {
    expect(adapter.canHandle({ type: 'claude-history', path: '/some/path' })).toBe(true);
    expect(adapter.canHandle({ type: 'docs', url: 'https://example.com' })).toBe(false);
  });

  test('canHandle detects .claude/projects path', () => {
    expect(adapter.canHandle({ type: 'local', path: '/home/user/.claude/projects' })).toBe(true);
  });

  test('loads project directory with sessions', async () => {
    const result = await adapter.load({ type: 'claude-history', path: tmpDir });
    // abc-123 + def-456 (from indexed project) + session-no-idx (from index-less project)
    expect(result.fileCount).toBe(3);
    expect(result.metadata.projectCount).toBe(2);
    expect(result.metadata.sessionCount).toBe(3);
  });

  test('loads sessions from directories without sessions-index.json', async () => {
    const result = await adapter.load({ type: 'claude-history', path: tmpDir });
    const noIdxSession = result.files.find((f) => f.path.includes('session-no-idx'));
    expect(noIdxSession).toBeDefined();
    expect(noIdxSession!.content).toContain('Worked on indexless project');
    expect(noIdxSession!.content).toContain('help with indexless');
    // Agent files excluded by default even in index-less dirs
    const agentInNoIdx = result.files.find((f) => f.path.includes('-home-user-projects-other/agent-'));
    expect(agentInNoIdx).toBeUndefined();
  });

  test('parses session content correctly', async () => {
    const result = await adapter.load({ type: 'claude-history', path: tmpDir });
    const mainSession = result.files.find((f) => f.path.includes('abc-123'));
    expect(mainSession).toBeDefined();
    const content = mainSession!.content;

    // Header
    expect(content).toContain('# Session: Fixed auth token refresh bug');
    expect(content).toContain('Branch: main');

    // User messages (only text, not tool_results)
    expect(content).toContain('## User\nfix the bug in auth');

    // Assistant messages (text only, no thinking or tool_use)
    expect(content).toContain('I found the auth bug');
    expect(content).not.toContain('Let me think about this');
    expect(content).not.toContain('tool_use');
    expect(content).not.toContain('tool_result');
  });

  test('skips sidechain sessions', async () => {
    const result = await adapter.load({ type: 'claude-history', path: tmpDir });
    const sideSession = result.files.find((f) => f.path.includes('side-789'));
    expect(sideSession).toBeUndefined();
  });

  test('skips -tmp directory by default', async () => {
    const result = await adapter.load({ type: 'claude-history', path: tmpDir });
    const tmpSession = result.files.find((f) => f.path.includes('-tmp'));
    expect(tmpSession).toBeUndefined();
  });

  test('excludes agent files by default', async () => {
    const result = await adapter.load({ type: 'claude-history', path: tmpDir });
    const agentSession = result.files.find((f) => f.path.includes('agent-'));
    expect(agentSession).toBeUndefined();
  });

  test('includes agent files when opted in', async () => {
    const result = await adapter.load({
      type: 'claude-history',
      path: tmpDir,
      options: { includeAgents: true },
    });
    const agentSession = result.files.find((f) => f.path.includes('agent-'));
    expect(agentSession).toBeDefined();
  });

  test('filters by date with since option', async () => {
    const result = await adapter.load({
      type: 'claude-history',
      path: tmpDir,
      options: { since: '2025-06-01T00:00:00.000Z' },
    });
    // abc-123 (Dec 2025) + index-less session (just created), not def-456 (Jan 2025)
    expect(result.fileCount).toBe(2);
    const paths = result.files.map((f) => f.path);
    expect(paths.some((p) => p.includes('abc-123'))).toBe(true);
    expect(paths.some((p) => p.includes('def-456'))).toBe(false);
  });

  test('truncates long messages', async () => {
    const result = await adapter.load({
      type: 'claude-history',
      path: tmpDir,
      options: { maxContentPerMessage: 20 },
    });
    const session = result.files.find((f) => f.path.includes('abc-123'));
    expect(session!.content).toContain('[...truncated]');
  });

  test('loads single project directory directly', async () => {
    const result = await adapter.load({ type: 'claude-history', path: projectDir });
    expect(result.fileCount).toBe(2);
    expect(result.metadata.projectCount).toBe(1);
  });

  test('throws on missing path', async () => {
    await expect(adapter.load({ type: 'claude-history' })).rejects.toThrow('No path provided');
  });

  test('throws on nonexistent directory', async () => {
    await expect(
      adapter.load({ type: 'claude-history', path: '/nonexistent/path' })
    ).rejects.toThrow('Directory not found');
  });
});
