import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { gitCommitTool, gitStageTool, gitUnstageTool } from '../../src/core/tools/builtin/gitWriteTools';
import { CheckpointRecorder } from '../../src/core/checkpoints/checkpoints';
import { AgentRunner } from '../../src/core/agent/agentRunner';
import { MemoryCapabilityStore } from '../../src/core/providers/capabilities';
import { nullLogger } from '../../src/core/ports';
import type { AnyTool, PreparedAction } from '../../src/core/tools/types';
import { createBuiltinRegistry } from '../../src/core/tools/builtin';
import type { Session, ToolMessage } from '../../src/core/sessions/model';
import { ScriptedApprovals, ScriptedProvider, call, text } from '../fixtures/fakes';
import { createGitFixture, git } from '../fixtures/git';

const folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0)) await fs.rm(folder, { recursive: true, force: true });
});
const fixture = (unborn = false) => createGitFixture(folders, unborn);
const prepare = async (
  t: Awaited<ReturnType<typeof fixture>>,
  tool: AnyTool,
  input: Record<string, unknown> = {},
) => {
  const args = tool.schema.parse({ repository: '.', ...input });
  return { args, prepared: await tool.prepare!(args, t.ctx) };
};
const execute = (
  t: Awaited<ReturnType<typeof fixture>>,
  tool: AnyTool,
  ready: { args: unknown; prepared: PreparedAction },
) => tool.execute(ready.args, t.ctx, ready.prepared);

async function runAgent(
  t: Awaited<ReturnType<typeof fixture>>,
  approve: boolean,
  mode: 'act' | 'plan' = 'act',
) {
  const provider = new ScriptedProvider([
    [call(0, 'git_stage', { repository: '.', paths: ['.env'] })],
    [text('done')],
  ]);
  const approvals = new ScriptedApprovals(() => ({ approved: approve }));
  const session: Session = { id: 's', title: 'Git write', mode, createdAt: 0, updatedAt: 0, messages: [] };
  const runner = new AgentRunner({
    provider,
    registry: createBuiltinRegistry(),
    workspace: t.ctx.workspace,
    process: t.ctx.process,
    approvals,
    capabilities: new MemoryCapabilityStore(),
    logger: nullLogger,
  });
  await runner.run({
    session,
    providerId: 'fixture',
    model: { id: 'm' },
    mode,
    settings: {
      maxIterations: 3,
      policy: {
        approvalMode: 'auto',
        allowedCommands: ['git'],
        protectedPaths: t.ctx.settings.protectedPaths,
      },
      tools: t.ctx.settings,
      defaultContextWindow: 32768,
      defaultMaxOutputTokens: 4096,
    },
    grants: { edits: true },
    signal: t.ctx.signal,
    emit: () => {},
  });
  return { approvals, messages: session.messages.filter((m): m is ToolMessage => m.role === 'tool') };
}

describe('controlled native Git writes', () => {
  it('prepares a repository/file preview without mutation, then stages only selected saved files', async () => {
    const t = await fixture();
    await fs.writeFile(path.join(t.root, 'a.txt'), 'saved change\n');
    await fs.writeFile(path.join(t.root, 'unselected.txt'), 'keep untracked');
    const index = await fs.readFile(path.join(t.root, '.git/index'));
    const ready = await prepare(t, gitStageTool, { paths: ['a.txt'] });
    expect(await fs.readFile(path.join(t.root, '.git/index'))).toEqual(index);
    expect(ready.prepared.approval).toMatchObject({
      kind: 'git',
      operation: 'stage',
      repository: '.',
      branch: 'refs/heads/main',
      files: ['a.txt'],
    });
    expect(ready.prepared.approval?.kind === 'git' && ready.prepared.approval.preview).toContain(
      '+saved change',
    );
    expect((await execute(t, gitStageTool, ready)).isError).toBeUndefined();
    expect(git(t.root, 'diff', '--cached', '--name-only')).toBe('a.txt');
    expect(git(t.root, 'rev-parse', 'HEAD')).toBe(t.initial);
    expect(t.ctx.onOutput).not.toHaveBeenCalled();
  });

  it('always asks even in Auto, blocks rejection and never exposes protected content in the tool result', async () => {
    const t = await fixture();
    await fs.writeFile(path.join(t.root, '.env'), 'PRIVATE_FIXTURE=changed-secret\n');
    const denied = await runAgent(t, false);
    expect(denied.approvals.requests).toHaveLength(1);
    expect(denied.messages[0]?.status).toBe('denied');
    expect(git(t.root, 'diff', '--cached', '--name-only')).toBe('');
    const allowed = await runAgent(t, true);
    expect(allowed.approvals.requests).toHaveLength(1);
    expect(allowed.messages[0]?.status).toBe('success');
    expect(allowed.messages[0]?.autoApproved).toBeUndefined();
    expect(allowed.messages[0]?.content).not.toContain('changed-secret');
    expect(git(t.root, 'diff', '--cached', '--name-only')).toBe('.env');
  });

  it('does not prepare a repository write in Plan or Restricted Mode', async () => {
    const t = await fixture();
    await fs.writeFile(path.join(t.root, '.env'), 'modified');
    expect((await runAgent(t, true, 'plan')).messages[0]?.status).toBe('denied');
    expect(t.calls).toHaveLength(0);
    t.workspace.trusted = false;
    const result = await runAgent(t, true);
    expect(result.approvals.requests).toHaveLength(0);
    expect(t.calls).toHaveLength(0);
  });

  it('unstages only selected files and preserves saved contents and other staged entries', async () => {
    const t = await fixture();
    await fs.writeFile(path.join(t.root, 'a.txt'), 'saved change');
    await fs.writeFile(path.join(t.root, 'new.txt'), 'new');
    git(t.root, 'add', '--', 'a.txt', 'new.txt');
    const ready = await prepare(t, gitUnstageTool, { paths: ['a.txt'] });
    expect((await execute(t, gitUnstageTool, ready)).isError).toBeUndefined();
    expect(git(t.root, 'diff', '--cached', '--name-only')).toBe('new.txt');
    expect(await fs.readFile(path.join(t.root, 'a.txt'), 'utf8')).toBe('saved change');
  });

  it('unstages selected files on an unborn branch without creating HEAD or deleting working files', async () => {
    const t = await fixture(true);
    git(t.root, 'add', '--', 'a.txt', '.env');
    const ready = await prepare(t, gitUnstageTool, { paths: ['a.txt'] });
    expect((await execute(t, gitUnstageTool, ready)).isError).toBeUndefined();
    expect(git(t.root, 'ls-files')).toBe('.env');
    expect(await fs.readFile(path.join(t.root, 'a.txt'), 'utf8')).toContain('first');
  });

  it('commits reviewed staged changes with the exact multi-line literal message and no automatic staging', async () => {
    const t = await fixture();
    await fs.writeFile(path.join(t.root, 'a.txt'), 'staged');
    await fs.writeFile(path.join(t.root, 'untracked.txt'), 'untracked');
    git(t.root, 'add', '--', 'a.txt');
    const message = 'feat: native commit\n\nLiteral $(touch FORBIDDEN) and `id`';
    const ready = await prepare(t, gitCommitTool, { message });
    expect(ready.prepared.approval).toMatchObject({ kind: 'git', files: ['a.txt'], message });
    const result = await execute(t, gitCommitTool, ready);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content).headAfter).toBe(git(t.root, 'rev-parse', 'HEAD'));
    expect(git(t.root, 'log', '-1', '--format=%B')).toBe(message);
    expect(git(t.root, 'diff', 'HEAD^', 'HEAD', '--name-only')).toBe('a.txt');
    expect(await fs.stat(path.join(t.root, 'FORBIDDEN')).catch(() => null)).toBeNull();
    expect(git(t.root, 'ls-files', 'untracked.txt')).toBe('');
  });

  it.each([gitStageTool, gitUnstageTool, gitCommitTool])('rejects a stale index for $name', async (tool) => {
    const t = await fixture();
    await fs.writeFile(path.join(t.root, 'a.txt'), 'changed');
    if (tool !== gitStageTool) git(t.root, 'add', '--', 'a.txt');
    const ready = await prepare(
      t,
      tool,
      tool === gitCommitTool ? { message: 'reviewed' } : { paths: ['a.txt'] },
    );
    await fs.writeFile(path.join(t.root, 'other.txt'), 'other');
    git(t.root, 'add', '--', 'other.txt');
    const index = await fs.readFile(path.join(t.root, '.git/index'));
    await expect(execute(t, tool, ready)).rejects.toThrow('changed while awaiting approval');
    expect(await fs.readFile(path.join(t.root, '.git/index'))).toEqual(index);
    expect(git(t.root, 'rev-parse', 'HEAD')).toBe(t.initial);
  });

  it.each(['branch', 'HEAD', 'configuration', 'saved file'])(
    'rejects changed %s after preview',
    async (change) => {
      const t = await fixture();
      await fs.writeFile(path.join(t.root, 'a.txt'), 'changed');
      const ready = await prepare(t, gitStageTool, { paths: ['a.txt'] });
      if (change === 'branch') git(t.root, 'checkout', '-b', 'another');
      if (change === 'HEAD') git(t.root, 'commit', '--allow-empty', '-m', 'Another HEAD');
      if (change === 'configuration') git(t.root, 'config', 'core.commentChar', '!');
      if (change === 'saved file') await fs.writeFile(path.join(t.root, 'a.txt'), 'changed again');
      await expect(execute(t, gitStageTool, ready)).rejects.toThrow('changed while awaiting approval');
      expect(git(t.root, 'diff', '--cached', '--name-only')).toBe('');
    },
  );

  it('rejects whole-repository/directory selections, including deleted directory prefixes, and unsaved files', async () => {
    const t = await fixture();
    await fs.mkdir(path.join(t.root, 'directory'));
    await fs.writeFile(path.join(t.root, 'directory/a.txt'), 'a');
    git(t.root, 'add', '--', 'directory/a.txt');
    git(t.root, 'commit', '-m', 'Directory');
    await expect(prepare(t, gitStageTool, { paths: ['.'] })).rejects.toThrow('individual files');
    await expect(prepare(t, gitStageTool, { paths: ['directory'] })).rejects.toThrow('Directory-wide');
    await fs.rm(path.join(t.root, 'directory'), { recursive: true });
    await expect(prepare(t, gitStageTool, { paths: ['directory'] })).rejects.toThrow('directory prefix');
    await expect(prepare(t, gitUnstageTool, { paths: ['directory'] })).rejects.toThrow('directory prefix');
    t.workspace.dirty.add(path.join(t.root, 'a.txt'));
    await expect(prepare(t, gitStageTool, { paths: ['a.txt'] })).rejects.toThrow('Save a.txt');
  });

  it.each(['disabled', 'trust', 'workspace', 'unsaved'])(
    'blocks changed %s at the actual mutation spawn boundary',
    async (change) => {
      const t = await fixture();
      await fs.writeFile(path.join(t.root, 'a.txt'), 'changed');
      const ready = await prepare(t, gitStageTool, { paths: ['a.txt'] });
      const original = t.ctx.process.runFile.bind(t.ctx.process);
      let disabled = false;
      t.ctx.revalidate = () => {
        if (disabled) throw new Error('git_stage is disabled');
      };
      t.ctx.process.runFile = (exe, argv, options) => {
        if (argv.includes('add')) {
          if (change === 'disabled') disabled = true;
          if (change === 'trust') t.workspace.trusted = false;
          if (change === 'workspace') t.workspace.roots = () => [];
          if (change === 'unsaved') t.workspace.dirty.add(path.join(t.root, 'a.txt'));
        }
        return original(exe, argv, options);
      };
      const result = await execute(t, gitStageTool, ready);
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/disabled|trusted workspace|open workspace|Save a.txt/);
      expect(git(t.root, 'diff', '--cached', '--name-only')).toBe('');
    },
  );

  it('runs a configured clean filter only after approval, without streaming its output', async () => {
    const t = await fixture();
    const marker = path.join(t.root, 'FILTER_RAN');
    const script = path.join(t.root, 'filter.cjs');
    await fs.writeFile(
      script,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)},'yes');process.stdout.write(require('node:fs').readFileSync(0))`,
    );
    const command = `"${process.execPath.replace(/\\/g, '/')}" "${script.replace(/\\/g, '/')}"`;
    git(t.root, 'config', 'filter.fixture.clean', command);
    git(t.root, 'config', 'filter.fixture.required', 'true');
    await fs.writeFile(path.join(t.root, '.gitattributes'), 'a.txt filter=fixture\n');
    await fs.writeFile(path.join(t.root, 'a.txt'), 'filtered content');
    const ready = await prepare(t, gitStageTool, { paths: ['a.txt'] });
    expect(await fs.stat(marker).catch(() => null)).toBeNull();
    expect((await execute(t, gitStageTool, ready)).isError).toBeUndefined();
    expect(await fs.readFile(marker, 'utf8')).toBe('yes');
    expect(t.ctx.onOutput).not.toHaveBeenCalled();
  });

  it('executes commit hooks only after approval and reports hook failures without claiming rollback', async () => {
    const t = await fixture();
    await fs.writeFile(path.join(t.root, 'a.txt'), 'changed');
    git(t.root, 'add', '--', 'a.txt');
    const marker = path.join(t.root, 'HOOK_RAN');
    const helper = path.join(t.root, 'hook.cjs');
    await fs.writeFile(
      helper,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)},'yes');process.exitCode=1`,
    );
    const command = `"${process.execPath.replace(/\\/g, '/')}" "${helper.replace(/\\/g, '/')}"`;
    await fs.writeFile(path.join(t.root, '.git/hooks/pre-commit'), `#!/bin/sh\n${command}\n`, {
      mode: 0o755,
    });
    const ready = await prepare(t, gitCommitTool, { message: 'hook check' });
    expect(await fs.stat(marker).catch(() => null)).toBeNull();
    expect(ready.prepared.approval?.kind === 'git' && ready.prepared.approval.warnings.join(' ')).toContain(
      'Hooks and signing',
    );
    const result = await execute(t, gitCommitTool, ready);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('inspect git_status/git_log');
    expect(await fs.readFile(marker, 'utf8')).toBe('yes');
    expect(git(t.root, 'rev-parse', 'HEAD')).toBe(t.initial);
  });

  it('reports a cancellation after a commit without pretending the new commit was undone', async () => {
    const t = await fixture();
    await fs.writeFile(path.join(t.root, 'a.txt'), 'committed before cancellation');
    git(t.root, 'add', '--', 'a.txt');
    const helper = path.join(t.root, 'post-commit.cjs');
    await fs.writeFile(helper, `process.stdout.write('POST_COMMIT_READY');setInterval(()=>{},1000)`);
    const command = `"${process.execPath.replace(/\\/g, '/')}" "${helper.replace(/\\/g, '/')}"`;
    await fs.writeFile(path.join(t.root, '.git/hooks/post-commit'), `#!/bin/sh\n${command}\n`, {
      mode: 0o755,
    });
    const ready = await prepare(t, gitCommitTool, { message: 'commit before stop' });
    const abort = new AbortController();
    t.ctx.signal = abort.signal;
    const original = t.ctx.process.runFile.bind(t.ctx.process);
    t.ctx.process.runFile = (exe, argv, options) =>
      original(exe, argv, {
        ...options,
        ...(argv.includes('commit')
          ? {
              onOutput: (chunk: string) => {
                if (chunk.includes('POST_COMMIT_READY')) abort.abort();
              },
            }
          : {}),
      });
    const result = await execute(t, gitCommitTool, ready);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('may have changed');
    expect(git(t.root, 'rev-parse', 'HEAD')).not.toBe(t.initial);
    expect(git(t.root, 'log', '-1', '--format=%s')).toBe('commit before stop');
  });

  it('rejects another Sovran write while a repository mutation is in progress', async () => {
    const t = await fixture();
    await fs.writeFile(path.join(t.root, 'a.txt'), 'changed');
    const first = await prepare(t, gitStageTool, { paths: ['a.txt'] });
    const second = await prepare(t, gitStageTool, { paths: ['a.txt'] });
    const original = t.ctx.process.runFile.bind(t.ctx.process);
    let resume!: () => void;
    let observed!: () => void;
    const held = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const started = new Promise<void>((resolve) => {
      observed = resolve;
    });
    t.ctx.process.runFile = async (exe, argv, options) => {
      if (argv.includes('add')) {
        observed();
        await held;
      }
      return original(exe, argv, options);
    };
    const running = execute(t, gitStageTool, first);
    await started;
    try {
      await expect(execute(t, gitStageTool, second)).rejects.toThrow('Another Sovran Git write');
    } finally {
      resume();
    }
    expect((await running).isError).toBeUndefined();
  });

  it('does not offer amend/force/stage-all arguments or accept a Git metadata selection', async () => {
    const t = await fixture();
    expect(gitStageTool.schema.safeParse({ repository: '.', paths: ['a.txt'], all: true }).success).toBe(
      false,
    );
    expect(gitCommitTool.schema.safeParse({ repository: '.', message: 'message', amend: true }).success).toBe(
      false,
    );
    await expect(prepare(t, gitStageTool, { paths: ['.git/config'] })).rejects.toThrow('Git metadata');
    await expect(prepare(t, gitStageTool, { paths: ['a.txt '] })).rejects.toThrow('edge whitespace');
  });

  it('supports linked-worktree index snapshots and records no fictitious checkpoint undo', async () => {
    const t = await fixture();
    const linked = path.join(t.root, 'linked');
    git(t.root, 'worktree', 'add', '-b', 'linked', linked);
    t.workspace.roots = () => [{ name: 'linked', path: linked }];
    const checkpoint = new CheckpointRecorder(t.workspace);
    t.ctx.workspace = checkpoint;
    await fs.writeFile(path.join(linked, 'a.txt'), 'linked change');
    const ready = await prepare(t, gitStageTool, { paths: ['a.txt'] });
    expect((await execute(t, gitStageTool, ready)).isError).toBeUndefined();
    expect(git(linked, 'diff', '--cached', '--name-only')).toBe('a.txt');
    expect(checkpoint.changedFiles()).toEqual([]);
    t.workspace.dirty.add(path.join(linked, 'a.txt'));
    await expect(prepare(t, gitStageTool, { paths: ['a.txt'] })).rejects.toThrow('Save a.txt');
  });

  it('rejects a changed worktree administrative directory even when refs/config/index contents match', async () => {
    const t = await fixture();
    const linked = path.join(t.root, 'linked');
    git(t.root, 'worktree', 'add', '-b', 'linked', linked);
    t.workspace.roots = () => [{ name: 'linked', path: linked }];
    await fs.writeFile(path.join(linked, 'a.txt'), 'linked change');
    const ready = await prepare(t, gitStageTool, { paths: ['a.txt'] });
    const alternate = path.join(t.root, 'alternate.git');
    await fs.cp(path.join(t.root, '.git'), alternate, { recursive: true });
    await fs.writeFile(
      path.join(t.root, '.git/worktrees/linked/commondir'),
      alternate.replace(/\\/g, '/') + '\n',
    );
    await expect(execute(t, gitStageTool, ready)).rejects.toThrow('changed while awaiting approval');
    expect(git(linked, 'diff', '--cached', '--name-only')).toBe('');
  });

  it('handles prototype-like filenames without losing their staging snapshots', async () => {
    const t = await fixture();
    await fs.writeFile(path.join(t.root, '__proto__'), 'first');
    const ready = await prepare(t, gitStageTool, { paths: ['__proto__'] });
    await fs.writeFile(path.join(t.root, '__proto__'), 'second');
    await expect(execute(t, gitStageTool, ready)).rejects.toThrow('Saved files changed');
  });
});
