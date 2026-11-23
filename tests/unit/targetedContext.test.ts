import { describe, expect, it, vi } from 'vitest';
import { buildContext } from '../../src/core/context/contextManager';
import { selectTargetedContext } from '../../src/core/context/targetedContext';
import type { WorkspacePort } from '../../src/core/ports';
import { FakeProcess, MemoryWorkspace } from '../fixtures/fakes';

const lines = Array.from({ length: 45 }, (_, i) => `source line ${i + 1}`).join('\n');

function select(workspace: WorkspacePort, prompt: string, allowed = () => true) {
  return selectTargetedContext({
    prompt,
    allowed,
    excluded: (_root, local) => local.startsWith('generated/'),
    tool: {
      workspace,
      process: new FakeProcess(),
      signal: new AbortController().signal,
      settings: { maxToolResultChars: 4000, terminalTimeoutMs: 1000, protectedPaths: ['**/.env*'] },
    },
  });
}

describe('targeted context', () => {
  it('prioritizes stack frames, deduplicates overlapping lines and excludes protected aliases', async () => {
    const workspace = new MemoryWorkspace({
      'src/a.ts': lines,
      'generated/a.ts': lines,
      'alias.ts': 'private',
    });
    workspace.links.set(workspace.abs('alias.ts'), workspace.abs('.env.local'));
    const diagnostics = vi.fn(() => [
      {
        path: workspace.abs('src/a.ts'),
        diagnostics: [{ line: 22, severity: 'error' as const, message: 'Type mismatch' }],
      },
    ]);
    const context = await select(
      Object.assign(workspace, { diagnostics }),
      'Fix at src/a.ts:21:2 and generated/a.ts:12:1 and alias.ts:1:1',
    );
    expect(context[0]).toMatchObject({ path: 'src/a.ts', origin: 'stack', startLine: 15, endLine: 29 });
    expect(context.filter((file) => file.startLine! <= 22 && file.endLine! >= 22)).toHaveLength(1);
    expect(context.every((file) => file.path === 'src/a.ts')).toBe(true);
    expect(context[0]?.content).toContain('source line 21');
  });

  it('finds the definition and references for the named symbol and respects tool settings', async () => {
    const workspace = new MemoryWorkspace({ 'src/a.ts': lines, 'src/b.ts': lines });
    const querySemantic: NonNullable<WorkspacePort['querySemantic']> = vi.fn(async (query) =>
      query.kind === 'symbols'
        ? [{ path: workspace.abs('src/a.ts'), name: 'parse', line: 17, column: 4 }]
        : [
            {
              path: workspace.abs(query.kind === 'definition' ? 'src/a.ts' : 'src/b.ts'),
              line: 17,
              column: 4,
            },
          ],
    );
    const ws = Object.assign(workspace, { querySemantic });
    expect((await select(ws, 'Refactor `parse` in src/a.ts')).slice(0, 2)).toMatchObject([
      { path: 'src/a.ts', origin: 'definition' },
      { path: 'src/b.ts', origin: 'reference' },
    ]);
    expect(await select(ws, 'Refactor `parse` in src/a.ts', (name?: string) => name !== 'read_file')).toEqual(
      [],
    );
    workspace.trusted = false;
    expect(await select(ws, 'Fix src/a.ts:17')).toEqual([]);
  });

  it('keeps explicit attachments first and reports only the range that fits the wire budget', () => {
    const context = buildContext({
      systemPrompt: 'Use the sources.',
      toolMode: 'native',
      budgetTokens: 230,
      toolSchemaTokens: 30,
      maxToolResultChars: 2000,
      messages: [
        {
          role: 'user',
          id: 'u',
          content: 'Fix the issue',
          createdAt: 0,
          attachments: [
            {
              kind: 'selection',
              path: 'a.ts',
              startLine: 20,
              endLine: 64,
              content: lines,
              origin: 'attachment',
            },
          ],
        },
      ],
      targeted: {
        messageId: 'u',
        attachments: [
          {
            kind: 'selection',
            path: 'a.ts',
            startLine: 20,
            endLine: 21,
            origin: 'stack',
            content: 'overlap',
          },
          { kind: 'selection', path: 'b.ts', startLine: 1, endLine: 45, origin: 'search', content: lines },
        ],
      },
    });
    expect(context.estimatedTokens).toBeLessThanOrEqual(230);
    expect(context.sources).toHaveLength(1);
    expect(context.sources[0]).toMatchObject({
      path: 'a.ts',
      startLine: 20,
      origin: 'attachment',
      truncated: true,
    });
    expect(context.sources[0]!.endLine).toBeLessThan(64);
    expect(context.messages[1]?.content).toContain(`lines="20-${context.sources[0]!.endLine}"`);
  });
});
