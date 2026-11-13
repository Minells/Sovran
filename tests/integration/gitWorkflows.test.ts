import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  gitFetchTool,
  gitPullTool,
  gitPushTool,
  gitRebaseTool,
} from '../../src/core/tools/builtin/gitWriteTools';
import { createBuiltinRegistry } from '../../src/core/tools/builtin';
import type { AnyTool } from '../../src/core/tools/types';
import { createGitFixture, git } from '../fixtures/git';

const folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0)) await fs.rm(folder, { recursive: true, force: true });
});

async function fixture() {
  const test = await createGitFixture(folders);
  const bare = path.join(test.root, '.git', 'remote.git');
  const peer = path.join(test.root, '.git', 'peer');
  git(test.root, 'init', '--bare', '--initial-branch=main', bare);
  git(test.root, 'remote', 'add', 'origin', bare);
  const prepare = async (tool: AnyTool, input = {}) => {
    const args = tool.schema.parse({ repository: '.', ...input });
    const prepared = await tool.prepare!(args, test.ctx);
    return { prepared, execute: () => tool.execute(args, test.ctx, prepared) };
  };
  return { ...test, bare, peer, prepare };
}

describe('native Git workflow tools', () => {
  it(
    'pushes one branch and tracks it, fetches without moving HEAD, then fast-forwards pull',
    { timeout: 25_000 },
    async () => {
      const test = await fixture();
      const push = await test.prepare(gitPushTool, { remote: 'origin', branch: 'main', set_upstream: true });
      expect(push.prepared.approval).toMatchObject({
        kind: 'git',
        operation: 'push',
        target: { destination: `origin · ${test.bare}` },
      });
      expect(push.prepared.risks).not.toHaveLength(0);
      expect(git(test.bare, 'for-each-ref')).toBe('');
      expect(await push.execute()).not.toHaveProperty('isError');
      expect(git(test.bare, 'rev-parse', 'main')).toBe(test.initial);
      expect(git(test.root, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe('origin/main');

      git(test.root, 'clone', test.bare, test.peer);
      await fs.writeFile(path.join(test.peer, 'peer.txt'), 'change\n');
      git(test.peer, 'add', 'peer.txt');
      git(test.peer, '-c', 'commit.gpgsign=false', 'commit', '-m', 'Peer change');
      git(test.peer, 'push', 'origin', 'main');
      const peerHead = git(test.peer, 'rev-parse', 'HEAD');
      const fetch = await test.prepare(gitFetchTool, { remote: 'origin' });
      expect(await fetch.execute()).not.toHaveProperty('isError');
      expect(git(test.root, 'rev-parse', 'HEAD')).toBe(test.initial);
      expect(git(test.root, 'rev-parse', 'origin/main')).toBe(peerHead);
      const pull = await test.prepare(gitPullTool);
      expect(await pull.execute()).not.toHaveProperty('isError');
      expect(git(test.root, 'rev-parse', 'HEAD')).toBe(peerHead);
      expect(await fs.readFile(path.join(test.root, 'peer.txt'), 'utf8')).toBe('change\n');
      expect(createBuiltinRegistry().get('git_push')).toMatchObject({ risk: 'execute', requiresTrust: true });
    },
  );

  it('rejects refspecs that touch local branches and resolves a separate push URL before approval', async () => {
    const test = await fixture();
    git(test.root, 'config', 'remote.origin.pushurl', 'https://example.invalid/group/project.git');
    const push = await test.prepare(gitPushTool, { remote: 'origin', branch: 'main' });
    expect(push.prepared.approval).toMatchObject({
      target: { destination: 'origin · https://example.invalid/group/project.git' },
    });
    git(test.root, 'config', 'remote.origin.pushurl', test.bare);
    await expect(push.execute()).rejects.toThrow(/changed while awaiting approval/);
    expect(git(test.bare, 'for-each-ref')).toBe('');

    git(test.root, 'config', 'remote.origin.fetch', '+refs/heads/main:refs/heads/main');
    await expect(test.prepare(gitFetchTool, { remote: 'origin' })).rejects.toThrow(/matching tracking refs/);
  });

  it('refuses a credential-bearing remote without reflecting its token', async () => {
    const test = await fixture();
    git(test.root, 'config', 'remote.origin.url', 'https://user:fixture-secret@example.invalid/repo');
    await expect(test.prepare(gitFetchTool, { remote: 'origin' })).rejects.toThrow(/^Remove credentials,/);
    expect(test.calls.some((args) => args.includes('fetch'))).toBe(false);
  });

  // About ten Git processes: close to the default 5 s on Windows runners, like the other tests timed here.
  it('pins the rebase target and refuses a dirty working tree or editor', { timeout: 20_000 }, async () => {
    const test = await fixture();
    git(test.root, 'switch', '-c', 'feature');
    await fs.writeFile(path.join(test.root, 'feature.txt'), 'feature\n');
    await expect(test.prepare(gitRebaseTool, { upstream: 'main' })).rejects.toThrow(/clean working tree/);
    git(test.root, 'add', 'feature.txt');
    git(test.root, 'commit', '-m', 'Feature');
    const original = git(test.root, 'rev-parse', 'HEAD');
    git(test.root, 'switch', 'main');
    git(test.root, 'commit', '--allow-empty', '-m', 'New base');
    const base = git(test.root, 'rev-parse', 'HEAD');
    git(test.root, 'switch', 'feature');
    test.ctx.workspace.dirtyFiles = () => [path.join(test.root, 'a.txt')];
    await expect(test.prepare(gitRebaseTool, { upstream: 'main' })).rejects.toThrow(/Save the repository/);
    test.ctx.workspace.dirtyFiles = () => [];

    const rebase = await test.prepare(gitRebaseTool, { upstream: 'main' });
    expect(rebase.prepared.approval).toMatchObject({ target: { destination: `main (${base})` } });
    expect(await rebase.execute()).not.toHaveProperty('isError');
    expect(git(test.root, 'rev-parse', 'HEAD')).not.toBe(original);
    expect(git(test.root, 'rev-parse', 'HEAD^')).toBe(base);
  });

  it('protects an ignored file that the rebase target would replace', async () => {
    const test = await fixture();
    git(test.root, 'switch', '-c', 'base');
    await fs.writeFile(path.join(test.root, 'local.settings'), 'upstream\n');
    git(test.root, 'add', 'local.settings');
    git(test.root, 'commit', '-m', 'Tracked settings');
    git(test.root, 'switch', 'main');
    await fs.appendFile(path.join(test.root, '.git', 'info', 'exclude'), '\nlocal.settings\n');
    await fs.writeFile(path.join(test.root, 'local.settings'), 'local only\n');

    await expect(test.prepare(gitRebaseTool, { upstream: 'base' })).rejects.toThrow(
      /could overwrite ignored files/,
    );
    expect(await fs.readFile(path.join(test.root, 'local.settings'), 'utf8')).toBe('local only\n');
  });

  it('reports a rebase conflict and leaves it available for Git to abort', { timeout: 20_000 }, async () => {
    const test = await fixture();
    git(test.root, 'switch', '-c', 'feature');
    await fs.writeFile(path.join(test.root, 'a.txt'), 'feature\n');
    git(test.root, 'commit', '-am', 'Change on feature');
    const original = git(test.root, 'rev-parse', 'HEAD');
    git(test.root, 'switch', 'main');
    await fs.writeFile(path.join(test.root, 'a.txt'), 'main\n');
    git(test.root, 'commit', '-am', 'Change on main');
    git(test.root, 'switch', 'feature');

    const rebase = await test.prepare(gitRebaseTool, { upstream: 'main' });
    expect(await rebase.execute()).toMatchObject({
      isError: true,
      content: expect.stringContaining('Resolve the conflicts'),
    });
    expect(git(test.root, 'status', '--porcelain')).toContain('UU a.txt');
    git(test.root, 'rebase', '--abort');
    expect(git(test.root, 'rev-parse', 'HEAD')).toBe(original);
  });

  it(
    'stops a pull after fetching if an editor became dirty during the network phase',
    { timeout: 20_000 },
    async () => {
      const test = await fixture();
      expect(
        await (
          await test.prepare(gitPushTool, { remote: 'origin', branch: 'main', set_upstream: true })
        ).execute(),
      ).not.toHaveProperty('isError');
      git(test.root, 'clone', test.bare, test.peer);
      git(test.peer, 'commit', '--allow-empty', '-m', 'New remote commit');
      git(test.peer, 'push', 'origin', 'main');
      const pull = await test.prepare(gitPullTool);
      let dirty = false;
      test.ctx.workspace.dirtyFiles = () => (dirty ? [path.join(test.root, 'a.txt')] : []);
      const run = test.ctx.process.runFile.bind(test.ctx.process);
      test.ctx.process.runFile = async (...args) => {
        const result = await run(...args);
        if (args[1].includes('fetch')) dirty = true;
        return result;
      };
      expect(await pull.execute()).toMatchObject({
        isError: true,
        content: expect.stringContaining('Fetch completed'),
      });
      expect(git(test.root, 'rev-parse', 'HEAD')).toBe(test.initial);
      expect(git(test.root, 'rev-parse', 'origin/main')).toBe(git(test.peer, 'rev-parse', 'HEAD'));
    },
  );
});
