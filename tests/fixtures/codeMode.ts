import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { integration } from '../../src/core/mcp/catalog';
import { McpHub } from '../../src/core/mcp/hub';
import { nullLogger } from '../../src/core/ports';
import { ToolRegistry } from '../../src/core/tools/registry';
import { MemoryTransports, server, until } from './mcp';

export const projectCount = 10;
export const expectedFailed = 20;

/** Deterministic, JSON-producing read tools; runs through the real MCP SDK, without accounts or network. */
export function projectServer(
  onCall: (name: string) => void = () => {},
  extraTools = 0,
  options: { pageSize?: number; failureProject?: string } = {},
): McpServer {
  const instance = new McpServer({ name: 'prototype-gitlab', version: '1.0' });
  const projects = Array.from({ length: projectCount }, (_, n) => ({
    id: String(n + 1),
    name: `project-${n + 1}`,
    description: 'Fixture project metadata. '.repeat(30),
  }));
  instance.registerTool(
    'list_projects',
    {
      description:
        'List projects with IDs. Returns {projects:[{id,name,description}],nextPage:number|null}. Pass page starting at 1; follow nextPage until null.',
      inputSchema: z.object({ page: z.number().int().min(1).max(100).optional() }),
      annotations: { readOnlyHint: true },
    },
    async ({ page = 1 }) => {
      onCall('list_projects');
      const limit = options.pageSize ?? projectCount;
      const data = {
        projects: projects.slice((page - 1) * limit, page * limit),
        nextPage: page * limit < projects.length ? page + 1 : null,
      };
      return { structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] };
    },
  );
  instance.registerTool(
    'list_pipelines',
    {
      description:
        'List pipelines for one project_id. Returns {pipelines:[{id,status,details}],nextPage:number|null}. Pass page starting at 1; follow nextPage until null. Count status === "failed".',
      inputSchema: z.object({
        project_id: z.string().min(1).max(20),
        page: z.number().int().min(1).max(100).optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ project_id, page = 1 }) => {
      onCall('list_pipelines');
      if (project_id === options.failureProject)
        return { isError: true, content: [{ type: 'text', text: 'Project temporarily unavailable.' }] };
      const data = {
        pipelines: Array.from({ length: 6 }, (_, n) => ({
          id: `${project_id}-${n}`,
          status: n < 2 ? 'failed' : 'success',
          details: 'Fixture pipeline metadata. '.repeat(30),
        })),
        nextPage: null,
      };
      const limit = options.pageSize ?? 6;
      const result = {
        pipelines: data.pipelines.slice((page - 1) * limit, page * limit),
        nextPage: page * limit < data.pipelines.length ? page + 1 : null,
      };
      return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );
  for (let n = 0; n < extraTools; n++)
    instance.registerTool(
      `unreviewed_read_${n}`,
      {
        description: 'An unrelated tool. Its readOnlyHint must not grant Code Mode access.',
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true },
      },
      async () => {
        onCall('unreviewed');
        return { content: [{ type: 'text', text: 'not part of this prototype' }] };
      },
    );
  return instance;
}

export async function codeFixture(
  options: {
    allowed?: boolean;
    onCall?: (name: string) => void;
    servers?: number;
    extraTools?: number;
    pageSize?: number;
    failureProject?: string;
  } = {},
) {
  const configs = Array.from({ length: options.servers ?? 2 }, (_, n) =>
    server({
      id: `gitlab-${n}`,
      managed: {
        id: 'gitlab',
        profile: 'readonly',
        version: integration('gitlab').version,
        instanceUrl: 'https://gitlab.example.com',
      },
      allowedTools: options.allowed === false ? [] : ['list_projects', 'list_pipelines'],
    }),
  );
  const transports = new MemoryTransports(
    Object.fromEntries(
      configs.map((c) => [c.id, () => projectServer(options.onCall, options.extraTools, options)]),
    ),
  );
  const hub = new McpHub({ transports, logger: nullLogger, client: { name: 'test', version: '1' } });
  const registry = new ToolRegistry().addSource(hub);
  hub.update(configs, true);
  await until(() => hub.states().every((state) => state.status === 'connected'));
  return { configs, transports, hub, registry };
}

export const aggregationCode = (projectsTool: string, pipelinesTool: string) => `
  const response = await tools.call(${JSON.stringify(projectsTool)}, {});
  if (!response.data || response.data.nextPage !== null) throw new Error('Incomplete project page');
  const projects = response.data.projects;
  let failedPipelines = 0;
  for (let i = 0; i < projects.length; i += 4) {
    const pages = await Promise.all(projects.slice(i, i + 4).map(p => tools.call(${JSON.stringify(pipelinesTool)}, {project_id: p.id})));
    for (const page of pages) {
      if (!page.data || page.data.nextPage !== null) throw new Error('Incomplete pipeline page');
      failedPipelines += page.data.pipelines.filter(p => p.status === 'failed').length;
    }
  }
  return {totalProjects: projects.length, failedPipelines};
`;
