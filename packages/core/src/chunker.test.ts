import { describe, test, expect } from 'bun:test';
import {
  chunkFile,
  chunkLoadedSource,
  estimateTokens,
  detectFileType,
  chunkToVectorMetadata,
  prepareChunkForEmbedding,
} from './chunker';

describe('estimateTokens', () => {
  test('estimates tokens based on character count', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('test')).toBe(1);
    expect(estimateTokens('hello world')).toBe(3); // 11 chars / 4 = ~3
  });
});

describe('detectFileType', () => {
  test('detects TypeScript files', () => {
    expect(detectFileType('src/index.ts')).toBe('typescript');
    expect(detectFileType('component.tsx')).toBe('typescript');
  });

  test('detects JavaScript files', () => {
    expect(detectFileType('script.js')).toBe('javascript');
    expect(detectFileType('app.jsx')).toBe('javascript');
  });

  test('detects Python files', () => {
    expect(detectFileType('main.py')).toBe('python');
  });

  test('detects Markdown files', () => {
    expect(detectFileType('README.md')).toBe('markdown');
    expect(detectFileType('docs/guide.mdx')).toBe('markdown');
  });

  test('returns text for unknown extensions', () => {
    expect(detectFileType('file.xyz')).toBe('text');
    expect(detectFileType('no-extension')).toBe('text');
  });
});

describe('chunkFile', () => {
  test('keeps small files whole', () => {
    const content = 'const x = 1;\nconsole.log(x);';
    const chunks = chunkFile('test.ts', content, 'my-repo');

    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe(content);
    expect(chunks[0].filePath).toBe('test.ts');
    expect(chunks[0].repoAlias).toBe('my-repo');
    expect(chunks[0].fileType).toBe('typescript');
    expect(chunks[0].chunkIndex).toBe(0);
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].endLine).toBe(2);
  });

  test('keeps always-include files whole regardless of size', () => {
    // Create a large README
    const content = 'A'.repeat(5000); // ~1250 tokens
    const chunks = chunkFile('README.md', content, 'my-repo');

    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe(content);
  });

  test('chunks large TypeScript files by function boundaries', () => {
    const content = `
import { something } from 'module';

function foo() {
  return ${'x'.repeat(2000)}; // Make it large enough to chunk
}

function bar() {
  return ${'y'.repeat(2000)};
}

export class MyClass {
  method() {
    return ${'z'.repeat(2000)};
  }
}
`.trim();

    const chunks = chunkFile('large.ts', content, 'my-repo');

    // Should produce multiple chunks
    expect(chunks.length).toBeGreaterThan(1);

    // All chunks should have proper metadata
    for (const chunk of chunks) {
      expect(chunk.repoAlias).toBe('my-repo');
      expect(chunk.filePath).toBe('large.ts');
      expect(chunk.fileType).toBe('typescript');
      expect(chunk.id).toBeTruthy();
      expect(chunk.startLine).toBeGreaterThan(0);
      expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine);
    }
  });

  test('chunks Markdown by headings', () => {
    const content = `
# Main Title

Some intro text.

## Section One

${'Content '.repeat(500)}

## Section Two

${'More content '.repeat(500)}

### Subsection

${'Even more '.repeat(500)}
`.trim();

    const chunks = chunkFile('docs.md', content, 'my-repo');

    // Should produce multiple chunks
    expect(chunks.length).toBeGreaterThan(1);

    // All chunks should be markdown type
    for (const chunk of chunks) {
      expect(chunk.fileType).toBe('markdown');
    }
  });

  test('generates unique IDs for each chunk', () => {
    const content = 'Line\n'.repeat(1000);
    const chunks = chunkFile('test.txt', content, 'my-repo');

    const ids = chunks.map((c) => c.id);
    const uniqueIds = new Set(ids);

    expect(uniqueIds.size).toBe(ids.length);
  });
});

describe('chunkLoadedSource', () => {
  test('chunks multiple files', () => {
    const files = [
      { path: 'a.ts', content: 'const a = 1;' },
      { path: 'b.ts', content: 'const b = 2;' },
      { path: 'c.py', content: 'c = 3' },
    ];

    const chunks = chunkLoadedSource(files, 'my-repo');

    expect(chunks).toHaveLength(3);
    expect(chunks[0].filePath).toBe('a.ts');
    expect(chunks[1].filePath).toBe('b.ts');
    expect(chunks[2].filePath).toBe('c.py');
    expect(chunks[2].fileType).toBe('python');
  });
});

describe('chunkToVectorMetadata', () => {
  test('converts chunk to vector metadata format', () => {
    const chunk = {
      id: 'test-id',
      repoAlias: 'my-repo',
      filePath: 'src/index.ts',
      fileType: 'typescript',
      chunkIndex: 2,
      content: 'const x = 1;',
      startLine: 10,
      endLine: 20,
      tokenEstimate: 100,
    };

    const metadata = chunkToVectorMetadata(chunk);

    expect(metadata).toEqual({
      repo_alias: 'my-repo',
      file_path: 'src/index.ts',
      file_type: 'typescript',
      chunk_index: 2,
      start_line: 10,
      end_line: 20,
    });
  });
});

describe('prepareChunkForEmbedding', () => {
  test('adds file path header to content', () => {
    const chunk = {
      id: 'test-id',
      repoAlias: 'my-repo',
      filePath: 'src/utils.ts',
      fileType: 'typescript',
      chunkIndex: 0,
      content: 'export function add(a: number, b: number) { return a + b; }',
      startLine: 5,
      endLine: 5,
      tokenEstimate: 20,
    };

    const prepared = prepareChunkForEmbedding(chunk);

    expect(prepared).toContain('### src/utils.ts (lines 5-5)');
    expect(prepared).toContain('export function add');
  });
});
