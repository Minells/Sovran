import { z } from 'zod';
import { executeGitWrite, prepareGitWrite } from '../../git/write';
import { defineTool } from '../types';

const repository = z
  .string()
  .min(1)
  .max(4096)
  .describe('Explicit workspace repository root containing .git.');
const paths = z
  .array(z.string().min(1).max(4096))
  .min(1)
  .max(50)
  .describe('Individual repository-relative file paths. No stage-all, directories, flags or pathspec magic.');
const metadata = {
  risk: 'execute' as const,
  requiresTrust: true,
  group: 'git',
  source: { kind: 'native' as const },
};

export const gitStageTool = defineTool({
  ...metadata,
  name: 'git_stage',
  description:
    'Stage only selected saved files after repository/file preview and mandatory approval, even in Auto. Rejects a changed index, HEAD, config or saved content. Git filters may execute; no checkpoint undo.',
  schema: z.object({ repository, paths }).strict(),
  label: (a) => `Stage · ${a.repository}`,
  prepare: (a, ctx) => prepareGitWrite('stage', a, ctx),
  execute: (a, ctx, prepared) => executeGitWrite(a, ctx, prepared),
});
export const gitUnstageTool = defineTool({
  ...metadata,
  name: 'git_unstage',
  description:
    'Unstage only selected files after preview and mandatory approval. Keeps working files. Rejects stale index/HEAD/config; no checkout, reset-hard or checkpoint undo.',
  schema: z.object({ repository, paths }).strict(),
  label: (a) => `Unstage · ${a.repository}`,
  prepare: (a, ctx) => prepareGitWrite('unstage', a, ctx),
  execute: (a, ctx, prepared) => executeGitWrite(a, ctx, prepared),
});
export const gitCommitTool = defineTool({
  ...metadata,
  name: 'git_commit',
  description:
    'Commit reviewed staged changes with the approved message. Always asks; checks stale index/branch/HEAD/config. Hooks/signing can execute programs. No automatic staging, amend, push or checkpoint undo.',
  schema: z
    .object({
      repository,
      message: z
        .string()
        .min(1)
        .max(10000)
        .refine(
          (value) => !!value.trim() && !value.includes('\0'),
          'Enter a non-empty commit message without NUL characters.',
        ),
    })
    .strict(),
  label: (a) => `Commit · ${a.repository}`,
  prepare: (a, ctx) => prepareGitWrite('commit', a, ctx),
  execute: (a, ctx, prepared) => executeGitWrite(a, ctx, prepared),
});
