import { z } from 'zod';
import { policyPaths, resolveAndVerify, type ResolvedPath } from '../../security/paths';
import { applySearchReplace, contentHash, isProbablyBinary, makeDiff } from '../edits';
import { ToolError, defineTool, type PreparedAction, type ToolContext, type ToolResult } from '../types';

interface EditState {
  resolved: ResolvedPath;
  exists: boolean;
  originalHash: string;
  proposed: string;
}

async function readExisting(ctx: ToolContext, resolved: ResolvedPath): Promise<{ exists: boolean; text: string }> {
  const stat = await ctx.workspace.stat(resolved.absolute);
  if (!stat) return { exists: false, text: '' };
  if (stat.type === 'directory') throw new ToolError(`${resolved.relative} is a directory.`);
  const text = await ctx.workspace.readFile(resolved.absolute);
  if (isProbablyBinary(text)) throw new ToolError(`${resolved.relative} is a binary file and cannot be edited.`);
  return { exists: true, text };
}

async function proposal(
  ctx: ToolContext,
  resolved: ResolvedPath,
  exists: boolean,
  original: string,
  proposed: string,
): Promise<PreparedAction> {
  if (exists && original === proposed) throw new ToolError(`The change would not modify ${resolved.relative}.`);
  const { diff, added, removed } = makeDiff(resolved.relative, original, proposed);
  const state: EditState = { resolved, exists, originalHash: contentHash(original), proposed };
  return {
    // Through a symbolic link, the file that is really written decides whether the path is protected.
    paths: await policyPaths(resolved, ctx.workspace),
    state,
    approval: {
      kind: 'edit',
      path: resolved.relative,
      absolutePath: resolved.absolute,
      isNew: !exists,
      diff,
      added,
      removed,
      originalContent: original,
      proposedContent: proposed,
    },
  };
}

async function commit(ctx: ToolContext, prepared: PreparedAction): Promise<ToolResult> {
  const state = prepared.state as EditState;
  const current = await readExisting(ctx, state.resolved);
  // Staleness check: never overwrite a file that changed after the user saw the diff.
  if (current.exists !== state.exists || contentHash(current.text) !== state.originalHash) {
    throw new ToolError(`${state.resolved.relative} changed while the edit was awaiting approval. Re-read it and propose the change again.`);
  }
  await ctx.workspace.writeFile(state.resolved.absolute, state.proposed);
  const approval = prepared.approval;
  const stats = approval?.kind === 'edit' ? approval : undefined;
  const added = stats?.added ?? 0;
  const removed = stats?.removed ?? 0;
  return {
    content: `${state.exists ? 'Updated' : 'Created'} ${state.resolved.relative} (+${added} −${removed} lines).`,
    summary: `+${added} −${removed}`,
    display: stats ? { kind: 'diff', path: stats.path, diff: stats.diff, added, removed, isNew: stats.isNew } : undefined,
  };
}

export const writeFileTool = defineTool({
  name: 'write_file',
  risk: 'write',
  description:
    'Create a new file or completely replace an existing one with the given content. Prefer edit_file or apply_diff for changes to existing files.',
  schema: z.object({
    path: z.string().min(1).describe('Workspace-relative file path'),
    content: z.string().describe('The complete file content'),
  }),
  label: (a) => a.path,
  async prepare(a, ctx) {
    const resolved = await resolveAndVerify(a.path, ctx.workspace);
    const existing = await readExisting(ctx, resolved);
    return proposal(ctx, resolved, existing.exists, existing.text, a.content);
  },
  execute: (_a, ctx, prepared) => commit(ctx, prepared),
});

export const editFileTool = defineTool({
  name: 'edit_file',
  risk: 'write',
  description:
    'Replace an exact text fragment in a file. old_string must match the file exactly (including indentation) and be unique unless replace_all is true. Read the file first.',
  schema: z.object({
    path: z.string().min(1),
    old_string: z.string().min(1).describe('Exact existing text to replace'),
    new_string: z.string().describe('Replacement text'),
    replace_all: z.boolean().default(false),
  }),
  label: (a) => a.path,
  async prepare(a, ctx) {
    const resolved = await resolveAndVerify(a.path, ctx.workspace);
    const existing = await readExisting(ctx, resolved);
    if (!existing.exists) throw new ToolError(`File not found: ${resolved.relative}. Use write_file to create it.`);
    const next = applySearchReplace(existing.text, [{ search: a.old_string, replace: a.new_string, replaceAll: a.replace_all }]);
    return proposal(ctx, resolved, true, existing.text, next);
  },
  execute: (_a, ctx, prepared) => commit(ctx, prepared),
});

export const applyDiffTool = defineTool({
  name: 'apply_diff',
  risk: 'write',
  description:
    'Apply several search/replace edits to one file atomically. Each search must match exactly once. Use for multiple related changes in the same file.',
  schema: z.object({
    path: z.string().min(1),
    edits: z
      .array(z.object({ search: z.string().min(1), replace: z.string() }))
      .min(1)
      .max(50)
      .describe('Edits applied in order'),
  }),
  label: (a) => `${a.path} (${a.edits.length} edits)`,
  async prepare(a, ctx) {
    const resolved = await resolveAndVerify(a.path, ctx.workspace);
    const existing = await readExisting(ctx, resolved);
    if (!existing.exists) throw new ToolError(`File not found: ${resolved.relative}. Use write_file to create it.`);
    const next = applySearchReplace(existing.text, a.edits);
    return proposal(ctx, resolved, true, existing.text, next);
  },
  execute: (_a, ctx, prepared) => commit(ctx, prepared),
});
