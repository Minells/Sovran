import * as path from 'node:path';
import { z } from 'zod';
import { isProtectedPath } from '../../permissions/policy';
import { isInside, resolveAndVerify, type ResolvedPath } from '../../security/paths';
import { defineTool, ToolError, type ToolContext } from '../types';

function check(ctx: ToolContext): void {
  if (ctx.signal.aborted) throw new ToolError('Cancelled by the user.');
  ctx.revalidate?.();
}

/** Match both root-local and displayed multi-root paths, including a symlink's canonical target. */
async function protectedPath(resolved: ResolvedPath, ctx: ToolContext): Promise<boolean> {
  const local = path.relative(resolved.root.path, resolved.absolute).split(path.sep).join('/');
  const patterns = ctx.settings.protectedPaths;
  if (isProtectedPath(local, patterns) || isProtectedPath(resolved.relative, patterns)) return true;
  // A diagnostic may refer to a new unsaved file: resolve its nearest existing ancestor too.
  let probe = resolved.absolute;
  const suffix: string[] = [];
  let real: string;
  for (;;) {
    try {
      real = path.join(await ctx.workspace.realpath(probe), ...suffix);
      break;
    } catch {
      if (await ctx.workspace.stat(probe)) return true; // Unverifiable existing path: fail closed.
      const parent = path.dirname(probe);
      if (parent === probe) return true;
      suffix.unshift(path.basename(probe));
      probe = parent;
    }
  }
  const root = await ctx.workspace.realpath(resolved.root.path);
  if (!isInside(root, real)) return true;
  const canonical = path.relative(root, real).split(path.sep).join('/');
  return (
    isProtectedPath(canonical, patterns) || isProtectedPath(`${resolved.root.name}/${canonical}`, patterns)
  );
}

export const diagnosticsTool = defineTool({
  name: 'get_diagnostics',
  risk: 'read',
  description:
    'Read cached VS Code diagnostics (Problems) for the workspace or active file, including unopened files. ' +
    'Optional path selects a literal file or directory; use rootName/path in multi-root workspaces. ' +
    'Protected paths are omitted even when selected; outside-workspace and unverifiable diagnostic entries are omitted. ' +
    'Does not open files, start language servers or run checks; empty results do not prove the workspace is error-free.',
  schema: z
    .object({
      scope: z.enum(['workspace', 'active']).default('workspace'),
      path: z
        .string()
        .trim()
        .min(1)
        .max(4096)
        .optional()
        .describe(
          'Literal workspace file or directory; only with scope=workspace. Omit to include all roots.',
        ),
      severity: z.enum(['all', 'error', 'warning', 'info', 'hint']).default('all'),
      max_results: z.number().int().min(1).max(500).default(100),
    })
    .strict(),
  label: (a) => a.path ?? (a.scope === 'active' ? 'active file diagnostics' : 'workspace diagnostics'),
  async execute(a, ctx) {
    check(ctx);
    if (!ctx.workspace.diagnostics)
      throw new ToolError('This host does not support cached workspace diagnostics.');
    if (a.scope === 'active' && a.path !== undefined)
      throw new ToolError('Use either scope=active or path, not both.');
    const input = a.scope === 'active' ? ctx.workspace.activeEditor()?.path : a.path;
    if (a.scope === 'active' && !input)
      return { content: 'No active file editor.', summary: 'no active editor' };
    const selected = input === undefined ? undefined : await resolveAndVerify(input, ctx.workspace);
    const directory = selected && (await ctx.workspace.stat(selected.absolute))?.type === 'directory';
    const exact = selected && !directory ? selected.absolute : undefined;
    // No diagnostic content is queried before a user force-Ask approval: execution owns the snapshot.
    check(ctx);
    const entries = ctx.workspace.diagnostics(exact);
    const lines: string[] = [];
    const header = 'Cached editor diagnostics; no analysis was run.\n';
    const omitted =
      '\n[Protected, outside-workspace and unverifiable paths are omitted. Only diagnostics already reported to the editor are available.]';
    const limited =
      '\n[Results limited by count or output size. Narrow path/severity, increase max_results or the Sovran result-size setting.]';
    const budget = Math.max(
      0,
      ctx.settings.maxToolResultChars - header.length - omitted.length - limited.length,
    );
    let size = 0;
    let truncated = false;
    for (const entry of [...entries].sort((x, y) => x.path.localeCompare(y.path))) {
      check(ctx);
      if (
        selected &&
        (directory
          ? !isInside(selected.absolute, entry.path)
          : path.relative(selected.absolute, entry.path) !== '')
      )
        continue;
      let resolved: ResolvedPath;
      try {
        resolved = await resolveAndVerify(entry.path, ctx.workspace);
        if (await protectedPath(resolved, ctx)) continue;
      } catch {
        continue; // A Problems collection may include external, deleted or broken-link files.
      }
      check(ctx);
      for (const d of entry.diagnostics) {
        if (a.severity !== 'all' && d.severity !== a.severity) continue;
        // Quoting keeps newlines/control characters in paths, sources and messages on one result line.
        const line = `${JSON.stringify(resolved.relative)}:${d.line}: ${d.severity}: ${JSON.stringify(d.message)}${d.source ? ` (${JSON.stringify(d.source)})` : ''}`;
        if (lines.length >= a.max_results || size + line.length + 1 > budget) {
          truncated = true;
          break;
        }
        lines.push(line);
        size += line.length + 1;
      }
      if (truncated) break;
    }
    check(ctx);
    return {
      content: (
        header +
        (lines.join('\n') || 'No matching cached diagnostics returned.') +
        (truncated ? limited : '') +
        omitted
      ).slice(0, ctx.settings.maxToolResultChars),
      summary: `${lines.length} cached diagnostic(s)${truncated ? ' (limited)' : ''}`,
    };
  },
});
