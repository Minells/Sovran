import { z } from 'zod';
import * as path from 'node:path';
import { resolveAndVerify, resolveWorkspacePath } from '../../security/paths';
import { isProbablyBinary } from '../edits';
import { isProtectedPath } from '../../permissions/policy';
import { ToolError, defineTool, type ToolContext } from '../types';

const IGNORED_DIRS = new Set(['.git', 'node_modules', '.hg', '.svn', '__pycache__', '.venv', 'venv', '.next', '.turbo', '.cache', '.DS_Store']);
const MAX_READ_BYTES = 5 * 1024 * 1024;
const MAX_SEARCH_FILE_BYTES = 1024 * 1024;

function relativeOf(ctx: ToolContext, absolute: string): string {
  try {
    return resolveWorkspacePath(absolute, ctx.workspace.roots()).relative;
  } catch {
    return absolute;
  }
}

export const readFileTool = defineTool({
  name: 'read_file',
  risk: 'read',
  description:
    'Read a text file from the workspace. Use start_line/end_line (1-based, inclusive) for large files. Returns the raw text without line numbers.',
  schema: z.object({
    path: z.string().min(1).describe('Workspace-relative file path'),
    start_line: z.number().int().min(1).optional(),
    end_line: z.number().int().min(1).optional(),
  }),
  label: (a) => a.path,
  async prepare(a, ctx) {
    const resolved = await resolveAndVerify(a.path, ctx.workspace);
    return { paths: [resolved.relative], approval: { kind: 'read', path: resolved.relative, reason: 'Protected file' }, state: resolved };
  },
  async execute(a, ctx) {
    const resolved = await resolveAndVerify(a.path, ctx.workspace);
    const stat = await ctx.workspace.stat(resolved.absolute);
    if (!stat) throw new ToolError(`File not found: ${resolved.relative}. Use find_files to locate it.`);
    if (stat.type === 'directory') throw new ToolError(`${resolved.relative} is a directory. Use list_directory.`);
    if (stat.size > MAX_READ_BYTES) throw new ToolError(`${resolved.relative} is too large (${Math.round(stat.size / 1024)} KB) to read.`);
    const text = await ctx.workspace.readFile(resolved.absolute);
    if (isProbablyBinary(text)) throw new ToolError(`${resolved.relative} appears to be a binary file.`);

    const lines = text.split(/\r?\n/);
    const total = lines.length;
    const start = Math.min(a.start_line ?? 1, total);
    let end = Math.min(a.end_line ?? total, total);
    if (end < start) throw new ToolError(`end_line (${end}) is before start_line (${start}).`);

    // Fit within the per-result budget, leaving room for the header.
    const budget = ctx.settings.maxToolResultChars - 200;
    let size = 0;
    for (let i = start - 1; i < end; i++) {
      size += (lines[i]?.length ?? 0) + 1;
      if (size > budget) {
        end = Math.max(start, i);
        break;
      }
    }
    const body = lines.slice(start - 1, end).join('\n');
    const partial = start > 1 || end < total;
    const header = partial ? `${resolved.relative} (lines ${start}-${end} of ${total})` : `${resolved.relative} (${total} lines)`;
    const more = end < total ? `\n\n[Showing lines ${start}-${end} of ${total}. Use start_line=${end + 1} to continue.]` : '';
    return { content: `${header}\n${body}${more}`, summary: partial ? `lines ${start}–${end} of ${total}` : `${total} lines` };
  },
});

export const listDirectoryTool = defineTool({
  name: 'list_directory',
  risk: 'read',
  description: 'List files and folders in a workspace directory. Folders end with "/". Dependency and VCS folders are skipped.',
  schema: z.object({
    path: z.string().default('.').describe('Workspace-relative directory, "." for the root'),
    depth: z.number().int().min(1).max(3).default(1).describe('Levels to recurse (1-3)'),
  }),
  label: (a) => a.path ?? '.',
  async execute(a, ctx) {
    const resolved = await resolveAndVerify(a.path, ctx.workspace);
    const stat = await ctx.workspace.stat(resolved.absolute);
    if (!stat || stat.type !== 'directory') throw new ToolError(`${resolved.relative} is not a directory.`);
    const out: string[] = [];
    const limit = 500;
    const walk = async (dir: string, prefix: string, level: number) => {
      const entries = (await ctx.workspace.readDirectory(dir)).sort((x, y) =>
        x.type === y.type ? x.name.localeCompare(y.name) : x.type === 'directory' ? -1 : 1,
      );
      for (const e of entries) {
        if (out.length >= limit || ctx.signal.aborted) return;
        if (IGNORED_DIRS.has(e.name)) continue;
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        out.push(e.type === 'directory' ? `${rel}/` : rel);
        if (e.type === 'directory' && level < a.depth) await walk(path.join(dir, e.name), rel, level + 1);
      }
    };
    await walk(resolved.absolute, '', 1);
    const truncated = out.length >= limit ? `\n[Listing truncated at ${limit} entries.]` : '';
    return {
      content: `${resolved.relative}/\n${out.join('\n') || '(empty)'}${truncated}`,
      summary: `${out.length} entries`,
      display: { kind: 'list', items: out.slice(0, 200), total: out.length },
    };
  },
});

export const findFilesTool = defineTool({
  name: 'find_files',
  risk: 'read',
  description: 'Find files by glob pattern, e.g. "**/*.ts" or "src/**/config*.json". Respects the editor exclude settings.',
  schema: z.object({
    pattern: z.string().min(1).describe('Glob pattern relative to the workspace root'),
    max_results: z.number().int().min(1).max(1000).default(200),
  }),
  label: (a) => a.pattern,
  async execute(a, ctx) {
    const files = await ctx.workspace.findFiles(a.pattern, { maxResults: a.max_results, signal: ctx.signal });
    const rels = files.map((f) => relativeOf(ctx, f)).sort();
    const note = rels.length >= a.max_results ? `\n[Results limited to ${a.max_results}. Use a narrower pattern.]` : '';
    return {
      content: rels.length ? `${rels.join('\n')}${note}` : `No files match ${a.pattern}.`,
      summary: `${rels.length} files`,
      display: { kind: 'list', items: rels.slice(0, 200), total: rels.length },
    };
  },
});

export const searchFilesTool = defineTool({
  name: 'search_files',
  risk: 'read',
  description:
    'Search file contents for a literal string or regular expression. Returns "path:line: text" matches. Narrow with a glob such as "src/**/*.ts".',
  schema: z.object({
    query: z.string().min(1),
    is_regex: z.boolean().default(false),
    case_sensitive: z.boolean().default(false),
    glob: z.string().default('**/*').describe('Files to search'),
    max_results: z.number().int().min(1).max(500).default(100),
  }),
  label: (a) => a.query,
  async execute(a, ctx) {
    let re: RegExp;
    try {
      const source = a.is_regex ? a.query : a.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      re = new RegExp(source, a.case_sensitive ? '' : 'i');
    } catch (e) {
      throw new ToolError(`Invalid regular expression: ${e instanceof Error ? e.message : String(e)}`);
    }
    const matches: string[] = [];
    let scanned = 0;
    let skippedProtected = 0;
    if (ctx.workspace.searchText) {
      // Fast path (ripgrep in VS Code). Protected paths are excluded by the searcher *and* filtered here.
      const r = await ctx.workspace.searchText({
        query: a.query,
        isRegex: a.is_regex,
        caseSensitive: a.case_sensitive,
        include: a.glob,
        excludes: ctx.settings.protectedPaths,
        maxResults: a.max_results,
        signal: ctx.signal,
      });
      for (const m of r.matches) {
        const rel = relativeOf(ctx, m.path);
        if (isProtectedPath(rel, ctx.settings.protectedPaths)) {
          skippedProtected++;
          continue;
        }
        if (matches.length < a.max_results) matches.push(`${rel}:${m.line}: ${m.text.trim().slice(0, 200)}`);
      }
      scanned = new Set(r.matches.map((m) => m.path)).size;
    } else {
      const files = await ctx.workspace.findFiles(a.glob, { maxResults: 5000, signal: ctx.signal });
      for (const file of files) {
        if (ctx.signal.aborted || matches.length >= a.max_results) break;
        const stat = await ctx.workspace.stat(file);
        if (!stat || stat.type !== 'file' || stat.size > MAX_SEARCH_FILE_BYTES) continue;
        const rel = relativeOf(ctx, file);
        if (isProtectedPath(rel, ctx.settings.protectedPaths)) {
          skippedProtected++;
          continue;
        }
        let text: string;
        try {
          text = await ctx.workspace.readFile(file);
        } catch {
          continue;
        }
        if (isProbablyBinary(text)) continue;
        scanned++;
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length && matches.length < a.max_results; i++) {
          const line = lines[i] ?? '';
          if (re.test(line)) matches.push(`${rel}:${i + 1}: ${line.trim().slice(0, 200)}`);
        }
      }
    }
    const capped = matches.length >= a.max_results ? `\n[Stopped at ${a.max_results} matches. Refine the query or glob.]` : '';
    const skipped = skippedProtected ? `\n[${skippedProtected} protected file(s) were not searched.]` : '';
    return {
      content: (matches.length ? `${matches.join('\n')}${capped}` : `No matches for "${a.query}" in ${scanned} files.`) + skipped,
      summary: `${matches.length} matches`,
      display: { kind: 'list', items: matches.slice(0, 200), total: matches.length },
    };
  },
});

export const workspaceInfoTool = defineTool({
  name: 'get_workspace_info',
  risk: 'read',
  description: 'Get workspace folders, operating system, shell, current git branch and top-level entries.',
  schema: z.object({}),
  label: () => 'workspace',
  async execute(_a, ctx) {
    const env = ctx.workspace.environment();
    const parts = [`OS: ${env.os}`, `Shell: ${env.shell}`, `Trusted: ${ctx.workspace.isTrusted() ? 'yes' : 'no (Restricted Mode)'}`];
    for (const root of ctx.workspace.roots()) {
      let branch: string;
      try {
        const head = (await ctx.workspace.readFile(path.join(root.path, '.git', 'HEAD'))).trim();
        branch = head.startsWith('ref: refs/heads/') ? head.slice(16) : `detached at ${head.slice(0, 8)}`;
      } catch {
        branch = 'not a git repository';
      }
      const entries = (await ctx.workspace.readDirectory(root.path).catch(() => []))
        .filter((e) => !IGNORED_DIRS.has(e.name))
        .slice(0, 60)
        .map((e) => (e.type === 'directory' ? `${e.name}/` : e.name));
      parts.push(`\nFolder "${root.name}" (git: ${branch})\n${entries.join('\n')}`);
    }
    return { content: parts.join('\n'), summary: `${ctx.workspace.roots().length} folder(s)` };
  },
});

export const activeEditorTool = defineTool({
  name: 'get_active_editor_context',
  risk: 'read',
  description: "Get the user's active file, current selection, open editor tabs and diagnostics (errors/warnings) for the active file.",
  schema: z.object({}),
  label: () => 'active editor',
  async execute(_a, ctx) {
    const ed = ctx.workspace.activeEditor();
    const tabs = ctx.workspace.openEditors().map((p) => relativeOf(ctx, p));
    if (!ed) return { content: `No active text editor.\nOpen editors:\n${tabs.join('\n') || '(none)'}`, summary: 'no active editor' };
    const rel = relativeOf(ctx, ed.path);
    const lines = [`File: ${rel} (${ed.languageId}, ${ed.lineCount} lines${ed.isDirty ? ', unsaved changes' : ''})`];
    if (ed.selection && ed.selection.text) {
      lines.push(`Selection: lines ${ed.selection.startLine}-${ed.selection.endLine}\n${ed.selection.text.slice(0, 10_000)}`);
    }
    if (ed.diagnostics.length) {
      lines.push(
        `Diagnostics:\n${ed.diagnostics
          .slice(0, 50)
          .map((d) => `${rel}:${d.line}: ${d.severity}: ${d.message}${d.source ? ` (${d.source})` : ''}`)
          .join('\n')}`,
      );
    }
    lines.push(`Open editors:\n${tabs.join('\n') || '(none)'}`);
    return { content: lines.join('\n\n'), summary: rel };
  },
});
