import * as path from 'node:path';
import { z } from 'zod';
import { isProtectedPath } from '../../permissions/policy';
import type { SemanticQuery } from '../../ports';
import { isInside, resolveWorkspacePath, type ResolvedPath } from '../../security/paths';
import { defineTool, ToolError, type ToolContext } from '../types';

const MAX_CANDIDATES = 2_000;
const LIMIT_NOTE = '\n[Results limited by count or size.]';
const inputSchema = z.object({
  path: z
    .string()
    .trim()
    .min(1)
    .max(4096)
    .describe('Workspace file path. Use rootName/path in a multi-root workspace.'),
  max_results: z.number().int().min(1).max(200).default(50),
});
const positionSchema = inputSchema.extend({
  line: z.number().int().min(1).describe('One-based line containing the symbol.'),
  column: z.number().int().min(1).describe('One-based UTF-16 column on the symbol.'),
});

function check(ctx: ToolContext, patterns = ctx.settings.protectedPaths): void {
  if (ctx.signal.aborted) throw new ToolError('Cancelled by the user.');
  if (!ctx.workspace.isTrusted()) throw new ToolError('Trust the workspace to use semantic navigation.');
  ctx.revalidate?.();
  const current = ctx.settings.protectedPaths;
  if (
    current !== patterns &&
    (current.length !== patterns.length || current.some((value, i) => value !== patterns[i]))
  )
    throw new ToolError('Protected paths changed during semantic navigation. Run the query again.');
}

/** Providers can return dependencies, virtual documents and symlink aliases. Return only verifiable files. */
async function permittedFile(input: string, ctx: ToolContext): Promise<ResolvedPath | undefined> {
  const patterns = ctx.settings.protectedPaths;
  try {
    const resolved = resolveWorkspacePath(input, ctx.workspace.roots());
    const local = path.relative(resolved.root.path, resolved.absolute).split(path.sep).join('/');
    if (isProtectedPath(local, patterns) || isProtectedPath(resolved.relative, patterns)) return;
    const [root, target] = await Promise.all([
      ctx.workspace.realpath(resolved.root.path),
      ctx.workspace.realpath(resolved.absolute),
    ]);
    if (!isInside(root, target)) return;
    const canonical = path.relative(root, target).split(path.sep).join('/');
    if (
      isProtectedPath(canonical, patterns) ||
      isProtectedPath(`${resolved.root.name}/${canonical}`, patterns)
    )
      return;
    if ((await ctx.workspace.stat(target))?.type === 'file') return resolved;
  } catch {
    // Deleted files, paths outside open roots and unverifiable targets are excluded.
  }
}

async function queryFile(input: string, ctx: ToolContext): Promise<ResolvedPath> {
  check(ctx);
  const file = await permittedFile(input, ctx);
  if (!file) throw new ToolError('Choose an existing, unprotected file inside an open workspace folder.');
  check(ctx);
  return file;
}

async function prepare<A extends { path: string }>({ path }: A, ctx: ToolContext) {
  const file = await queryFile(path, ctx);
  return { paths: [file.relative] };
}

async function run(query: SemanticQuery, maxResults: number, ctx: ToolContext) {
  const file = await queryFile(query.path, ctx);
  const patterns = ctx.settings.protectedPaths;
  if (!ctx.workspace.querySemantic)
    throw new ToolError('This host does not support semantic navigation. Use search_files.');
  const locations = await ctx.workspace.querySemantic({ ...query, path: file.absolute }, ctx.signal);
  check(ctx, patterns);
  await queryFile(query.path, ctx);

  const files = new Map<string, ResolvedPath | undefined>();
  const seen = new Set<string>();
  const lines: string[] = [];
  const budget = Math.max(0, ctx.settings.maxToolResultChars - LIMIT_NOTE.length);
  let scanned = 0;
  let size = 0;
  let limited = false;
  for (const location of locations) {
    check(ctx, patterns);
    if (++scanned > MAX_CANDIDATES) {
      limited = true;
      break;
    }
    if (!files.has(location.path)) files.set(location.path, await permittedFile(location.path, ctx));
    const resolved = files.get(location.path);
    if (!resolved) continue;
    const position = `${JSON.stringify(resolved.relative)}:${location.line}:${location.column}`;
    const line = location.name === undefined ? position : `${position} ${JSON.stringify(location.name)}`;
    if (seen.has(line)) continue;
    if (lines.length >= maxResults || size + line.length + 1 > budget) {
      limited = true;
      break;
    }
    seen.add(line);
    lines.push(line);
    size += line.length + 1;
  }
  check(ctx, patterns);
  const empty = limited
    ? 'No locations fit the current limits.'
    : 'No permitted workspace results. The language provider may be unavailable or still indexing. Use search_files as a fallback.';
  return {
    content: ((lines.join('\n') || empty) + (limited ? LIMIT_NOTE : '')).slice(
      0,
      ctx.settings.maxToolResultChars,
    ),
    summary: `${lines.length} ${query.kind === 'symbols' ? 'symbol(s)' : 'location(s)'}${limited ? ' (limited)' : ''}`,
  };
}

export const documentSymbolsTool = defineTool({
  name: 'list_document_symbols',
  risk: 'read',
  requiresTrust: true,
  description:
    'List named symbols in a workspace file using VS Code. Returns positions you can pass to go_to_definition or find_references.',
  schema: inputSchema.strict(),
  label: (a) => a.path,
  prepare,
  execute: (a, ctx) => run({ kind: 'symbols', path: a.path }, a.max_results, ctx),
});

export const definitionTool = defineTool({
  name: 'go_to_definition',
  risk: 'read',
  requiresTrust: true,
  description:
    'Find the definition of the symbol at a file position using VS Code. Returns workspace locations as path:line:column.',
  schema: positionSchema.strict(),
  label: (a) => `${a.path}:${a.line}:${a.column}`,
  prepare,
  execute: (a, ctx) =>
    run({ kind: 'definition', path: a.path, line: a.line, column: a.column }, a.max_results, ctx),
});

export const referencesTool = defineTool({
  name: 'find_references',
  risk: 'read',
  requiresTrust: true,
  description:
    'Find references to the symbol at a file position using VS Code. Results may include its declaration and depend on the language provider.',
  schema: positionSchema.strict(),
  label: (a) => `${a.path}:${a.line}:${a.column}`,
  prepare,
  execute: (a, ctx) =>
    run({ kind: 'references', path: a.path, line: a.line, column: a.column }, a.max_results, ctx),
});
