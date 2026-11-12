import * as path from 'node:path';
import { isProtectedPath } from '../permissions/policy';
import { isInside, resolveAndVerify, resolveWorkspacePath, type ResolvedPath } from '../security/paths';
import { isProbablyBinary, truncateMiddle } from '../tools/edits';
import { ToolError, type PreparedAction, type ToolContext } from '../tools/types';

const METADATA_CHARS = 1024 * 1024;
const MAX_BLOB_BYTES = 2 * 1024 * 1024;
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SAFE_CONFIG = [
  'core.fsmonitor=false',
  'core.untrackedCache=false',
  'core.preloadIndex=false',
  'core.pager=cat',
  'color.ui=false',
  'diff.external=',
  'diff.submodule=short',
  'submodule.recurse=false',
  'protocol.allow=never',
  'credential.helper=',
  'gc.auto=0',
  'maintenance.auto=false',
];

export interface GitRequest {
  repository: string;
  paths?: string[];
}

export interface Change {
  status: string;
  path: string;
  oldPath?: string;
}

/** Deliberately limited commit-ish syntax. No paths, ranges, revision searches, flags or reflog expansion. */
export function validRevision(value: string): boolean {
  return (
    value.length <= 200 &&
    /^(?:HEAD|[a-zA-Z0-9_][a-zA-Z0-9._/-]*)(?:[~^][0-9]*)*$/.test(value) &&
    !value.includes('..')
  );
}

async function repositoryPath(input: string, ctx: ToolContext): Promise<ResolvedPath> {
  if (!ctx.workspace.isTrusted()) throw new ToolError('Native Git requires a trusted workspace.');
  if (ctx.signal.aborted) throw new ToolError('Git inspection was cancelled.');
  if (
    ctx.workspace.roots().length > 1 &&
    !path.isAbsolute(input) &&
    !ctx.workspace.roots().some((root) => input === root.name || input.startsWith(`${root.name}/`))
  ) {
    throw new ToolError('Select a named workspace root explicitly for the Git repository.');
  }
  const resolved = await resolveAndVerify(input, ctx.workspace);
  if ((await ctx.workspace.stat(resolved.absolute))?.type !== 'directory')
    throw new ToolError('Select an existing repository directory.');
  const metadataPath = path.join(resolved.absolute, '.git');
  const metadata = await ctx.workspace.stat(metadataPath);
  if (!metadata || !['directory', 'file'].includes(metadata.type)) {
    throw new ToolError(
      'Select the repository root containing .git. Native Git does not search parent repositories.',
    );
  }
  const realRepository = await ctx.workspace.realpath(resolved.absolute);
  const realMetadata = await ctx.workspace.realpath(metadataPath);
  if (!isInside(realRepository, realMetadata))
    throw new ToolError(
      'The .git marker resolves outside the selected repository. Use a regular Git worktree file instead.',
    );
  return resolved;
}

/** User paths are repository-relative literal paths, never pathspec expressions. */
export async function gitPath(
  repository: ResolvedPath,
  input: string,
  ctx: ToolContext,
): Promise<{ local: string; paths: string[] }> {
  if (
    !input ||
    input.includes('\0') ||
    input.trim() !== input ||
    input.includes('\\') ||
    path.isAbsolute(input) ||
    input.split('/').includes('..') ||
    input.includes('\uFFFD')
  ) {
    throw new ToolError(
      'Git paths must be literal repository-relative paths without traversal, edge whitespace or backslashes.',
    );
  }
  const absolute = path.resolve(repository.absolute, input);
  if (!isInside(repository.absolute, absolute))
    throw new ToolError('Git path escapes the selected repository.');
  const verified = await resolveAndVerify(absolute, ctx.workspace);
  const real = await ctx.workspace.realpath(absolute).catch(() => absolute);
  const physicalRoots = await Promise.all(
    ctx.workspace.roots().map(async (root) => ({
      ...root,
      path: await ctx.workspace.realpath(root.path).catch(() => root.path),
    })),
  );
  const canonical = resolveWorkspacePath(real, physicalRoots).relative;
  return {
    local: path.relative(repository.absolute, verified.absolute).split(path.sep).join('/') || '.',
    paths: [...new Set([verified.relative, canonical])],
  };
}

export async function prepareGit(request: GitRequest, ctx: ToolContext): Promise<PreparedAction> {
  const repository = await repositoryPath(request.repository, ctx);
  const paths = (await Promise.all((request.paths ?? []).map((p) => gitPath(repository, p, ctx)))).flatMap(
    (p) => p.paths,
  );
  // Preparation performs only path checks. No Git process, object read or repository mutation precedes approval.
  return {
    paths: [...new Set(paths)],
    state: {
      repository: repository.absolute,
      realRepository: await ctx.workspace.realpath(repository.absolute),
    },
  };
}

function terminatedFields(output: string): string[] {
  if (!output) return [];
  if (!output.endsWith('\0')) throw new ToolError('Git returned incomplete metadata.');
  return output.slice(0, -1).split('\0');
}

export function parseChanges(output: string): Change[] {
  const fields = terminatedFields(output);
  const changes: Change[] = [];
  for (let i = 0; i < fields.length;) {
    const status = fields[i++]!;
    if (!/^[ACDMRTUXB](?:[0-9]{1,3})?$/.test(status))
      throw new ToolError('Git returned an invalid change record.');
    const oldPath = /^[RC]/.test(status) ? fields[i++] : undefined;
    const name = fields[i++];
    if (!name || (/^[RC]/.test(status) && !oldPath))
      throw new ToolError('Git returned an incomplete change record.');
    changes.push({ status, path: name, ...(oldPath ? { oldPath } : {}) });
  }
  return changes;
}

/** A per-call deadline, fixed argv construction and protected-content checks around the existing process port. */
export class GitReader {
  private readonly deadline: number;
  private readonly config = [...SAFE_CONFIG];
  private constructor(
    readonly repository: ResolvedPath,
    private readonly ctx: ToolContext,
    private readonly approvedPaths: ReadonlySet<string>,
  ) {
    this.deadline = Date.now() + Math.min(15_000, ctx.settings.terminalTimeoutMs);
  }

  static async open(request: GitRequest, ctx: ToolContext, prepared: PreparedAction): Promise<GitReader> {
    const repository = await repositoryPath(request.repository, ctx);
    const old = prepared.state as { repository?: string; realRepository?: string } | undefined;
    if (
      old?.repository !== repository.absolute ||
      old.realRepository !== (await ctx.workspace.realpath(repository.absolute))
    )
      throw new ToolError('The selected repository changed. Request this action again.');
    const reader = new GitReader(repository, ctx, new Set(prepared.paths));
    // Status/diff can run clean/process filters even when textconv and external diff are disabled. Neutralize every
    // effective configured filter, including user includes. Never accept a model-supplied -c option.
    const keys = await reader.call(
      ['config', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process|required)$'],
      METADATA_CHARS,
      [0, 1],
    );
    const names = terminatedFields(keys.stdout);
    if (names.length > 512) throw new ToolError('Too many Git filters for bounded inspection.');
    const drivers = new Set(names.map((key) => key.slice(0, key.lastIndexOf('.'))));
    for (const driver of drivers) {
      if (!driver.startsWith('filter.') || driver.includes('\0'))
        throw new ToolError('Invalid Git filter configuration.');
      reader.config.push(
        `${driver}.clean=`,
        `${driver}.smudge=`,
        `${driver}.process=`,
        `${driver}.required=false`,
      );
    }
    return reader;
  }

  async call(
    args: readonly string[],
    maxOutputChars = METADATA_CHARS,
    accepted = [0],
    allowTruncated = false,
  ) {
    this.checkActive();
    const timeoutMs = this.deadline - Date.now();
    const argv = [
      '--no-pager',
      '--no-optional-locks',
      '--no-lazy-fetch',
      '--no-replace-objects',
      '--literal-pathspecs',
      `--git-dir=${path.join(this.repository.absolute, '.git')}`,
      `--work-tree=${this.repository.absolute}`,
      ...this.config.flatMap((setting) => ['-c', setting]),
      ...args,
    ];
    const result = await this.ctx.process.runFile('git', argv, {
      cwd: this.repository.absolute,
      timeoutMs,
      signal: this.ctx.signal,
      maxOutputChars,
      disallowedExecutableRoots: this.ctx.workspace.roots().map((root) => root.path),
      env: {
        LC_ALL: 'C',
        LANG: 'C',
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_NO_LAZY_FETCH: '1',
        GIT_NO_REPLACE_OBJECTS: '1',
        GIT_ATTR_NOSYSTEM: '1',
        GIT_PAGER: 'cat',
        PAGER: 'cat',
      },
      beforeSpawn: () => {
        this.ctx.revalidate?.();
        this.checkActive();
      },
      // Do not stream raw Git stdout/stderr: only filtered results may reach the model or webview.
    });
    if (result.cancelled || this.ctx.signal.aborted) throw new ToolError('Git inspection was cancelled.');
    if (result.timedOut) throw new ToolError('Git inspection timed out and was terminated.');
    if (!accepted.includes(result.exitCode ?? -1)) {
      if (/unknown option.*no-lazy-fetch/i.test(result.stderr))
        throw new ToolError('Update host Git: native inspection requires --no-lazy-fetch support.');
      throw new ToolError(
        `Git inspection failed: ${truncateMiddle(result.stderr.trim() || result.output || 'Git is unavailable.', 1000)}`,
      );
    }
    if (result.truncated && !allowTruncated)
      throw new ToolError(
        'Git metadata exceeds the inspection limit. Request a smaller history range or inspect a specific file.',
      );
    return result;
  }

  private checkActive() {
    if (!this.ctx.workspace.roots().some((root) => isInside(root.path, this.repository.absolute)))
      throw new ToolError('The repository is no longer inside the open workspace.');
    if (!this.ctx.workspace.isTrusted()) throw new ToolError('Native Git requires a trusted workspace.');
    if (this.ctx.signal.aborted) throw new ToolError('Git inspection was cancelled.');
    if (Date.now() >= this.deadline) throw new ToolError('Git inspection exceeded its time budget.');
  }

  async paths(inputs: readonly string[] = []): Promise<string[]> {
    return Promise.all(inputs.map(async (input) => (await gitPath(this.repository, input, this.ctx)).local));
  }

  async commit(revision: string): Promise<string> {
    if (!validRevision(revision))
      throw new ToolError(
        'Use a commit ID, branch/tag name or HEAD ancestry; revision flags, ranges and path expressions are not accepted.',
      );
    return this.resolveCommit(revision);
  }

  /** Resolve a revision already validated by the caller, including a fully qualified ref from Git. */
  async resolveCommit(revision: string): Promise<string> {
    const result = await this.call(['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`]);
    const oid = result.stdout.trim();
    if (!OID.test(oid)) throw new ToolError('Git did not resolve the revision to one commit.');
    return oid;
  }

  async status(paths: string[], offset: number, limit: number) {
    const result = await this.call([
      'status',
      '--porcelain=v1',
      '--branch',
      '-z',
      '--untracked-files=normal',
      '--ignore-submodules=all',
      '--no-renames',
      '--',
      ...paths,
    ]);
    const fields = terminatedFields(result.stdout);
    const branch = fields[0]?.startsWith('## ') ? fields.shift()!.slice(3) : '';
    const entries = fields.map((record) => {
      if (record.length < 4 || record[2] !== ' ')
        throw new ToolError('Git returned an invalid status record.');
      return { index: record[0], worktree: record[1], path: record.slice(3) };
    });
    return { branch, ...page(entries, offset, limit) };
  }

  async log(commit: string, paths: string[], offset: number, limit: number) {
    const result = await this.call([
      'log',
      '-z',
      '--no-patch',
      '--no-decorate',
      '--no-notes',
      '--no-show-signature',
      '--no-use-mailmap',
      '--encoding=UTF-8',
      '--format=tformat:%H%x00%aI%x00%an%x00%s',
      `--skip=${offset}`,
      `--max-count=${limit + 1}`,
      commit,
      '--',
      ...paths,
    ]);
    const fields = terminatedFields(result.stdout);
    if (fields.length % 4) throw new ToolError('Git returned invalid history metadata.');
    const entries = [];
    for (let i = 0; i < fields.length; i += 4) {
      if (!OID.test(fields[i]!)) throw new ToolError('Git returned an invalid history commit.');
      entries.push({ commit: fields[i], date: fields[i + 1], author: fields[i + 2], subject: fields[i + 3] });
    }
    return { entries: entries.slice(0, limit), nextOffset: entries.length > limit ? offset + limit : null };
  }

  async branches(includeRemotes: boolean, offset: number, limit: number) {
    const result = await this.call([
      'for-each-ref',
      '--sort=refname',
      '--format=%(refname)%00%(objectname)%00%(HEAD)',
      'refs/heads',
      ...(includeRemotes ? ['refs/remotes'] : []),
    ]);
    const entries = result.stdout
      .trimEnd()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, commit, current] = line.split('\0');
        if (!name || !commit || !OID.test(commit))
          throw new ToolError('Git returned invalid branch metadata.');
        return { name, commit, current: current === '*', remote: name.startsWith('refs/remotes/') };
      });
    return page(entries, offset, limit);
  }

  async blob(commit: string, file: string, start: number, end?: number) {
    const tree = await this.call(['ls-tree', '-z', '--full-name', commit, '--', file]);
    const records = terminatedFields(tree.stdout);
    if (records.length !== 1) throw new ToolError('Select one file present in that commit.');
    const tab = records[0]!.indexOf('\t');
    const [mode, type, oid] = records[0]!.slice(0, tab).split(' ');
    if (tab < 0 || records[0]!.slice(tab + 1) !== file || type !== 'blob' || !oid || !OID.test(oid))
      throw new ToolError('Select a file rather than a directory or submodule.');
    const size = Number((await this.call(['cat-file', '-s', oid])).stdout.trim());
    if (!Number.isSafeInteger(size) || size > MAX_BLOB_BYTES)
      throw new ToolError('Git blob exceeds the 2 MiB inspection limit.');
    const body = (await this.call(['cat-file', 'blob', oid], MAX_BLOB_BYTES)).stdout;
    if (isProbablyBinary(body)) return { path: file, commit, binary: true, size };
    const lines = body.split('\n');
    const last = Math.min(end ?? lines.length, lines.length);
    if (last < start) throw new ToolError('The requested line range is empty or reversed.');
    const budget = Math.max(1, this.ctx.settings.maxToolResultChars - 700);
    const selected: string[] = [];
    let sizeChars = 0;
    let lastLine = start - 1;
    let truncated = false;
    for (let i = start - 1; i < last; i++) {
      const line = lines[i]!;
      if (selected.length && sizeChars + line.length + 1 > budget) break;
      const bounded = truncateMiddle(line, budget - sizeChars);
      truncated ||= bounded !== line;
      selected.push(bounded);
      sizeChars += bounded.length + 1;
      lastLine = i + 1;
    }
    return {
      path: file,
      commit,
      mode,
      startLine: start,
      endLine: lastLine,
      totalLines: lines.length,
      content: selected.join('\n'),
      truncated: truncated || lastLine < last,
      nextLine: lastLine < lines.length ? lastLine + 1 : null,
    };
  }

  private async allowed(file: string, explicit: ReadonlySet<string>): Promise<boolean> {
    try {
      const checked = await gitPath(this.repository, file, this.ctx);
      return checked.paths.every(
        (name) =>
          !isProtectedPath(name, this.ctx.settings.protectedPaths) ||
          (explicit.has(file) && this.approvedPaths.has(name)),
      );
    } catch {
      return false;
    } // Inaccessible, invalid or escaping paths never contribute bulk content.
  }

  async diff(
    args: string[],
    showCommit: string | undefined,
    requested: string[],
    offset: number,
    limit: number,
    namesOnly: boolean,
  ) {
    const common = ['--no-ext-diff', '--no-textconv', '--ignore-submodules=all'];
    const listing = showCommit
      ? [
          'diff-tree',
          '--root',
          '--diff-merges=first-parent',
          '--no-commit-id',
          '-r',
          ...common,
          '--name-status',
          '-z',
          '--find-renames',
          showCommit,
          '--',
        ]
      : ['diff', ...common, '--name-status', '-z', '--find-renames', ...args, '--'];
    const changes = parseChanges((await this.call(listing)).stdout);
    const explicit = new Set(requested);
    const selected: Change[] = [];
    let omittedProtected = 0;
    for (const change of changes) {
      this.checkActive();
      const names = [change.path, ...(change.oldPath ? [change.oldPath] : [])];
      if (
        requested.length &&
        !names.some((name) =>
          requested.some((filter) => filter === '.' || name === filter || name.startsWith(`${filter}/`)),
        )
      )
        continue;
      if (!(await Promise.all(names.map((name) => this.allowed(name, explicit)))).every(Boolean)) {
        omittedProtected++;
        continue;
      }
      selected.push(change);
    }
    const selectedPage = page(selected, offset, limit);
    const files = [];
    let remaining = Math.max(
      200,
      this.ctx.settings.maxToolResultChars - JSON.stringify(selectedPage).length - 700,
    );
    let examined = 0;
    for (const change of selectedPage.entries) {
      this.checkActive();
      if (namesOnly) {
        files.push(change);
        examined++;
        continue;
      }
      if (remaining < 200) break;
      examined++;
      const names = [change.path, ...(change.oldPath ? [change.oldPath] : [])];
      // Recheck after preceding asynchronous calls; never expose a newly protected/symlinked path.
      if (!(await Promise.all(names.map((name) => this.allowed(name, explicit)))).every(Boolean)) {
        omittedProtected++;
        continue;
      }
      const patchArgs = showCommit
        ? [
            'show',
            '--format=',
            '--no-notes',
            '--no-show-signature',
            '--root',
            '--diff-merges=first-parent',
            ...common,
            '--no-renames',
            showCommit,
            '--',
            ...names,
          ]
        : ['diff', ...common, '--no-renames', ...args, '--', ...names];
      const result = await this.call(patchArgs, remaining, [0], true);
      files.push({ ...change, patch: result.stdout, truncated: result.truncated });
      remaining -= result.stdout.length + 150;
    }
    return {
      files,
      omittedProtected,
      total: selectedPage.total,
      nextOffset: offset + examined < selected.length ? offset + examined : null,
    };
  }
}

export function page<T>(entries: T[], offset: number, limit: number) {
  return {
    entries: entries.slice(offset, offset + limit),
    total: entries.length,
    nextOffset: offset + limit < entries.length ? offset + limit : null,
  };
}
