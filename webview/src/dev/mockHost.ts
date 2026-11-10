/**
 * DEVELOPMENT HARNESS ONLY — never bundled into the extension (guarded by import.meta.env.DEV).
 * Simulates the extension host and a VS Code theme so the UI can be built, reviewed and
 * screenshotted in a browser:  npm run dev:webview → http://localhost:5173/?scenario=conversation&theme=dark
 */
import '../../../media/sovran.css';
import type { AppState, HostMessage, McpServerView, SessionMessage } from '../../../src/shared/protocol';
import { onPost, setUiState } from '../vscode';
import { INTEGRATIONS } from '../../../src/core/mcp/catalog';

const params = new URLSearchParams(location.search);
const theme = params.get('theme') === 'light' ? 'light' : 'dark';
const scenario = params.get('scenario') ?? 'conversation';
/** `?surface=panel` previews a chat in an editor tab (full width, editor background). */
const surface = params.get('surface') === 'panel' ? 'panel' : 'sidebar';
/** `?scenario=settings&area=mcp` opens Settings on one area. */
if (params.get('area')) setUiState({ settingsArea: params.get('area') ?? undefined });

const THEMES: Record<string, Record<string, string>> = {
  dark: {
    'font-family': '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, Ubuntu, sans-serif',
    'font-size': '13px',
    'editor-font-family': 'Menlo, Monaco, Consolas, "DejaVu Sans Mono", monospace',
    'editor-font-size': '12px',
    'sideBar-background': '#181818',
    'editor-background': '#1f1f1f',
    foreground: '#cccccc',
    descriptionForeground: '#9d9d9d',
    'widget-border': '#313131',
    'panel-border': '#2b2b2b',
    focusBorder: '#0078d4',
    'list-hoverBackground': '#2a2d2e',
    'list-inactiveSelectionBackground': '#37373d',
    'list-activeSelectionBackground': '#04395e',
    'list-activeSelectionForeground': '#ffffff',
    'input-background': '#313131',
    'input-foreground': '#cccccc',
    'input-border': '#3c3c3c',
    'input-placeholderForeground': '#989898',
    'dropdown-background': '#313131',
    'dropdown-border': '#3c3c3c',
    'button-background': '#0078d4',
    'button-foreground': '#ffffff',
    'button-hoverBackground': '#026ec1',
    'button-secondaryBackground': '#313131',
    'button-secondaryForeground': '#cccccc',
    'button-secondaryHoverBackground': '#3c3c3c',
    'textCodeBlock-background': '#1f1f1f',
    'textLink-foreground': '#4daafc',
    'charts-blue': '#3794ff',
    'editorWarning-foreground': '#cca700',
    errorForeground: '#f85149',
    'testing-iconPassed': '#73c991',
    'gitDecoration-addedResourceForeground': '#81b88b',
    'gitDecoration-deletedResourceForeground': '#c74e39',
    'symbolIcon-keywordForeground': '#569cd6',
    'symbolIcon-functionForeground': '#dcdcaa',
    'symbolIcon-classForeground': '#4ec9b0',
    'symbolIcon-variableForeground': '#9cdcfe',
    'debugTokenExpression-string': '#ce9178',
    'debugTokenExpression-number': '#b5cea8',
  },
  light: {
    'font-family': '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, Ubuntu, sans-serif',
    'font-size': '13px',
    'editor-font-family': 'Menlo, Monaco, Consolas, "DejaVu Sans Mono", monospace',
    'editor-font-size': '12px',
    'sideBar-background': '#f8f8f8',
    'editor-background': '#ffffff',
    foreground: '#3b3b3b',
    descriptionForeground: '#717171',
    'widget-border': '#e5e5e5',
    'panel-border': '#e5e5e5',
    focusBorder: '#005fb8',
    'list-hoverBackground': '#f2f2f2',
    'list-inactiveSelectionBackground': '#e4e6f1',
    'list-activeSelectionBackground': '#e8e8e8',
    'list-activeSelectionForeground': '#000000',
    'input-background': '#ffffff',
    'input-foreground': '#3b3b3b',
    'input-border': '#cecece',
    'input-placeholderForeground': '#767676',
    'dropdown-background': '#ffffff',
    'dropdown-border': '#cecece',
    'button-background': '#005fb8',
    'button-foreground': '#ffffff',
    'button-hoverBackground': '#0258a8',
    'button-secondaryBackground': '#e5e5e5',
    'button-secondaryForeground': '#3b3b3b',
    'button-secondaryHoverBackground': '#cccccc',
    'textCodeBlock-background': '#f2f2f2',
    'textLink-foreground': '#005fb8',
    'charts-blue': '#1a85ff',
    'editorWarning-foreground': '#bf8803',
    errorForeground: '#e51400',
    'testing-iconPassed': '#388a34',
    'gitDecoration-addedResourceForeground': '#587c0c',
    'gitDecoration-deletedResourceForeground': '#ad0707',
    'symbolIcon-keywordForeground': '#0000ff',
    'symbolIcon-functionForeground': '#795e26',
    'symbolIcon-classForeground': '#267f99',
    'symbolIcon-variableForeground': '#001080',
    'debugTokenExpression-string': '#a31515',
    'debugTokenExpression-number': '#098658',
  },
};

const style = document.createElement('style');
style.textContent = `:root{${Object.entries(THEMES[theme]!)
  .map(([k, v]) => `--vscode-${k.replace(/\./g, '-')}:${v}`)
  .join(
    ';',
  )}} body{max-width:${surface === 'panel' ? 'none' : `${params.get('width') ?? '420'}px`};height:100vh;border-right:1px solid var(--vscode-panel-border)}`;
document.head.appendChild(style);
document.body.classList.add(theme === 'light' ? 'vscode-light' : 'vscode-dark');
// The host sets this on <body> (see webviewHtml).
document.body.dataset.surface = surface;

const now = Date.now();
const providers: AppState['providers'] = [
  {
    id: 'ollama',
    name: 'Ollama',
    baseUrl: 'http://localhost:11434/v1',
    authType: 'none',
    hasKey: false,
    models: [
      { id: 'qwen2.5-coder:14b', toolMode: 'auto' },
      { id: 'devstral:24b', toolMode: 'auto', learnedToolMode: 'prompted' },
    ],
  },
  {
    id: 'gateway',
    name: 'Company AI Gateway',
    baseUrl: 'https://llm.internal.example/v1',
    authType: 'header',
    headerName: 'api-key',
    hasKey: true,
    models: [
      { id: 'coder-large', contextWindow: 131072, toolMode: 'native' },
      {
        id: 'glm-5.3-flash',
        toolMode: 'auto',
        maxOutputTokens: 8192,
        serverLimits: { contextWindow: 131072, maxOutputTokens: 32768 },
      },
    ],
  },
];

/** `?config=missing|error|ignored` previews the other states of the config file card. */
const configParam = params.get('config');
const configFile: AppState['configFile'] =
  configParam === 'missing'
    ? { path: '~/.sovran/config.yaml', state: 'missing', providers: 0, problems: [] }
    : configParam === 'ignored'
      ? { path: '~/.sovran/config.yaml', state: 'ignored', providers: 0, problems: [] }
      : configParam === 'error'
        ? {
            path: '~/.sovran/config.yaml',
            state: 'error',
            providers: 1,
            problems: [
              { line: 7, message: 'Unknown field "base_url". Did you mean "baseUrl"?' },
              {
                line: 12,
                message:
                  'API keys are never read from config.yaml. Use "Set key" in Sovran: keys are kept in VS Code Secret Storage.',
              },
            ],
          }
        : { path: '~/.sovran/config.yaml', state: 'ok', providers: 2, problems: [] };

/** `?mcp=empty` previews the first-run presets; `?mcp=restricted` an untrusted workspace. */
const mcpParam = params.get('mcp');
const mcpServers: McpServerView[] = [
  {
    id: 'github',
    name: 'GitHub',
    enabled: true,
    transport: 'http',
    url: 'https://api.githubcopilot.com/mcp/',
    auth: { type: 'bearer' },
    hasToken: true,
    insecure: false,
    timeoutSeconds: 60,
    status: 'connected',
    server: { name: 'github-mcp-server', version: '1.4.2' },
    toolTokens: 2140,
    tools: [
      {
        name: 'search_issues',
        title: 'Search issues',
        modelName: 'mcp__github__search_issues',
        policy: 'allow',
        hints: ['read-only'],
        description:
          'Search issues and pull requests across GitHub repositories using the GitHub search syntax.',
      },
      {
        name: 'get_pull_request',
        title: 'Get pull request',
        modelName: 'mcp__github__get_pull_request',
        policy: 'ask',
        hints: ['read-only'],
        description: 'Get the details of a pull request: title, body, state, reviewers and checks.',
      },
      {
        name: 'create_issue',
        title: 'Create issue',
        modelName: 'mcp__github__create_issue',
        policy: 'ask',
        hints: [],
        description: 'Create a new issue in a GitHub repository.',
      },
      {
        name: 'merge_pull_request',
        title: 'Merge pull request',
        modelName: 'mcp__github__merge_pull_request',
        policy: 'off',
        hints: ['destructive'],
        description: 'Merge a pull request into its base branch.',
      },
    ],
  },
  {
    id: 'filesystem',
    name: 'Filesystem',
    enabled: true,
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '${workspaceFolder}'],
    auth: { type: 'none' },
    hasToken: false,
    insecure: false,
    timeoutSeconds: 60,
    status: 'starting',
    toolTokens: 0,
    tools: [],
  },
  {
    id: 'jira',
    name: 'Jira',
    enabled: true,
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-atlassian'],
    env: { JIRA_URL: 'https://acme.atlassian.net' },
    auth: { type: 'env', envName: 'JIRA_API_TOKEN' },
    hasToken: false,
    insecure: false,
    timeoutSeconds: 120,
    status: 'error',
    error: 'No token is stored for Jira. Add it with Set token.',
    toolTokens: 0,
    tools: [],
  },
  {
    id: 'fetch',
    name: 'Fetch',
    enabled: false,
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-fetch'],
    auth: { type: 'none' },
    hasToken: false,
    insecure: false,
    timeoutSeconds: 60,
    status: 'disabled',
    toolTokens: 0,
    tools: [],
  },
];

/** `?scenario=mcp`: the agent wants to open a GitHub issue through MCP. */
const issueArgs = {
  owner: 'acme',
  repo: 'acme-api',
  title: 'Session TTL ignores SESSION_TTL in staging',
  labels: ['bug', 'auth'],
};
const mcpConversation: SessionMessage[] = [
  {
    role: 'user',
    id: 'm0',
    createdAt: now - 40_000,
    content: 'Open an issue for the session TTL bug we just found, and link the failing test.',
  },
  {
    role: 'assistant',
    id: 'm1',
    createdAt: now - 35_000,
    model: { providerId: 'ollama', modelId: 'qwen2.5-coder:14b' },
    content: "I'll check for an existing issue first, then open one.",
    toolCalls: [
      {
        id: 'g1',
        name: 'mcp__github__search_issues',
        arguments: JSON.stringify({ q: 'repo:acme/acme-api session TTL is:open' }),
      },
      { id: 'g2', name: 'mcp__github__create_issue', arguments: JSON.stringify(issueArgs) },
    ],
  },
  {
    role: 'tool',
    id: 'm2',
    toolCallId: 'g1',
    toolName: 'mcp__github__search_issues',
    createdAt: now - 33_000,
    status: 'success',
    summary: 'Search issues · GitHub',
    autoApproved: 'Ran without asking (you allowed this tool of GitHub).',
    durationMs: 640,
    content: 'No open issues match.',
  },
];

const editArgs = JSON.stringify({
  path: 'src/auth/session.ts',
  old_string: 'const TTL = 3600;',
  new_string: 'const TTL = Number(process.env.SESSION_TTL ?? 3600);',
});
const conversation: SessionMessage[] = [
  {
    role: 'user',
    id: 'u0',
    createdAt: now - 300_000,
    content: 'Add a health check endpoint',
    display: '/review src/http/server.ts',
    checkpoint: { id: 'cp0', files: ['src/http/health.ts', 'src/http/server.ts'] },
  },
  {
    role: 'assistant',
    id: 'a0',
    createdAt: now - 290_000,
    model: { providerId: 'ollama', modelId: 'qwen2.5-coder:14b' },
    content: 'Added `GET /healthz` in `src/http/health.ts` and registered it in the server.',
  },
  {
    role: 'user',
    id: 'u1',
    createdAt: now - 60_000,
    content:
      'Sessions expire too early in staging. Make the session TTL configurable and keep the current default.',
    attachments: [{ kind: 'file', path: 'src/auth/session.ts', content: '' }],
  },
  {
    role: 'assistant',
    id: 'a1',
    createdAt: now - 55_000,
    model: { providerId: 'ollama', modelId: 'qwen2.5-coder:14b' },
    reasoning: 'The TTL is hard-coded. I should find every place that reads it before changing anything.',
    content: "I'll check how the TTL is defined and where it is used.",
    toolCalls: [
      { id: 't1', name: 'search_files', arguments: JSON.stringify({ query: 'TTL', glob: 'src/**/*.ts' }) },
      { id: 't2', name: 'read_file', arguments: JSON.stringify({ path: 'src/auth/session.ts' }) },
    ],
  },
  {
    role: 'tool',
    id: 'r1',
    toolCallId: 't1',
    toolName: 'search_files',
    createdAt: now - 54_000,
    status: 'success',
    summary: '3 matches',
    content: '',
    display: {
      kind: 'list',
      items: [
        'src/auth/session.ts:4: const TTL = 3600;',
        'src/auth/session.ts:31: expiresAt: now + TTL * 1000,',
        'src/auth/refresh.ts:12: if (age > TTL) {',
      ],
      total: 3,
    },
  },
  {
    role: 'tool',
    id: 'r2',
    toolCallId: 't2',
    toolName: 'read_file',
    createdAt: now - 53_000,
    status: 'success',
    summary: '48 lines',
    content: '',
  },
  {
    role: 'assistant',
    id: 'a2',
    createdAt: now - 50_000,
    model: { providerId: 'ollama', modelId: 'qwen2.5-coder:14b' },
    content:
      '`TTL` is defined once in `src/auth/session.ts:4` and read in two places, so a single change covers both:\n\n```ts\nconst TTL = Number(process.env.SESSION_TTL ?? 3600);\n```\n\nThe default stays **3600 seconds**.',
    toolCalls: [{ id: 't3', name: 'edit_file', arguments: editArgs }],
  },
];

const autoConversation: SessionMessage[] = [
  {
    role: 'user',
    id: 'v0',
    createdAt: now - 45_000,
    content: 'Rename getUser to fetchUser everywhere, run the tests and push.',
  },
  {
    role: 'assistant',
    id: 'v1',
    createdAt: now - 44_000,
    model: { providerId: 'ollama', modelId: 'qwen2.5-coder:14b' },
    content: 'Renaming in the two files that use it, then running the test suite.',
    toolCalls: [
      { id: 'x1', name: 'apply_diff', arguments: JSON.stringify({ path: 'src/users/api.ts', edits: [] }) },
      { id: 'x2', name: 'execute_terminal', arguments: JSON.stringify({ command: 'npm test' }) },
    ],
  },
  {
    role: 'tool',
    id: 'y1',
    toolCallId: 'x1',
    toolName: 'apply_diff',
    createdAt: now - 43_000,
    status: 'success',
    summary: '+3 −3',
    content: '',
    autoApproved: 'Applied without asking (Auto mode).',
    display: {
      kind: 'diff',
      path: 'src/users/api.ts',
      diff: '@@ -1,3 +1,3 @@\n-export async function getUser(id: string) {\n+export async function fetchUser(id: string) {',
      added: 3,
      removed: 3,
      isNew: false,
    },
  },
  {
    role: 'tool',
    id: 'y2',
    toolCallId: 'x2',
    toolName: 'execute_terminal',
    createdAt: now - 42_000,
    status: 'success',
    summary: 'exit 0 · 4.2s',
    content: '',
    autoApproved: 'Ran without asking (in your allowed commands).',
    display: {
      kind: 'command',
      command: 'npm test',
      cwd: '.',
      output: 'Test Files  12 passed (12)\n     Tests  148 passed (148)',
      exitCode: 0,
      timedOut: false,
    },
  },
  {
    role: 'assistant',
    id: 'v2',
    createdAt: now - 41_000,
    model: { providerId: 'ollama', modelId: 'qwen2.5-coder:14b' },
    content: 'All 148 tests pass. Pushing the branch.',
    toolCalls: [
      { id: 'x3', name: 'execute_terminal', arguments: JSON.stringify({ command: 'git push origin main' }) },
    ],
  },
];

const doneConversation: SessionMessage[] = [
  ...conversation.slice(0, 2),
  { role: 'user', id: 'u9', createdAt: now - 20_000, content: 'Is the health check covered by tests?' },
  {
    role: 'assistant',
    id: 'a9',
    createdAt: now - 18_000,
    model: { providerId: 'ollama', modelId: 'qwen2.5-coder:14b' },
    content:
      'Not yet: `src/http/health.ts` has no test. A request to `GET /healthz` that expects **200** and `{ "status": "ok" }` would cover it, next to the existing tests in `test/http`.',
  },
];

/** `?scenario=long`: several exchanges with long answers, to scroll through (the pinned message). */
const longAnswer = (topic: string) =>
  [
    `Here is how ${topic} works, step by step.`,
    ...Array.from(
      { length: 6 },
      (_, i) =>
        `**Step ${i + 1}.** The request goes through \`src/http/client.ts\`, which retries idempotent calls with exponential backoff and jitter, and gives up after the configured budget so a slow dependency cannot hold the worker.`,
    ),
    'That covers the whole path.',
  ].join('\n\n');
const longConversation: SessionMessage[] = [
  { role: 'user', id: 'l0', createdAt: now - 900_000, content: 'Explain the retry logic in http/client.ts' },
  {
    role: 'assistant',
    id: 'l1',
    createdAt: now - 890_000,
    model: { providerId: 'ollama', modelId: 'qwen2.5-coder:14b' },
    content: longAnswer('the retry logic'),
  },
  {
    role: 'user',
    id: 'l2',
    createdAt: now - 600_000,
    content:
      'And how are timeouts chosen? I want to understand why some calls wait 30 seconds and others give up after 5, and whether that is configurable per endpoint.',
  },
  {
    role: 'assistant',
    id: 'l3',
    createdAt: now - 590_000,
    model: { providerId: 'ollama', modelId: 'qwen2.5-coder:14b' },
    content: longAnswer('timeout selection'),
  },
  { role: 'user', id: 'l4', createdAt: now - 300_000, content: 'Summarize it in three bullets' },
  {
    role: 'assistant',
    id: 'l5',
    createdAt: now - 290_000,
    model: { providerId: 'ollama', modelId: 'qwen2.5-coder:14b' },
    content: longAnswer('the summary'),
  },
];

/** `?scenario=bigdiff`: a proposal longer than the view, as real edits usually are. */
const bigDiff = [
  '===================================================================',
  '--- a/src/auth/session.ts\t',
  '+++ b/src/auth/session.ts\t',
  '@@ -1,40 +1,52 @@',
  " import { randomUUID } from 'node:crypto';",
  " import type { User } from '../users';",
  '+import { readDuration } from "../config/env";',
  ' ',
  '-const TTL = 3600;',
  "+/** Session lifetime in seconds. Override with SESSION_TTL (for example 900 for 15 minutes, or '2h' in duration notation). */",
  '+const TTL = readDuration(process.env.SESSION_TTL, { fallback: 3600, min: 60, max: 86_400 * 30 });',
  ' ',
  ...Array.from(
    { length: 24 },
    (_, i) =>
      ` export function helper${i}(session: Session): boolean { return session.expiresAt > Date.now() + ${i} * 1000; }`,
  ),
  '-export function isExpired(s: Session) {',
  '-  return s.expiresAt < Date.now();',
  '+export function isExpired(s: Session, now = Date.now()) {',
  '+  // A session that expires within the clock skew allowance counts as expired, so clients refresh early.',
  '+  return s.expiresAt - CLOCK_SKEW_MS < now;',
  ' }',
  '-- old SQL-style comment kept as text',
  ...Array.from({ length: 30 }, (_, i) => `+export const LIMIT_${i} = ${i * 10};`),
].join('\n');

const diff = `--- a/src/auth/session.ts\n+++ b/src/auth/session.ts\n@@ -1,7 +1,7 @@\n import { randomUUID } from 'node:crypto';\n import type { User } from '../users';\n \n-const TTL = 3600;\n+const TTL = Number(process.env.SESSION_TTL ?? 3600);\n \n export interface Session {\n   id: string;`;

function baseState(): AppState {
  const messages =
    scenario === 'conversation' || scenario === 'bigdiff'
      ? conversation
      : scenario === 'mcp'
        ? mcpConversation
        : scenario === 'auto'
          ? autoConversation
          : scenario === 'done'
            ? doneConversation
            : scenario === 'long'
              ? longConversation
              : [];
  const awaitingEdit = scenario === 'conversation' || scenario === 'bigdiff';
  const approvalParam =
    (['ask', 'edits', 'auto'] as const).find((m) => m === params.get('approval')) ?? 'ask';
  return {
    surface,
    toolGroups: [
      {
        id: 'files',
        label: 'Read files and search',
        selected: true,
        availableTools: 4,
        definitionTokens: 680,
      },
      { id: 'git', label: 'Git', selected: true, availableTools: 8, definitionTokens: 1500 },
      { id: 'web', label: 'Web fetch', selected: false, availableTools: 1, definitionTokens: 240 },
      { id: 'mcp:github', label: 'GitHub', selected: true, availableTools: 2, definitionTokens: 2140 },
    ],
    nativeTools: [
      {
        name: 'read_file',
        description: 'Read text or document content from the workspace, with optional paging.',
        group: 'files',
        risk: 'read',
      },
      {
        name: 'git_status',
        description: 'Read repository branch, staged and unstaged file status.',
        group: 'git',
        risk: 'read',
      },
      {
        name: 'web_fetch',
        description: 'Read one approved public HTTP(S) page with source links.',
        group: 'web',
        risk: 'read',
      },
    ],
    view:
      scenario === 'providers'
        ? 'providers'
        : scenario === 'history'
          ? 'history'
          : scenario === 'settings'
            ? 'settings'
            : 'chat',
    workspace: { name: 'acme-api', trusted: mcpParam !== 'restricted', hasFolder: true },
    providers: scenario === 'onboarding' ? [] : providers,
    selected: scenario === 'onboarding' ? null : { providerId: 'ollama', modelId: 'qwen2.5-coder:14b' },
    mode: params.get('mode') === 'plan' ? 'plan' : 'act',
    approvalMode: scenario === 'auto' ? 'auto' : approvalParam,
    sessions: [
      {
        id: 's1',
        title: 'Make the session TTL configurable',
        createdAt: now - 60_000,
        updatedAt: now - 50_000,
        messageCount: 3,
      },
      {
        id: 's2',
        title: 'Explain the retry logic in http/client.ts',
        createdAt: now - 3_600_000 * 5,
        updatedAt: now - 3_600_000 * 5,
        messageCount: 6,
      },
      {
        id: 's3',
        title: 'Plan the migration to Postgres 17',
        createdAt: now - 86_400_000 * 1.2,
        updatedAt: now - 86_400_000 * 1.2,
        messageCount: 11,
      },
      {
        id: 's4',
        title: 'Add tests for the billing webhooks',
        createdAt: now - 86_400_000 * 4,
        updatedAt: now - 86_400_000 * 4,
        messageCount: 9,
      },
    ],
    liveSessions:
      scenario === 'history'
        ? [
            { id: 's1', inEditor: true, running: true, needsApproval: true },
            { id: 's2', inEditor: true, running: true, needsApproval: false },
            { id: 's3', inEditor: true, running: false, needsApproval: false },
          ]
        : awaitingEdit
          ? [{ id: 's1', inEditor: surface === 'panel', running: true, needsApproval: true }]
          : [],
    session: {
      id: messages.length ? 's1' : 'draft',
      title: messages.length ? 'Make the session TTL configurable' : 'New chat',
      messages,
    },
    run: awaitingEdit
      ? {
          sessionId: 's1',
          iteration: 3,
          maxIterations: 25,
          startedAt: now - 58_000,
          activity: {
            phase: 'awaiting_approval',
            label: 'src/auth/session.ts',
            toolName: 'edit_file',
            callId: 't3',
          },
        }
      : scenario === 'auto'
        ? {
            sessionId: 's1',
            iteration: 4,
            maxIterations: 25,
            startedAt: now - 41_000,
            activity: {
              phase: 'awaiting_approval',
              label: 'git push origin main',
              toolName: 'execute_terminal',
              callId: 'x3',
            },
          }
        : scenario === 'mcp'
          ? {
              sessionId: 's1',
              iteration: 2,
              maxIterations: 25,
              startedAt: now - 40_000,
              activity: {
                phase: 'awaiting_approval',
                label: 'Create issue · GitHub',
                toolName: 'mcp__github__create_issue',
                callId: 'g2',
              },
            }
          : null,
    approvals: awaitingEdit
      ? [
          {
            id: 'ap1',
            callId: 't3',
            toolName: 'edit_file',
            title: 'src/auth/session.ts',
            detail:
              scenario === 'bigdiff'
                ? {
                    kind: 'edit',
                    path: 'src/auth/session.ts',
                    isNew: false,
                    diff: bigDiff,
                    added: 36,
                    removed: 4,
                  }
                : { kind: 'edit', path: 'src/auth/session.ts', isNew: false, diff, added: 1, removed: 1 },
          },
        ]
      : scenario === 'mcp'
        ? [
            {
              id: 'ap3',
              callId: 'g2',
              toolName: 'mcp__github__create_issue',
              title: 'Create issue · GitHub',
              reason:
                'Tools of MCP servers ask before they run, in every approval mode, until you allow them.',
              detail: {
                kind: 'mcp',
                server: 'GitHub',
                tool: 'create_issue',
                title: 'Create issue',
                arguments: JSON.stringify(issueArgs, null, 2),
                hints: ['open-world'],
              },
            },
          ]
        : scenario === 'auto'
          ? [
              {
                id: 'ap2',
                callId: 'x3',
                toolName: 'execute_terminal',
                title: 'git push origin main',
                reason: 'Pushes commits to a remote repository.',
                detail: {
                  kind: 'command',
                  command: 'git push origin main',
                  cwd: '.',
                  warnings: ['Pushes commits to a remote repository.'],
                  allowPrefix: null,
                },
              },
            ]
          : [],
    context: {
      editor:
        params.get('editor') === 'outside'
          ? { path: '/home/dev/.aws/credentials', label: 'credentials', blocked: 'outside' }
          : params.get('editor') === 'none'
            ? null
            : params.get('editor') === 'selection'
              ? { path: 'src/auth/session.ts', label: 'session.ts:12-30', startLine: 12, endLine: 30 }
              : { path: 'src/auth/session.ts', label: 'session.ts' },
      includeEditor: true,
      attachments: [],
    },
    grants: { edits: false },
    planModel: null,
    titleModel: null,
    usage: scenario === 'conversation' ? { tokens: 23_480, contextWindow: 32_768, source: 'server' } : null,
    compaction: null,
    commands: [
      { name: 'explain', description: 'Explain the selection, a file or a concept', source: 'builtin' },
      { name: 'fix', description: 'Find and fix problems (uses editor diagnostics)', source: 'builtin' },
      { name: 'test', description: 'Write tests following the project conventions', source: 'builtin' },
      { name: 'review', description: 'Review code for bugs and risks without editing', source: 'builtin' },
      { name: 'release-notes', description: 'Draft release notes since the last tag', source: 'workspace' },
      { name: 'compact', description: 'Summarize older messages to free context', source: 'builtin' },
    ],
    settings: {
      defaultApprovalMode: 'ask',
      allowedCommands: ['npm test', 'git status', 'npm run lint'],
      protectedPaths: ['**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/id_rsa*', '**/.git/**'],
      disabledTools: [],
      forceAskTools: [],
      defaultProtectedPaths: [
        '**/.env',
        '**/.env.*',
        '**/*.pem',
        '**/*.key',
        '**/id_rsa*',
        '**/id_ed25519*',
        '**/.git/**',
        '**/.npmrc',
        '**/.pypirc',
        '**/.netrc',
      ],
      maxIterations: 25,
      terminalTimeoutSeconds: 120,
      mirrorToTerminal: true,
      openDiffOnProposal: true,
      includeActiveEditor: true,
      autoCompact: true,
      projectInstructions: true,
      maxToolResultChars: 20000,
      persistSessions: true,
      generateTitles: params.get('titles') !== 'off',
      overriddenByWorkspace: [],
    },
    configFile:
      scenario === 'onboarding'
        ? { path: '~/.sovran/config.yaml', state: 'missing', providers: 0, problems: [] }
        : configFile,
    mcp: {
      active: mcpParam !== 'restricted',
      catalog: {
        host: 'This computer (macOS)',
        remote: false,
        entries: INTEGRATIONS.map((item) => ({ id: item.id, status: item.package ? 'missing' : 'remote' })),
      },
      // In Restricted Mode no server runs, as in the real host.
      servers:
        mcpParam === 'empty'
          ? []
          : mcpParam === 'restricted'
            ? mcpServers.map((s) => ({
                ...s,
                status: s.enabled ? 'stopped' : 'disabled',
                error: undefined,
                server: undefined,
                tools: [],
                toolTokens: 0,
              }))
            : mcpServers,
    },
  };
}

let state = baseState();
const send = (m: HostMessage) => window.postMessage(m, '*');
const patchMcp = (servers: McpServerView[]) => {
  state = { ...state, mcp: { ...state.mcp, servers } };
  send({ type: 'patch', patch: { mcp: state.mcp } });
};
const updateServer = (id: string, change: (s: McpServerView) => McpServerView) =>
  patchMcp(state.mcp.servers.map((s) => (s.id === id ? change(s) : s)));
/** Pretends to start a server: a moment of "Starting…", then connected with a couple of tools. */
const connect = (id: string) => {
  updateServer(id, (s) => ({ ...s, status: 'starting', error: undefined }));
  setTimeout(
    () =>
      updateServer(id, (s) => {
        const missing = s.auth.type !== 'none' && !s.hasToken;
        return {
          ...s,
          status: missing ? 'error' : 'connected',
          error: missing ? `No token is stored for ${s.name}. Add it with Set token.` : undefined,
          server: { name: s.id, version: '1.0.0' },
          tools: s.tools.length
            ? s.tools
            : [
                {
                  name: 'list_items',
                  modelName: `mcp__${s.id}__list_items`,
                  policy: 'ask',
                  hints: ['read-only'],
                  description: 'Lists the items the server knows about.',
                },
                {
                  name: 'update_item',
                  modelName: `mcp__${s.id}__update_item`,
                  policy: 'ask',
                  hints: ['destructive'],
                  description: 'Changes one item.',
                },
              ],
          toolTokens: s.toolTokens || 410,
        };
      }),
    800,
  );
};
// The filesystem server finishes starting shortly after the page opens.
setTimeout(
  () =>
    state.mcp.active &&
    state.mcp.servers.some((s) => s.id === 'filesystem' && s.status === 'starting') &&
    connect('filesystem'),
  1500,
);

/** A small fake repository for the attach menu. */
const TREE: Record<string, Array<{ name: string; type: 'file' | 'directory' }>> = {
  '': [
    { name: '.github', type: 'directory' },
    { name: 'src', type: 'directory' },
    { name: 'test', type: 'directory' },
    { name: '.env', type: 'file' },
    { name: 'AGENTS.md', type: 'file' },
    { name: 'package.json', type: 'file' },
    { name: 'README.md', type: 'file' },
    { name: 'tsconfig.json', type: 'file' },
  ],
  '.github': [{ name: 'workflows', type: 'directory' }],
  '.github/workflows': [{ name: 'ci.yml', type: 'file' }],
  src: [
    { name: 'auth', type: 'directory' },
    { name: 'http', type: 'directory' },
    { name: 'index.ts', type: 'file' },
  ],
  'src/auth': [
    { name: 'refresh.ts', type: 'file' },
    { name: 'session.ts', type: 'file' },
  ],
  'src/http': [
    { name: 'client.ts', type: 'file' },
    { name: 'health.ts', type: 'file' },
    { name: 'server.ts', type: 'file' },
  ],
  test: [{ name: 'auth', type: 'directory' }],
  'test/auth': [{ name: 'session.spec.ts', type: 'file' }],
};
const ALL_FILES = Object.entries(TREE).flatMap(([dir, entries]) =>
  entries.filter((e) => e.type === 'file').map((e) => (dir ? `${dir}/${e.name}` : e.name)),
);
const OPEN = ['src/auth/session.ts', 'src/http/server.ts', 'src/auth/refresh.ts'];
let attachmentSeq = 0;
const setAttachments = (attachments: AppState['context']['attachments']) => {
  state = { ...state, context: { ...state.context, attachments } };
  send({ type: 'patch', patch: { context: state.context } });
};

onPost((m) => {
  switch (m.type) {
    case 'ready':
      return send({ type: 'state', state });
    case 'setMode':
      state = { ...state, mode: m.mode };
      return send({ type: 'patch', patch: { mode: m.mode } });
    case 'setToolGroup':
      state = {
        ...state,
        toolGroups: state.toolGroups?.map((group) =>
          group.id === m.group ? { ...group, selected: m.selected } : group,
        ),
      };
      return send({ type: 'patch', patch: { toolGroups: state.toolGroups } });
    case 'setApprovalMode':
      state = { ...state, approvalMode: m.mode };
      return send({ type: 'patch', patch: { approvalMode: m.mode } });
    case 'updateSetting': {
      const key = m.setting.key;
      const field = (
        {
          'tools.disabled': 'disabledTools',
          'tools.forceAsk': 'forceAskTools',
          'approvals.mode': 'defaultApprovalMode',
          'approvals.allowedCommands': 'allowedCommands',
          'security.protectedPaths': 'protectedPaths',
          'agent.maxIterations': 'maxIterations',
          'terminal.timeoutSeconds': 'terminalTimeoutSeconds',
          'terminal.mirrorToTerminal': 'mirrorToTerminal',
          'diff.openOnProposal': 'openDiffOnProposal',
          'context.includeActiveEditor': 'includeActiveEditor',
          'context.autoCompact': 'autoCompact',
          'context.projectInstructions': 'projectInstructions',
          'context.maxToolResultChars': 'maxToolResultChars',
          'sessions.persist': 'persistSessions',
          'sessions.generateTitles': 'generateTitles',
        } as const
      )[key];
      state = { ...state, settings: { ...state.settings, [field]: m.setting.value } };
      return send({ type: 'patch', patch: { settings: state.settings } });
    }
    case 'setModel': {
      const sel = m.providerId && m.modelId ? { providerId: m.providerId, modelId: m.modelId } : null;
      state =
        m.role === 'plan'
          ? { ...state, planModel: sel }
          : m.role === 'title'
            ? { ...state, titleModel: sel }
            : { ...state, selected: sel ?? state.selected };
      return send({
        type: 'patch',
        patch: { selected: state.selected, planModel: state.planModel, titleModel: state.titleModel },
      });
    }
    case 'openConfigFile':
    case 'reloadConfigFile':
      return send({
        type: 'notice',
        id: `n-${Date.now()}`,
        level: 'info',
        message: `${m.type === 'openConfigFile' ? 'Opens' : 'Reloads'} ~/.sovran/config.yaml in VS Code.`,
      });
    case 'stopConfigFile':
    case 'useConfigFile': {
      const stop = m.type === 'stopConfigFile';
      state = {
        ...state,
        configFile: {
          ...state.configFile,
          state: stop ? 'ignored' : 'ok',
          providers: stop ? 0 : state.providers.length,
        },
      };
      return send({ type: 'patch', patch: { configFile: state.configFile } });
    }
    case 'saveProvider': {
      if (!m.requestId) return;
      const id = m.provider.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'provider';
      const view = {
        id,
        name: m.provider.name,
        baseUrl: m.provider.baseUrl,
        authType: m.provider.authType,
        hasKey: m.provider.authType !== 'none',
        models: [],
      };
      state = { ...state, providers: [...state.providers.filter((p) => p.id !== id), view] };
      send({ type: 'patch', patch: { providers: state.providers } });
      send({ type: 'providerSaved', requestId: m.requestId, providerId: id });
      const models = [
        'qwen2.5-coder:14b',
        'qwen2.5-coder:32b',
        'devstral:24b',
        'llama3.1:8b',
        'deepseek-r1:14b',
      ];
      return setTimeout(
        () =>
          send({
            type: 'providerTest',
            requestId: m.requestId!,
            providerId: id,
            result: {
              ok: true,
              latencyMs: 38,
              models,
              message: `Connected · ${models.length} models available`,
            },
          }),
        600,
      );
    }
    case 'addModels': {
      state = {
        ...state,
        providers: state.providers.map((p) =>
          p.id === m.providerId
            ? { ...p, models: m.modelIds.map((x) => ({ id: x, toolMode: 'auto' as const })) }
            : p,
        ),
        selected: m.select ? { providerId: m.providerId, modelId: m.select } : state.selected,
      };
      return send({ type: 'patch', patch: { providers: state.providers, selected: state.selected } });
    }
    case 'setView':
      state = { ...state, view: m.view };
      return send({ type: 'patch', patch: { view: m.view } });
    case 'setIncludeEditor':
      state = { ...state, context: { ...state.context, includeEditor: m.value } };
      return send({ type: 'patch', patch: { context: state.context } });
    case 'testProvider':
      return setTimeout(
        () =>
          send({
            type: 'providerTest',
            requestId: m.requestId,
            providerId: m.providerId,
            result: {
              ok: true,
              latencyMs: 42,
              models: ['qwen2.5-coder:14b', 'llama3.1:8b'],
              message: 'Connected · 2 models available',
            },
          }),
        400,
      );
    case 'approval':
      if (m.allowTool)
        send({
          type: 'notice',
          id: `n-${Date.now()}`,
          level: 'info',
          message: 'create_issue of GitHub now runs without asking. Change it in Settings → Tools.',
        });
      return send({ type: 'patch', patch: { approvals: [], run: null } });
    case 'saveMcpServer': {
      const v = m.server;
      const id =
        v.id ??
        (v.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '') ||
          'server');
      const old = state.mcp.servers.find((s) => s.id === id);
      const view: McpServerView = {
        id,
        name: v.name,
        enabled: old?.enabled ?? true,
        transport: v.transport,
        command: v.command,
        args: v.args,
        env: v.env,
        cwd: v.cwd,
        url: v.url,
        headers: v.headers,
        auth: v.auth,
        hasToken: !!v.token || (old?.hasToken ?? false),
        insecure: false,
        timeoutSeconds: v.timeoutSeconds ?? 60,
        status: 'stopped',
        tools: old?.tools ?? [],
        toolTokens: old?.toolTokens ?? 0,
      };
      patchMcp(old ? state.mcp.servers.map((s) => (s.id === id ? view : s)) : [...state.mcp.servers, view]);
      return connect(id);
    }
    case 'deleteMcpServer':
      return patchMcp(state.mcp.servers.filter((s) => s.id !== m.id));
    case 'setMcpServerEnabled':
      updateServer(m.id, (s) => ({
        ...s,
        enabled: m.enabled,
        status: m.enabled ? 'stopped' : 'disabled',
        tools: m.enabled ? s.tools : [],
        toolTokens: m.enabled ? s.toolTokens : 0,
      }));
      return m.enabled ? connect(m.id) : undefined;
    case 'restartMcpServer':
      return connect(m.id);
    case 'setMcpToolPolicy':
      return updateServer(m.id, (s) => ({
        ...s,
        tools: s.tools.map((t) => (t.name === m.tool ? { ...t, policy: m.policy } : t)),
      }));
    case 'setMcpToken':
      updateServer(m.id, (s) => ({ ...s, hasToken: true }));
      return connect(m.id);
    case 'suggestFiles': {
      const q = m.query.toLowerCase();
      const items = q
        ? ALL_FILES.filter((f) => f.toLowerCase().includes(q)).map((f) => ({
            path: f,
            label: f.split('/').pop()!,
          }))
        : [
            ...OPEN.map((f, i) => ({
              path: f,
              label: f.split('/').pop()!,
              hint: i === 0 ? ('active' as const) : ('open' as const),
            })),
            ...ALL_FILES.filter((f) => !OPEN.includes(f)).map((f) => ({
              path: f,
              label: f.split('/').pop()!,
            })),
          ];
      return send({ type: 'fileSuggestions', requestId: m.requestId, items });
    }
    case 'listDirectory': {
      const dir = m.path;
      const entries = (TREE[dir] ?? []).map((e) => ({
        ...e,
        path: dir ? `${dir}/${e.name}` : e.name,
        ...(e.name === '.env' ? { protected: true } : {}),
      }));
      return setTimeout(
        () => send({ type: 'directoryListing', requestId: m.requestId, listing: { path: dir, entries } }),
        60,
      );
    }
    case 'attachPath':
      if (state.context.attachments.some((a) => a.path === m.path)) return;
      return setAttachments([
        ...state.context.attachments,
        { id: `att${++attachmentSeq}`, path: m.path, label: m.path.split('/').pop()! },
      ]);
    case 'removeAttachment':
      return setAttachments(state.context.attachments.filter((a) => a.id !== m.id));
    case 'uploadFiles':
      return setTimeout(
        () =>
          setAttachments([
            ...state.context.attachments,
            {
              id: `att${++attachmentSeq}`,
              path: '~/Downloads/api-spec.md',
              label: 'api-spec.md',
              external: true,
            },
          ]),
        300,
      );
    default:
      // eslint-disable-next-line no-console -- development harness only
      console.info('[mock host] received', m);
  }
});
