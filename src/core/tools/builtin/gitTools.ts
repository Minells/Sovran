import { z } from 'zod';
import { GitReader, prepareGit, validRevision } from '../../git/read';
import { defineTool, type ToolResult } from '../types';

const repository = z
  .string()
  .min(1)
  .max(4096)
  .describe(
    'Explicit workspace repository root containing .git; use rootName/path in multi-root workspaces.',
  );
const paths = z
  .array(z.string().min(1).max(4096))
  .max(50)
  .optional()
  .describe(
    'Literal paths relative to that repository. Bulk content omits protected files; exact protected file paths require approval.',
  );
const revision = z
  .string()
  .refine(
    validRevision,
    'Use a commit ID, branch/tag or HEAD ancestry, without flags, ranges or path expressions.',
  );
const paging = {
  offset: z.number().int().min(0).max(100_000).default(0),
  limit: z.number().int().min(1).max(50).default(20),
};
const result = (value: object): ToolResult => ({ content: JSON.stringify(value, null, 2) });
const metadata = {
  risk: 'read' as const,
  requiresTrust: true,
  group: 'git',
  source: { kind: 'native' as const },
};

export const gitStatusTool = defineTool({
  ...metadata,
  name: 'git_status',
  description:
    'Read repository branch and staged/unstaged/untracked file metadata without changing the index. Requires a trusted workspace. No network.',
  schema: z.object({ repository, paths, ...paging }),
  label: (a) => a.repository,
  prepare: (a, ctx) => prepareGit(a, ctx),
  async execute(a, ctx, prepared) {
    const git = await GitReader.open(a, ctx, prepared);
    return result({
      repository: a.repository,
      ...(await git.status(await git.paths(a.paths), a.offset, a.limit)),
    });
  },
});

export const gitDiffTool = defineTool({
  ...metadata,
  name: 'git_diff',
  description:
    'Read unstaged, staged or two-commit differences. Renames from protected paths are omitted too. No external diff, textconv, filters or network. Use names_only or paging for concise results.',
  schema: z
    .object({
      repository,
      paths,
      scope: z.enum(['unstaged', 'staged', 'revision']).default('unstaged'),
      from: revision.optional(),
      to: revision.optional(),
      names_only: z.boolean().default(false),
      ...paging,
    })
    .superRefine((a, ctx) => {
      if (a.scope === 'revision' ? !a.from : a.from !== undefined || a.to !== undefined)
        ctx.addIssue({
          code: 'custom',
          message: 'from/to apply only to scope=revision, which requires from.',
        });
    }),
  label: (a) => a.repository,
  prepare: (a, ctx) => prepareGit(a, ctx),
  async execute(a, ctx, prepared) {
    const git = await GitReader.open(a, ctx, prepared);
    const compare =
      a.scope === 'revision'
        ? [await git.commit(a.from!), await git.commit(a.to ?? 'HEAD')]
        : a.scope === 'staged'
          ? ['--cached']
          : [];
    return result({
      repository: a.repository,
      scope: a.scope,
      ...(await git.diff(compare, undefined, await git.paths(a.paths), a.offset, a.limit, a.names_only)),
    });
  },
});

export const gitLogTool = defineTool({
  ...metadata,
  name: 'git_log',
  description:
    'Read bounded commit metadata (ID, author, date, subject), optionally for literal paths. Does not include patches, notes or signature verification and never fetches missing objects.',
  schema: z.object({ repository, paths, revision: revision.default('HEAD'), ...paging }),
  label: (a) => a.repository,
  prepare: (a, ctx) => prepareGit(a, ctx),
  async execute(a, ctx, prepared) {
    const git = await GitReader.open(a, ctx, prepared);
    return result({
      repository: a.repository,
      ...(await git.log(await git.commit(a.revision), await git.paths(a.paths), a.offset, a.limit)),
    });
  },
});

export const gitShowTool = defineTool({
  ...metadata,
  name: 'git_show',
  description:
    'Read a commit summary/diff, or one file blob at a commit with path and line range. Protected file blobs require approval. Paths are separate from revisions; no REV:path syntax or filters.',
  schema: z.object({
    repository,
    revision: revision.default('HEAD'),
    path: z.string().min(1).max(4096).optional(),
    start_line: z.number().int().min(1).default(1),
    end_line: z.number().int().min(1).optional(),
    ...paging,
  }),
  label: (a) => a.path ?? a.revision,
  prepare: (a, ctx) => prepareGit({ repository: a.repository, paths: a.path ? [a.path] : [] }, ctx),
  async execute(a, ctx, prepared) {
    const request = { repository: a.repository, paths: a.path ? [a.path] : [] };
    const git = await GitReader.open(request, ctx, prepared);
    const commit = await git.commit(a.revision);
    if (a.path) {
      const file = (await git.paths([a.path]))[0]!;
      return result({
        repository: a.repository,
        ...(await git.blob(commit, file, a.start_line, a.end_line)),
      });
    }
    return result({
      repository: a.repository,
      ...(await git.log(commit, [], 0, 1)),
      ...(await git.diff([], commit, [], a.offset, a.limit, false)),
    });
  },
});

export const gitBranchesTool = defineTool({
  ...metadata,
  name: 'git_branches',
  description:
    'List local branch refs, commit IDs and the current branch. Optionally include already-local remote-tracking refs. No fetch or checkout.',
  schema: z.object({ repository, include_remotes: z.boolean().default(false), ...paging }),
  label: (a) => a.repository,
  prepare: (a, ctx) => prepareGit(a, ctx),
  async execute(a, ctx, prepared) {
    const git = await GitReader.open(a, ctx, prepared);
    return result({
      repository: a.repository,
      ...(await git.branches(a.include_remotes, a.offset, a.limit)),
    });
  },
});
