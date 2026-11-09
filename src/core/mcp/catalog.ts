/** Reviewed optional integrations. This metadata never starts or installs a server. */
export const INTEGRATION_IDS = ['playwright', 'devtools', 'github'] as const;
export type IntegrationId = (typeof INTEGRATION_IDS)[number];
export type IntegrationProfile = 'isolated' | 'extension' | 'readonly' | 'collaboration';
export interface ManagedIntegration {
  id: IntegrationId;
  profile: IntegrationProfile;
  version: string;
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
    profiles: ['isolated'],
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
    profiles: ['readonly'],
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
  if (managed.id === 'playwright') return ['--isolated', '--browser', 'chrome'];
  if (managed.id === 'devtools') return ['--isolated', '--no-usage-statistics', '--no-performance-crux'];
  return [];
}
export function integrationHeaders(): Record<string, string> {
  return {
    'X-MCP-Tools': 'get_me,issue_read,pull_request_read,search_issues,search_pull_requests',
    'X-MCP-Readonly': 'true',
  };
}
export interface InstallationState {
  id: IntegrationId;
  status: 'missing' | 'installing' | 'ready' | 'remote' | 'error';
  error?: string;
}
export interface IntegrationCatalogView {
  host: string;
  entries: InstallationState[];
}
