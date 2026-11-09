import { describe, expect, it } from 'vitest';
import { GIT_WRITE_REASON } from '../../src/core/git/write';
import { decide } from '../../src/core/permissions/policy';
import { gitStageTool, gitCommitTool } from '../../src/core/tools/builtin/gitWriteTools';
import { parseChanges, prepareGit, validRevision } from '../../src/core/git/read';
import { createBuiltinRegistry } from '../../src/core/tools/builtin';
import type { ToolContext } from '../../src/core/tools/types';
import { FakeProcess, MemoryWorkspace } from '../fixtures/fakes';

describe('native Git argument and metadata boundaries', () => {
  it('accepts commit/ref ancestry and rejects option, range, search and path syntax', () => {
    for (const revision of ['HEAD', 'HEAD~2^', 'refs/heads/feature/name', 'v1.0.0', 'a'.repeat(40)])
      expect(validRevision(revision)).toBe(true);
    for (const revision of [
      '',
      '--help',
      'HEAD:.env',
      ':0:.env',
      'HEAD..main',
      'HEAD^{/password}',
      '@{1}',
      'HEAD\nmain',
      'x'.repeat(201),
    ])
      expect(validRevision(revision)).toBe(false);
  });

  it('parses NUL-delimited rename sources and literal filenames without line/quote ambiguity', () => {
    expect(parseChanges('R100\0.env\0public name\0M\0line\n"quoted".txt\0')).toEqual([
      { status: 'R100', oldPath: '.env', path: 'public name' },
      { status: 'M', path: 'line\n"quoted".txt' },
    ]);
    expect(parseChanges('')).toEqual([]);
  });

  it('rejects incomplete or malformed change records', () => {
    for (const output of ['M\0truncated', 'R100\0old\0', 'M\0', '??\0file\0'])
      expect(() => parseChanges(output)).toThrow();
  });

  it('prepares only filesystem/approval data and requires explicit repository roots', async () => {
    const process = new FakeProcess();
    const workspace = new MemoryWorkspace({ '.git/config': '', '.env': 'secret' });
    const ctx: ToolContext = {
      process,
      workspace,
      signal: new AbortController().signal,
      settings: { protectedPaths: ['**/.env'], maxToolResultChars: 2000, terminalTimeoutMs: 1000 },
    };
    expect((await prepareGit({ repository: '.', paths: ['.env'] }, ctx)).paths).toEqual(['.env']);
    expect(process.commands).toEqual([]);
    await expect(prepareGit({ repository: '../outside' }, ctx)).rejects.toThrow();
    await expect(prepareGit({ repository: '.', paths: ['../outside'] }, ctx)).rejects.toThrow();
    workspace.trusted = false;
    await expect(prepareGit({ repository: '.' }, ctx)).rejects.toThrow('trusted workspace');
  });

  it('offers all five tools only in trusted workspaces and honors native disable settings', () => {
    const registry = createBuiltinRegistry();
    expect(
      registry
        .list('plan', { workspaceTrusted: true })
        .filter((tool) => tool.group === 'git')
        .map((tool) => tool.name),
    ).toEqual(['git_status', 'git_diff', 'git_log', 'git_show', 'git_branches']);
    expect(registry.list('act', { workspaceTrusted: false }).some((tool) => tool.group === 'git')).toBe(
      false,
    );
    expect(
      registry
        .list('plan', { workspaceTrusted: true, disabledTools: ['git_show'] })
        .some((tool) => tool.name === 'git_show'),
    ).toBe(false);
  });
  it('does not allow a native Git mutation through Auto, edit grants or command allow-lists', () => {
    for (const approvalMode of ['ask', 'edits', 'auto'] as const) {
      expect(
        decide({
          risk: 'execute',
          mode: 'act',
          workspaceTrusted: true,
          paths: [],
          risks: [GIT_WRITE_REASON],
          settings: { approvalMode, allowedCommands: ['git'], protectedPaths: [] },
          grants: { edits: true },
        }).action,
      ).toBe('ask');
    }
    expect(gitStageTool.schema.safeParse({ repository: '.', paths: ['a'], all: true }).success).toBe(false);
    expect(gitCommitTool.schema.safeParse({ repository: '.', message: 'message', amend: true }).success).toBe(
      false,
    );
    expect(gitCommitTool.schema.safeParse({ repository: '.', message: '   ' }).success).toBe(false);
  });
});
