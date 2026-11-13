import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GitApprovalDetail } from '../ports';
import { DECEPTIVE_CHARS } from '../permissions/commands';
import { isInside } from '../security/paths';
import { ToolError, type PreparedAction, type ToolContext, type ToolResult } from '../tools/types';
import { GitReader, prepareGit, type GitRequest } from './read';
import { gitWriteSnapshot, withGitWriteLock } from './write';

export type GitWorkflow =
  | { operation: 'fetch'; remote: string }
  | { operation: 'push'; remote: string; branch: string; setUpstream: boolean }
  | { operation: 'pull' }
  | { operation: 'rebase'; upstream: string };

type Snapshot = Awaited<ReturnType<typeof gitWriteSnapshot>>;
type WorkflowPlan = {
  argv: string[];
  target: NonNullable<GitApprovalDetail['target']>;
  protocol?: 'file' | 'https' | 'ssh';
  tracking?: string;
  fastForward?: string;
};

const OPERATIONS_IN_PROGRESS = [
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'rebase-merge',
  'rebase-apply',
  'sequencer',
  'BISECT_START',
];
const FETCH_FLAGS = [
  '--no-tags',
  '--no-prune',
  '--no-prune-tags',
  '--no-recurse-submodules',
  '--atomic',
  '--no-auto-maintenance',
  '--no-write-commit-graph',
  '--refmap=',
];
const WORKFLOW_REASON = 'Git synchronization and history changes require approval in every mode.';

async function config(git: GitReader, key: string): Promise<string[]> {
  const { stdout } = await git.call(['config', '--null', '--get-all', key], 20_000, [0, 1]);
  if (!stdout) return [];
  if (!stdout.endsWith('\0')) throw new ToolError('Git returned incomplete configuration.');
  return stdout.slice(0, -1).split('\0');
}

async function singleConfig(git: GitReader, key: string): Promise<string | undefined> {
  const entries = await config(git, key);
  if (entries.length > 1) throw new ToolError('Git returned multiple values for a required branch setting.');
  return entries[0];
}

async function branchRef(git: GitReader, ref: string): Promise<string> {
  if (
    !ref.startsWith('refs/heads/') ||
    ref.length > 300 ||
    /\s/u.test(ref) ||
    ref.replace(DECEPTIVE_CHARS, '') !== ref
  )
    throw new ToolError('Choose a single valid branch.');
  const result = await git.call(['check-ref-format', ref], 1000, [0, 1]);
  if (result.exitCode !== 0) throw new ToolError('Choose a single valid branch.');
  return ref;
}

async function cleanWorktree(git: GitReader, ctx: ToolContext): Promise<void> {
  assertSavedBuffers(git, ctx);
  for (const marker of OPERATIONS_IN_PROGRESS) {
    const { stdout } = await git.call(['rev-parse', '--path-format=absolute', '--git-path', marker], 4096);
    if (await ctx.workspace.stat(stdout.replace(/\n$/, '')))
      throw new ToolError('Finish the Git operation already in progress before changing this branch.');
  }
  const status = await git.status([], 0, 1);
  if (status.entries.length) throw new ToolError('Pull and rebase require a clean working tree and index.');
}

async function protectIgnoredFiles(git: GitReader, base: string, head: string): Promise<void> {
  const ignored = (
    await git.call([
      'ls-files',
      '--others',
      '--ignored',
      '--exclude-standard',
      '--directory',
      '--no-empty-directory',
      '-z',
      '--',
    ])
  ).stdout;
  if (!ignored) return;
  const paths = new Set(
    ignored
      .split('\0')
      .filter(Boolean)
      .map((file) => file.replace(/\/$/, '').toLowerCase()),
  );
  const parents = new Set<string>();
  for (const file of paths) {
    for (let slash = file.indexOf('/'); slash !== -1; slash = file.indexOf('/', slash + 1))
      parents.add(file.slice(0, slash));
  }
  const changes = await git.call(['diff', '--name-only', '--no-renames', '-z', head, base, '--']);
  const replay = await git.call([
    'log',
    '--format=',
    '--name-only',
    '--no-renames',
    '--diff-merges=first-parent',
    '-z',
    `${base}..${head}`,
    '--',
  ]);
  const overlaps = [...changes.stdout.split('\0'), ...replay.stdout.split('\0')].some((file) => {
    const name = file.toLowerCase();
    if (paths.has(name) || parents.has(name)) return true;
    for (let slash = name.indexOf('/'); slash !== -1; slash = name.indexOf('/', slash + 1)) {
      if (paths.has(name.slice(0, slash))) return true;
    }
    return false;
  });
  if (overlaps)
    throw new ToolError('Rebase could overwrite ignored files. Move or back them up before rebasing.');
}

function assertSavedBuffers(git: GitReader, ctx: ToolContext): void {
  const { workspace } = ctx;
  const active = workspace.activeEditor();
  const dirty =
    workspace.dirtyFiles?.() ?? workspace.openEditors().filter((file) => workspace.isDirty?.(file));
  if (
    [...dirty, ...(active?.isDirty ? [active.path] : [])].some((file) =>
      isInside(git.repository.absolute, file),
    )
  )
    throw new ToolError('Save the repository’s open editors before pulling or rebasing.');
}

async function remoteDestination(git: GitReader, ctx: ToolContext, remote: string, push: boolean) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,99}$/.test(remote) || remote.includes('..'))
    throw new ToolError('Choose a configured Git remote by name.');
  const valid = await git.call(['check-ref-format', `refs/remotes/${remote}/HEAD`], 1000, [0, 1]);
  if (valid.exitCode !== 0 || (await config(git, `remote.${remote}.vcs`)).length)
    throw new ToolError('Choose a configured remote that uses a standard Git transport.');
  let destination: string;
  try {
    destination = (
      await git.call(['remote', 'get-url', '--all', ...(push ? ['--push'] : []), remote], 4096)
    ).stdout.replace(/\r?\n$/, '');
  } catch {
    throw new ToolError('Git could not resolve the configured remote. Inspect the remote settings.');
  }
  // Do not echo malformed or credential-bearing URLs, even when Git rejects them.
  if (
    !destination ||
    /[\r\n\t]/u.test(destination) ||
    destination.replace(DECEPTIVE_CHARS, '') !== destination
  )
    throw new ToolError('Git requires exactly one safe URL for the selected remote and direction.');

  if (
    /^(?:[a-zA-Z0-9][a-zA-Z0-9._-]*@)?(?:[a-zA-Z0-9][a-zA-Z0-9.-]*|\[[0-9a-f:]+\]):[a-zA-Z0-9_./~-]+$/i.test(
      destination,
    ) &&
    !path.isAbsolute(destination)
  ) {
    return { protocol: 'ssh' as const, destination };
  }
  let localPath = destination;
  if (!path.isAbsolute(destination)) {
    let url: URL;
    try {
      url = new URL(destination);
    } catch {
      throw new ToolError('Use an HTTPS, SSH or absolute local Git remote.');
    }
    if (url.password || url.search || url.hash || (url.protocol === 'https:' && url.username))
      throw new ToolError('Remove credentials, query parameters and fragments from the Git remote URL.');
    if (
      url.protocol === 'https:' &&
      url.hostname &&
      /^https:\/\//i.test(destination) &&
      !/[\s\\]/u.test(destination)
    )
      return { protocol: 'https' as const, destination };
    if (
      url.protocol === 'ssh:' &&
      url.hostname &&
      /^ssh:\/\//i.test(destination) &&
      !/[\s\\]/u.test(destination) &&
      (!url.username || /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(url.username))
    )
      return { protocol: 'ssh' as const, destination };
    if (url.protocol !== 'file:' || url.host || url.username)
      throw new ToolError('Use an HTTPS, SSH or absolute local Git remote.');
    try {
      localPath = fileURLToPath(url);
    } catch {
      throw new ToolError('The local Git remote URL is invalid.');
    }
  }
  const real = await ctx.workspace.realpath(localPath).catch(() => undefined);
  const roots = await Promise.all(ctx.workspace.roots().map((root) => ctx.workspace.realpath(root.path)));
  if (
    !real ||
    !roots.some((root) => isInside(root, real)) ||
    (await ctx.workspace.stat(real))?.type !== 'directory'
  )
    throw new ToolError('A local Git remote must resolve to a directory inside the open workspace.');
  return { protocol: 'file' as const, destination: real };
}

/** Only branch-to-tracking mappings in the selected remote's namespace may update local refs. */
async function trackingSpecs(git: GitReader, remote: string): Promise<string[]> {
  const specs = await config(git, `remote.${remote}.fetch`);
  if (!specs.length || specs.length > 32)
    throw new ToolError('Configure branch tracking for this Git remote.');
  for (const spec of specs) {
    const [source, target, ...rest] = spec.replace(/^\+/, '').split(':');
    if (
      !source?.startsWith('refs/heads/') ||
      rest.length ||
      target !== `refs/remotes/${remote}/${source.slice(11)}`
    )
      throw new ToolError(
        'This operation requires fetch refspecs that map remote branches to matching tracking refs.',
      );
    if (source !== 'refs/heads/*') await branchRef(git, source);
  }
  return specs;
}

async function workflowPlan(
  git: GitReader,
  ctx: ToolContext,
  workflow: GitWorkflow,
  snapshot: Snapshot,
): Promise<WorkflowPlan> {
  const { operation } = workflow;
  if (operation === 'pull' || operation === 'rebase') await cleanWorktree(git, ctx);
  if (operation !== 'fetch' && (!snapshot.head || !snapshot.branch.startsWith('refs/heads/')))
    throw new ToolError('Select a checked-out branch with an existing commit.');
  if (operation === 'rebase') {
    const base = await git.commit(workflow.upstream);
    await protectIgnoredFiles(git, base, snapshot.head!);
    return {
      argv: [
        'rebase',
        '--merge',
        '--no-autostash',
        '--no-update-refs',
        '--no-autosquash',
        '--rebase-merges',
        '--no-fork-point',
        '--',
        base,
      ],
      target: {
        destination: `${workflow.upstream} (${base})`,
        refs: [`Rebase ${snapshot.branch} at ${snapshot.head}`],
      },
    };
  }

  const branch = snapshot.branch.slice('refs/heads/'.length);
  const remote = operation === 'pull' ? await singleConfig(git, `branch.${branch}.remote`) : workflow.remote;
  if (!remote) throw new ToolError('Configure the current branch’s upstream before pulling.');
  const { protocol, destination } = await remoteDestination(git, ctx, remote, operation === 'push');
  if ((await config(git, 'fetch.bundleURI')).length)
    throw new ToolError('This operation requires a remote without an additional fetch bundle URL.');
  const specs = await trackingSpecs(git, remote);
  const tracking = (
    await git.call([
      'for-each-ref',
      '--format=%(refname)%09%(objectname)%09%(symref)',
      `refs/remotes/${remote}/`,
    ])
  ).stdout;
  if (
    tracking.split('\n').some((line) => {
      const target = line.split('\t')[2];
      return target && !target.startsWith(`refs/remotes/${remote}/`);
    })
  )
    throw new ToolError('The remote has a symbolic tracking ref outside its tracking namespace.');

  const target = { destination: `${remote} · ${destination}`, refs: specs };
  const argv = ['-c', 'http.followRedirects=false'];
  if (operation === 'fetch') {
    argv.push('fetch', ...FETCH_FLAGS, '--', remote, ...specs);
  } else if (operation === 'push') {
    const dest = await branchRef(git, `refs/heads/${workflow.branch}`);
    const source = workflow.setUpstream ? snapshot.branch : snapshot.head!;
    target.refs = [`${snapshot.branch} (${snapshot.head}) → ${dest}`];
    argv.push(
      '-c',
      `remote.${remote}.mirror=false`,
      '-c',
      'push.pushOption=',
      'push',
      '--porcelain',
      '--no-follow-tags',
      '--recurse-submodules=no',
      ...(workflow.setUpstream ? ['--set-upstream'] : []),
      '--',
      remote,
      `${source}:${dest}`,
    );
  } else {
    const merge = await singleConfig(git, `branch.${branch}.merge`);
    if (!merge) throw new ToolError('Configure the current branch’s upstream before pulling.');
    await branchRef(git, merge);
    const tracked = `refs/remotes/${remote}/${merge.slice('refs/heads/'.length)}`;
    const mapping = `${merge}:${tracked}`;
    const spec =
      specs.find((value) => value.replace(/^\+/, '') === mapping) ??
      specs.find((value) => value.replace(/^\+/, '') === `refs/heads/*:refs/remotes/${remote}/*`);
    if (!spec) throw new ToolError('The upstream branch is outside this remote’s fetch refspecs.');
    target.refs = [`${merge} → ${tracked}`, `Fast-forward ${snapshot.branch} only`];
    argv.push('fetch', ...FETCH_FLAGS, '--', remote, `${spec.startsWith('+') ? '+' : ''}${mapping}`);
    return { argv, target, tracking, protocol, fastForward: tracked };
  }
  return { argv, target, tracking, protocol };
}

type WorkflowState = { snapshot: Snapshot; plan: WorkflowPlan; workflow: GitWorkflow };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export async function prepareGitWorkflow(
  request: GitRequest,
  workflow: GitWorkflow,
  ctx: ToolContext,
): Promise<PreparedAction> {
  const prepared = await prepareGit(request, ctx);
  const git = await GitReader.open(request, ctx, prepared);
  const snapshot = await gitWriteSnapshot(git, ctx);
  const plan = await workflowPlan(git, ctx, workflow, snapshot);
  if (!same(snapshot, await gitWriteSnapshot(git, ctx)))
    throw new ToolError('Git state changed while preparing the approval. Request the action again.');
  return {
    ...prepared,
    state: { ...(prepared.state as object), snapshot, plan, workflow },
    risks: [WORKFLOW_REASON],
    approval: {
      kind: 'git',
      operation: workflow.operation,
      repository: request.repository,
      branch: snapshot.branch,
      target: plan.target,
      files: [],
      preview: '',
      warnings: [
        'Git state changes are not covered by checkpoint undo.',
        'Configured Git helpers, hooks and filters may execute with your privileges.',
        ...(workflow.operation === 'rebase'
          ? ['Rebase can rewrite commit IDs and stop with conflicts.']
          : []),
      ],
    },
  };
}

function failureMessage(stderr: string): string {
  if (
    /authentication failed|could not read (username|password)|permission denied|publickey|\b(?:401|403)\b/i.test(
      stderr,
    )
  )
    return 'Check access and the SSH agent or HTTPS credential helper on the extension host.';
  if (/non-fast-forward|fetch first|not possible to fast-forward/i.test(stderr))
    return 'The branches diverged. Fetch and inspect them before deciding how to integrate.';
  if (/could not resolve|connection refused|certificate|unable to access|could not connect/i.test(stderr))
    return 'Check host reachability and the extension host’s network and TLS configuration.';
  if (/conflict|could not apply/i.test(stderr))
    return 'Resolve the conflicts in the working tree, then continue or abort the operation from Git.';
  return 'Inspect Git status and configuration before retrying.';
}

export async function executeGitWorkflow(
  request: GitRequest,
  ctx: ToolContext,
  prepared: PreparedAction,
): Promise<ToolResult> {
  const state = prepared.state as WorkflowState | undefined;
  if (prepared.approval?.kind !== 'git' || !state?.plan) throw new ToolError('Request a fresh Git approval.');
  const git = await GitReader.open(request, ctx, prepared);
  return withGitWriteLock(state.snapshot.commonDirectory, async () => {
    if (
      !same(state.snapshot, await gitWriteSnapshot(git, ctx)) ||
      !same(state.plan, await workflowPlan(git, ctx, state.workflow, state.snapshot)) ||
      !same(state.snapshot, await gitWriteSnapshot(git, ctx))
    )
      throw new ToolError(
        'Git state or the remote destination changed while awaiting approval. Review a fresh preview.',
      );

    const { operation } = state.workflow;
    const check = () => {
      ctx.revalidate?.();
      if (
        !ctx.workspace.isTrusted() ||
        ctx.signal.aborted ||
        !ctx.workspace.roots().some((root) => isInside(root.path, git.repository.absolute))
      )
        throw new ToolError('The Git action is no longer authorized in this workspace.');
      if (operation === 'pull' || operation === 'rebase') assertSavedBuffers(git, ctx);
    };
    const run = (argv: readonly string[], protocol: WorkflowPlan['protocol']) =>
      ctx.process.runFile(
        'git',
        [
          '--no-pager',
          ...git.noLazyFetch,
          '--no-replace-objects',
          `--git-dir=${path.join(git.repository.absolute, '.git')}`,
          `--work-tree=${git.repository.absolute}`,
          '-c',
          'core.fsmonitor=false',
          '-c',
          'submodule.recurse=false',
          '-c',
          'gc.auto=0',
          '-c',
          'maintenance.auto=false',
          ...argv,
        ],
        {
          cwd: git.repository.absolute,
          timeoutMs: ctx.settings.terminalTimeoutMs,
          signal: ctx.signal,
          maxOutputChars: 4000,
          beforeSpawn: check,
          disallowedExecutableRoots: ctx.workspace.roots().map((root) => root.path),
          inheritEnv: [
            'SSH_AUTH_SOCK',
            'GNUPGHOME',
            'GPG_TTY',
            'HTTP_PROXY',
            'HTTPS_PROXY',
            'NO_PROXY',
            'ALL_PROXY',
            'http_proxy',
            'https_proxy',
            'no_proxy',
            'all_proxy',
            'SSL_CERT_FILE',
            'SSL_CERT_DIR',
            'CURL_CA_BUNDLE',
          ],
          env: {
            LC_ALL: 'C',
            GIT_TERMINAL_PROMPT: '0',
            GIT_NO_LAZY_FETCH: '1',
            GIT_NO_REPLACE_OBJECTS: '1',
            GIT_ALLOW_PROTOCOL: protocol ?? '',
          },
        },
      );
    let result = await run(state.plan.argv, state.plan.protocol);
    if (state.plan.fastForward && result.exitCode === 0 && !result.cancelled && !result.timedOut) {
      // Pull's network phase may take time. Check the editor and clone again before touching the working tree.
      try {
        const fetched = await GitReader.open(request, ctx, prepared);
        await cleanWorktree(fetched, ctx);
        if (!same(state.snapshot, await gitWriteSnapshot(fetched, ctx)))
          throw new ToolError('The branch, index or configuration changed during fetch.');
        const head = await fetched.resolveCommit(state.plan.fastForward);
        result = await run(
          ['merge', '--ff-only', '--no-autostash', '--no-overwrite-ignore', '--', head],
          undefined,
        );
      } catch {
        return {
          isError: true,
          content:
            'Fetch completed. Sovran could not complete the fast-forward. Inspect the working tree and Git status before retrying.',
        };
      }
    }
    if (result.exitCode !== 0 || result.cancelled || result.timedOut) {
      const reason = result.cancelled ? ' (cancelled)' : result.timedOut ? ' (timed out)' : '';
      return {
        isError: true,
        content: `Git ${operation} did not finish successfully${reason}. Git state may have changed. ${failureMessage(result.stderr)}`,
      };
    }
    return {
      content: JSON.stringify({
        operation,
        repository: request.repository,
        branch: state.snapshot.branch,
        ...state.plan.target,
        checkpointUndo: false,
      }),
      summary: `Git ${operation}`,
    };
  });
}
