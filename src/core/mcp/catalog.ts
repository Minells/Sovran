/** Reviewed optional integrations. This metadata never starts or installs a server. */
export const INTEGRATION_IDS = ['playwright', 'devtools', 'github', 'context7', 'gitlab'] as const;
export type IntegrationId = (typeof INTEGRATION_IDS)[number];
export const INTEGRATION_PROFILES = [
  'isolated',
  'extension',
  'readonly',
  'collaboration',
  'developer',
] as const;
export type IntegrationProfile = (typeof INTEGRATION_PROFILES)[number];
export interface ManagedIntegration {
  id: IntegrationId;
  profile: IntegrationProfile;
  version: string;
  browserProfile?: string;
  instanceUrl?: string;
}
export interface IntegrationDefinition {
  id: IntegrationId;
  name: string;
  description: string;
  icon: string;
  version: string;
  package?: string;
  entry?: string;
  documentation: string;
  requirements: string;
  remote?: {
    url: string;
    configurableInstance?: boolean;
    token: 'required' | 'optional';
    headers?: (profile: IntegrationProfile) => Record<string, string>;
  };
  security?: string;
  defaultProfile: IntegrationProfile;
  profiles: readonly IntegrationProfile[];
}
export const INTEGRATIONS: readonly IntegrationDefinition[] = [
  {
    id: 'gitlab',
    name: 'GitLab MCP',
    description: 'Work with projects, merge requests, issues and pipelines on your GitLab instance.',
    icon: 'repo',
    version: 'hosted-v1',
    documentation: 'https://docs.gitlab.com/user/model_context_protocol/mcp_server/',
    requirements:
      'MCP enabled on the instance and a fine-grained personal access token with MCP tool → Execute.',
    remote: {
      url: 'https://gitlab.com/api/v4/mcp',
      configurableInstance: true,
      token: 'required',
      headers: (profile) => ({ 'X-Gitlab-Enabled-Mcp-Server-Tools': gitlabTools(profile).join(',') }),
    },
    defaultProfile: 'readonly',
    profiles: ['readonly', 'collaboration'],
  },
  {
    id: 'github',
    name: 'GitHub MCP',
    description: 'Read issues and pull requests using GitHub’s hosted server and your personal access token.',
    icon: 'github',
    version: 'hosted-v1',
    documentation: 'https://github.com/github/github-mcp-server',
    requirements: 'A GitHub personal access token with access to the repositories you select.',
    remote: {
      url: 'https://api.githubcopilot.com/mcp/',
      token: 'required',
      headers: integrationHeaders,
    },
    defaultProfile: 'readonly',
    profiles: ['readonly', 'collaboration', 'developer'],
  },
  {
    id: 'playwright',
    name: 'Playwright MCP',
    description: 'Navigate pages and interact with web applications in a separate browser session.',
    icon: 'globe',
    version: '0.0.84',
    package: '@playwright/mcp',
    entry: 'node_modules/@playwright/mcp/cli.js',
    documentation: 'https://github.com/microsoft/playwright-mcp',
    requirements: 'Node.js 20+ with npm and Google Chrome on the extension host.',
    security: 'Browser tools can reach sites and services available to the extension host.',
    defaultProfile: 'isolated',
    profiles: ['isolated', 'extension'],
  },
  {
    id: 'context7',
    name: 'Context7 MCP',
    description: 'Look up current documentation and code examples for libraries and frameworks.',
    icon: 'book',
    version: 'hosted-v1',
    documentation: 'https://github.com/upstash/context7',
    requirements: 'Internet access. An optional Context7 API key raises the usage limits.',
    remote: { url: 'https://mcp.context7.com/mcp', token: 'optional' },
    security: 'Documentation queries go to Context7. Keep credentials and private code out of queries.',
    defaultProfile: 'readonly',
    profiles: ['readonly'],
  },
  {
    id: 'devtools',
    name: 'Chrome DevTools MCP',
    description: 'Inspect browser errors, network requests and performance in a separate Chrome session.',
    icon: 'tools',
    version: '1.12.0',
    package: 'chrome-devtools-mcp',
    entry: 'node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js',
    documentation: 'https://github.com/ChromeDevTools/chrome-devtools-mcp',
    requirements: 'Node.js 20.19+, 22.12+ or 23+ with npm and Google Chrome on the extension host.',
    security: 'Browser tools can reach sites and services available to the extension host.',
    defaultProfile: 'isolated',
    profiles: ['isolated'],
  },
];
export function integration(id: IntegrationId): IntegrationDefinition {
  return INTEGRATIONS.find((item) => item.id === id)!;
}
export function supportedNode(id: IntegrationId, version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return id === 'devtools'
    ? major >= 23 || (major === 22 && minor >= 12) || (major === 20 && minor >= 19)
    : major >= 20;
}
export function integrationArguments(managed: ManagedIntegration): string[] {
  const item = integration(managed.id);
  if (item.version !== managed.version || !item.profiles.includes(managed.profile))
    throw new Error(
      'This integration version or profile is unavailable. Add the current catalog entry instead.',
    );
  if (managed.id === 'gitlab') {
    if (!managed.instanceUrl || normalizeGitLabInstance(managed.instanceUrl) !== managed.instanceUrl)
      throw new Error('Enter a valid HTTPS GitLab instance URL.');
  } else if (managed.instanceUrl !== undefined) {
    throw new Error('This integration has a fixed endpoint.');
  }
  if (managed.id === 'playwright') {
    if (managed.profile === 'extension' && !/^[a-zA-Z0-9 _-]{1,80}$/.test(managed.browserProfile ?? ''))
      throw new Error('Choose an explicit local Chrome profile before using the browser extension.');
    return [
      ...(managed.profile === 'extension'
        ? ['--extension', '--profile-dir-name', managed.browserProfile!]
        : ['--isolated']),
      '--browser',
      'chrome',
      '--sandbox',
      '--no-webmcp',
      '--image-responses',
      'omit',
      '--redact-url-params',
      'access_token,code,token',
      '--timeout-navigation',
      '30000',
      '--idle-timeout',
      '300000',
    ];
  }
  if (managed.id === 'devtools')
    return [
      '--isolated',
      '--no-usage-statistics',
      '--no-performance-crux',
      '--no-javascript-evaluation',
      '--no-file-navigations',
      '--category-input=false',
      '--category-emulation=false',
      '--category-memory=false',
      '--category-experimental-third-party=false',
      '--category-experimental-webmcp=false',
      '--category-extensions=false',
      '--category-pwa=false',
      '--redact-network-headers',
    ];
  return [];
}

/** Base URL only, including an optional relative root. Reject characters that could change the request target. */
export function normalizeGitLabInstance(input: string): string {
  const value = input.trim();
  const problem = 'Enter an HTTPS GitLab instance URL, for example https://gitlab.example.com/gitlab.';
  if (
    value.length > 1900 ||
    !/^https:\/\/[a-z0-9.:[\]-]+(?:\/[a-z0-9._~-]+)*\/?$/i.test(value) ||
    value.split('/').some((segment) => segment === '.' || segment === '..') ||
    /\/api\/v4(?:\/|$)/i.test(value)
  )
    throw new Error(problem);
  try {
    return new URL(value).href.replace(/\/$/, '');
  } catch {
    throw new Error(problem);
  }
}

export function integrationEndpoint(managed: ManagedIntegration): string | undefined {
  if (managed.id === 'gitlab') return `${normalizeGitLabInstance(managed.instanceUrl ?? '')}/api/v4/mcp`;
  return integration(managed.id).remote?.url;
}

export function integrationHeaders(profile: IntegrationProfile = 'readonly'): Record<string, string> {
  return {
    'X-MCP-Tools': githubTools(profile).join(','),
    ...(profile === 'readonly' ? { 'X-MCP-Readonly': 'true' } : {}),
  };
}
const GITHUB_READ_TOOLS = [
  'get_me',
  'issue_read',
  'pull_request_read',
  'search_issues',
  'search_pull_requests',
];
const GITHUB_WRITE_TOOLS = ['issue_write', 'add_issue_comment', 'create_pull_request'];
const GITHUB_DEVELOPER_READ = [
  'list_pull_requests',
  'search_repositories',
  'list_branches',
  'list_commits',
  'list_issues',
  'actions_list',
  'actions_get',
  'list_releases',
  'get_latest_release',
];
const GITHUB_DEVELOPER_WRITE = [
  'update_pull_request',
  'pull_request_review_write',
  'add_comment_to_pending_review',
  'merge_pull_request',
];
const githubTools = (profile: IntegrationProfile) => [
  ...GITHUB_READ_TOOLS,
  ...(profile === 'collaboration' || profile === 'developer' ? GITHUB_WRITE_TOOLS : []),
  ...(profile === 'developer' ? [...GITHUB_DEVELOPER_READ, ...GITHUB_DEVELOPER_WRITE] : []),
];
const GITLAB_READ_TOOLS = [
  'get_mcp_server_version',
  'get_project',
  'list_projects',
  'list_groups',
  'get_merge_request',
  'list_merge_requests',
  'get_work_item',
  'list_work_items',
  'get_issue',
  'list_branches',
  'list_commits',
  'get_pipeline',
  'list_pipelines',
  'get_job',
];
const GITLAB_WRITE_TOOLS = [
  'save_merge_request',
  'create_merge_request',
  'update_merge_request',
  'save_merge_request_review',
  'accept_merge_request',
  'save_work_item',
  'create_issue',
  'save_note',
];
const gitlabTools = (profile: IntegrationProfile) => [
  ...GITLAB_READ_TOOLS,
  ...(profile === 'collaboration' ? GITLAB_WRITE_TOOLS : []),
];

export function integrationToolRequiresApproval(
  managed: ManagedIntegration | undefined,
  tool: string,
): boolean {
  return (
    (managed?.id === 'gitlab' && GITLAB_WRITE_TOOLS.includes(tool)) ||
    (managed?.id === 'github' &&
      managed.profile === 'developer' &&
      [...GITHUB_WRITE_TOOLS, ...GITHUB_DEVELOPER_WRITE].includes(tool))
  );
}
const CONTEXT7_TOOLS: Readonly<Record<string, string>> = {
  'resolve-library-id': 'Find the Context7 ID for a library or framework. Send a public documentation query.',
  'query-docs':
    'Find docs and code examples for a Context7 library ID. Keep credentials and private code out of the query.',
};
const PLAYWRIGHT_TOOLS = [
  'browser_navigate',
  'browser_navigate_back',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_fill_form',
  'browser_select_option',
  'browser_press_key',
  'browser_hover',
  'browser_drag',
  'browser_wait_for',
  'browser_tabs',
  'browser_close',
  'browser_handle_dialog',
  'browser_console_messages',
  'browser_network_requests',
  'browser_resize',
];
const DEVTOOLS_TOOLS = [
  'list_pages',
  'select_page',
  'new_page',
  'close_page',
  'take_snapshot',
  'list_console_messages',
  'get_console_message',
  'list_network_requests',
  'get_network_request',
  'performance_start_trace',
  'performance_stop_trace',
  'performance_analyze_insight',
];
/** An upper bound for managed profiles, independently of server annotations and per-tool Allow choices. */
export function integrationToolAllowed(managed: ManagedIntegration | undefined, tool: string): boolean {
  if (!managed) return true;
  try {
    integrationArguments(managed);
  } catch {
    return false;
  }
  switch (managed.id) {
    case 'playwright':
      return PLAYWRIGHT_TOOLS.includes(tool);
    case 'devtools':
      return DEVTOOLS_TOOLS.includes(tool);
    case 'context7':
      return Object.hasOwn(CONTEXT7_TOOLS, tool);
    case 'github':
      return githubTools(managed.profile).includes(tool);
    case 'gitlab':
      return gitlabTools(managed.profile).includes(tool);
  }
}

export function reviewedToolDescription(
  managed: ManagedIntegration | undefined,
  tool: string,
): string | undefined {
  return managed?.id === 'context7' && Object.hasOwn(CONTEXT7_TOOLS, tool) ? CONTEXT7_TOOLS[tool] : undefined;
}
/** Managed browser tools return text; saving a result to a caller-selected host path is outside these profiles. */
export function integrationCallProblem(
  managed: ManagedIntegration | undefined,
  tool: string,
  args: Record<string, unknown>,
): string | undefined {
  if (
    managed?.id === 'github' &&
    managed.profile === 'developer' &&
    tool === 'merge_pull_request' &&
    (typeof args.expectedHeadSha !== 'string' || !/^[0-9a-f]{40}$/i.test(args.expectedHeadSha))
  )
    return 'Read the pull request first and provide its full head commit SHA as expectedHeadSha.';
  if (!managed || integration(managed.id).remote) return;
  if (['filename', 'filePath'].some((key) => args[key] !== undefined))
    return 'Managed browser tools cannot save results to a caller-selected path. Request an inline result instead.';
  if (['browser_navigate', 'new_page'].includes(tool)) {
    try {
      if (['http:', 'https:'].includes(new URL(String(args.url)).protocol)) return;
    } catch {
      /* Invalid URL. */
    }
    return 'Managed browser navigation accepts only HTTP or HTTPS URLs.';
  }
  return;
}
export const PROFILE_LABELS: Record<IntegrationProfile, string> = {
  isolated: 'Separate browser session',
  extension: 'Existing Chrome profile (advanced)',
  readonly: 'Read issues and pull requests',
  collaboration: 'Issues and pull requests with optional writes',
  developer: 'Repositories, reviews and Actions',
};

export function integrationProfileLabel(id: IntegrationId, profile: IntegrationProfile): string {
  if (id === 'gitlab')
    return profile === 'collaboration'
      ? 'Merge requests and issues with writes'
      : 'Read projects, merge requests and pipelines';
  return PROFILE_LABELS[profile];
}
export interface InstallationState {
  id: IntegrationId;
  status: 'missing' | 'installing' | 'ready' | 'remote' | 'error';
  error?: string;
}
export interface IntegrationCatalogView {
  host: string;
  remote?: boolean;
  entries: InstallationState[];
}
