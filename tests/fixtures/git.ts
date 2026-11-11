import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { vi } from 'vitest';
import type { AnyTool, ToolContext } from '../../src/core/tools/types';
import { runFileProcess } from '../../src/extension/adapters/processExecution';
import { FakeProcess, MemoryWorkspace } from './fakes';

class DiskWorkspace extends MemoryWorkspace {
  readonly dirty = new Set<string>();
  isDirty(file: string) {
    return this.dirty.has(file);
  }
  override async readBytes(file: string) {
    return new Uint8Array(await fs.readFile(file));
  }
  override async readFile(file: string) {
    return fs.readFile(file, 'utf8');
  }
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
export const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export async function createGitFixture(folders: string[], unborn = false) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'sovran-git-'));
  folders.push(folder);
  const root = await fs.realpath(folder);
  git(root, 'init', '--initial-branch=main');
  git(root, 'config', 'user.name', 'Fixture');
  git(root, 'config', 'user.email', 'fixture@example.invalid');
  git(root, 'config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(root, 'a.txt'), 'first\nsecond\n');
  await fs.writeFile(path.join(root, '.env'), 'PRIVATE_FIXTURE=original-secret\n');
  if (!unborn) {
    git(root, 'add', '--', 'a.txt', '.env');
    git(root, '-c', 'commit.gpgsign=false', 'commit', '-m', 'Initial fixture');
  }
  const initial = unborn ? '' : git(root, 'rev-parse', 'HEAD');
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
