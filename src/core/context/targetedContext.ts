import * as path from 'node:path';
import { GitReader, prepareGit } from '../git/read';
import { isProtectedPath } from '../permissions/policy';
import type { SemanticLocation, WorkspacePort, WorkspaceRoot } from '../ports';
import { isInside, resolveAndVerify } from '../security/paths';
import { redactKnown } from '../security/redact';
import type { ContextAttachment, ContextOrigin } from '../sessions/model';
import { isProbablyBinary } from '../tools/edits';
import type { ToolContext } from '../tools/types';

export type ExcludedFile = (root: WorkspaceRoot, local: string) => boolean;

/** Background reads accept only existing, verifiable files and check both names of a symlink. */
export async function automaticFile(
  input: string,
  workspace: WorkspacePort,
  protectedPaths: readonly string[],
  excluded?: ExcludedFile,
) {
  try {
    const file = await resolveAndVerify(input, workspace);
    const [root, canonical] = await Promise.all([
      workspace.realpath(file.root.path),
      workspace.realpath(file.absolute),
    ]);
    if (!isInside(root, canonical)) return undefined;
    const local = path.relative(file.root.path, file.absolute).split(path.sep).join('/');
    const real = path.relative(root, canonical).split(path.sep).join('/');
    for (const name of [local, real]) {
      if (
        isProtectedPath(name, protectedPaths) ||
        isProtectedPath(`${file.root.name}/${name}`, protectedPaths) ||
        excluded?.(file.root, name)
      )
        return undefined;
    }
    return { ...file, canonical };
  } catch {
    return undefined;
  }
}

interface Location {
  path: string;
  line: number;
  origin: ContextOrigin;
}

const FIX = /\b(?:fix|bug|error|failed|failing|failure|errore|correggi|sistem\w*|fallit\w*)\b/i;
const REFACTOR = /\b(?:refactor\w*|rename|rinomin\w*|references?|riferimenti|usages?)\b/i;
const REVIEW = /\b(?:review|diff|changes|modifiche|revisione)\b/i;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_EXCERPTS = 10;

export function stackLocations(text: string): Location[] {
  return Array.from(text.matchAll(/((?:[A-Za-z]:)?[.\w/\\@-]+\.[\w-]+):(\d+)(?::\d+)?/g), (m) => ({
    path: m[1]!,
    line: Number(m[2]),
    origin: 'stack' as const,
  }))
    .filter((location) => Number.isSafeInteger(location.line) && location.line > 0)
    .slice(0, 16);
}

export interface TargetedContextOptions {
  prompt: string;
  failedOutput?: string;
  changedPaths?: readonly string[];
  activePath?: string;
  tool: ToolContext;
  allowed: (name: string) => boolean;
  excluded: ExcludedFile;
  secrets?: readonly (string | undefined)[];
}

export async function selectTargetedContext(o: TargetedContextOptions): Promise<ContextAttachment[]> {
  const { workspace, signal } = o.tool;
  const allowed = (name: string) => !signal.aborted && workspace.isTrusted() && o.allowed(name);
  if (!allowed('read_file')) return [];
  const checked = (file: string) =>
    automaticFile(file, workspace, o.tool.settings.protectedPaths, o.excluded);
  const goal = o.prompt.slice(0, 16_000);
  const stack = stackLocations(`${goal}\n${o.failedOutput ?? ''}`);
  const named = Array.from(goal.matchAll(/\b[\w.-]+(?:[/\\][\w.@()-]+)*\.[\w-]+\b/g), (m) => m[0]).slice(
    0,
    6,
  );
  const symbols = REFACTOR.test(goal)
    ? Array.from(
        goal.matchAll(/`([A-Za-z_$][\w$]*)`|\b(?:rename|refactor|rinomina)\s+([A-Za-z_$][\w$]*)/gi),
        (m) => m[1] ?? m[2]!,
      ).slice(0, 3)
    : [];
  const textSearch = async (query: string) => {
    if (!allowed('search_files') || !workspace.searchText) return [];
    return (
      (
        await workspace
          .searchText({
            query,
            isRegex: false,
            caseSensitive: true,
            include: '**/*',
            excludes: o.tool.settings.protectedPaths,
            maxResults: 12,
            signal,
          })
          .catch(() => undefined)
      )?.matches ?? []
    );
  };
  const semantic = async (kind: 'symbols' | 'definition' | 'references', seed: SemanticLocation) => {
    const name = {
      symbols: 'list_document_symbols',
      definition: 'go_to_definition',
      references: 'find_references',
    }[kind];
    if (!allowed(name) || !workspace.querySemantic || !(await checked(seed.path)) || !allowed(name))
      return [];
    const results = await workspace.querySemantic({ ...seed, kind }, signal).catch(() => []);
    const limited: SemanticLocation[] = [];
    for (const location of results) {
      limited.push(location);
      if (limited.length === 12) break;
    }
    return limited;
  };

  const located: Location[] = (o.changedPaths ?? []).slice(0, 8).map((file) => ({
    path: file,
    line: 1,
    origin: 'path',
  }));
  for (const symbol of new Set(symbols)) {
    let seed: SemanticLocation | undefined;
    for (const candidate of [...named, ...(o.activePath ? [o.activePath] : [])]) {
      const file = await checked(candidate);
      if (!file) continue;
      seed = (await semantic('symbols', { path: file.absolute, line: 1, column: 1 })).find(
        (s) => s.name === symbol,
      );
      if (seed) break;
    }
    const matches = seed ? [] : await textSearch(symbol);
    const match = matches.find((m) => m.text.includes(symbol));
    seed ??= match && { path: match.path, line: match.line, column: match.text.indexOf(symbol) + 1 };
    if (seed) {
      const definitions = await semantic('definition', seed);
      for (const d of definitions) located.push({ ...d, origin: 'definition' });
      for (const r of await semantic('references', definitions[0] ?? seed))
        located.push({ ...r, origin: 'reference' });
      for (const m of matches) located.push({ ...m, origin: 'search' });
    }
  }
  if ((stack.length || FIX.test(goal)) && allowed('get_diagnostics')) {
    for (const file of workspace.diagnostics?.() ?? []) {
      for (const d of file.diagnostics) {
        if (d.severity === 'error') located.push({ path: file.path, line: d.line, origin: 'diagnostics' });
        if (located.length >= 24) break;
      }
      if (located.length >= 24) break;
    }
  }
  if (stack.length === 0 && FIX.test(goal)) {
    const error = /["`]([^"`\n]{8,100})["`]/.exec(goal)?.[1] ?? /\b[A-Z]{2,6}\d{3,6}\b/.exec(goal)?.[0];
    if (error) {
      for (const match of await textSearch(error)) located.push({ ...match, origin: 'search' });
    }
  }
  if (REVIEW.test(goal) && allowed('git_diff') && workspace.roots().length === 1) {
    try {
      const ctx = {
        ...o.tool,
        revalidate: () => {
          if (!allowed('git_diff')) throw new Error('Git context unavailable');
        },
      };
      const request = { repository: '.', paths: [] };
      const git = await GitReader.open(request, ctx, await prepareGit(request, ctx));
      const diff = await git.diff([], undefined, [], 0, 5, false);
      for (const file of diff.files) {
        const patch = 'patch' in file && typeof file.patch === 'string' ? file.patch : '';
        const line = Number(/^@@ -\d+(?:,\d+)? \+(\d+)/m.exec(patch)?.[1] ?? 1);
        located.push({
          path: path.join(git.repository.absolute, file.path),
          line: Math.max(1, line),
          origin: 'git',
        });
      }
    } catch {
      // Non-Git workspaces and unavailable optional sources still get other excerpts.
    }
  }
  for (const file of named) located.push({ path: file, line: 1, origin: 'path' });

  const result: Array<ContextAttachment & { canonical: string }> = [];
  const files = new Map<string, string[]>();
  for (const hint of [...stack, ...located].slice(0, 50)) {
    if (!allowed('read_file') || result.length === MAX_EXCERPTS) break;
    const file = await checked(hint.path);
    if (!file) continue;
    let lines = files.get(file.canonical);
    if (!lines) {
      const stat = await workspace.stat(file.absolute);
      if (!allowed('read_file') || !stat || stat.type !== 'file' || stat.size > MAX_FILE_BYTES) continue;
      const text = await workspace.readFile(file.absolute).catch(() => '');
      if (!text || text.length > MAX_FILE_BYTES || isProbablyBinary(text)) continue;
      lines = text.split(/\r?\n/);
      files.set(file.canonical, lines);
    }
    if (hint.line > lines.length) continue;
    let remaining = [
      { startLine: Math.max(1, hint.line - 6), endLine: Math.min(lines.length, hint.line + 8) },
    ];
    for (const known of result) {
      if (known.canonical !== file.canonical) continue;
      remaining = remaining.flatMap(({ startLine, endLine }) => {
        const left = Math.min(endLine, known.startLine! - 1);
        const right = Math.max(startLine, known.endLine! + 1);
        return [
          ...(left >= startLine ? [{ startLine, endLine: left }] : []),
          ...(right <= endLine ? [{ startLine: right, endLine }] : []),
        ];
      });
    }
    for (const { startLine, endLine } of remaining.slice(0, MAX_EXCERPTS - result.length)) {
      result.push({
        canonical: file.canonical,
        kind: 'selection',
        path: file.relative,
        startLine,
        endLine,
        origin: hint.origin,
        content: redactKnown(lines.slice(startLine - 1, endLine).join('\n'), o.secrets),
      });
    }
  }
  return result.map(({ canonical: _canonical, ...attachment }) => attachment);
}
