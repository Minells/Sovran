import { z } from 'zod';
import { executeGitWrite, prepareGitWrite } from '../../git/write';
import { executeGitWorkflow, prepareGitWorkflow } from '../../git/workflows';
import { validRevision } from '../../git/read';
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

const remote = z.string().min(1).max(100).describe('Name of a configured Git remote, e.g. origin.');

export const gitFetchTool = defineTool({
  ...metadata,
  name: 'git_fetch',
  description:
    'Fetch configured branch refs into remote-tracking refs after approval. Leaves the checked-out branch and files alone. Uses Git credentials on the extension host.',
  schema: z.object({ repository, remote }).strict(),
  label: (a) => `Fetch · ${a.remote}`,
  prepare: (a, ctx) => prepareGitWorkflow(a, { operation: 'fetch', remote: a.remote }, ctx),
  execute: (a, ctx, prepared) => executeGitWorkflow(a, ctx, prepared),
});

export const gitPushTool = defineTool({
  ...metadata,
  name: 'git_push',
  description:
    'Push the checked-out branch to one named branch on a configured remote after approval. Fast-forward updates only. Can set its upstream. Uses Git credentials on the extension host.',
  schema: z
    .object({
      repository,
      remote,
      branch: z.string().min(1).max(250).describe('Short destination branch name, e.g. feature/my-change.'),
      set_upstream: z.boolean().default(false),
    })
    .strict(),
  label: (a) => `Push · ${a.remote}/${a.branch}`,
  prepare: (a, ctx) =>
    prepareGitWorkflow(
      a,
      { operation: 'push', remote: a.remote, branch: a.branch, setUpstream: a.set_upstream },
      ctx,
    ),
  execute: (a, ctx, prepared) => executeGitWorkflow(a, ctx, prepared),
});

export const gitPullTool = defineTool({
  ...metadata,
  name: 'git_pull',
  description:
    'Fetch the checked-out branch’s configured upstream and fast-forward to it after approval. Requires a clean working tree. Refuses to merge or rebase divergent history.',
  schema: z.object({ repository }).strict(),
  label: (a) => `Pull · ${a.repository}`,
  prepare: (a, ctx) => prepareGitWorkflow(a, { operation: 'pull' }, ctx),
  execute: (a, ctx, prepared) => executeGitWorkflow(a, ctx, prepared),
});

export const gitRebaseTool = defineTool({
  ...metadata,
  name: 'git_rebase',
  description:
    'Rebase the checked-out branch onto a commit already in the clone, after approval. Requires a clean working tree. This can rewrite commits and may stop with conflicts.',
  schema: z
    .object({
      repository,
      upstream: z
        .string()
        .refine(validRevision)
        .describe('Local commit ID or ref, e.g. origin/main after fetching.'),
    })
    .strict(),
  label: (a) => `Rebase · ${a.repository}`,
  prepare: (a, ctx) => prepareGitWorkflow(a, { operation: 'rebase', upstream: a.upstream }, ctx),
  execute: (a, ctx, prepared) => executeGitWorkflow(a, ctx, prepared),
});
