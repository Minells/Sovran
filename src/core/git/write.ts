import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type { GitApprovalDetail } from '../ports';
import { makeDiff, isProbablyBinary, truncateMiddle } from '../tools/edits';
import { ToolError, type PreparedAction, type ToolContext, type ToolResult } from '../tools/types';
import { isInside } from '../security/paths';
import { GitReader, gitPath, prepareGit, type GitRequest } from './read';

export const GIT_WRITE_REASON = 'Git index changes and commits require approval in every mode.';
const activeRepositories = new Set<string>();
const MAX_INDEX_BYTES = 16 * 1024 * 1024;
const oidPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

type Operation = Extract<GitApprovalDetail['operation'], 'stage' | 'unstage' | 'commit'>;
interface Snapshot {
  indexPath: string;
  indexHash: string | null;
  commonDirectory: string;
  head: string | null;
  branch: string;
  configHash: string;
}
interface WriteState {
  repository: string;
  realRepository: string;
  operation: Operation;
  files: string[];
  message?: string;
  snapshot: Snapshot;
  savedFiles: Record<string, string>;
}

function fields(output: string): string[] {
  if (!output) return [];
  if (!output.endsWith('\0')) throw new ToolError('Incomplete Git index metadata.');
  return output.slice(0, -1).split('\0');
}

export async function gitWriteSnapshot(git: GitReader, ctx: ToolContext): Promise<Snapshot> {
  if (!ctx.workspace.readBytes) throw new ToolError('This host cannot safely read the raw Git index.');
  const location = (
    await git.call(['rev-parse', '--path-format=absolute', '--git-path', 'index'])
  ).stdout.replace(/\n$/, '');
  if (!path.isAbsolute(location)) throw new ToolError('Git did not resolve an absolute index path.');
  const commonPath = (
    await git.call(['rev-parse', '--path-format=absolute', '--git-common-dir'])
  ).stdout.replace(/\n$/, '');
  if (!path.isAbsolute(commonPath))
    throw new ToolError('Git did not resolve an absolute administrative directory.');
  const commonDirectory = await ctx.workspace.realpath(commonPath);
  const indexStat = await ctx.workspace.stat(location);
  let indexHash: string | null = null;
  if (indexStat) {
    if (indexStat.type !== 'file' || indexStat.size > MAX_INDEX_BYTES)
      throw new ToolError('The Git index exceeds the 16 MiB safety limit or is not a regular file.');
    const actual = await ctx.workspace.realpath(location);
    const expected = path.join(await ctx.workspace.realpath(path.dirname(location)), path.basename(location));
    if (actual !== expected) throw new ToolError('Native Git writes do not support a symlinked index.');
    const bytes = await ctx.workspace.readBytes(location);
    if (bytes.length > MAX_INDEX_BYTES || Buffer.from(bytes.subarray(0, 4)).toString('ascii') !== 'DIRC')
      throw new ToolError('The raw Git index is invalid or too large.');
    indexHash = hash(bytes);
  }
  const resolved = await git.call(
    ['rev-parse', '--verify', '--quiet', '--end-of-options', 'HEAD^{commit}'],
    200,
    [0, 1],
  );
  const head = resolved.exitCode === 0 ? resolved.stdout.trim() : null;
  if (head !== null && !oidPattern.test(head)) throw new ToolError('Git returned an invalid HEAD.');
  const symbolic = await git.call(['symbolic-ref', '--quiet', 'HEAD'], 1000, [0, 1]);
  const branch = symbolic.exitCode === 0 ? symbolic.stdout.trim() : '(detached HEAD)';
  if (!head) {
    if (!branch.startsWith('refs/heads/'))
      throw new ToolError('The repository has no valid HEAD or unborn branch.');
    const exists = await git.call(['show-ref', '--verify', '--quiet', branch], 1000, [0, 1]);
    if (exists.exitCode !== 1) throw new ToolError('The existing branch does not resolve to a valid commit.');
  }
  // Raw configuration is hashed in memory only. It never enters approval details, logs or model results.
  const configHash = hash((await git.call(['config', '--null', '--list'])).stdout);
  return { indexPath: location, indexHash, commonDirectory, head, branch, configHash };
}

/** Sovran mutations in linked worktrees share refs and therefore share a lock. */
export async function withGitWriteLock<T>(commonDirectory: string, action: () => Promise<T>): Promise<T> {
  if (activeRepositories.has(commonDirectory))
    throw new ToolError(
      'Another Sovran Git write is running for this repository. Inspect status and request this action again.',
    );
  activeRepositories.add(commonDirectory);
  try {
    return await action();
  } finally {
    activeRepositories.delete(commonDirectory);
  }
}

async function stagedFiles(git: GitReader): Promise<string[]> {
  return fields(
    (
      await git.call([
        'diff',
        '--cached',
        '--name-only',
        '-z',
        '--no-renames',
        '--no-ext-diff',
        '--no-textconv',
        '--ignore-submodules=all',
        '--',
      ])
    ).stdout,
  );
}

async function savedFiles(
  git: GitReader,
  files: readonly string[],
  ctx: ToolContext,
  includePreview = false,
) {
  if (!ctx.workspace.readBytes) throw new ToolError('This host cannot read saved file bytes for staging.');
  const snapshots: Record<string, string> = Object.create(null);
  const previews: Record<string, string> = Object.create(null);
  for (const file of files) {
    const absolute = path.join(git.repository.absolute, file);
    const active = ctx.workspace.activeEditor();
    if (ctx.workspace.isDirty?.(absolute) || (active?.path === absolute && active.isDirty))
      throw new ToolError(`Save ${file} before requesting staging.`);
    const stat = await ctx.workspace.stat(absolute);
    if (!stat) {
      snapshots[file] = 'absent';
      continue;
    }
    if (stat.type !== 'file' || stat.size > 5 * 1024 * 1024)
      throw new ToolError(`Select individual saved files up to 5 MiB: ${file}.`);
    const bytes = await ctx.workspace.readBytes(absolute);
    if (bytes.length > 5 * 1024 * 1024)
      throw new ToolError(`${file} grew beyond the staging inspection limit.`);
    snapshots[file] = hash(`${await ctx.workspace.realpath(absolute)}\0${hash(bytes)}`);
    if (!includePreview) continue;
    const buffer = Buffer.from(bytes);
    previews[file] = isProbablyBinary(buffer.toString('utf8'))
      ? `Binary file ${file} (${bytes.length} bytes)`
      : makeDiff(file, '', truncateMiddle(buffer.toString('utf8'), 4000)).diff;
  }
  return { snapshots, previews };
}

function same(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Only bounded reads happen while preparing this always-confirmed repository action. */
export async function prepareGitWrite(
  operation: Operation,
  request: GitRequest & { message?: string },
  ctx: ToolContext,
): Promise<PreparedAction> {
  const initial = await prepareGit(request, ctx);
  let git = await GitReader.open(request, ctx, initial);
  const initialSnapshot = await gitWriteSnapshot(git, ctx);
  let files = operation === 'commit' ? await stagedFiles(git) : await git.paths(request.paths);
  files = [...new Set(files)];
  if (!files.length || files.length > 100)
    throw new ToolError('Select 1–100 files for this Git action; commits require staged changes.');
  for (const file of files) {
    if (file === '.' || file.split('/').some((part) => part.toLowerCase() === '.git'))
      throw new ToolError('Select individual files, not the whole repository or Git metadata.');
    const checked = await gitPath(git.repository, file, ctx);
    if ((await ctx.workspace.stat(path.join(git.repository.absolute, checked.local)))?.type === 'directory')
      throw new ToolError(`Directory-wide staging/unstaging is not supported: ${file}.`);
  }
  // Include every exact staged path in the approval's permission context, protected files included.
  const prepared = await prepareGit({ repository: request.repository, paths: files }, ctx);
  git = await GitReader.open(request, ctx, prepared);
  const before = await gitWriteSnapshot(git, ctx);
  if (!same(initialSnapshot, before))
    throw new ToolError('Git state changed while selecting the preview. Request the action again.');
  const saved =
    operation === 'stage'
      ? await savedFiles(git, files, ctx, true)
      : { snapshots: {}, previews: {} as Record<string, string> };
  const untracked = new Set<string>();
  if (operation !== 'commit') {
    for (const file of files) {
      const tracked = fields((await git.call(['ls-files', '--cached', '-z', '--', file])).stdout);
      if (tracked.some((name) => name !== file))
        throw new ToolError(`Select individual index entries, not a directory prefix: ${file}.`);
      if (!tracked.length && operation === 'stage') untracked.add(file);
      if (!tracked.length && (operation === 'unstage' || saved.snapshots[file] === 'absent'))
        throw new ToolError(`${file} has no matching index entry to ${operation}.`);
    }
  }
  const preview = await git.diff(
    operation === 'stage' ? [] : ['--cached'],
    undefined,
    files,
    0,
    Math.min(files.length, 50),
    false,
  );
  if (operation === 'unstage' && !(await stagedFiles(git)).some((file) => files.includes(file)))
    throw new ToolError('No selected file has staged changes.');
  if (operation === 'stage' && !preview.files.length && !untracked.size)
    throw new ToolError('No selected saved file differs from the index.');
  const patches = preview.files.map((file) => ('patch' in file ? file.patch : '')).join('\n');
  const additional =
    operation === 'stage'
      ? files
          .filter((file) => untracked.has(file))
          .map((file) => saved.previews[file] ?? '')
          .join('\n')
      : '';
  if (!same(before, await gitWriteSnapshot(git, ctx)))
    throw new ToolError('Git state changed while preparing the preview. Request the action again.');
  if (operation === 'stage' && !same(saved.snapshots, (await savedFiles(git, files, ctx)).snapshots))
    throw new ToolError('Saved files changed while preparing the preview. Request the action again.');
  const state: WriteState = {
    ...(prepared.state as Pick<WriteState, 'repository' | 'realRepository'>),
    operation,
    files,
    snapshot: before,
    savedFiles: saved.snapshots,
    ...(request.message !== undefined ? { message: request.message } : {}),
  };
  const warnings = [
    'Git state changes are not covered by checkpoint undo.',
    ...(operation === 'stage'
      ? [
          'Clean/process filters can run programs with your privileges. The preview uses saved content with filters disabled.',
        ]
      : []),
    ...(operation === 'commit'
      ? ['Hooks and signing may run programs with your privileges, change files/index or contact services.']
      : []),
  ];
  return {
    ...prepared,
    state,
    risks: [GIT_WRITE_REASON],
    approval: {
      kind: 'git',
      operation,
      repository: request.repository,
      branch: before.branch,
      files,
      ...(request.message !== undefined ? { message: request.message } : {}),
      preview: truncateMiddle(patches + '\n' + additional, 20_000),
      warnings,
    },
  };
}

export async function executeGitWrite(
  request: GitRequest,
  ctx: ToolContext,
  prepared: PreparedAction,
): Promise<ToolResult> {
  const state = prepared.state as WriteState;
  if (
    prepared.approval?.kind !== 'git' ||
    !state?.snapshot ||
    !['stage', 'unstage', 'commit'].includes(state.operation)
  )
    throw new ToolError('Request a fresh Git approval.');
  const git = await GitReader.open(request, ctx, prepared);
  return withGitWriteLock(state.snapshot.commonDirectory, async () => {
    if (!same(state.snapshot, await gitWriteSnapshot(git, ctx)))
      throw new ToolError(
        'The Git index, branch, HEAD or configuration changed while awaiting approval. Review a fresh preview.',
      );
    if (
      state.operation === 'stage' &&
      !same(state.savedFiles, (await savedFiles(git, state.files, ctx)).snapshots)
    )
      throw new ToolError('Saved files changed while awaiting approval. Review a fresh staging preview.');
    const command =
      state.operation === 'stage'
        ? ['add', '--', ...state.files]
        : state.operation === 'unstage'
          ? state.snapshot.head
            ? ['restore', '--staged', `--source=${state.snapshot.head}`, '--', ...state.files]
            : ['reset', '--quiet', '--', ...state.files]
          : ['commit', '--cleanup=verbatim', '-m', state.message!];
    const check = () => {
      ctx.revalidate?.();
      if (!ctx.workspace.isTrusted()) throw new ToolError('Native Git writes require a trusted workspace.');
      if (ctx.signal.aborted) throw new ToolError('Git action was cancelled before execution.');
      if (!ctx.workspace.roots().some((root) => isInside(root.path, git.repository.absolute)))
        throw new ToolError('The repository is no longer inside the open workspace.');
      if (state.operation === 'stage') {
        const active = ctx.workspace.activeEditor();
        const dirty = state.files.find((file) => {
          const absolute = path.join(git.repository.absolute, file);
          return ctx.workspace.isDirty?.(absolute) || (active?.path === absolute && active.isDirty);
        });
        if (dirty) throw new ToolError(`Save ${dirty} before requesting staging.`);
      }
    };
    check();
    const result = await ctx.process.runFile(
      'git',
      [
        '--no-pager',
        '--no-optional-locks',
        '--no-lazy-fetch',
        '--no-replace-objects',
        '--literal-pathspecs',
        `--git-dir=${path.join(git.repository.absolute, '.git')}`,
        `--work-tree=${git.repository.absolute}`,
        '-c',
        'core.fsmonitor=false',
        '-c',
        'submodule.recurse=false',
        '-c',
        'color.ui=false',
        '-c',
        'gc.auto=0',
        '-c',
        'maintenance.auto=false',
        ...command,
      ],
      {
        cwd: git.repository.absolute,
        timeoutMs: ctx.settings.terminalTimeoutMs,
        signal: ctx.signal,
        maxOutputChars: 4000,
        disallowedExecutableRoots: ctx.workspace.roots().map((root) => root.path),
        beforeSpawn: check,
        // Only an approved commit inherits configured signing-agent/key-store locations; no plaintext tokens.
        ...(state.operation === 'commit' ? { inheritEnv: ['SSH_AUTH_SOCK', 'GNUPGHOME', 'GPG_TTY'] } : {}),
        env: {
          GIT_TERMINAL_PROMPT: '0',
          GIT_OPTIONAL_LOCKS: '0',
          GIT_NO_LAZY_FETCH: '1',
          GIT_NO_REPLACE_OBJECTS: '1',
          GIT_PAGER: 'cat',
          PAGER: 'cat',
        },
      },
    );
    if (result.exitCode !== 0 || result.cancelled || result.timedOut) {
      return {
        isError: true,
        content: `Git ${state.operation} did not finish successfully${result.cancelled ? ' (cancelled)' : result.timedOut ? ' (timed out)' : ''}. Git state may have changed; inspect git_status/git_log before retrying. No rollback was attempted.\n${truncateMiddle(result.stderr || result.output, 1000)}`,
      };
    }
    // Hooks may have printed arbitrary content. Return bounded structured metadata rather than their stdout.
    let commit: string | undefined;
    if (state.operation === 'commit') {
      try {
        commit = await (await GitReader.open(request, ctx, prepared)).commit('HEAD');
      } catch {
        /* The command completed; post-command inspection is best-effort, not evidence of rollback. */
      }
    }
    return {
      content: JSON.stringify({
        operation: state.operation,
        repository: request.repository,
        reviewedFiles: state.files,
        ...(commit ? { headAfter: commit } : {}),
        checkpointUndo: false,
        ...(state.operation === 'commit'
          ? {
              note: 'Hooks may have changed the index or files; inspect git_status/git_log to verify the resulting commit.',
            }
          : {}),
      }),
      summary: `${state.operation} · ${state.files.length} file(s)`,
    };
  });
}
