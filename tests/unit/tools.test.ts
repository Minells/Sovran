import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyDiffTool, editFileTool, writeFileTool } from '../../src/core/tools/builtin/writeTools';
import { findFilesTool, listDirectoryTool, readFileTool, searchFilesTool, activeEditorTool } from '../../src/core/tools/builtin/readTools';
import { executeTerminalTool } from '../../src/core/tools/builtin/terminalTool';
import { ToolError, type ToolContext } from '../../src/core/tools/types';
import { applySearchReplace, makeDiff, truncateMiddle } from '../../src/core/tools/edits';
import { FakeProcess, MemoryWorkspace } from '../fixtures/fakes';

function ctx(ws: MemoryWorkspace, over: Partial<ToolContext> = {}): ToolContext {
  return {
    workspace: ws,
    process: new FakeProcess(),
    signal: new AbortController().signal,
    settings: { terminalTimeoutMs: 1000, maxToolResultChars: 20_000, protectedPaths: ['**/.env'] },
    ...over,
  };
}

describe('edit engine', () => {
  it('preserves CRLF line endings while matching LF search text', () => {
    expect(applySearchReplace('a\r\nb\r\nc\r\n', [{ search: 'b\nc', replace: 'B\nC' }])).toBe('a\r\nB\r\nC\r\n');
  });
  it('rejects ambiguous and missing matches with guidance', () => {
    expect(() => applySearchReplace('x\nx\n', [{ search: 'x', replace: 'y' }])).toThrow(/matches 2 places/);
    expect(() => applySearchReplace('  foo\n  bar\n', [{ search: 'foo\nbaz', replace: '' }])).toThrow(/first line appears at line 1/);
    expect(applySearchReplace('x\nx\n', [{ search: 'x', replace: 'y', replaceAll: true }])).toBe('y\ny\n');
  });
  it('treats $ in replacements literally', () => {
    expect(applySearchReplace('a', [{ search: 'a', replace: '$& $1 $$' }])).toBe('$& $1 $$');
  });
  it('is atomic: a failing edit leaves nothing applied', () => {
    expect(() => applySearchReplace('a b', [{ search: 'a', replace: 'A' }, { search: 'zzz', replace: '' }])).toThrow(/Edit #2/);
  });
  it('counts diff lines and truncates in the middle', () => {
    const d = makeDiff('f.ts', 'a\nb\n', 'a\nc\nd\n');
    expect([d.added, d.removed]).toEqual([2, 1]);
    expect(d.diff.startsWith('--- a/f.ts')).toBe(true);
    const t = truncateMiddle('x'.repeat(1000), 100);
    expect(t).toContain('characters omitted');
    expect(t.length).toBeLessThan(200);
  });
});

describe('file tools', () => {
  it('read_file pages large files and refuses directories and binaries', async () => {
    const ws = new MemoryWorkspace({ 'big.txt': Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n'), 'bin.dat': 'a\0b', 'src/x.ts': '' });
    const c = ctx(ws);
    const r = await readFileTool.execute({ path: 'big.txt', start_line: 10, end_line: 12 }, c, { paths: [] });
    expect(r.content).toBe('big.txt (lines 10-12 of 100)\nline 10\nline 11\nline 12\n\n[Showing lines 10-12 of 100. Use start_line=13 to continue.]');
    await expect(readFileTool.execute({ path: 'src' }, c, { paths: [] })).rejects.toThrow(/directory/);
    await expect(readFileTool.execute({ path: 'bin.dat' }, c, { paths: [] })).rejects.toThrow(/binary/);
    await expect(readFileTool.execute({ path: '../etc/passwd' }, c, { paths: [] })).rejects.toThrow(/escapes the workspace/);
  });

  it('write_file proposes a diff, then refuses stale writes', async () => {
    const ws = new MemoryWorkspace({ 'a.ts': 'old\n' });
    const c = ctx(ws);
    const prepared = await writeFileTool.prepare!({ path: 'a.ts', content: 'new\n' }, c);
    expect(prepared.approval).toMatchObject({ kind: 'edit', isNew: false, added: 1, removed: 1 });
    ws.set('a.ts', 'changed by user\n');
    await expect(writeFileTool.execute({ path: 'a.ts', content: 'new\n' }, c, prepared)).rejects.toThrow(/changed while/);
    expect(ws.get('a.ts')).toBe('changed by user\n');
  });

  it('write_file creates new files and edit tools refuse missing ones', async () => {
    const ws = new MemoryWorkspace();
    const c = ctx(ws);
    const prepared = await writeFileTool.prepare!({ path: 'pkg/new.ts', content: 'x' }, c);
    const r = await writeFileTool.execute({ path: 'pkg/new.ts', content: 'x' }, c, prepared);
    expect(r.content).toMatch(/^Created pkg\/new.ts/);
    await expect(editFileTool.prepare!({ path: 'nope.ts', old_string: 'a', new_string: 'b', replace_all: false }, c)).rejects.toBeInstanceOf(ToolError);
  });

  it('apply_diff applies several edits atomically', async () => {
    const ws = new MemoryWorkspace({ 'a.ts': 'one\ntwo\nthree\n' });
    const c = ctx(ws);
    const args = { path: 'a.ts', edits: [{ search: 'one', replace: '1' }, { search: 'three', replace: '3' }] };
    const prepared = await applyDiffTool.prepare!(args, c);
    await applyDiffTool.execute(args, c, prepared);
    expect(ws.get('a.ts')).toBe('1\ntwo\n3\n');
  });

  it('rejects writes through symlinks that leave the workspace', async () => {
    const ws = new MemoryWorkspace({ 'link/x': '' });
    ws.links.set(ws.abs('link'), path.resolve('/outside'));
    await expect(writeFileTool.prepare!({ path: 'link/evil.ts', content: 'x' }, ctx(ws))).rejects.toThrow(/symbolic link/);
  });
});

describe('search and listing tools', () => {
  const ws = new MemoryWorkspace({
    'src/a.ts': 'export const TOKEN = 1;\n',
    'src/b.ts': 'import { TOKEN } from "./a";\n',
    '.env': 'TOKEN=supersecret',
    'node_modules/x/index.js': 'TOKEN',
  });

  it('search_files finds literal matches and never returns protected file contents', async () => {
    const r = await searchFilesTool.execute({ query: 'token', is_regex: false, case_sensitive: false, glob: '**/*', max_results: 100 }, ctx(ws), { paths: [] });
    expect(r.content).toContain('src/a.ts:1:');
    expect(r.content).not.toContain('supersecret');
    expect(r.content).toContain('1 protected file(s) were not searched');
  });

  it('search_files reports invalid regex as a tool error', async () => {
    await expect(searchFilesTool.execute({ query: '(', is_regex: true, case_sensitive: false, glob: '**/*', max_results: 10 }, ctx(ws), { paths: [] })).rejects.toThrow(
      /Invalid regular expression/,
    );
  });

  it('list_directory skips dependency folders; find_files matches globs', async () => {
    const list = await listDirectoryTool.execute({ path: '.', depth: 2 }, ctx(ws), { paths: [] });
    expect(list.content).toContain('src/a.ts');
    expect(list.content).not.toContain('node_modules');
    const found = await findFilesTool.execute({ pattern: 'src/*.ts', max_results: 10 }, ctx(ws), { paths: [] });
    expect(found.content).toBe('src/a.ts\nsrc/b.ts');
  });

  it('active editor context includes selection and diagnostics', async () => {
    ws.active = {
      path: ws.abs('src/a.ts'),
      languageId: 'typescript',
      lineCount: 1,
      isDirty: true,
      selection: { startLine: 1, endLine: 1, text: 'TOKEN' },
      diagnostics: [{ line: 1, severity: 'error', message: 'bad', source: 'ts' }],
    };
    const r = await activeEditorTool.execute({}, ctx(ws), { paths: [] });
    expect(r.content).toContain('src/a.ts (typescript, 1 lines, unsaved changes)');
    expect(r.content).toContain('src/a.ts:1: error: bad (ts)');
  });
});

describe('execute_terminal', () => {
  it('confines cwd and reports exit status', async () => {
    const ws = new MemoryWorkspace({ 'pkg/a': '' });
    const proc = new FakeProcess({ exitCode: 2, output: 'fail' });
    const c = ctx(ws, { process: proc });
    await expect(executeTerminalTool.prepare!({ command: 'ls', cwd: '../..' }, c)).rejects.toThrow(/escapes/);
    const prepared = await executeTerminalTool.prepare!({ command: 'make', cwd: 'pkg' }, c);
    const r = await executeTerminalTool.execute({ command: 'make', cwd: 'pkg' }, c, prepared);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('[exit code 2]');
    expect(proc.commands[0]!.cwd).toBe(ws.abs('pkg'));
  });
});
