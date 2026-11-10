/** Reviewed optional integrations. This metadata never starts or installs a server. */
export const INTEGRATION_IDS = ['playwright', 'devtools', 'github'] as const;
export type IntegrationId = (typeof INTEGRATION_IDS)[number];
export type IntegrationProfile = 'isolated' | 'extension' | 'readonly' | 'collaboration';
export interface ManagedIntegration {
  id: IntegrationId;
  profile: IntegrationProfile;
  version: string;
  browserProfile?: string;
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
  defaultProfile: IntegrationProfile;
  profiles: readonly IntegrationProfile[];
}
export const INTEGRATIONS: readonly IntegrationDefinition[] = [
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
    defaultProfile: 'isolated',
    profiles: ['isolated', 'extension'],
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
    defaultProfile: 'isolated',
    profiles: ['isolated'],
  },
  {
    id: 'github',
    name: 'GitHub MCP',
    description: 'Read issues and pull requests using GitHub’s hosted server and your personal access token.',
    icon: 'github',
    version: 'hosted-v1',
    documentation: 'https://github.com/github/github-mcp-server',
    requirements: 'A GitHub personal access token with access to the repositories you select.',
    defaultProfile: 'readonly',
    profiles: ['readonly', 'collaboration'],
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
export function integrationHeaders(profile: IntegrationProfile = 'readonly'): Record<string, string> {
  return {
    'X-MCP-Tools': [...GITHUB_READ_TOOLS, ...(profile === 'collaboration' ? GITHUB_WRITE_TOOLS : [])].join(
      ',',
    ),
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
  const allowed =
    managed.id === 'playwright'
      ? PLAYWRIGHT_TOOLS
      : managed.id === 'devtools'
        ? DEVTOOLS_TOOLS
        : [...GITHUB_READ_TOOLS, ...(managed.profile === 'collaboration' ? GITHUB_WRITE_TOOLS : [])];
  return allowed.includes(tool);
}
/** Managed browser tools return text; saving a result to a caller-selected host path is outside these profiles. */
export function integrationCallProblem(
  managed: ManagedIntegration | undefined,
  tool: string,
  args: Record<string, unknown>,
): string | undefined {
  if (!managed || managed.id === 'github') return;
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
};
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
