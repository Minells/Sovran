import type { ManagedIntegration } from '../mcp/catalog';

/** Deliberately smaller than the MCP catalog. An annotation supplied by a server grants nothing. */
const READ_TOOLS: Readonly<Record<string, readonly string[]>> = {
  github: ['get_me', 'search_issues', 'search_pull_requests'],
  gitlab: [
    'get_project',
    'list_projects',
    'get_merge_request',
    'list_merge_requests',
    'get_issue',
    'list_pipelines',
    'get_pipeline',
  ],
};

export function codeModeEligible(managed: ManagedIntegration | undefined, name: string): boolean {
  return managed?.profile === 'readonly' && !!READ_TOOLS[managed.id]?.includes(name);
}
