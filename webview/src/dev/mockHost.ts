/**
 * DEVELOPMENT HARNESS ONLY — never bundled into the extension (guarded by import.meta.env.DEV).
 * Simulates the extension host and a VS Code theme so the UI can be built, reviewed and
 * screenshotted in a browser:  npm run dev:webview → http://localhost:5173/?scenario=conversation&theme=dark
 */
import '../../../media/sovran.css';
import type { AppState, HostMessage, SessionMessage } from '../../../src/shared/protocol';
import { onPost } from '../vscode';

const params = new URLSearchParams(location.search);
const theme = params.get('theme') === 'light' ? 'light' : 'dark';
const scenario = params.get('scenario') ?? 'conversation';

const THEMES: Record<string, Record<string, string>> = {
  dark: {
    'font-family': '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, Ubuntu, sans-serif',
    'font-size': '13px',
    'editor-font-family': 'Menlo, Monaco, Consolas, "DejaVu Sans Mono", monospace',
    'editor-font-size': '12px',
    'sideBar-background': '#181818',
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
  .join(';')}} body{max-width:${params.get('width') ?? '420'}px;height:100vh;border-right:1px solid var(--vscode-panel-border)}`;
document.head.appendChild(style);
document.body.classList.add(theme === 'light' ? 'vscode-light' : 'vscode-dark');

const now = Date.now();
const providers: AppState['providers'] = [
  {
    id: 'ollama',
    name: 'Ollama',
    baseUrl: 'http://localhost:11434/v1',
    authType: 'none',
    hasKey: false,
    source: 'settings',
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
    source: 'file',
    models: [{ id: 'coder-large', contextWindow: 131072, toolMode: 'native' }],
  },
];

/** `?config=missing|error` previews the other states of the config file card. */
const configParam = params.get('config');
const configFile: AppState['configFile'] =
  configParam === 'missing'
    ? { path: '~/.sovran/config.yaml', state: 'missing', providers: 0, problems: [] }
    : configParam === 'error'
      ? {
          path: '~/.sovran/config.yaml',
          state: 'error',
          providers: 1,
          problems: [
            { line: 7, message: 'Unknown field "base_url". Did you mean "baseUrl"?' },
            { line: 12, message: 'API keys are never read from config.yaml. Use "Set key" in Sovran: keys are kept in VS Code Secret Storage.' },
          ],
        }
      : { path: '~/.sovran/config.yaml', state: 'ok', providers: 1, problems: [] };

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
    content: 'Sessions expire too early in staging. Make the session TTL configurable and keep the current default.',
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
    display: { kind: 'list', items: ['src/auth/session.ts:4: const TTL = 3600;', 'src/auth/session.ts:31: expiresAt: now + TTL * 1000,', 'src/auth/refresh.ts:12: if (age > TTL) {'], total: 3 },
  },
  { role: 'tool', id: 'r2', toolCallId: 't2', toolName: 'read_file', createdAt: now - 53_000, status: 'success', summary: '48 lines', content: '' },
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
  { role: 'user', id: 'v0', createdAt: now - 45_000, content: 'Rename getUser to fetchUser everywhere, run the tests and push.' },
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
    role: 'tool', id: 'y1', toolCallId: 'x1', toolName: 'apply_diff', createdAt: now - 43_000, status: 'success', summary: '+3 −3', content: '',
    autoApproved: 'Applied without asking (Auto mode).',
    display: { kind: 'diff', path: 'src/users/api.ts', diff: '@@ -1,3 +1,3 @@\n-export async function getUser(id: string) {\n+export async function fetchUser(id: string) {', added: 3, removed: 3, isNew: false },
  },
  {
    role: 'tool', id: 'y2', toolCallId: 'x2', toolName: 'execute_terminal', createdAt: now - 42_000, status: 'success', summary: 'exit 0 · 4.2s', content: '',
    autoApproved: 'Ran without asking (in your allowed commands).',
    display: { kind: 'command', command: 'npm test', cwd: '.', output: 'Test Files  12 passed (12)\n     Tests  148 passed (148)', exitCode: 0, timedOut: false },
  },
  {
    role: 'assistant',
    id: 'v2',
    createdAt: now - 41_000,
    model: { providerId: 'ollama', modelId: 'qwen2.5-coder:14b' },
    content: 'All 148 tests pass. Pushing the branch.',
    toolCalls: [{ id: 'x3', name: 'execute_terminal', arguments: JSON.stringify({ command: 'git push origin main' }) }],
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

const diff = `--- a/src/auth/session.ts\n+++ b/src/auth/session.ts\n@@ -1,7 +1,7 @@\n import { randomUUID } from 'node:crypto';\n import type { User } from '../users';\n \n-const TTL = 3600;\n+const TTL = Number(process.env.SESSION_TTL ?? 3600);\n \n export interface Session {\n   id: string;`;

function baseState(): AppState {
  const messages = scenario === 'conversation' ? conversation : scenario === 'auto' ? autoConversation : scenario === 'done' ? doneConversation : [];
  const approvalParam = (['ask', 'edits', 'auto'] as const).find((m) => m === params.get('approval')) ?? 'ask';
  return {
    view: scenario === 'providers' ? 'providers' : scenario === 'history' ? 'history' : scenario === 'settings' ? 'settings' : 'chat',
    workspace: { name: 'acme-api', trusted: true, hasFolder: true },
    providers: scenario === 'onboarding' ? [] : providers,
    selected: scenario === 'onboarding' ? null : { providerId: 'ollama', modelId: 'qwen2.5-coder:14b' },
    mode: params.get('mode') === 'plan' ? 'plan' : 'act',
    approvalMode: scenario === 'auto' ? 'auto' : approvalParam,
    sessions: [
      { id: 's1', title: 'Make the session TTL configurable', createdAt: now - 60_000, updatedAt: now - 50_000, messageCount: 3 },
      { id: 's2', title: 'Explain the retry logic in http/client.ts', createdAt: now - 3_600_000 * 5, updatedAt: now - 3_600_000 * 5, messageCount: 6 },
      { id: 's3', title: 'Plan the migration to Postgres 17', createdAt: now - 86_400_000 * 1.2, updatedAt: now - 86_400_000 * 1.2, messageCount: 11 },
      { id: 's4', title: 'Add tests for the billing webhooks', createdAt: now - 86_400_000 * 4, updatedAt: now - 86_400_000 * 4, messageCount: 9 },
    ],
    session: { id: messages.length ? 's1' : 'draft', title: messages.length ? 'Make the session TTL configurable' : 'New chat', messages },
    run:
      scenario === 'conversation'
        ? { sessionId: 's1', iteration: 3, maxIterations: 25, startedAt: now - 58_000, activity: { phase: 'awaiting_approval', label: 'src/auth/session.ts', toolName: 'edit_file', callId: 't3' } }
        : scenario === 'auto'
          ? { sessionId: 's1', iteration: 4, maxIterations: 25, startedAt: now - 41_000, activity: { phase: 'awaiting_approval', label: 'git push origin main', toolName: 'execute_terminal', callId: 'x3' } }
          : null,
    approvals:
      scenario === 'conversation'
        ? [{ id: 'ap1', callId: 't3', toolName: 'edit_file', title: 'src/auth/session.ts', detail: { kind: 'edit', path: 'src/auth/session.ts', isNew: false, diff, added: 1, removed: 1 } }]
        : scenario === 'auto'
          ? [
              {
                id: 'ap2',
                callId: 'x3',
                toolName: 'execute_terminal',
                title: 'git push origin main',
                reason: 'Pushes commits to a remote repository.',
                detail: { kind: 'command', command: 'git push origin main', cwd: '.', warnings: ['Pushes commits to a remote repository.'], allowPrefix: null },
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
      defaultProtectedPaths: ['**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/id_rsa*', '**/id_ed25519*', '**/.git/**', '**/.npmrc', '**/.pypirc', '**/.netrc'],
      maxIterations: 25,
      terminalTimeoutSeconds: 120,
      mirrorToTerminal: true,
      openDiffOnProposal: true,
      includeActiveEditor: true,
      autoCompact: true,
      projectInstructions: true,
      maxToolResultChars: 20000,
      persistSessions: true,
      generateTitles: params.get('titles') === 'on',
      overriddenByWorkspace: [],
    },
    configFile: scenario === 'onboarding' ? { path: '~/.sovran/config.yaml', state: 'missing', providers: 0, problems: [] } : configFile,
  };
}

let state = baseState();
const send = (m: HostMessage) => window.postMessage(m, '*');

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
const ALL_FILES = Object.entries(TREE).flatMap(([dir, entries]) => entries.filter((e) => e.type === 'file').map((e) => (dir ? `${dir}/${e.name}` : e.name)));
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
    case 'setApprovalMode':
      state = { ...state, approvalMode: m.mode };
      return send({ type: 'patch', patch: { approvalMode: m.mode } });
    case 'updateSetting': {
      const key = m.setting.key;
      const field = ({
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
      } as const)[key];
      state = { ...state, settings: { ...state.settings, [field]: m.setting.value } };
      return send({ type: 'patch', patch: { settings: state.settings } });
    }
    case 'setModel': {
      const sel = m.providerId && m.modelId ? { providerId: m.providerId, modelId: m.modelId } : null;
      state =
        m.role === 'plan' ? { ...state, planModel: sel } : m.role === 'title' ? { ...state, titleModel: sel } : { ...state, selected: sel ?? state.selected };
      return send({ type: 'patch', patch: { selected: state.selected, planModel: state.planModel, titleModel: state.titleModel } });
    }
    case 'openConfigFile':
    case 'reloadConfigFile':
      return send({ type: 'notice', id: `n-${Date.now()}`, level: 'info', message: `${m.type === 'openConfigFile' ? 'Opens' : 'Reloads'} ~/.sovran/config.yaml in VS Code.` });
    case 'saveProvider': {
      if (!m.requestId) return;
      const id = m.provider.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'provider';
      const view = { id, name: m.provider.name, baseUrl: m.provider.baseUrl, authType: m.provider.authType, hasKey: m.provider.authType !== 'none', source: 'settings' as const, models: [] };
      state = { ...state, providers: [...state.providers.filter((p) => p.id !== id), view] };
      send({ type: 'patch', patch: { providers: state.providers } });
      send({ type: 'providerSaved', requestId: m.requestId, providerId: id });
      const models = ['qwen2.5-coder:14b', 'qwen2.5-coder:32b', 'devstral:24b', 'llama3.1:8b', 'deepseek-r1:14b'];
      return setTimeout(
        () => send({ type: 'providerTest', requestId: m.requestId!, providerId: id, result: { ok: true, latencyMs: 38, models, message: `Connected · ${models.length} models available` } }),
        600,
      );
    }
    case 'addModels': {
      state = {
        ...state,
        providers: state.providers.map((p) => (p.id === m.providerId ? { ...p, models: m.modelIds.map((x) => ({ id: x, toolMode: 'auto' as const })) } : p)),
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
        () => send({ type: 'providerTest', requestId: m.requestId, providerId: m.providerId, result: { ok: true, latencyMs: 42, models: ['qwen2.5-coder:14b', 'llama3.1:8b'], message: 'Connected · 2 models available' } }),
        400,
      );
    case 'approval':
      return send({ type: 'patch', patch: { approvals: [], run: null } });
    case 'suggestFiles': {
      const q = m.query.toLowerCase();
      const items = q
        ? ALL_FILES.filter((f) => f.toLowerCase().includes(q)).map((f) => ({ path: f, label: f.split('/').pop()! }))
        : [
            ...OPEN.map((f, i) => ({ path: f, label: f.split('/').pop()!, hint: i === 0 ? ('active' as const) : ('open' as const) })),
            ...ALL_FILES.filter((f) => !OPEN.includes(f)).map((f) => ({ path: f, label: f.split('/').pop()! })),
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
      return setTimeout(() => send({ type: 'directoryListing', requestId: m.requestId, listing: { path: dir, entries } }), 60);
    }
    case 'attachPath':
      if (state.context.attachments.some((a) => a.path === m.path)) return;
      return setAttachments([...state.context.attachments, { id: `att${++attachmentSeq}`, path: m.path, label: m.path.split('/').pop()! }]);
    case 'removeAttachment':
      return setAttachments(state.context.attachments.filter((a) => a.id !== m.id));
    case 'uploadFiles':
      return setTimeout(
        () => setAttachments([...state.context.attachments, { id: `att${++attachmentSeq}`, path: '~/Downloads/api-spec.md', label: 'api-spec.md', external: true }]),
        300,
      );
    default:
      // eslint-disable-next-line no-console -- development harness only
      console.info('[mock host] received', m);
  }
});
