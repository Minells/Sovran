/**
 * The controller with several surfaces (the Activity Bar view and chats in editor tabs): each surface shows its own
 * chat, chats run in parallel, and every message reaches only the surface it belongs to. A real HTTP server plays the
 * model; the VS Code API is a small in-memory stand-in.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState, HostMessage } from '../../src/shared/protocol';
import { MemoryWorkspace } from '../fixtures/fakes';
import { MockOpenAIServer, sse } from '../fixtures/mockOpenAIServer';
import { makePng } from '../fixtures/images';

const h = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  info: [] as string[],
  warningAnswer: undefined as string | undefined,
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
    ConfigurationTarget: { Global: 1 },
    ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2 },
    workspace: {
      name: 'ws',
      isTrusted: true,
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
          h.config[`${section}.${key}`] = value;
        },
      }),
      onDidGrantWorkspaceTrust: event(),
      onDidChangeWorkspaceFolders: event(),
      onDidChangeConfiguration: event(),
    },
    window: {
      activeTextEditor: undefined,
      visibleTextEditors: [],
      onDidChangeActiveTextEditor: event(),
      onDidChangeTextEditorSelection: event(),
      showInformationMessage: async (message: string) => {
        h.info.push(message);
        return undefined;
      },
      showWarningMessage: async () => h.warningAnswer,
    },
    commands: { executeCommand: async () => undefined },
  };
});

const { SovranController } = await import('../../src/extension/SovranController');
const { MemorySessionRepository } = await import('../../src/extension/adapters/FsSessionRepository');
const { MemoryImageStore } = await import('../../src/extension/adapters/FsImageStore');
const { mergeCommands } = await import('../../src/core/commands/slashCommands');
type Controller = InstanceType<typeof SovranController>;
type Panel = {
  reveal: ReturnType<typeof vi.fn>;
  setTitle: ReturnType<typeof vi.fn>;
  active: boolean;
  visible: boolean;
  viewColumn: number;
};

const server = new MockOpenAIServer();
const delta = (d: unknown, finish: string | null = null) => ({
  choices: [{ index: 0, delta: d, finish_reason: finish }],
});

beforeAll(async () => {
  await server.start();
  // The model edits the file named in the user's message, then answers "done" once it sees the tool result.
  server.handler = (req, res) => {
    if (req.url.endsWith('/models'))
      return res
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ data: [{ id: 'm' }] }));
    const messages = (req.body?.messages ?? []) as Array<{ role: string; content: string }>;
    const last = messages[messages.length - 1];
    // Anything else (model-limit probes on other paths) is not a chat request.
    if (!last) return res.writeHead(404).end();
    if (last.role === 'tool') return sse(res, [delta({ content: 'done' }), delta({}, 'stop')]);
    const file = /edit (\w+)/.exec(last.content)?.[1] ?? 'x';
    const args = JSON.stringify({ path: `${file}.txt`, old_string: 'one', new_string: 'ONE' });
    return sse(res, [
      delta(
        {
          tool_calls: [
            {
              index: 0,
              id: `call-${file}`,
              type: 'function',
              function: { name: 'edit_file', arguments: args },
            },
          ],
        },
        'tool_calls',
      ),
    ]);
  };
});
afterAll(() => server.stop());

let workspace: MemoryWorkspace;
let controller: Controller;
let sidebar: HostMessage[];
let tabs: Record<string, { messages: HostMessage[]; panel: Panel }>;
let revealSidebar: ReturnType<typeof vi.fn>;
let opened: Array<string | undefined>;
/** The title each tab was created with: it must be the chat's from the start, never a placeholder. */
let openedTitles: string[];

/** The latest value of a state field a surface received, from its snapshots and patches. */
function latest<K extends keyof AppState>(messages: HostMessage[], key: K): AppState[K] | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.type === 'state') return m.state[key];
    if (m.type === 'patch' && key in m.patch) return m.patch[key] as AppState[K];
  }
  return undefined;
}
const sessionOf = (messages: HostMessage[]) => latest(messages, 'session')?.id;
const approvalsOf = (messages: HostMessage[]) => latest(messages, 'approvals') ?? [];
/** Every chat a surface was sent messages about. */
const chatsIn = (messages: HostMessage[]) =>
  new Set(messages.flatMap((m) => ('sessionId' in m ? [m.sessionId] : [])));

let repo: InstanceType<typeof MemorySessionRepository>;

beforeEach(async () => {
  h.info = [];
  h.warningAnswer = undefined;
  h.config = {
    'sovran.providers': [
      {
        id: 'mock',
        name: 'Mock',
        baseUrl: server.baseUrl,
        auth: { type: 'none' },
        models: [{ id: 'm', toolMode: 'native' }, { id: 'text-only', toolMode: 'none' }],
      },
    ],
    'sovran.defaultModel': 'mock/m',
    'sovran.sessions.generateTitles': false,
    'sovran.configFile.enabled': false,
    'sovran.terminal.mirrorToTerminal': false,
  };
  workspace = new MemoryWorkspace({ 'a.txt': 'one\n', 'b.txt': 'one\n' });
  sidebar = [];
  tabs = {};
  opened = [];
  openedTitles = [];
  revealSidebar = vi.fn(async () => undefined);
  let seq = 0;
  const noop = () => ({ dispose() {} });
  controller = new SovranController({
    logger: { debug() {}, info() {}, warn() {}, error() {}, show() {}, addSecret() {}, dispose() {} },
    secrets: { get: async () => undefined, has: async () => false },
    diff: { register() {}, show: async () => undefined, release: async () => undefined },
    workspace,
    process: {},
    capabilities: { get: () => undefined, set() {}, clear() {} },
    statusBar: { update() {} },
    repo: (repo = new MemorySessionRepository()),
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
    reveal: revealSidebar,
    openPanel: async (sessionId: string | undefined, title: string) => {
      opened.push(sessionId);
      openedTitles.push(title);
      const id = `tab${++seq}`;
      const panel: Panel = { reveal: vi.fn(), setTitle: vi.fn(), active: true, visible: true, viewColumn: 2 };
      tabs[id] = { messages: [], panel };
      await controller.addPanel(id, (m) => tabs[id]!.messages.push(m), panel as never, sessionId);
      await controller.handle({ type: 'ready' }, id);
    },
  } as never);
  controller.attach((m) => sidebar.push(m));
  await controller.init();
  await controller.handle({ type: 'ready' });
});

afterEach(() => controller.dispose());

it('keeps tool groups local to each chat and rejects a stale session intent', async () => {
  const sidebarId = sessionOf(sidebar)!;
  await controller.openInEditor();
  const tabId = sessionOf(tabs.tab1!.messages)!;
  await controller.handle({ type: 'setToolGroup', sessionId: tabId, group: 'git', selected: false }, 'tab1');
  expect(latest(tabs.tab1!.messages, 'toolGroups')?.find((group) => group.id === 'git')?.selected).toBe(
    false,
  );
  expect(latest(sidebar, 'toolGroups')?.find((group) => group.id === 'git')?.selected).toBe(true);
  await controller.handle(
    { type: 'setToolGroup', sessionId: sidebarId, group: 'git', selected: false },
    'tab1',
  );
  expect(controller.snapshot().toolGroups?.find((group) => group.id === 'git')?.selected).toBe(true);
});

it('projects tool availability for the effective model and preserves exclusions when switching mode', async () => {
  const sessionId = sessionOf(sidebar)!;
  await controller.handle({ type: 'setToolGroup', sessionId, group: 'editing', selected: false });
  await controller.handle({ type: 'setModel', role: 'plan', providerId: 'mock', modelId: 'text-only' });
  expect(latest(sidebar, 'toolAvailability')).toBe('available');
  expect(latest(sidebar, 'toolGroups')?.some((group) => group.availableTools > 0)).toBe(true);

  controller.setMode('plan');
  expect(latest(sidebar, 'toolAvailability')).toBe('model-disabled');
  expect(latest(sidebar, 'toolGroups')?.every((group) => !group.availableTools && !group.definitionTokens)).toBe(true);

  controller.setMode('act');
  expect(latest(sidebar, 'toolAvailability')).toBe('available');
  expect(latest(sidebar, 'toolGroups')?.find((group) => group.id === 'editing')?.selected).toBe(false);
});

it('blocks an approved edit after the host excludes its group and persists the choice', async () => {
  const sessionId = sessionOf(sidebar)!;
  const running = controller.handle({ type: 'send', text: 'edit a' });
  await vi.waitFor(() => expect(approvalsOf(sidebar)).toHaveLength(1));
  await controller.handle({ type: 'setToolGroup', sessionId, group: 'editing', selected: false });
  await controller.handle({ type: 'approval', id: approvalsOf(sidebar)[0]!.id, approved: true });
  await running;
  expect(workspace.get('a.txt')).toBe('one\n');
  expect(
    latest(sidebar, 'session')?.messages.some(
      (message) => message.role === 'tool' && message.status === 'denied',
    ),
  ).toBe(true);
  expect((await repo.load(sessionId))?.excludedToolGroups).toEqual(['editing']);
});

describe('surfaces', () => {
  it('gives every surface its own chat and answers requests where they came from', async () => {
    await controller.openInEditor();
    const tab = tabs.tab1!;
    expect(opened).toEqual([undefined]);
    expect(openedTitles).toEqual(['New chat']);
    expect(latest(sidebar, 'surface')).toBe('sidebar');
    expect(latest(tab.messages, 'surface')).toBe('panel');
    expect(sessionOf(tab.messages)).not.toBe(sessionOf(sidebar));

    sidebar.length = 0;
    await controller.handle({ type: 'suggestFiles', requestId: 's1', query: '' }, 'tab1');
    await controller.handle({ type: 'setIncludeEditor', value: false }, 'tab1');
    expect(tab.messages.some((m) => m.type === 'fileSuggestions' && m.requestId === 's1')).toBe(true);
    expect(latest(tab.messages, 'context')?.includeEditor).toBe(false);
    // Request ids are only unique within one webview, and the composer context is per surface.
    expect(
      sidebar.filter((m) => m.type === 'fileSuggestions' || (m.type === 'patch' && 'context' in m.patch)),
    ).toEqual([]);
  });

  it('runs chats in parallel and keeps each approval, delta and result with its own surface', async () => {
    await controller.openInEditor();
    const tab = tabs.tab1!;
    const tabChat = sessionOf(tab.messages)!;
    const sideChat = sessionOf(sidebar)!;

    const runInTab = controller.handle({ type: 'send', text: 'edit a' }, 'tab1');
    await vi.waitFor(() => expect(approvalsOf(tab.messages)).toHaveLength(1));
    // A second chat starts while the first waits for its approval.
    const runInSidebar = controller.handle({ type: 'send', text: 'edit b' });
    await vi.waitFor(() => expect(approvalsOf(sidebar)).toHaveLength(1));

    const tabApproval = approvalsOf(tab.messages)[0]!;
    const sideApproval = approvalsOf(sidebar)[0]!;
    expect(tabApproval.detail).toMatchObject({ kind: 'edit', path: 'a.txt' });
    expect(sideApproval.detail).toMatchObject({ kind: 'edit', path: 'b.txt' });
    expect(latest(sidebar, 'liveSessions')).toEqual(
      expect.arrayContaining([
        { id: tabChat, inEditor: true, running: true, needsApproval: true },
        { id: sideChat, inEditor: false, running: true, needsApproval: true },
      ]),
    );

    await controller.handle({ type: 'approval', id: tabApproval.id, approved: true }, 'tab1');
    await runInTab;
    expect(workspace.get('a.txt')).toBe('ONE\n');
    expect(latest(tab.messages, 'run')).toBeNull();
    // The other chat is still waiting, untouched.
    expect(approvalsOf(sidebar)).toEqual([sideApproval]);
    expect(latest(sidebar, 'run')).not.toBeNull();

    await controller.handle({ type: 'approval', id: sideApproval.id, approved: false });
    await runInSidebar;
    expect(workspace.get('b.txt')).toBe('one\n');

    expect(chatsIn(tab.messages)).toEqual(new Set([tabChat]));
    expect(chatsIn(sidebar)).toEqual(new Set([sideChat]));
    expect(latest(sidebar, 'liveSessions')).toEqual([
      { id: tabChat, inEditor: true, running: false, needsApproval: false },
    ]);
  });

  it('refuses a second message in a chat that is still working', async () => {
    const run = controller.handle({ type: 'send', text: 'edit a' });
    await vi.waitFor(() => expect(approvalsOf(sidebar)).toHaveLength(1));
    await controller.handle({ type: 'send', text: 'edit b' });
    expect(sidebar).toContainEqual(
      expect.objectContaining({
        type: 'notice',
        message: expect.stringMatching(/still working in this chat/),
      }),
    );
    controller.cancel();
    await run;
    expect(latest(sidebar, 'run')).toBeNull();
  });

  it('moves the view chat into an editor tab, and a chat lives in one place only', async () => {
    const run = controller.handle({ type: 'send', text: 'edit a' });
    await vi.waitFor(() => expect(approvalsOf(sidebar)).toHaveLength(1));
    const chat = sessionOf(sidebar)!;
    const approval = approvalsOf(sidebar)[0]!;

    await controller.moveSidebarToEditor();
    const tab = tabs.tab1!;
    expect(opened).toEqual([chat]);
    expect(openedTitles).toEqual(['edit a']);
    expect(sessionOf(tab.messages)).toBe(chat);
    // The pending approval moves with the chat; the view starts a new chat.
    expect(approvalsOf(tab.messages)).toEqual([approval]);
    expect(sessionOf(sidebar)).not.toBe(chat);
    expect(approvalsOf(sidebar)).toEqual([]);
    expect(tab.panel.setTitle).toHaveBeenLastCalledWith('edit a');

    // Opening it from the chat list focuses its tab instead of showing it twice.
    const before = sidebar.length;
    await controller.handle({ type: 'openSession', id: chat });
    await controller.handle({ type: 'openSessionInEditor', id: chat });
    expect(tab.panel.reveal).toHaveBeenCalledTimes(2);
    expect(sidebar.slice(before).some((m) => m.type === 'state')).toBe(false);
    expect(opened).toHaveLength(1);

    // Approving from the proposal's diff editor resolves the right approval.
    await controller.decideProposal(true, { scheme: 'sovran-proposal', query: `${approval.id}:empty` });
    await run;
    expect(workspace.get('a.txt')).toBe('ONE\n');
  });

  it('opens lists and settings from an editor tab in the view', async () => {
    await controller.openInEditor();
    await controller.handle({ type: 'setView', view: 'settings' }, 'tab1');
    expect(latest(sidebar, 'view')).toBe('settings');
    expect(revealSidebar).toHaveBeenCalled();
    expect(latest(tabs.tab1!.messages, 'view')).toBe('chat');
  });

  it('asks for attention when the chat waiting for approval is not on screen, and lets the run go on after its tab closes', async () => {
    await controller.openInEditor();
    const tab = tabs.tab1!;
    tab.panel.visible = false;
    const run = controller.handle({ type: 'send', text: 'edit a' }, 'tab1');
    await vi.waitFor(() => expect(h.info).toEqual(['Sovran needs your approval: a.txt']));
    const approval = approvalsOf(tab.messages)[0]!;

    controller.removePanel('tab1');
    expect(latest(sidebar, 'liveSessions')).toEqual([
      expect.objectContaining({ inEditor: false, running: true, needsApproval: true }),
    ]);
    await controller.decideProposal(false);
    await run;
    expect(workspace.get('a.txt')).toBe('one\n');
    expect(approval.id).toBeTruthy();
  });

  it('does not save a deleted chat back while its run stops', async () => {
    await controller.openInEditor();
    const run = controller.handle({ type: 'send', text: 'edit a' }, 'tab1');
    await vi.waitFor(() => expect(approvalsOf(tabs.tab1!.messages)).toHaveLength(1));
    const chat = sessionOf(tabs.tab1!.messages)!;
    expect((await repo.list()).map((x) => x.id)).toContain(chat);

    h.warningAnswer = 'Delete';
    await controller.handle({ type: 'deleteSession', id: chat });
    await run;
    expect((await repo.list()).map((x) => x.id)).not.toContain(chat);
    // The tab that showed it starts a new chat.
    expect(sessionOf(tabs.tab1!.messages)).not.toBe(chat);
  });
});

describe('images in a chat', () => {
  type Part = { type: string; text?: string; image_url?: { url: string } };
  const userContent = (body: { messages?: Array<{ role: string; content: unknown }> }) =>
    body.messages?.filter((m) => m.role === 'user').at(-1)?.content;

  it('sends a pasted image to the model as an image part after its label, and keeps only its metadata in the chat', async () => {
    const original = server.handler;
    const bodies: Array<{ messages?: Array<{ role: string; content: unknown }> }> = [];
    server.handler = (req, res) => {
      if (!req.url.endsWith('/chat/completions')) return original(req, res);
      bodies.push(req.body as never);
      return sse(res, [delta({ content: 'A login form.' }), delta({}, 'stop')]);
    };
    try {
      const png = makePng(20, 10);
      await controller.handle({ type: 'attachImage', data: Buffer.from(png).toString('base64') });
      await controller.handle({ type: 'send', text: 'what is this?' });
      const parts = userContent(bodies[0]!) as Part[];
      expect(parts).toEqual([
        { type: 'text', text: '<image name="Pasted image 1" type="PNG image" size="20×10"/>' },
        {
          type: 'image_url',
          image_url: { url: `data:image/png;base64,${Buffer.from(png).toString('base64')}` },
        },
        { type: 'text', text: 'what is this?' },
      ]);
      // The saved chat names the image; its bytes stay in the image store.
      const saved = await repo.load(sessionOf(sidebar)!);
      const message = saved?.messages.find((m) => m.role === 'user');
      expect(message).toMatchObject({
        images: [{ name: 'Pasted image 1', source: 'pasted', mime: 'image/png', width: 20, height: 10 }],
      });
      expect(JSON.stringify(saved)).not.toContain('base64');
    } finally {
      server.handler = original;
    }
  });

  it('retries with the image names when the server refuses images', async () => {
    const original = server.handler;
    const bodies: Array<{ messages?: Array<{ role: string; content: unknown }> }> = [];
    server.handler = (req, res) => {
      if (!req.url.endsWith('/chat/completions')) return original(req, res);
      bodies.push(req.body as never);
      if (bodies.length === 1)
        return res
          .writeHead(400, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ error: { message: 'm is not a multimodal model' } }));
      return sse(res, [delta({ content: 'I cannot see it.' }), delta({}, 'stop')]);
    };
    try {
      await controller.handle({ type: 'attachImage', data: Buffer.from(makePng(4, 4)).toString('base64') });
      await controller.handle({ type: 'send', text: 'look' });
      expect(bodies).toHaveLength(2);
      expect(userContent(bodies[1]!)).toBe(
        '<image name="Pasted image 1" type="PNG image" size="4×4" note="Not sent: this model does not accept images. Say so if the answer depends on it."/>\n\nlook',
      );
      expect(
        sidebar.some(
          (m) =>
            m.type === 'notice' &&
            /m does not accept images\. Sovran sent their names instead and retried/.test(m.message),
        ),
      ).toBe(true);
    } finally {
      server.handler = original;
    }
  });
});
