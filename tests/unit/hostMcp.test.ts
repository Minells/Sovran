/**
 * MCP through the real controller and host: settings in, Settings view out, a model that calls an MCP tool, the
 * approval card with "Always allow", tokens kept out of every message to the webview, and Restricted Mode. The MCP
 * server is the SDK's own, connected in memory; a real HTTP server plays the model.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState, HostMessage } from '../../src/shared/protocol';
import { MemoryWorkspace } from '../fixtures/fakes';
import { MemoryTransports, notesServer, until } from '../fixtures/mcp';
import { MockOpenAIServer, sse } from '../fixtures/mockOpenAIServer';

const h = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  trusted: true,
  warningAnswer: undefined as string | undefined,
  inputAnswer: undefined as string | undefined,
  configListeners: [] as Array<(e: { affectsConfiguration: (k: string) => boolean }) => unknown>,
  trustListeners: [] as Array<() => unknown>,
}));

vi.mock('vscode', async () => {
  const p = await import('node:path');
  const root = p.resolve('/ws');
  const Uri = { file: (f: string) => ({ scheme: 'file', fsPath: f, path: f }) };
  const inside = (f: string) => f === root || f.startsWith(root + p.sep);
  const folder = { uri: Uri.file(root), name: 'ws', index: 0 };
  const event = () => () => ({ dispose() {} });
  return {
    Uri,
    ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2 },
    ConfigurationTarget: { Global: 1 },
    workspace: {
      name: 'ws',
      get isTrusted() {
        return h.trusted;
      },
      workspaceFolders: [folder],
      getWorkspaceFolder: (uri: { fsPath: string }) => (inside(uri.fsPath) ? folder : undefined),
      asRelativePath: (target: string | { fsPath: string }) => {
        const abs = typeof target === 'string' ? target : target.fsPath;
        return inside(abs) ? p.relative(root, abs).split(p.sep).join('/') : abs;
      },
      getConfiguration: (section: string) => ({
        get: <T>(key: string, fallback?: T) =>
          `${section}.${key}` in h.config ? (h.config[`${section}.${key}`] as T) : fallback,
        inspect: (key: string) => ({ globalValue: h.config[`${section}.${key}`] }),
        update: async (key: string, value: unknown) => {
          const full = `${section}.${key}`;
          if (value === undefined) delete h.config[full];
          else h.config[full] = structuredClone(value);
          for (const l of h.configListeners)
            await l({ affectsConfiguration: (k: string) => full === k || full.startsWith(`${k}.`) });
        },
      }),
      onDidGrantWorkspaceTrust: (l: () => unknown) => {
        h.trustListeners.push(l);
        return { dispose() {} };
      },
      onDidChangeWorkspaceFolders: event(),
      onDidChangeConfiguration: (l: (e: { affectsConfiguration: (k: string) => boolean }) => unknown) => {
        h.configListeners.push(l);
        return { dispose() {} };
      },
    },
    window: {
      activeTextEditor: undefined,
      visibleTextEditors: [],
      onDidChangeActiveTextEditor: event(),
      onDidChangeTextEditorSelection: event(),
      showInformationMessage: async () => undefined,
      showWarningMessage: async () => h.warningAnswer,
      showInputBox: async () => h.inputAnswer,
    },
    commands: { executeCommand: async () => undefined },
  };
});

const { SovranController } = await import('../../src/extension/SovranController');
const { McpHost } = await import('../../src/extension/mcpHost');
const { McpSecrets } = await import('../../src/extension/services');
const { MemorySessionRepository } = await import('../../src/extension/adapters/FsSessionRepository');
const { MemoryImageStore } = await import('../../src/extension/adapters/FsImageStore');
const { mergeCommands } = await import('../../src/core/commands/slashCommands');

const model = new MockOpenAIServer();
const delta = (d: unknown, finish: string | null = null) => ({
  choices: [{ index: 0, delta: d, finish_reason: finish }],
});

beforeAll(async () => {
  await model.start();
  // Asks for the welcome note, then answers with what the tool returned.
  model.handler = (req, res) => {
    if (req.url.endsWith('/models'))
      return res
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ data: [{ id: 'm' }] }));
    const messages = (req.body?.messages ?? []) as Array<{ role: string; content: string }>;
    const last = messages.at(-1);
    if (!last) return res.writeHead(404).end();
    if (last.role === 'tool')
      return sse(res, [delta({ content: `The note says: ${last.content}` }), delta({}, 'stop')]);
    const call = {
      index: 0,
      id: `call-${messages.length}`,
      type: 'function',
      function: { name: 'mcp__notes__read_note', arguments: '{"name":"welcome"}' },
    };
    return sse(res, [delta({ tool_calls: [call] }, 'tool_calls')]);
  };
});
afterAll(() => model.stop());

type Controller = InstanceType<typeof SovranController>;
let controller: Controller;
let mcp: InstanceType<typeof McpHost>;
let sidebar: HostMessage[];
let notices: string[];
let stored: Map<string, string>;

function latest<K extends keyof AppState>(key: K): AppState[K] | undefined {
  for (let i = sidebar.length - 1; i >= 0; i--) {
    const m = sidebar[i]!;
    if (m.type === 'state') return m.state[key];
    if (m.type === 'patch' && key in m.patch) return m.patch[key] as AppState[K];
  }
  return undefined;
}
const mcpView = () => latest('mcp')!;
const servers = () => h.config['sovran.mcp.servers'] as Array<Record<string, unknown>>;
const toolMessages = () => (latest('session')?.messages ?? []).filter((m) => m.role === 'tool');

beforeEach(async () => {
  h.trusted = true;
  h.warningAnswer = undefined;
  h.inputAnswer = undefined;
  h.configListeners = [];
  h.trustListeners = [];
  h.config = {
    'sovran.providers': [
      {
        id: 'mock',
        name: 'Mock',
        baseUrl: model.baseUrl,
        auth: { type: 'none' },
        models: [{ id: 'm', toolMode: 'native' }],
      },
    ],
    'sovran.defaultModel': 'mock/m',
    'sovran.sessions.generateTitles': false,
    'sovran.configFile.enabled': false,
    'sovran.terminal.mirrorToTerminal': false,
    'sovran.mcp.servers': [{ id: 'notes', name: 'Notes', command: 'node' }],
  };
  sidebar = [];
  notices = [];
  stored = new Map();
  const storage = {
    get: async (k: string) => stored.get(k),
    store: async (k: string, v: string) => void stored.set(k, v),
    delete: async (k: string) => void stored.delete(k),
  };
  const logger = { debug() {}, info() {}, warn() {}, error() {}, show() {}, addSecret() {}, dispose() {} };
  const transports = new MemoryTransports({ notes: notesServer, docs: notesServer });
  const ref: { controller?: Controller } = {};
  mcp = new McpHost({
    secrets: new McpSecrets(storage as never),
    logger,
    version: '0.0.0-test',
    notify: (_l, m) => notices.push(m),
    transports,
  });
  await mcp.init();
  const noop = () => ({ dispose() {} });
  controller = new SovranController({
    logger,
    secrets: { get: async () => undefined, has: async () => false },
    diff: { register() {}, show: async () => undefined, release: async () => undefined },
    workspace: new MemoryWorkspace({}),
    process: {},
    capabilities: { get: () => undefined, set() {}, clear() {} },
    statusBar: { update() {} },
    repo: new MemorySessionRepository(),
    checkpoints: {
      save: async () => undefined,
      load: async () => undefined,
      deleteForSession: async () => undefined,
    },
    images: new MemoryImageStore(),
    fileIndex: { suggest: async () => [] },
    commandLoader: { load: async () => mergeCommands([]), onDidChange: noop },
    configFile: {
      displayPath: '~/.sovran/config.yaml',
      read: async () => ({ kind: 'missing' }),
      setProblems() {},
      setSynced: async () => undefined,
      onDidChange: noop,
    },
    mcp,
    reveal: async () => undefined,
  } as never);
  ref.controller = controller;
  controller.attach((m) => sidebar.push(m));
  await controller.init();
  await controller.handle({ type: 'ready' });
  await until(() => mcpView().servers[0]?.status === 'connected');
});

afterEach(async () => {
  controller.dispose();
  await mcp.dispose();
});

describe('MCP in the host', () => {
  it('shows each server with its tools in the Settings view', () => {
    const view = mcpView();
    expect(view.active).toBe(true);
    expect(view.servers[0]).toMatchObject({
      id: 'notes',
      name: 'Notes',
      transport: 'stdio',
      command: 'node',
      status: 'connected',
      server: { name: 'notes', version: '1.2.0' },
      hasToken: false,
      insecure: false,
      timeoutSeconds: 60,
    });
    expect(view.servers[0]!.tools.map((t) => [t.name, t.policy, t.hints])).toEqual([
      ['read_note', 'ask', ['read-only']],
      ['delete_note', 'ask', ['destructive']],
      ['broken', 'ask', []],
    ]);
    expect(view.servers[0]!.toolTokens).toBeGreaterThan(30);
  });

  it('asks before the tool runs, and "Always allow" stops asking for that tool only', async () => {
    // The run waits for the approval, so the send is not awaited here.
    const sent = controller.handle({ type: 'send', text: 'read my note' });
    await until(() => (latest('approvals') ?? []).length === 1);
    const approval = latest('approvals')![0]!;
    expect(approval).toMatchObject({
      toolName: 'mcp__notes__read_note',
      title: 'Read note · Notes',
      detail: {
        kind: 'mcp',
        server: 'Notes',
        tool: 'read_note',
        title: 'Read note',
        arguments: '{\n  "name": "welcome"\n}',
        hints: ['read-only'],
      },
      reason: expect.stringContaining('in every approval mode'),
    });
    await controller.handle({ type: 'approval', id: approval.id, approved: true, allowTool: true });
    await sent;
    expect(toolMessages()[0]).toMatchObject({
      status: 'success',
      content: 'Hello from MCP',
      summary: 'Read note · Notes',
    });
    expect(servers()[0]).toMatchObject({ allowedTools: ['read_note'] });
    expect(notices).toContain('read_note of Notes now runs without asking. Change it in Settings → MCP.');
    expect(mcpView().servers[0]!.tools[0]!.policy).toBe('allow');

    await controller.handle({ type: 'send', text: 'again' });
    await until(() => latest('run') === null && toolMessages().length === 2);
    expect(toolMessages()[1]).toMatchObject({
      status: 'success',
      autoApproved: 'Ran without asking (you allowed this tool of Notes).',
    });
  });

  it('turns a tool off for the model, and offers it again', async () => {
    await controller.handle({ type: 'setMcpToolPolicy', id: 'notes', tool: 'read_note', policy: 'off' });
    expect(servers()[0]).toMatchObject({ disabledTools: ['read_note'] });
    expect(mcpView().servers[0]!.tools[0]!.policy).toBe('off');
    await controller.handle({ type: 'send', text: 'read my note' });
    await until(() => latest('run') === null);
    const chat = model.requests.filter((r) => r.body?.tools);
    const offered = (chat.at(-1)!.body!.tools as Array<{ function: { name: string } }>).map(
      (t) => t.function.name,
    );
    expect(offered).toContain('mcp__notes__delete_note');
    expect(offered).not.toContain('mcp__notes__read_note');
    expect(toolMessages()[0]).toMatchObject({
      status: 'error',
      content: expect.stringContaining('Unknown tool "mcp__notes__read_note"'),
    });

    await controller.handle({ type: 'setMcpToolPolicy', id: 'notes', tool: 'read_note', policy: 'ask' });
    expect(servers()[0]!.disabledTools).toBeUndefined();
  });

  it('adds a server with its token in Secret Storage, never in settings or in a message to the webview', async () => {
    const token = 'tok-ABCDEF-123456';
    await controller.handle({
      type: 'saveMcpServer',
      server: {
        name: 'Docs',
        transport: 'http',
        url: 'https://docs.example/mcp',
        headers: { 'X-Team': 'core' },
        auth: { type: 'bearer' },
        token: `Bearer ${token}`,
      },
    });
    expect(servers()[1]).toEqual({
      id: 'docs',
      name: 'Docs',
      url: 'https://docs.example/mcp',
      headers: { 'X-Team': 'core' },
      auth: { type: 'bearer' },
    });
    expect(stored.get('sovran.mcp.docs.token')).toBe(token);
    await until(() => mcpView().servers[1]?.status === 'connected');
    expect(mcpView().servers[1]).toMatchObject({
      transport: 'http',
      hasToken: true,
      url: 'https://docs.example/mcp',
    });
    expect(JSON.stringify(sidebar)).not.toContain(token);
    expect(JSON.stringify(h.config)).not.toContain(token);

    // Editing keeps the token and the tool choices; a new name does not change the id.
    await controller.handle({ type: 'setMcpToolPolicy', id: 'docs', tool: 'broken', policy: 'off' });
    await controller.handle({
      type: 'saveMcpServer',
      server: {
        id: 'docs',
        name: 'Team docs',
        transport: 'http',
        url: 'https://docs.example/mcp',
        auth: { type: 'bearer' },
      },
    });
    expect(servers()[1]).toMatchObject({ id: 'docs', name: 'Team docs', disabledTools: ['broken'] });
    expect(servers()[1]!.headers).toBeUndefined();
    expect(stored.get('sovran.mcp.docs.token')).toBe(token);
  });

  it('says when a server still needs its token, and stores one from the password box', async () => {
    await controller.handle({
      type: 'saveMcpServer',
      server: {
        name: 'Docs',
        transport: 'stdio',
        command: 'docs-mcp',
        auth: { type: 'env', envName: 'DOCS_TOKEN' },
      },
    });
    expect(notices.at(-1)).toContain('Docs needs a token before it can connect');
    h.inputAnswer = '  secret-value-1  ';
    await controller.handle({ type: 'setMcpToken', id: 'docs' });
    expect(stored.get('sovran.mcp.docs.token')).toBe('secret-value-1');
    expect(mcpView().servers[1]!.hasToken).toBe(true);
  });

  it('removes a server and its token only after confirmation', async () => {
    stored.set('sovran.mcp.notes.token', 'old-token-123');
    await controller.handle({ type: 'deleteMcpServer', id: 'notes' });
    expect(servers()).toHaveLength(1);
    h.warningAnswer = 'Remove';
    await controller.handle({ type: 'deleteMcpServer', id: 'notes' });
    expect(h.config['sovran.mcp.servers']).toBeUndefined();
    expect(stored.has('sovran.mcp.notes.token')).toBe(false);
    expect(mcpView().servers).toEqual([]);
  });

  it('keeps a hand-written entry it cannot read when a tool changes in Settings', async () => {
    const typo = { id: 'broken', comand: 'oops' };
    h.config['sovran.mcp.servers'] = [...servers(), typo];
    await controller.handle({ type: 'setMcpToolPolicy', id: 'notes', tool: 'broken', policy: 'off' });
    expect(servers()).toEqual([
      { id: 'notes', name: 'Notes', command: 'node', disabledTools: ['broken'] },
      typo,
    ]);
  });

  it("masks a server's token if a tool result ever contains it", async () => {
    // The test server's note happens to be the stored token: the model and the chat file must never see it.
    h.config['sovran.mcp.servers'] = [
      {
        id: 'notes',
        name: 'Notes',
        command: 'node',
        auth: { type: 'env', envName: 'NOTES_TOKEN' },
        allowedTools: ['read_note'],
      },
    ];
    stored.set('sovran.mcp.notes.token', 'Hello from MCP');
    for (const l of h.configListeners)
      await l({ affectsConfiguration: (k: string) => k === 'sovran.mcp.servers' });
    await until(() => mcpView().servers[0]?.status === 'connected' && mcpView().servers[0]!.hasToken);
    await controller.handle({ type: 'send', text: 'read my note' });
    expect(toolMessages()[0]).toMatchObject({ status: 'success', content: '••••' });
    expect(JSON.stringify(model.requests.at(-1)?.body)).not.toContain('Hello from MCP');
  });

  it('turns a server off and on', async () => {
    await controller.handle({ type: 'setMcpServerEnabled', id: 'notes', enabled: false });
    expect(servers()[0]).toMatchObject({ enabled: false });
    expect(mcpView().servers[0]).toMatchObject({ status: 'disabled', tools: [] });
    await controller.handle({ type: 'setMcpServerEnabled', id: 'notes', enabled: true });
    await until(() => mcpView().servers[0]?.status === 'connected');
  });
});

describe('MCP in Restricted Mode', () => {
  it('starts no server until the workspace is trusted', async () => {
    await mcp.dispose();
    h.trusted = false;
    const transports = new MemoryTransports({ notes: notesServer });
    const logger = { debug() {}, info() {}, warn() {}, error() {}, show() {}, addSecret() {}, dispose() {} };
    mcp = new McpHost({
      secrets: new McpSecrets({ get: async () => undefined } as never),
      logger,
      version: '0',
      notify: () => {},
      transports,
    });
    await mcp.init();
    expect(mcp.view()).toMatchObject({ active: false, servers: [{ id: 'notes', status: 'stopped' }] });
    expect(transports.created.size).toBe(0);
    h.trusted = true;
    for (const l of h.trustListeners) await l();
    await until(() => mcp.view().servers[0]?.status === 'connected');
  });
});
