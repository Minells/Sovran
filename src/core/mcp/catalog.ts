/** Reviewed optional integrations. This metadata never starts or installs a server. */
import type { McpAuth } from './rules';
import {
  integrationWriteTools,
  integrationWriteProblem,
  reviewedWriteDescription,
} from './writes';

export const INTEGRATION_IDS = [
  'playwright',
  'devtools',
  'github',
  'context7',
  'gitlab',
  'sentry',
  'grafana',
  'terraform',
  'opensearch',
] as const;
export type IntegrationId = (typeof INTEGRATION_IDS)[number];
export const INTEGRATION_PROFILES = [
  'isolated',
  'extension',
  'readonly',
  'collaboration',
  'developer',
  'registry',
  'hcp-readonly',
  'hcp-operations',
  'operations',
] as const;
export type IntegrationProfile = (typeof INTEGRATION_PROFILES)[number];
export interface ManagedIntegration {
  id: IntegrationId;
  profile: IntegrationProfile;
  version: string;
  browserProfile?: string;
  instanceUrl?: string;
  /** User-installed executable on the extension host. Never a shell command line. */
  executable?: string;
  /** External MCP endpoint, distinct from the service's API URL. */
  endpoint?: string;
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
  external?: {
    command: string;
    instance?: { label: string; defaultUrl: string };
  };
  remote?: {
    url: string;
    configurableInstance?: boolean;
    configurableEndpoint?: boolean;
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
  {
    id: 'sentry',
    name: 'Sentry MCP',
    description: 'Investigate Sentry issues and optionally update their status, assignment and notes.',
    icon: 'bug',
    version: '0.49.0',
    documentation: 'https://github.com/getsentry/toolkit/blob/cli%400.49.0/packages/mcp-server/README.md',
    requirements:
      'Install @sentry/mcp-server 0.49.0 separately on the extension host with Node.js 22.15+. Supply a Sentry API token; collaboration also requires event:write.',
    external: {
      command: 'sentry-mcp',
      instance: { label: 'Sentry instance URL', defaultUrl: 'https://sentry.io' },
    },
    security:
      'Read-only by default. Collaboration adds approved issue updates and notes. Telemetry is disabled; hosted OAuth and AI-powered searches are not included.',
    defaultProfile: 'readonly',
    profiles: ['readonly', 'collaboration'],
  },
  {
    id: 'grafana',
    name: 'Grafana MCP',
    description: 'Query metrics and logs, and optionally create or update dashboards and annotations.',
    icon: 'dashboard',
    version: '2.3.0',
    documentation: 'https://github.com/grafana/mcp-grafana/tree/v2.3.0',
    requirements:
      'Install mcp-grafana 2.3.0 separately on the extension host. Requires Grafana 9+ and a service account token; collaboration needs dashboard and annotation write permissions.',
    external: {
      command: 'mcp-grafana',
      instance: { label: 'Grafana instance URL', defaultUrl: 'http://localhost:3000' },
    },
    security:
      'Read-only by default; collaboration enables selected writes with approval each time. Usage statistics remain disabled. Queries use your service account permissions.',
    defaultProfile: 'readonly',
    profiles: ['readonly', 'collaboration'],
  },
  {
    id: 'terraform',
    name: 'Terraform MCP',
    description:
      'Look up Registry documentation, inspect HCP/TFE workspaces and optionally manage workspaces and runs.',
    icon: 'server-environment',
    version: '1.4.1',
    documentation: 'https://github.com/hashicorp/terraform-mcp-server/tree/v1.4.1',
    requirements:
      'Install terraform-mcp-server 1.4.1 separately on the extension host. Public Registry needs no token. HCP/TFE profiles require an API token with the chosen operation permissions.',
    external: {
      command: 'terraform-mcp-server',
      instance: { label: 'HCP Terraform / Terraform Enterprise URL', defaultUrl: 'https://app.terraform.io' },
    },
    security:
      'Operations allow approved workspace changes, plan runs and apply/cancel/discard of one run. Automatic apply and creation of destroy runs are excluded. Review the run plan before applying.',
    defaultProfile: 'registry',
    profiles: ['registry', 'hcp-readonly', 'hcp-operations'],
  },
  {
    id: 'opensearch',
    name: 'OpenSearch MCP',
    description:
      'Search an external OpenSearch MCP server and optionally create indexes or modify individual documents.',
    icon: 'search',
    version: 'external-v1',
    documentation:
      'https://github.com/opensearch-project/opensearch-mcp-server-py/blob/ec714bb377372cb66f140143d8376fb452ab7975/USER_GUIDE.md',
    requirements:
      'An existing Streamable HTTP MCP endpoint with an operator-configured cluster and OPENSEARCH_DYNAMIC_CONNECTION=false. Operations also require OPENSEARCH_SETTINGS_ALLOW_WRITE=true on the server. Optional MCP proxy bearer token.',
    remote: { url: '', configurableEndpoint: true, token: 'optional' },
    security:
      'Cluster credentials, IAM and TLS stay on the external server. Operations require approval and are restricted to explicit index/document routes; connection overrides, scripted document updates, bulk and index deletion are blocked.',
    defaultProfile: 'readonly',
    profiles: ['readonly', 'operations'],
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
  } else if (item.external) {
    if (!managed.executable || !validIntegrationExecutable(managed.executable))
      throw new Error('Enter an executable name or full path, without arguments or variables.');
    const needsInstance = managed.id !== 'terraform' || managed.profile !== 'registry';
    if (needsInstance) {
      if (
        !managed.instanceUrl ||
        normalizeIntegrationUrl(managed.instanceUrl, managed.id === 'sentry') !== managed.instanceUrl
      )
        throw new Error('Enter a valid service instance URL.');
    } else if (managed.instanceUrl !== undefined)
      throw new Error('Public Registry does not use a service instance URL.');
  } else if (managed.instanceUrl !== undefined) {
    throw new Error('This integration has a fixed endpoint.');
  }
  if (!item.external && managed.executable !== undefined)
    throw new Error('This integration does not use an external executable.');
  if (item.remote?.configurableEndpoint) {
    if (!managed.endpoint || normalizeIntegrationUrl(managed.endpoint) !== managed.endpoint)
      throw new Error('Enter the full Streamable HTTP MCP endpoint URL.');
  } else if (managed.endpoint !== undefined)
    throw new Error('This integration does not use a configurable MCP endpoint.');
  if (managed.id === 'sentry')
    return ['mcp', '--skills', managed.profile === 'collaboration' ? 'inspect,triage' : 'inspect'];
  if (managed.id === 'grafana')
    return [
      '-t',
      'stdio',
      ...(managed.profile === 'collaboration' ? ['--disable-write=false'] : ['--disable-write']),
      '--usage-stats=disabled',
      '--enabled-tools',
      `datasource,search,dashboard,prometheus,loki${managed.profile === 'collaboration' ? ',annotations' : ''}`,
    ];
  if (managed.id === 'terraform') return ['stdio', `--tools=${terraformTools(managed.profile).join(',')}`];
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
  if (managed.id === 'opensearch') return normalizeIntegrationUrl(managed.endpoint ?? '');
  return integration(managed.id).remote?.url;
}

/** No URL credentials, variables, query or fragment; HTTP is limited to literal loopback hosts. */
export function normalizeIntegrationUrl(input: string, originOnly = false): string {
  const value = input.trim();
  const problem = 'Use HTTPS (or HTTP on localhost), without credentials, query, fragment or variables.';
  try {
    if (
      value.length > 1900 ||
      !/^https?:\/\//i.test(value) ||
      /[\\\s${}?#]/.test(value) ||
      value.split('/').some((p) => p === '.' || p === '..')
    )
      throw new Error();
    const url = new URL(value);
    if (
      url.username ||
      url.password ||
      (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    )
      throw new Error();
    if (originOnly && url.pathname !== '/') throw new Error();
    return url.href.replace(/\/$/, '');
  } catch {
    throw new Error(originOnly ? `${problem} Enter only the service origin, without a path.` : problem);
  }
}

export function validIntegrationExecutable(value: string): boolean {
  return (
    value === value.trim() &&
    value.length > 0 &&
    value.length <= 1000 &&
    !/[\r\n\0${}]/.test(value) &&
    (/^[a-zA-Z0-9_.-]+$/.test(value) || value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value))
  );
}

export interface IntegrationConnection {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  auth: McpAuth;
}

/** Canonical persisted connection. Used by setup and checked again before requesting any secret. */
export function integrationConnection(managed: ManagedIntegration): IntegrationConnection {
  const args = integrationArguments(managed);
  const item = integration(managed.id);
  if (item.remote)
    return {
      url: integrationEndpoint(managed),
      headers: item.remote.headers?.(managed.profile),
      auth: { type: 'bearer' },
    };
  switch (managed.id) {
    case 'sentry':
      return {
        command: managed.executable,
        args,
        env: { SENTRY_HOST: managed.instanceUrl!, SENTRY_CLI_NO_TELEMETRY: '1', DO_NOT_TRACK: '1' },
        auth: { type: 'env', envName: 'SENTRY_AUTH_TOKEN' },
      };
    case 'grafana':
      return {
        command: managed.executable,
        args,
        env: { GRAFANA_URL: managed.instanceUrl!, DO_NOT_TRACK: '1' },
        auth: { type: 'env', envName: 'GRAFANA_SERVICE_ACCOUNT_TOKEN' },
      };
    case 'terraform':
      return {
        command: managed.executable,
        args,
        env: {
          ...(managed.profile !== 'registry' ? { TFE_ADDRESS: managed.instanceUrl! } : {}),
          OTEL_METRICS_ENABLED: 'false',
          ENABLE_TF_OPERATIONS: managed.profile === 'hcp-operations' ? 'true' : 'false',
        },
        auth: managed.profile !== 'registry' ? { type: 'env', envName: 'TFE_TOKEN' } : { type: 'none' },
      };
    default:
      return { command: 'node', args: [], auth: { type: 'none' } };
  }
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
      [...GITHUB_WRITE_TOOLS, ...GITHUB_DEVELOPER_WRITE].includes(tool)) ||
    (!!managed && integrationWriteTools(managed.id, managed.profile).includes(tool))
  );
}

export function integrationProfileRequiresApproval(id: IntegrationId, profile: IntegrationProfile): boolean {
  return (
    (id === 'gitlab' && profile === 'collaboration') ||
    (id === 'github' && profile === 'developer') ||
    integrationWriteTools(id, profile).length > 0
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
const SENTRY_READ_TOOLS = [
  'find_organizations',
  'find_projects',
  'find_teams',
  'find_releases',
  'get_release_details',
  'get_issue_details',
  'get_event_stacktrace',
  'get_issue_activity',
  'get_issue_breadcrumbs',
  'get_issue_tag_values',
  'get_issue_user_reports',
  'get_trace_details',
  'get_span_details',
  'search_issues',
];
const GRAFANA_READ_TOOLS = [
  'list_datasources',
  'get_datasource',
  'search_dashboards',
  'get_dashboard_summary',
  'get_dashboard_property',
  'get_dashboard_panel_queries',
  'list_prometheus_metric_metadata',
  'list_prometheus_metric_names',
  'list_prometheus_label_names',
  'list_prometheus_label_values',
  'query_prometheus',
  'list_loki_label_names',
  'list_loki_label_values',
  'query_loki_logs',
  'query_loki_stats',
];
const TERRAFORM_REGISTRY_TOOLS = [
  'search_provider_docs',
  'get_provider_details',
  'get_latest_provider_version',
  'search_modules',
  'get_module_details',
  'get_latest_module_version',
  'search_policies',
  'get_policy_details',
  'get_provider_capabilities',
];
const TERRAFORM_HCP_READ_TOOLS = [
  'list_workspaces',
  'get_workspace_details',
  'list_runs',
  'get_run_details',
  'get_plan_details',
  'get_plan_logs',
];
const terraformTools = (profile: IntegrationProfile) =>
  profile === 'hcp-readonly' || profile === 'hcp-operations'
    ? [
        ...TERRAFORM_REGISTRY_TOOLS,
        ...TERRAFORM_HCP_READ_TOOLS,
        ...(profile === 'hcp-operations'
          ? ['get_apply_details', 'get_apply_logs', ...integrationWriteTools('terraform', profile)]
          : []),
      ]
    : TERRAFORM_REGISTRY_TOOLS;
const OPENSEARCH_READ_TOOLS = [
  'ListIndexTool',
  'IndexMappingTool',
  'SearchIndexTool',
  'CountTool',
  'MsearchTool',
  'ClusterHealthTool',
  'GetShardsTool',
];

/** Terraform can initialize with only Registry tools when its TFE client setup fails. */
export function integrationDiscoveryProblem(
  managed: ManagedIntegration | undefined,
  tools: readonly string[],
): string | undefined {
  if (managed && integrationWriteTools(managed.id, managed.profile).some((name) => !tools.includes(name)))
    return `${integration(managed.id).name} does not offer all writes required by the selected profile. Check the token permissions and server configuration${managed.id === 'opensearch' ? ' (including OPENSEARCH_SETTINGS_ALLOW_WRITE=true)' : ''}, then reconnect. No write access was added to existing read profiles.`;
  if (
    managed?.id === 'terraform' &&
    (managed.profile === 'hcp-readonly' || managed.profile === 'hcp-operations') &&
    !tools.some((name) => TERRAFORM_HCP_READ_TOOLS.includes(name))
  )
    return 'HCP/TFE read tools are unavailable. Check the stored token, service URL, certificate trust and account access, then reconnect. Public Registry is available as a separate profile.';
}
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
    case 'sentry':
      return [...SENTRY_READ_TOOLS, ...integrationWriteTools(managed.id, managed.profile)].includes(tool);
    case 'grafana':
      return [
        ...GRAFANA_READ_TOOLS,
        ...(managed.profile === 'collaboration'
          ? ['get_dashboard_by_uid', 'get_annotations', 'get_annotation_tags']
          : []),
        ...integrationWriteTools(managed.id, managed.profile),
      ].includes(tool);
    case 'terraform':
      return terraformTools(managed.profile).includes(tool);
    case 'opensearch':
      return [...OPENSEARCH_READ_TOOLS, ...integrationWriteTools(managed.id, managed.profile)].includes(tool);
  }
}

export function reviewedToolDescription(
  managed: ManagedIntegration | undefined,
  tool: string,
): string | undefined {
  const writeDescription = reviewedWriteDescription(managed, tool);
  if (writeDescription) return writeDescription;
  if (managed?.id === 'sentry' && tool === 'search_issues')
    return 'Search Sentry issues using Sentry search syntax, for example is:unresolved release:latest. Scope the project, time window and result limit. Natural-language AI search is not configured.';
  return managed?.id === 'context7' && Object.hasOwn(CONTEXT7_TOOLS, tool) ? CONTEXT7_TOOLS[tool] : undefined;
}
/** Managed browser tools return text; saving a result to a caller-selected host path is outside these profiles. */
export function integrationCallProblem(
  managed: ManagedIntegration | undefined,
  tool: string,
  args: Record<string, unknown>,
): string | undefined {
  if (
    managed?.id === 'opensearch' &&
    Object.keys(args).some((key) => /^(opensearch_|aws_)/i.test(key) && key !== 'opensearch_cluster_name')
  )
    return 'OpenSearch connection and credential overrides are unavailable. Configure the cluster on the external MCP server.';
  const writeProblem = integrationWriteProblem(managed, tool, args);
  if (writeProblem) return writeProblem;
  if (
    managed?.id === 'github' &&
    managed.profile === 'developer' &&
    tool === 'merge_pull_request' &&
    (typeof args.expectedHeadSha !== 'string' || !/^[0-9a-f]{40}$/i.test(args.expectedHeadSha))
  )
    return 'Read the pull request first and provide its full head commit SHA as expectedHeadSha.';
  if (!managed || !['playwright', 'devtools'].includes(managed.id)) return;
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
  registry: 'Public Registry documentation',
  'hcp-readonly': 'Registry and HCP/TFE workspace and run reads',
  'hcp-operations': 'HCP/TFE workspace and run operations (approval required)',
  operations: 'Index and document operations (approval required)',
};

export function integrationProfileLabel(id: IntegrationId, profile: IntegrationProfile): string {
  if (id === 'sentry')
    return profile === 'collaboration'
      ? 'Issue triage and notes (approval required)'
      : 'Read issues, events, projects and releases';
  if (id === 'grafana')
    return profile === 'collaboration'
      ? 'Dashboards and annotations with writes (approval required)'
      : 'Read dashboards, metrics and logs';
  if (id === 'opensearch' && profile === 'readonly') return 'Read indexes and cluster health';
  if (id === 'gitlab')
    return profile === 'collaboration'
      ? 'Merge requests and issues with writes'
      : 'Read projects, merge requests and pipelines';
  return PROFILE_LABELS[profile];
}
export interface InstallationState {
  id: IntegrationId;
  status: 'missing' | 'installing' | 'ready' | 'remote' | 'external' | 'error';
  error?: string;
}
export interface IntegrationCatalogView {
  host: string;
  remote?: boolean;
  entries: InstallationState[];
}
