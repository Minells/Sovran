/**
 * The controller with several surfaces (the Activity Bar view and chats in editor tabs): each surface shows its own
 * chat, chats run in parallel, and every message reaches only the surface it belongs to. A real HTTP server plays the
 * model; the VS Code API is a small in-memory stand-in.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState, HostMessage } from '../../src/shared/protocol';
import { MemoryWorkspace } from '../fixtures/fakes';
import { MockOpenAIServer, sse } from '../fixtures/mockOpenAIServer';

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
        get: <T>(key: string, fallback?: T) => (`${section}.${key}` in h.config ? (h.config[`${section}.${key}`] as T) : fallback),
        inspect: (key: string) => ({ globalValue: h.config[`${section}.${key}`] }),
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
const { mergeCommands } = await import('../../src/core/commands/slashCommands');
type Controller = InstanceType<typeof SovranController>;
type Panel = { reveal: ReturnType<typeof vi.fn>; setTitle: ReturnType<typeof vi.fn>; active: boolean; visible: boolean; viewColumn: number };

const server = new MockOpenAIServer();
const delta = (d: unknown, finish: string | null = null) => ({ choices: [{ index: 0, delta: d, finish_reason: finish }] });

beforeAll(async () => {
  await server.start();
  // The model edits the file named in the user's message, then answers "done" once it sees the tool result.
  server.handler = (req, res) => {
    if (req.url.endsWith('/models')) return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'm' }] }));
    const messages = (req.body?.messages ?? []) as Array<{ role: string; content: string }>;
    const last = messages[messages.length - 1];
    // Anything else (model-limit probes on other paths) is not a chat request.
    if (!last) return res.writeHead(404).end();
    if (last.role === 'tool') return sse(res, [delta({ content: 'done' }), delta({}, 'stop')]);
    const file = /edit (\w+)/.exec(last.content)?.[1] ?? 'x';
    const args = JSON.stringify({ path: `${file}.txt`, old_string: 'one', new_string: 'ONE' });
    return sse(res, [delta({ tool_calls: [{ index: 0, id: `call-${file}`, type: 'function', function: { name: 'edit_file', arguments: args } }] }, 'tool_calls')]);
  };
});
afterAll(() => server.stop());

let workspace: MemoryWorkspace;
let controller: Controller;
let sidebar: HostMessage[];
let tabs: Record<string, { messages: HostMessage[]; panel: Panel }>;
let revealSidebar: ReturnType<typeof vi.fn>;
let opened: Array<string | undefined>;

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
const chatsIn = (messages: HostMessage[]) => new Set(messages.flatMap((m) => ('sessionId' in m ? [m.sessionId] : [])));

let repo: InstanceType<typeof MemorySessionRepository>;

beforeEach(async () => {
  h.info = [];
  h.warningAnswer = undefined;
  h.config = {
    'sovran.providers': [{ id: 'mock', name: 'Mock', baseUrl: server.baseUrl, auth: { type: 'none' }, models: [{ id: 'm', toolMode: 'native' }] }],
    'sovran.defaultModel': 'mock/m',
    'sovran.sessions.generateTitles': false,
    'sovran.configFile.enabled': false,
    'sovran.terminal.mirrorToTerminal': false,
  };
  workspace = new MemoryWorkspace({ 'a.txt': 'one\n', 'b.txt': 'one\n' });
  sidebar = [];
  tabs = {};
  opened = [];
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
    checkpoints: { save: async () => undefined, load: async () => undefined, deleteForSession: async () => undefined },
    fileIndex: { suggest: async () => [] },
    commandLoader: { load: async () => mergeCommands([]), onDidChange: noop },
    configFile: { displayPath: '~/.sovran/config.yaml', read: async () => ({ kind: 'missing' }), setProblems() {}, setSynced: async () => undefined, onDidChange: noop },
    reveal: revealSidebar,
    openPanel: async (sessionId?: string) => {
      opened.push(sessionId);
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

describe('surfaces', () => {
  it('gives every surface its own chat and answers requests where they came from', async () => {
    await controller.openInEditor();
    const tab = tabs.tab1!;
    expect(opened).toEqual([undefined]);
    expect(latest(sidebar, 'surface')).toBe('sidebar');
    expect(latest(tab.messages, 'surface')).toBe('panel');
    expect(sessionOf(tab.messages)).not.toBe(sessionOf(sidebar));

    sidebar.length = 0;
    await controller.handle({ type: 'suggestFiles', requestId: 's1', query: '' }, 'tab1');
    await controller.handle({ type: 'setIncludeEditor', value: false }, 'tab1');
    expect(tab.messages.some((m) => m.type === 'fileSuggestions' && m.requestId === 's1')).toBe(true);
    expect(latest(tab.messages, 'context')?.includeEditor).toBe(false);
    // Request ids are only unique within one webview, and the composer context is per surface.
    expect(sidebar.filter((m) => m.type === 'fileSuggestions' || (m.type === 'patch' && 'context' in m.patch))).toEqual([]);
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
    expect(latest(sidebar, 'liveSessions')).toEqual([{ id: tabChat, inEditor: true, running: false, needsApproval: false }]);
  });

  it('refuses a second message in a chat that is still working', async () => {
    const run = controller.handle({ type: 'send', text: 'edit a' });
    await vi.waitFor(() => expect(approvalsOf(sidebar)).toHaveLength(1));
    await controller.handle({ type: 'send', text: 'edit b' });
    expect(sidebar).toContainEqual(expect.objectContaining({ type: 'notice', message: expect.stringMatching(/still working in this chat/) }));
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
    expect(latest(sidebar, 'liveSessions')).toEqual([expect.objectContaining({ inEditor: false, running: true, needsApproval: true })]);
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
