import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnyTool, ToolContext } from '../../src/core/tools/types';
import {
  gitBranchesTool,
  gitDiffTool,
  gitLogTool,
  gitShowTool,
  gitStatusTool,
} from '../../src/core/tools/builtin/gitTools';
import { parseChanges, validRevision } from '../../src/core/git/read';
import { decide } from '../../src/core/permissions/policy';
import { runFileProcess } from '../../src/extension/adapters/processExecution';
import { AgentRunner } from '../../src/core/agent/agentRunner';
import { MemoryCapabilityStore } from '../../src/core/providers/capabilities';
import { nullLogger } from '../../src/core/ports';
import { createBuiltinRegistry } from '../../src/core/tools/builtin';
import type { Session, ToolMessage } from '../../src/core/sessions/model';
import {
  FakeProcess,
  MemoryWorkspace,
  ScriptedApprovals,
  ScriptedProvider,
  call,
  text,
} from '../fixtures/fakes';

class DiskWorkspace extends MemoryWorkspace {
  constructor(private readonly folders: Array<{ name: string; path: string }>) {
    super();
  }
  override roots() {
    return this.folders;
  }
  override async realpath(file: string) {
    return fs.realpath(file);
  }
  override async stat(file: string) {
    try {
      const s = await fs.stat(file);
      return {
        type: s.isDirectory() ? ('directory' as const) : s.isFile() ? ('file' as const) : ('other' as const),
        size: s.size,
        mtimeMs: s.mtimeMs,
      };
    } catch {
      return null;
    }
  }
}

const folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0)) await fs.rm(folder, { recursive: true, force: true });
});
const env = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function fixture() {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'sovran-git-'));
  folders.push(folder);
  const root = await fs.realpath(folder);
  git(root, 'init', '--initial-branch=main');
  await fs.writeFile(path.join(root, 'a.txt'), 'first\nsecond\n');
  await fs.writeFile(path.join(root, '.env'), 'PRIVATE_FIXTURE=original-secret\n');
  git(root, 'add', '--', 'a.txt', '.env');
  git(root, '-c', 'commit.gpgsign=false', 'commit', '-m', 'Initial fixture');
  const initial = git(root, 'rev-parse', 'HEAD');
  const workspace = new DiskWorkspace([{ name: 'app', path: root }]);
  const calls: string[][] = [];
  const process = new FakeProcess();
  process.runFile = async (executable, argv, options) => {
    calls.push([...argv]);
    return runFileProcess(executable, argv, {
      ...options,
      env: {
        ...options.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: globalThis.process.platform === 'win32' ? 'NUL' : '/dev/null',
      },
    });
  };
  const ctx: ToolContext = {
    workspace,
    process,
    signal: new AbortController().signal,
    settings: {
      terminalTimeoutMs: 15000,
      maxToolResultChars: 20000,
      protectedPaths: ['**/.env', '**/.git/**'],
    },
    onOutput: vi.fn(),
  };
  const execute = async (tool: AnyTool, input: Record<string, unknown> = {}) => {
    const args = tool.schema.parse({ repository: '.', ...input });
    const prepared = await tool.prepare!(args, ctx);
    return JSON.parse((await tool.execute(args, ctx, prepared)).content);
  };
  return { root, workspace, ctx, calls, initial, execute };
}

describe('native Git reads on disposable repositories', () => {
  it('reads status, history, branches and historical blobs without changing the index', async () => {
    const t = await fixture();
    const index = await fs.readFile(path.join(t.root, '.git/index'));
    await fs.writeFile(path.join(t.root, 'a.txt'), 'changed\nsecond\n');
    await fs.writeFile(path.join(t.root, 'new file.txt'), 'untracked');
    const status = await t.execute(gitStatusTool);
    expect(status.branch).toBe('main');
    expect(status.entries).toContainEqual({ index: ' ', worktree: 'M', path: 'a.txt' });
    expect(status.entries).toContainEqual({ index: '?', worktree: '?', path: 'new file.txt' });
    const history = await t.execute(gitLogTool);
    expect(history.entries[0]).toMatchObject({
      commit: t.initial,
      subject: 'Initial fixture',
      author: 'Fixture',
    });
    const branches = await t.execute(gitBranchesTool);
    expect(branches.entries).toContainEqual({
      name: 'refs/heads/main',
      commit: t.initial,
      current: true,
      remote: false,
    });
    const blob = await t.execute(gitShowTool, { path: 'a.txt', start_line: 2, end_line: 2 });
    expect(blob.content).toBe('second');
    expect(blob.truncated).toBe(false);
    expect(blob.nextLine).toBe(3);
    expect(await fs.readFile(path.join(t.root, '.git/index'))).toEqual(index);
    expect(t.ctx.onOutput).not.toHaveBeenCalled();
  });

  it('supports unstaged/staged/revision diff and commit/root-commit inspection', async () => {
    const t = await fixture();
    const rootCommit = await t.execute(gitShowTool);
    expect(rootCommit.files.some((entry: { path: string }) => entry.path === 'a.txt')).toBe(true);
    expect(rootCommit.omittedProtected).toBe(1);
    await fs.writeFile(path.join(t.root, 'a.txt'), 'next\nsecond\n');
    expect((await t.execute(gitDiffTool)).files[0].patch).toContain('+next');
    git(t.root, 'add', '--', 'a.txt');
    expect((await t.execute(gitDiffTool, { scope: 'staged' })).files[0].patch).toContain('+next');
    git(t.root, '-c', 'commit.gpgsign=false', 'commit', '-m', 'Second fixture');
    expect((await t.execute(gitDiffTool, { scope: 'revision', from: t.initial })).files[0].patch).toContain(
      '+next',
    );
    expect((await t.execute(gitShowTool)).files[0].patch).toContain('+next');
    expect((await t.execute(gitLogTool, { limit: 1 })).nextOffset).toBe(1);
    expect((await t.execute(gitLogTool, { limit: 1, offset: 1 })).entries[0].commit).toBe(t.initial);
  });

  it('omits protected diffs and protected rename sources, including a target-only request', async () => {
    const t = await fixture();
    await fs.writeFile(path.join(t.root, '.env'), 'PRIVATE_FIXTURE=changed-secret\n');
    await fs.writeFile(path.join(t.root, 'a.txt'), 'safe-content\n');
    const diff = await t.execute(gitDiffTool);
    expect(JSON.stringify(diff)).not.toContain('changed-secret');
    expect(diff.omittedProtected).toBe(1);
    git(t.root, 'restore', '--', '.env');
    git(t.root, 'mv', '.env', 'public.txt');
    const rename = await t.execute(gitDiffTool, { scope: 'staged', paths: ['public.txt'] });
    expect(rename.files).toEqual([]);
    expect(rename.omittedProtected).toBe(1);
    expect(JSON.stringify(rename)).not.toContain('original-secret');
  });

  it('prepares explicit protected reads for approval without starting Git', async () => {
    const t = await fixture();
    const args = gitShowTool.schema.parse({ repository: '.', path: '.env' });
    const prepared = await gitShowTool.prepare!(args, t.ctx);
    expect(t.calls).toHaveLength(0);
    expect(prepared.paths).toContain('.env');
    expect(
      decide({
        risk: 'read',
        mode: 'plan',
        workspaceTrusted: true,
        paths: prepared.paths,
        settings: {
          approvalMode: 'auto',
          allowedCommands: [],
          protectedPaths: t.ctx.settings.protectedPaths,
        },
        grants: { edits: false },
      }).action,
    ).toBe('ask');
    expect(JSON.parse((await gitShowTool.execute(args, t.ctx, prepared)).content).content).toContain(
      'original-secret',
    );
  });

  it('treats path metacharacters as literals and rejects revision/pathspec injection', async () => {
    const t = await fixture();
    const name = process.platform === 'win32' ? 'name ; $().txt' : 'name ; $(touch FORBIDDEN) `id` [x]*.txt';
    await fs.writeFile(path.join(t.root, name), 'before');
    git(t.root, 'add', '--', name);
    git(t.root, '-c', 'commit.gpgsign=false', 'commit', '-m', 'Literal filename');
    await fs.writeFile(path.join(t.root, name), 'after');
    const diff = await t.execute(gitDiffTool, { paths: [name] });
    expect(diff.files[0].patch).toContain('+after');
    expect((await t.execute(gitDiffTool, { paths: [':(top)*'] })).files).toEqual([]);
    for (const value of [
      '--output=FORBIDDEN',
      'HEAD:.env',
      ':/password',
      'HEAD..main',
      'HEAD^{/secret}',
      '@{1}',
    ]) {
      expect(gitShowTool.schema.safeParse({ repository: '.', revision: value }).success).toBe(false);
    }
    await expect(t.execute(gitShowTool, { path: '../outside' })).rejects.toThrow(/traversal/);
    expect(await fs.stat(path.join(t.root, 'FORBIDDEN')).catch(() => null)).toBeNull();
  });

  it('disables fsmonitor, external diff, textconv and clean/process filters', async () => {
    const t = await fixture();
    const marker = path.join(t.root, 'HELPER_RAN');
    const script = path.join(t.root, 'helper.cjs');
    await fs.writeFile(
      script,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad');process.stdout.write('helper-content')`,
    );
    const command = `"${process.execPath}" "${script}"`;
    git(t.root, 'config', 'core.fsmonitor', command);
    git(t.root, 'config', 'diff.external', command);
    git(t.root, 'config', 'diff.evil.textconv', command);
    git(t.root, 'config', 'filter.evil.clean', command);
    git(t.root, 'config', 'filter.evil.process', command);
    git(t.root, 'config', 'filter.evil.required', 'true');
    await fs.writeFile(path.join(t.root, '.gitattributes'), 'a.txt diff=evil filter=evil\n');
    await fs.writeFile(path.join(t.root, 'a.txt'), 'changed while helpers configured\n');
    await t.execute(gitStatusTool);
    const diff = await t.execute(gitDiffTool);
    expect(diff.files[0].patch).toContain('changed while helpers configured');
    await t.execute(gitShowTool, { path: 'a.txt' });
    await t.execute(gitLogTool);
    expect(await fs.stat(marker).catch(() => null)).toBeNull();
  });

  it('supports linked worktrees, explicit multi-root and nested repositories', async () => {
    const t = await fixture();
    const sibling = path.join(t.root, 'linked');
    git(t.root, 'worktree', 'add', '-b', 'linked', sibling);
    t.workspace.roots = () => [
      { name: 'main', path: t.root },
      { name: 'linked', path: sibling },
    ];
    await expect(t.execute(gitStatusTool)).rejects.toThrow('named workspace root');
    expect((await t.execute(gitStatusTool, { repository: 'linked' })).branch).toBe('linked');
    const nested = path.join(t.root, 'nested');
    await fs.mkdir(nested);
    git(nested, 'init', '--initial-branch=nested');
    expect((await t.execute(gitStatusTool, { repository: 'main/nested' })).branch).toContain('nested');
  });

  it('does not discover a parent outside the selected root or follow an escaping path', async () => {
    const t = await fixture();
    const child = path.join(t.root, 'child');
    await fs.mkdir(child);
    t.workspace.roots = () => [{ name: 'child', path: child }];
    await expect(t.execute(gitStatusTool)).rejects.toThrow('does not search parent');
    t.workspace.roots = () => [{ name: 'app', path: t.root }];
    if (process.platform !== 'win32') {
      await fs.symlink(os.tmpdir(), path.join(t.root, 'escape'));
      await expect(t.execute(gitShowTool, { path: 'escape/outside' })).rejects.toThrow(
        'outside the workspace',
      );
    }
  });

  it('fails before Git when trust is lost, and reports missing Git, timeout and cancelled calls', async () => {
    const t = await fixture();
    t.workspace.trusted = false;
    await expect(t.execute(gitStatusTool)).rejects.toThrow('trusted workspace');
    expect(t.calls).toHaveLength(0);
    t.workspace.trusted = true;
    t.ctx.process.runFile = (executable, argv, options) =>
      runFileProcess(executable, argv, { ...options, env: { PATH: '' } });
    await expect(t.execute(gitStatusTool)).rejects.toThrow('host PATH');
    t.ctx.process.runFile = async () => ({
      exitCode: null,
      signal: 'SIGTERM',
      output: '',
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: true,
      cancelled: false,
      durationMs: 1,
    });
    await expect(t.execute(gitStatusTool)).rejects.toThrow('timed out');
    t.ctx.signal = AbortSignal.abort();
    await expect(t.execute(gitStatusTool)).rejects.toThrow('cancelled');
  });

  it('uses native Git in trusted Plan, but rejects a protected file before starting any Git process', async () => {
    const t = await fixture();
    const provider = new ScriptedProvider([
      [call(0, 'git_status', { repository: '.' })],
      [call(0, 'git_show', { repository: '.', path: '.env' })],
      [text('done')],
    ]);
    let callsBeforeApproval = -1;
    const approvals = new ScriptedApprovals(() => {
      callsBeforeApproval = t.calls.length;
      return { approved: false };
    });
    const session: Session = {
      id: 's',
      title: 'Git',
      mode: 'plan',
      createdAt: 0,
      updatedAt: 0,
      messages: [],
    };
    const runner = new AgentRunner({
      provider,
      registry: createBuiltinRegistry(),
      workspace: t.workspace,
      process: t.ctx.process,
      approvals,
      capabilities: new MemoryCapabilityStore(),
      logger: nullLogger,
    });
    await runner.run({
      session,
      providerId: 'fixture',
      model: { id: 'm' },
      mode: 'plan',
      settings: {
        maxIterations: 3,
        policy: { approvalMode: 'auto', allowedCommands: [], protectedPaths: t.ctx.settings.protectedPaths },
        tools: t.ctx.settings,
        defaultContextWindow: 32768,
        defaultMaxOutputTokens: 4096,
      },
      grants: { edits: false },
      signal: t.ctx.signal,
      emit: () => {},
    });
    const messages = session.messages.filter((m): m is ToolMessage => m.role === 'tool');
    expect(messages.map((m) => m.status)).toEqual(['success', 'denied']);
    expect(approvals.requests).toHaveLength(1);
    expect(t.calls.length).toBe(callsBeforeApproval);
    expect(messages.map((m) => m.content).join('')).not.toContain('original-secret');
    t.workspace.trusted = false;
    expect(
      createBuiltinRegistry()
        .list('plan', { workspaceTrusted: false })
        .some((tool) => tool.group === 'git'),
    ).toBe(false);
  });

  it('never lazily fetches missing promisor objects or starts a configured SSH command', async () => {
    const t = await fixture();
    const marker = path.join(t.root, 'NETWORK_HELPER_RAN');
    const helper = path.join(t.root, 'ssh-helper.cjs');
    await fs.writeFile(helper, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad')`);
    const blob = git(t.root, 'rev-parse', 'HEAD:a.txt');
    await fs.unlink(path.join(t.root, '.git/objects', blob.slice(0, 2), blob.slice(2)));
    git(t.root, 'config', 'remote.fixture.url', 'ssh://fixture.invalid/repository');
    git(t.root, 'config', 'remote.fixture.promisor', 'true');
    git(t.root, 'config', 'extensions.partialClone', 'fixture');
    git(t.root, 'config', 'protocol.ssh.allow', 'always');
    git(t.root, 'config', 'core.sshCommand', `"${process.execPath}" "${helper}"`);
    await expect(t.execute(gitShowTool, { path: 'a.txt' })).rejects.toThrow('Git inspection failed');
    expect(await fs.stat(marker).catch(() => null)).toBeNull();
  });

  it('pins the working tree even if repository configuration points elsewhere', async () => {
    const t = await fixture();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'sovran-outside-'));
    folders.push(outside);
    await fs.writeFile(path.join(outside, 'OUTSIDE_FILE'), 'outside workspace');
    git(t.root, 'config', 'core.worktree', outside);
    await fs.writeFile(path.join(t.root, 'a.txt'), 'inside workspace');
    const status = await t.execute(gitStatusTool);
    expect(JSON.stringify(status)).not.toContain('OUTSIDE_FILE');
    expect((await t.execute(gitDiffTool)).files[0].patch).toContain('inside workspace');
  });

  it('handles merge inspection, filename paging, binary blobs and bounded patch output', async () => {
    const t = await fixture();
    git(t.root, 'checkout', '-b', 'side');
    await fs.writeFile(path.join(t.root, 'side.txt'), 'side branch\n');
    git(t.root, 'add', '--', 'side.txt');
    git(t.root, '-c', 'commit.gpgsign=false', 'commit', '-m', 'Side fixture');
    git(t.root, 'checkout', 'main');
    await fs.writeFile(path.join(t.root, 'main.txt'), 'main branch\n');
    await fs.writeFile(path.join(t.root, 'binary.bin'), Buffer.from([0, 1, 2]));
    git(t.root, 'add', '--', 'main.txt', 'binary.bin');
    git(t.root, '-c', 'commit.gpgsign=false', 'commit', '-m', 'Main fixture');
    git(t.root, '-c', 'commit.gpgsign=false', 'merge', '--no-ff', 'side', '-m', 'Merge fixture');
    expect(
      (await t.execute(gitShowTool)).files.some((file: { path: string }) => file.path === 'side.txt'),
    ).toBe(true);
    expect((await t.execute(gitShowTool, { path: 'binary.bin' })).binary).toBe(true);
    await fs.writeFile(path.join(t.root, 'a.txt'), 'long-line '.repeat(10000));
    await fs.writeFile(path.join(t.root, 'side.txt'), 'changed side');
    const names = await t.execute(gitDiffTool, { names_only: true, limit: 1 });
    expect(names.files).toHaveLength(1);
    expect(names.nextOffset).toBe(1);
    t.ctx.settings.maxToolResultChars = 2000;
    const patch = await t.execute(gitDiffTool, { paths: ['a.txt'] });
    expect(patch.files[0].truncated).toBe(true);
    expect(patch.files[0].patch.length).toBeLessThan(2100);
  });

  it('pages historical file content by the lines actually returned within the result budget', async () => {
    const t = await fixture();
    await fs.writeFile(
      path.join(t.root, 'a.txt'),
      Array.from({ length: 100 }, (_, i) => `line ${i}: ` + 'x'.repeat(100)).join('\n'),
    );
    git(t.root, 'add', '--', 'a.txt');
    git(t.root, '-c', 'commit.gpgsign=false', 'commit', '-m', 'Long fixture');
    t.ctx.settings.maxToolResultChars = 2000;
    const first = await t.execute(gitShowTool, { path: 'a.txt' });
    expect(first.truncated).toBe(true);
    expect(first.endLine).toBeLessThan(100);
    expect(first.nextLine).toBe(first.endLine + 1);
    expect(first.content).toContain('line 0:');
    const next = await t.execute(gitShowTool, { path: 'a.txt', start_line: first.nextLine });
    expect(next.content).not.toContain('line 0:');
    expect(next.startLine).toBe(first.nextLine);
  });

  it('rejects incomplete/truncated metadata rather than parsing a partial path', async () => {
    const t = await fixture();
    t.ctx.process.runFile = async () => ({
      exitCode: 0,
      signal: null,
      output: '',
      stdout: 'filter.evil.clean\0',
      stderr: '',
      truncated: true,
      timedOut: false,
      cancelled: false,
      durationMs: 1,
    });
    await expect(t.execute(gitStatusTool)).rejects.toThrow('metadata exceeds');
    expect(() => parseChanges('M\0.env')).toThrow('incomplete metadata');
    expect(validRevision('HEAD~2^')).toBe(true);
  });
});
