import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import picomatch from 'picomatch';
import { AgentRunner } from '../core/agent/agentRunner';
import {
  CheckpointRecorder,
  planRestore,
  restoreFiles,
  type Checkpoint,
  type FileSnapshot,
} from '../core/checkpoints/checkpoints';
import { expandCommand, mergeCommands, parseSlash, type SlashCommand } from '../core/commands/slashCommands';
import { planCompaction } from '../core/context/compaction';
import {
  configFileTemplate,
  mergeProviders,
  parseConfigFile,
  sameProviders,
  updateConfigText,
  type FileConfig,
  type ModelChoiceKey,
} from '../core/config/configFile';
import type { AgentEvent } from '../core/agent/events';
import { matchesAllowList, suggestAllowPrefix } from '../core/permissions/commands';
import type { AgentMode, ApprovalMode, SessionGrants } from '../core/permissions/policy';
import { TOOL_GROUP_LABELS, normalizeExcludedGroups } from '../core/tools/groups';
import { estimateTokens } from '../core/context/contextManager';
import { isProtectedPath } from '../core/permissions/policy';
import type {
  ApprovalPort,
  ApprovalRequest,
  ApprovalResponse,
  DirEntry,
  DocumentConverterPort,
  FileStat,
  ImageStorePort,
  WorkspacePort,
  WorkspaceRoot,
} from '../core/ports';
import { capabilityKey, resolveVision, type CapabilityStore } from '../core/providers/capabilities';
import { ProviderError, errorFromException } from '../core/providers/errors';
import { OpenAICompatibleProvider } from '../core/providers/openaiCompatible';
import { normalizeApiKey, probeConnection } from '../core/providers/connection';
import type { ModelInfo, ServerLimits } from '../core/providers/limits';
import type { ModelConfig, ProviderConfig } from '../core/providers/types';
import { PathError, resolveAndVerify, resolveWorkspacePath, type ResolvedPath } from '../core/security/paths';
import { compareEntries, displayPath } from '../core/util/files';
import {
  decodeText,
  describeDocumentError,
  describeUnsupported,
  sniffFile,
  type TextEncodingName,
} from '../core/documents/detect';
import { DOCUMENT_LIMITS, DocumentError, type DocumentResult } from '../core/documents/types';
import { DocumentReader } from '../core/documents/reader';
import { IMAGE_LIMITS, imageInfo, type ImageInfo, type ImageMime } from '../core/images/images';
import { imageId } from '../core/images/imageId';
import {
  DEFAULT_TITLE,
  deriveTitle,
  messagesForModel,
  repairInterruptedSession,
  type ContextAttachment,
  type ImageAttachment,
  type Session,
  type SessionRepository,
  type SessionSummary,
  type UserMessage,
} from '../core/sessions/model';
import { generateTitle } from '../core/sessions/titles';
import { createBuiltinRegistry } from '../core/tools/builtin';
import type { WebFetchPort } from '../core/web/types';
import type {
  AppState,
  ApprovalView,
  AttachmentView,
  ConfigFileView,
  DirectoryEntryView,
  DirectoryListingView,
  EditorContextView,
  FileSuggestionView,
  HostMessage,
  LiveSessionView,
  ProviderInput,
  ProviderTestResult,
  ProviderView,
  RunView,
  SelectedModel,
  SettingUpdate,
  SurfaceKind,
  View,
  WebviewMessage,
} from '../shared/protocol';
import { endpointLocation } from '../shared/endpoints';
import { DiffPresenter } from './adapters/DiffPresenter';
import { mergeSnapshots, type FsCheckpointRepository } from './adapters/FsCheckpointRepository';
import type { CommandLoader, FileIndex } from './workspaceServices';
import type { NodeProcessRunner } from './adapters/NodeProcessRunner';
import type { VscodeWorkspace } from './adapters/VscodeWorkspace';
import {
  addAllowedCommand,
  readDefaultModel,
  readPlanModel,
  readConfigFileEnabled,
  readProviders,
  readSettings,
  readSettingsView,
  readTitleModel,
  writeConfigFileEnabled,
  writeDefaultModel,
  writeNativeToolOverride,
  writePlanModel,
  writeProviders,
  writeSetting,
  writeTitleModel,
  type HostSettings,
} from './config';
import { ConfigFileBusyError, type ConfigFileHost } from './configFileHost';
import type { McpHost } from './mcpHost';
import type { HostLogger, ProviderSecrets, SovranStatusBar } from './services';

const MAX_ATTACHMENT_CHARS = 50_000;
const MAX_EDITOR_FILE_CHARS = 12_000;
/** Larger files are refused rather than read into memory only to be truncated to MAX_ATTACHMENT_CHARS. */
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
/** Converted documents kept for the send (and for files attached again), keyed by path and checked by size and mtime. */
const DOCUMENT_CACHE_SIZE = 16;
const TOO_MANY_IMAGES = `A message can carry up to ${IMAGE_LIMITS.maxPerMessage} images. Send these first, then attach more.`;
const tooLargeImage = (shown: string) =>
  `${shown} is larger than ${IMAGE_LIMITS.maxBytes / 1024 / 1024} MB. Send a smaller copy (a crop, or JPEG instead of PNG).`;
/** What the chip shows of an image. */
const imageView = (i: ImageInfo): NonNullable<AttachmentView['image']> => ({
  mime: i.mime,
  ...(i.width && i.height ? { width: i.width, height: i.height } : {}),
});
/** Entries sent per folder to the attach menu. */
const MAX_LISTING = 500;
/** Never shown in the attach menu: version-control internals and dependency folders. */
const BROWSE_HIDDEN = new Set(['.git', '.hg', '.svn', 'node_modules']);
const DELTA_FLUSH_MS = 40;

/** The first bytes of a file, enough to tell text from binary without reading all of it. */
async function readHead(absolute: string, length = 8000): Promise<Uint8Array> {
  const handle = await fs.open(absolute, 'r');
  try {
    const buffer = new Uint8Array(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export interface ControllerDeps {
  web?: WebFetchPort;
  logger: HostLogger;
  secrets: ProviderSecrets;
  diff: DiffPresenter;
  workspace: VscodeWorkspace;
  process: NodeProcessRunner;
  capabilities: CapabilityStore;
  statusBar: SovranStatusBar;
  repo: SessionRepository;
  checkpoints: FsCheckpointRepository;
  fileIndex: FileIndex;
  commandLoader: CommandLoader;
  configFile: ConfigFileHost;
  /** Converts PDF, Office and OpenDocument attachments to Markdown, isolated from the extension host. */
  documents: DocumentConverterPort;
  /** Keeps the images sent in chats (on disk, or in memory when chats are not persisted). */
  images: ImageStorePort;
  /** MCP servers: their tools join the agent's, and the Settings view manages them. Absent, Sovran has no MCP. */
  mcp?: McpHost;
  /** Shows the Activity Bar view. */
  reveal: () => Promise<void>;
  /**
   * Opens an editor tab showing `sessionId` (a new chat when undefined), titled `title` from the start so the tab never
   * shows a placeholder. It registers itself with `addPanel`.
   */
  openPanel?: (sessionId: string | undefined, title: string) => Promise<void>;
}

interface PendingApproval {
  sessionId: string;
  view: ApprovalView;
  settle: (r: ApprovalResponse) => void;
  request: ApprovalRequest;
}

interface ActiveRun {
  sessionId: string;
  abort: AbortController;
  view: RunView;
}

/** What the controller needs from an editor tab that shows a chat. */
export interface PanelHost {
  reveal(): void;
  setTitle(title: string): void;
  /** Whether the tab is the active editor (VS Code then reports no active text editor). */
  readonly active: boolean;
  /** Whether the tab is on screen (not behind another tab in its group). */
  readonly visible: boolean;
  readonly viewColumn: vscode.ViewColumn | undefined;
}

/**
 * A webview that shows Sovran: the Activity Bar view ("sidebar") or a chat in an editor tab ("panel"). Each has its own
 * chat, screen and composer context; providers, settings, modes and the chat list are shared by all of them.
 */
interface Surface {
  readonly id: string;
  readonly kind: SurfaceKind;
  /** Undefined while the webview is not resolved (the view is collapsed, or a tab is restoring). */
  post: ((m: HostMessage) => void) | undefined;
  session: Session;
  /** Panels always show the chat; lists and settings open in the sidebar. */
  view: View;
  attachments: AttachedFile[];
  includeEditor: boolean;
  panel?: PanelHost;
}

/**
 * A file for the next message. `format` marks a document (converted to Markdown when the message is sent);
 * `encoding` a text file that is not UTF-8. Plain UTF-8 text has neither.
 */
type AttachedFile = AttachmentView & {
  absolute: string;
  encoding?: Exclude<TextEncodingName, 'utf-8'>;
  /** The bytes of a pasted image (it has no file to read at send time). */
  pasted?: Uint8Array;
};

/** Whether a file can be attached, from its size and first bytes. A document still has to be converted. */
type FileCheck =
  | { problem: string }
  | { problem?: undefined; kind: 'text'; encoding: TextEncodingName }
  | { problem?: undefined; kind: 'document'; container: 'pdf' | 'zip'; textFallback: boolean; stat: FileStat }
  | { problem?: undefined; kind: 'image'; mime: ImageMime; stat: FileStat };

/** What a checked file becomes in the message: text in some encoding, or a converted document. */
type FileContent =
  | { problem: string }
  | { problem?: undefined; encoding: TextEncodingName; document?: undefined; image?: undefined }
  | { problem?: undefined; encoding?: undefined; document: DocumentResult; image?: undefined }
  | { problem?: undefined; encoding?: undefined; document?: undefined; image: ImageInfo; data: Uint8Array };

const SIDEBAR = 'sidebar';
/** Editor tab titles longer than this are shortened; the full title is in the chat header. */
const MAX_TAB_TITLE = 40;

const APPROVAL_LABEL: Record<ApprovalMode, string> = { ask: 'Ask', edits: 'Auto-edit', auto: 'Auto' };

const newSession = (mode: AgentMode): Session => {
  const now = Date.now();
  return { id: randomUUID(), title: DEFAULT_TITLE, createdAt: now, updatedAt: now, mode, messages: [] };
};

/**
 * Host-side authority: owns sessions, runs, approvals and provider configuration, and projects
 * them to the webviews (surfaces) as AppState snapshots plus incremental messages.
 *
 * Several surfaces can be open at once: the Activity Bar view and any number of chats in editor tabs. Each shows one
 * chat; a chat is shown by at most one surface. Each chat can have its own run, so chats in different tabs work in
 * parallel. Messages about a chat go to the surface that shows it; shared state goes to every surface.
 */
export class SovranController implements vscode.Disposable {
  private settings: HostSettings = readSettings();
  /** Providers in use: Settings' (which mirror the config file while it is synced). */
  private providers: ProviderConfig[] = [];
  /** Providers from `sovran.providers`, the store the UI writes to. */
  private settingsProviders: ProviderConfig[] = [];
  /** Providers from the last valid version of the config file. */
  private fileProviders: ProviderConfig[] = [];
  /** The config file is enabled, exists and was valid once: it and Settings mirror each other. */
  private syncing = false;
  /** Settings could not be updated from the file (for example settings.json has errors): use the file's providers. */
  private settingsStale = false;
  /** `providerId|baseUrl` whose model limits were already read in this session. */
  private readonly limitsChecked = new Set<string>();
  private configFileView: ConfigFileView = { path: '', state: 'missing', providers: 0, problems: [] };
  /** In-flight title requests, aborted on dispose. */
  private readonly titleRequests = new Set<AbortController>();
  /** Document conversions for attachments and read_file, cached by file (see DOCUMENT_CACHE_SIZE). */
  private reader?: DocumentReader;
  private get documentReader(): DocumentReader {
    return (this.reader ??= new DocumentReader(this.deps.documents, DOCUMENT_CACHE_SIZE));
  }
  /** Config file loads and writes run one after the other (a save and a Settings change must not interleave). */
  private configQueue: Promise<void> = Promise.resolve();
  private keyStatus = new Map<string, boolean>();
  private selected: SelectedModel | null = null;
  private planModel: SelectedModel | null = null;
  private titleModel: SelectedModel | null = null;
  private commands: SlashCommand[] = mergeCommands([]);
  private mode: AgentMode = 'act';
  /** Approval mode for this window. Starts from `sovran.approvals.mode`; the composer and Settings change it. */
  private approvalMode: ApprovalMode = 'ask';
  /** Whether the user confirmed the Auto-mode warning in this window. */
  private autoConfirmed = false;
  private sessions: SessionSummary[] = [];
  private readonly loaded = new Map<string, Session>();
  /** Chats deleted in this window: a run still winding down must not save them back. */
  private readonly deleted = new Set<string>();
  /** The Activity Bar view. It always exists; its webview comes and goes with the view. */
  private readonly sidebar: Surface;
  /** The sidebar first, then editor tabs in the order they were opened. */
  private readonly surfaces = new Map<string, Surface>();
  /** The surface the user worked in last: commands without a surface of their own (Ask About Selection) go there. */
  private lastFocused: string = SIDEBAR;
  /** Runs in progress, by session id. Each chat runs on its own, so chats in different tabs work in parallel. */
  private readonly runs = new Map<string, ActiveRun>();
  private readonly approvals = new Map<string, PendingApproval>();
  private editor: EditorContextView | null = null;
  /** The last focused text editor: a chat in an editor tab is the active editor, but the code beside it still counts. */
  private lastTextEditor: vscode.TextEditor | undefined;
  private readonly grants = new Map<string, SessionGrants>();
  private readonly registry = createBuiltinRegistry();
  private readonly deltas = new Map<string, Extract<HostMessage, { type: 'messageDelta' }>>();
  private readonly outputs = new Map<string, Extract<HostMessage, { type: 'toolOutput' }>>();
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  /** Debounced saves, per session: chats running in parallel must not cancel each other's save. */
  private readonly persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private editorTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly deps: ControllerDeps) {
    if (deps.mcp) this.registry.addSource(deps.mcp.hub);
    this.sidebar = this.createSurface(SIDEBAR, 'sidebar', newSession('act'));
    this.surfaces.set(SIDEBAR, this.sidebar);
    this.loaded.set(this.sidebar.session.id, this.sidebar.session);
  }

  private createSurface(id: string, kind: SurfaceKind, session: Session, panel?: PanelHost): Surface {
    return {
      id,
      kind,
      post: undefined,
      session,
      view: 'chat',
      attachments: [],
      includeEditor: this.settings.includeActiveEditor,
      panel,
    };
  }

  // ------------------------------------------------------------------ lifecycle

  async init() {
    this.sidebar.includeEditor = this.settings.includeActiveEditor;
    this.approvalMode = this.settings.agent.policy.approvalMode;
    // Choosing Auto as the start-up default in settings is itself the informed choice.
    this.autoConfirmed = this.approvalMode === 'auto';
    this.configFileView.path = this.deps.configFile.displayPath;
    await this.reloadProviders();
    await this.reloadConfigFile('startup');
    const def = readDefaultModel();
    const [pid, ...rest] = def.split('/');
    this.selected = this.validSelection(
      pid && rest.length ? { providerId: pid, modelId: rest.join('/') } : null,
    );
    this.planModel = this.parseModelRef(readPlanModel());
    this.titleModel = this.parseModelRef(readTitleModel());
    this.commands = await this.deps.commandLoader.load().catch(() => mergeCommands([]));
    if (!vscode.workspace.isTrusted) this.mode = 'plan';
    this.sidebar.session.mode = this.mode;
    this.sessions = await this.deps.repo.list().catch(() => []);
    this.updateEditorContext();
    this.updateStatusBar();

    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.scheduleEditorUpdate()),
      vscode.window.onDidChangeTextEditorSelection(() => this.scheduleEditorUpdate()),
      vscode.workspace.onDidGrantWorkspaceTrust(async () => {
        this.commands = await this.deps.commandLoader.load();
        this.patch({ workspace: this.workspaceView(), commands: this.commandViews() });
        this.refreshTools();
      }),
      this.deps.commandLoader.onDidChange(async () => {
        this.commands = await this.deps.commandLoader.load();
        this.patch({ commands: this.commandViews() });
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.patch({ workspace: this.workspaceView() })),
      ...(this.deps.mcp
        ? [
            this.deps.mcp.onDidChange(() => {
              this.patch({ mcp: this.mcpView() });
              this.refreshTools();
            }),
          ]
        : []),
      this.deps.configFile.onDidChange(() => void this.reloadConfigFile('change')),
      vscode.workspace.onDidChangeConfiguration(async (e) => {
        if (!e.affectsConfiguration('sovran')) return;
        this.settings = readSettings();
        await this.reloadProviders();
        if (e.affectsConfiguration('sovran.configFile.enabled'))
          void this.reloadConfigFile(readConfigFileEnabled() ? 'enable' : 'startup');
        // Providers or model choices changed in Settings (the panel, the composer or settings.json): mirror them.
        else if (this.syncing) void this.queueConfig(() => this.pushSettingsToFile());
        this.selected = this.validSelection(this.selected);
        this.planModel = this.parseModelRef(readPlanModel());
        this.titleModel = this.parseModelRef(readTitleModel());
        this.updateStatusBar();
        this.updateEditorContext();
        this.patch({
          providers: this.providerViews(),
          selected: this.selected,
          planModel: this.planModel,
          titleModel: this.titleModel,
          settings: readSettingsView(this.settings),
        });
        this.patchContexts();
        this.refreshTools();
      }),
    );
  }

  // ------------------------------------------------------------------ surfaces

  /** Connects the Activity Bar view's webview. */
  attach(post: (m: HostMessage) => void) {
    this.sidebar.post = post;
  }

  detach() {
    this.sidebar.post = undefined;
  }

  /**
   * Registers an editor tab. It shows `sessionId` when that chat exists (a restored tab, or "Open in Editor"), else a
   * new chat. A chat shown by another surface moves here, so every chat has one place. Call before the webview loads.
   */
  async addPanel(
    id: string,
    post: (m: HostMessage) => void,
    panel: PanelHost,
    sessionId?: string,
  ): Promise<void> {
    const session = (sessionId && (await this.loadSession(sessionId))) || this.blankSession();
    const surface = this.createSurface(id, 'panel', session, panel);
    surface.post = post;
    this.surfaces.set(id, surface);
    this.lastFocused = id;
    const previous = this.surfaceFor(session.id, surface);
    if (previous) this.showSession(previous, this.blankSession());
    panel.setTitle(this.tabTitle(session));
    this.liveSessionsChanged();
  }

  /** The editor tab was closed. A run in its chat continues; if it needs approval, Sovran offers to reopen the chat. */
  removePanel(id: string) {
    const surface = this.surfaces.get(id);
    if (!surface || surface.kind !== 'panel') return;
    this.surfaces.delete(id);
    if (this.lastFocused === id) this.lastFocused = SIDEBAR;
    this.forget(surface.session);
    this.liveSessionsChanged();
  }

  /** A surface received focus (its webview reported it, or its editor tab became active). */
  surfaceFocused(id: string) {
    if (this.surfaces.has(id)) this.lastFocused = id;
  }

  /** The surface that commands without one of their own act on: the last one used that still exists. */
  private target(): Surface {
    return this.surfaces.get(this.lastFocused) ?? this.sidebar;
  }

  /** The surface showing `sessionId`, other than `except`. */
  private surfaceFor(sessionId: string, except?: Surface): Surface | undefined {
    for (const s of this.surfaces.values()) if (s !== except && s.session.id === sessionId) return s;
    return undefined;
  }

  private async revealSurface(s: Surface) {
    if (s.panel) s.panel.reveal();
    else await this.deps.reveal();
  }

  private blankSession(): Session {
    const s = newSession(this.mode);
    this.loaded.set(s.id, s);
    return s;
  }

  private async loadSession(id: string): Promise<Session | undefined> {
    const cached = this.loaded.get(id);
    if (cached) return cached;
    const stored = await this.deps.repo.load(id).catch(() => undefined);
    if (!stored) return undefined;
    const s = repairInterruptedSession(stored, Date.now());
    this.loaded.set(id, s);
    return s;
  }

  /** Drops an empty chat nobody shows any more from memory (it was never saved). */
  private forget(session: Session) {
    if (session.messages.length === 0 && !this.surfaceFor(session.id) && !this.runs.has(session.id))
      this.loaded.delete(session.id);
  }

  /** Shows `session` in `surface` and sends the surface a full snapshot. */
  private showSession(surface: Surface, session: Session) {
    const previous = surface.session;
    surface.session = session;
    surface.view = 'chat';
    if (previous !== session) this.forget(previous);
    surface.panel?.setTitle(this.tabTitle(session));
    this.sendState(surface);
    this.liveSessionsChanged();
  }

  /**
   * A full snapshot. Pending text deltas go out first: the snapshot already contains their text, and a delta arriving
   * after it would add the text twice.
   */
  private sendState(surface: Surface) {
    this.flush();
    this.sendTo(surface, { type: 'state', state: this.snapshot(surface) });
  }

  private tabTitle(session: Session): string {
    return this.titleForTab(session.title);
  }

  private titleForTab(t: string): string {
    return t.length > MAX_TAB_TITLE ? `${t.slice(0, MAX_TAB_TITLE - 1).trimEnd()}…` : t;
  }

  /** Sends the chat's header (title and messages) to the surface showing it and renames its editor tab. */
  private sessionChanged(session: Session) {
    const surface = this.surfaceFor(session.id);
    if (!surface) return;
    this.patchSurface(surface, {
      session: { id: session.id, title: session.title, messages: session.messages },
    });
    surface.panel?.setTitle(this.tabTitle(session));
  }

  /** Opens a chat in an editor tab, or focuses the tab that already shows it. Without an id, a new chat. */
  async openInEditor(sessionId?: string) {
    if (!this.deps.openPanel) return;
    const shown = sessionId ? this.surfaceFor(sessionId) : undefined;
    if (shown?.panel) return shown.panel.reveal();
    // The chat may not be loaded yet (opened from the list): its summary has the title.
    const title =
      (sessionId &&
        (this.loaded.get(sessionId)?.title ?? this.sessions.find((s) => s.id === sessionId)?.title)) ||
      DEFAULT_TITLE;
    await this.deps.openPanel(sessionId, this.titleForTab(title));
  }

  /**
   * "Open Chat in Editor" in the view: the view's chat moves to an editor tab and the view starts a new chat. An empty
   * chat has nothing to move, so a new chat opens in the editor instead.
   */
  async moveSidebarToEditor() {
    const session = this.sidebar.session;
    await this.openInEditor(session.messages.length ? session.id : undefined);
  }

  dispose() {
    for (const run of this.runs.values()) run.abort.abort();
    for (const ac of this.titleRequests) ac.abort();
    for (const d of this.disposables) d.dispose();
    clearTimeout(this.flushTimer);
    for (const t of this.persistTimers.values()) clearTimeout(t);
    clearTimeout(this.editorTimer);
  }

  // ------------------------------------------------------------------ webview messages

  /** Handles a validated message from the webview of surface `from` (the Activity Bar view when omitted). */
  async handle(msg: WebviewMessage, from: string = SIDEBAR): Promise<void> {
    const surface = this.surfaces.get(from);
    if (!surface) return;
    // Anything but the start-up handshake means the user is working in this surface.
    if (msg.type !== 'ready') this.lastFocused = from;
    try {
      switch (msg.type) {
        case 'ready':
          return this.sendState(surface);
        case 'focused':
          return;
        case 'send':
          return await this.sendPrompt(surface, msg.text);
        case 'cancel':
          return this.cancel(surface.session.id);
        case 'approval':
          return await this.resolveApproval(
            msg.id,
            { approved: msg.approved, grant: msg.grant, feedback: msg.feedback },
            msg.allowCommand,
            msg.allowTool,
          );
        case 'openApprovalDiff':
          return await this.showApprovalDiff(msg.id);
        case 'newSession':
          return this.newSession(surface);
        case 'openSession':
          return await this.openSession(surface, msg.id);
        case 'openSessionInEditor':
          return await this.openInEditor(msg.id);
        case 'renameSession':
          return await this.renameSession(msg.id, msg.title);
        case 'deleteSession':
          return await this.deleteSession(msg.id);
        case 'setMode':
          return this.setMode(msg.mode);
        case 'setToolGroup': {
          if (surface.session.id !== msg.sessionId) return;
          const session = surface.session;
          const excluded = normalizeExcludedGroups(session.excludedToolGroups);
          session.excludedToolGroups = msg.selected
            ? excluded.filter((id) => id !== msg.group)
            : [...new Set([...excluded, msg.group])];
          session.updatedAt = Date.now();
          this.schedulePersist(session);
          this.patchSurface(surface, this.toolsView(session));
          return;
        }
        case 'setApprovalMode':
          return await this.setApprovalMode(msg.mode);
        case 'pickModel':
          return await this.pickModel();
        case 'selectModel':
          return await this.selectModel({ providerId: msg.providerId, modelId: msg.modelId });
        case 'setModel':
          return await this.setModel(
            msg.role,
            msg.providerId && msg.modelId ? { providerId: msg.providerId, modelId: msg.modelId } : null,
          );
        case 'openConfigFile':
          return await this.openConfigFile();
        case 'reloadConfigFile':
          return await this.reloadConfigFile('change');
        case 'stopConfigFile':
          return await this.stopConfigFile();
        case 'useConfigFile':
          return await writeConfigFileEnabled(true); // onDidChangeConfiguration syncs, Settings winning the merge
        case 'addModels':
          return await this.addModels(msg.providerId, msg.modelIds, msg.select);
        case 'discoverModels':
          return await this.discoverAndPick();
        case 'updateSetting':
          return await this.updateSetting(msg.setting);
        case 'setNativeToolOverride':
          return await writeNativeToolOverride(msg.key, msg.name, msg.included);
        case 'showLogs':
          return this.deps.logger.show();
        case 'attachFiles':
          return await this.attachFiles(surface);
        case 'removeAttachment':
          surface.attachments = surface.attachments.filter((a) => a.id !== msg.id);
          return this.patchSurface(surface, { context: this.contextView(surface) });
        case 'setIncludeEditor':
          surface.includeEditor = msg.value;
          return this.patchSurface(surface, { context: this.contextView(surface) });
        case 'openFile':
          return await this.openFile(msg.path, msg.line, surface);
        case 'openExternal':
          return await this.openExternal(msg.url);
        case 'insertCode':
          return await this.insertCode(msg.code, surface);
        case 'setView':
          return await this.setView(surface, msg.view);
        case 'saveProvider':
          return await this.saveProvider(msg.provider, msg.requestId, surface);
        case 'deleteProvider':
          return await this.deleteProvider(msg.id);
        case 'testProvider':
          return await this.testProvider(msg.requestId, msg.providerId, surface);
        case 'setApiKey':
          return await this.promptApiKey(msg.providerId);
        case 'openSettings':
          await vscode.commands.executeCommand('workbench.action.openSettings', 'sovran');
          return;
        case 'saveMcpServer':
          return await this.deps.mcp?.save(msg.server);
        case 'addMcpIntegration':
          return await this.deps.mcp?.addIntegration(msg.integration, msg.profile);
        case 'installMcpIntegration':
          return await this.deps.mcp?.installIntegration(msg.integration);
        case 'deleteMcpServer':
          return await this.deps.mcp?.remove(msg.id);
        case 'setMcpServerEnabled':
          return await this.deps.mcp?.setEnabled(msg.id, msg.enabled);
        case 'restartMcpServer':
          return await this.deps.mcp?.restart(msg.id);
        case 'setMcpToolPolicy':
          return await this.deps.mcp?.setToolPolicy(msg.id, msg.tool, msg.policy);
        case 'setMcpToken':
          return await this.deps.mcp?.promptToken(msg.id);
        case 'restoreCheckpoint':
          return await this.restoreCheckpoint(surface, msg.messageId);
        case 'retry':
          return await this.retry(surface);
        case 'editMessage':
          return await this.editMessage(surface, msg.messageId, msg.text);
        case 'compact':
          return await this.compactNow(surface);
        case 'suggestFiles':
          return this.sendTo(surface, {
            type: 'fileSuggestions',
            requestId: msg.requestId,
            items: await this.suggestFiles(msg.query),
          });
        case 'attachPath':
          return await this.attachPath(surface, msg.path);
        case 'listDirectory':
          return await this.listDirectory(surface, msg.requestId, msg.path);
        case 'attachImage':
          return this.attachPastedImage(surface, msg.data);
        case 'uploadFiles':
          return await this.uploadFiles(surface);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.deps.logger.error(`Failed to handle ${msg.type}: ${message}`);
      this.notice('error', message, surface);
    }
  }

  // ------------------------------------------------------------------ state projection

  /** The full state for one surface: its chat and screen, plus everything the surfaces share. */
  snapshot(surface: Surface = this.sidebar): AppState {
    const session = surface.session;
    return {
      surface: surface.kind,
      view: surface.view,
      workspace: this.workspaceView(),
      providers: this.providerViews(),
      selected: this.selected,
      mode: this.mode,
      approvalMode: this.approvalMode,
      sessions: this.sessions,
      liveSessions: this.liveSessionViews(),
      session: { id: session.id, title: session.title, messages: session.messages },
      run: this.runs.get(session.id)?.view ?? null,
      approvals: this.approvalsFor(session.id),
      context: this.contextView(surface),
      grants: { edits: this.grantsFor(session.id).edits },
      planModel: this.planModel,
      titleModel: this.titleModel,
      usage: this.usageView(session),
      compaction: this.compactionView(session),
      commands: this.commandViews(),
      settings: readSettingsView(this.settings),
      configFile: this.configFileView,
      mcp: this.mcpView(),
      ...this.toolsView(session),
    };
  }

  private mcpView(): AppState['mcp'] {
    return this.deps.mcp?.view() ?? { active: false, servers: [] };
  }

  private toolsView(session: Session): Pick<AppState, 'toolGroups' | 'nativeTools' | 'toolAvailability'> {
    const definitions = this.registry.all();
    const modelSelection = this.effectiveModel();
    const model = this.providers
      .find((provider) => provider.id === modelSelection?.providerId)
      ?.models?.find((item) => item.id === modelSelection?.modelId);
    const toolAvailability = !model ? 'no-model' : model.toolMode === 'none' ? 'model-disabled' : 'available';
    const selection = { ...this.settings.agent.policy, workspaceTrusted: this.deps.workspace.isTrusted() };
    const groups = new Map<string, NonNullable<AppState['toolGroups']>[number]>();
    const servers = this.deps.mcp?.view().servers ?? [];
    // Include disconnected integrations so the chat choice survives connection and list changes.
    for (const server of servers) {
      const id = `mcp:${server.id}`;
      groups.set(id, {
        id,
        label: server.name,
        selected: !session.excludedToolGroups?.includes(id),
        availableTools: 0,
        definitionTokens: 0,
      });
    }
    for (const tool of definitions) {
      const id = tool.group ?? 'other';
      const group = groups.get(id) ?? {
        id,
        label: TOOL_GROUP_LABELS[id] ?? id,
        selected: !session.excludedToolGroups?.includes(id),
        availableTools: 0,
        definitionTokens: 0,
      };
      if (toolAvailability === 'available' && !this.registry.unavailable(tool, this.mode, selection)) {
        group.availableTools++;
        group.definitionTokens += estimateTokens(JSON.stringify(this.registry.schema(tool)));
      }
      groups.set(id, group);
    }
    return {
      toolAvailability,
      toolGroups: [...groups.values()],
      nativeTools: definitions
        .filter((tool) => tool.source?.kind !== 'mcp')
        .map((tool) => ({
          name: tool.name,
          description: tool.description,
          group: tool.group ?? 'other',
          risk: tool.risk,
          unavailable: this.registry.unavailable(tool, this.mode, {
            ...selection,
            excludedToolGroups: session.excludedToolGroups,
          }),
        })),
    };
  }

  private refreshTools(): void {
    for (const surface of this.surfaces.values()) this.patchSurface(surface, this.toolsView(surface.session));
  }

  /** Chats open in editor tabs or running, so the chat list can show where each one is and whether it needs you. */
  private liveSessionViews(): LiveSessionView[] {
    const ids = new Set<string>(this.runs.keys());
    for (const s of this.surfaces.values()) if (s.kind === 'panel') ids.add(s.session.id);
    const awaiting = new Set([...this.approvals.values()].map((a) => a.sessionId));
    return [...ids].map((id) => ({
      id,
      inEditor: this.surfaceFor(id)?.kind === 'panel',
      running: this.runs.has(id),
      needsApproval: awaiting.has(id),
    }));
  }

  private liveSessionsChanged() {
    this.patch({ liveSessions: this.liveSessionViews() });
  }

  private usageView(s: Session): AppState['usage'] {
    return s.usage
      ? { tokens: s.usage.tokens, contextWindow: s.usage.contextWindow, source: s.usage.source }
      : null;
  }

  private compactionView(s: Session): AppState['compaction'] {
    const c = s.compaction;
    return c ? { summary: c.summary, firstKeptId: c.firstKeptId, summarizedCount: c.summarizedCount } : null;
  }

  private commandViews(): AppState['commands'] {
    return this.commands.map(({ name, description, source }) => ({ name, description, source }));
  }

  private rel(absPath: string): string {
    return vscode.workspace.asRelativePath(absPath, (vscode.workspace.workspaceFolders?.length ?? 0) > 1);
  }

  /** Sends to every surface: state they all share (providers, settings, modes, the chat list). */
  private send(m: HostMessage) {
    for (const s of this.surfaces.values()) s.post?.(m);
  }

  private sendTo(surface: Surface, m: HostMessage) {
    surface.post?.(m);
  }

  /** Sends to the surface showing the chat, if any (a chat runs on while its tab is closed). */
  private sendToSession(sessionId: string, m: HostMessage) {
    const s = this.surfaceFor(sessionId);
    if (s) this.sendTo(s, m);
  }

  private patch(p: Partial<AppState>) {
    this.send({ type: 'patch', patch: p });
  }

  private patchSurface(surface: Surface, p: Partial<AppState>) {
    this.sendTo(surface, { type: 'patch', patch: p });
  }

  private patchSession(sessionId: string, p: Partial<AppState>) {
    this.sendToSession(sessionId, { type: 'patch', patch: p });
  }

  /** Each surface has its own attachments; the active editor is the same for all. */
  private patchContexts() {
    for (const s of this.surfaces.values()) this.patchSurface(s, { context: this.contextView(s) });
  }

  /** A notice for every surface, from services outside the controller (MCP servers). */
  showNotice(level: 'info' | 'warning' | 'error', message: string) {
    this.notice(level, message);
  }

  /** Shows a notice in `to`, or in every surface when it concerns them all (providers, settings, the config file). */
  private notice(level: 'info' | 'warning' | 'error', message: string, to?: Surface) {
    const m: HostMessage = { type: 'notice', id: randomUUID(), level, message };
    if (to) this.sendTo(to, m);
    else this.send(m);
  }

  private workspaceView(): AppState['workspace'] {
    const folders = vscode.workspace.workspaceFolders ?? [];
    return {
      name: vscode.workspace.name ?? null,
      trusted: vscode.workspace.isTrusted,
      hasFolder: folders.length > 0,
    };
  }

  private providerViews(): ProviderView[] {
    return this.providers.map((p) => ({
      id: p.id,
      name: p.name,
      baseUrl: p.baseUrl,
      authType: p.auth?.type ?? 'bearer',
      headerName: p.auth?.headerName,
      timeoutSeconds: p.timeoutSeconds,
      hasKey: this.keyStatus.get(p.id) ?? false,
      models: (p.models ?? []).map((m) => ({
        id: m.id,
        name: m.name,
        contextWindow: m.contextWindow,
        maxOutputTokens: m.maxOutputTokens,
        serverLimits: this.serverLimits(p.id, m.id),
        toolMode: m.toolMode ?? 'auto',
        learnedToolMode: this.deps.capabilities.get(capabilityKey(p.id, m.id))?.toolMode,
      })),
    }));
  }

  private approvalsFor(sessionId: string): ApprovalView[] {
    return [...this.approvals.values()].filter((a) => a.sessionId === sessionId).map((a) => a.view);
  }

  private contextView(surface: Surface) {
    return {
      editor: this.editor,
      includeEditor: surface.includeEditor,
      attachments: surface.attachments.map(({ id, path: p, label, external, format, detail, image }) => ({
        id,
        path: p,
        label,
        ...(external ? { external } : {}),
        ...(format ? { format } : {}),
        ...(detail ? { detail } : {}),
        ...(image ? { image } : {}),
      })),
    };
  }

  private grantsFor(sessionId: string): SessionGrants {
    let g = this.grants.get(sessionId);
    if (!g) {
      g = { edits: false };
      this.grants.set(sessionId, g);
    }
    return g;
  }

  private updateStatusBar() {
    const effective = this.effectiveModel();
    const model = effective ? this.modelLabel(effective) : null;
    const baseUrl = effective
      ? this.providers.find((p) => p.id === effective.providerId)?.baseUrl
      : undefined;
    this.deps.statusBar.update({
      model,
      location: endpointLocation(baseUrl),
      endpoint: baseUrl ?? null,
      mode: this.mode,
      approvalMode: this.approvalMode,
      running: this.runs.size > 0,
    });
  }

  private modelLabel(sel: SelectedModel): string {
    const m = this.providers.find((p) => p.id === sel.providerId)?.models?.find((x) => x.id === sel.modelId);
    return m?.name ?? sel.modelId;
  }

  // ------------------------------------------------------------------ editor context

  private scheduleEditorUpdate() {
    clearTimeout(this.editorTimer);
    this.editorTimer = setTimeout(() => this.updateEditorContext(true), 150);
  }

  /**
   * Why the active file must not be attached automatically. Files outside the workspace (for example
   * ~/.aws/credentials opened from a terminal) and protected paths are never sent without an explicit action.
   */
  private editorBlock(uri: vscode.Uri, rel: string): EditorContextView['blocked'] {
    if (!vscode.workspace.getWorkspaceFolder(uri)) return 'outside';
    if (isProtectedPath(rel, this.settings.agent.policy.protectedPaths)) return 'protected';
    return undefined;
  }

  /**
   * The text editor the user means by "the active file". While a chat in an editor tab is focused it is the active
   * editor and VS Code reports no text editor, so the last text editor counts as long as it is still on screen (the code
   * beside the chat). Without a focused chat tab this is simply the active text editor, as before.
   */
  private textEditor(): vscode.TextEditor | undefined {
    const active = vscode.window.activeTextEditor;
    if (active) return (this.lastTextEditor = active);
    const last = this.lastTextEditor;
    const chatTabActive = [...this.surfaces.values()].some((s) => s.panel?.active);
    return chatTabActive && last && (vscode.window.visibleTextEditors ?? []).includes(last)
      ? last
      : undefined;
  }

  private updateEditorContext(push = false) {
    const ed = this.textEditor();
    let next: EditorContextView | null = null;
    if (ed && ed.document.uri.scheme === 'file') {
      const rel = vscode.workspace.asRelativePath(
        ed.document.uri,
        (vscode.workspace.workspaceFolders?.length ?? 0) > 1,
      );
      const sel = ed.selection;
      const base = path.basename(ed.document.uri.fsPath);
      const blocked = this.editorBlock(ed.document.uri, rel);
      next = sel.isEmpty
        ? { path: rel, label: base }
        : {
            path: rel,
            label: `${base}:${sel.start.line + 1}-${sel.end.line + 1}`,
            startLine: sel.start.line + 1,
            endLine: sel.end.line + 1,
          };
      if (blocked) next.blocked = blocked;
    }
    if (JSON.stringify(next) === JSON.stringify(this.editor)) return;
    this.editor = next;
    if (push) this.patchContexts();
  }

  private async collectAttachments(surface: Surface): Promise<ContextAttachment[]> {
    const out: ContextAttachment[] = [];
    const ed = this.textEditor();
    if (surface.includeEditor && ed && ed.document.uri.scheme === 'file') {
      const rel = vscode.workspace.asRelativePath(
        ed.document.uri,
        (vscode.workspace.workspaceFolders?.length ?? 0) > 1,
      );
      // The lexical check drives the chip; the send-time check also follows symbolic links.
      const allowed =
        !this.editorBlock(ed.document.uri, rel) &&
        (await resolveAndVerify(ed.document.uri.fsPath, this.deps.workspace).then(
          () => true,
          () => false,
        ));
      if (allowed) {
        const sel = ed.selection;
        if (!sel.isEmpty) {
          const text = ed.document.getText(sel);
          out.push({
            kind: 'selection',
            path: rel,
            startLine: sel.start.line + 1,
            endLine: sel.end.line + 1,
            content: text.slice(0, MAX_ATTACHMENT_CHARS),
            truncated: text.length > MAX_ATTACHMENT_CHARS || undefined,
          });
        } else {
          const text = ed.document.getText();
          out.push({
            kind: 'file',
            path: rel,
            content: text.slice(0, MAX_EDITOR_FILE_CHARS),
            truncated: text.length > MAX_EDITOR_FILE_CHARS || undefined,
          });
        }
      }
    }
    for (const a of surface.attachments) {
      // Images travel apart from the text context (see collectImages).
      if (a.image) continue;
      if (out.some((o) => o.path === a.path && o.kind === 'file')) continue;
      try {
        let content: FileContent = { encoding: 'utf-8' };
        if (a.external || a.format || a.encoding) {
          // Re-verified at send time: a symbolic link must not smuggle a file from outside the workspace.
          if (!a.external) await resolveAndVerify(a.absolute, this.deps.workspace);
          // Picked from the computer, a document or text that is not UTF-8: it may have changed since it was attached,
          // so it is checked again (an unchanged document comes from the cache, not converted twice).
          const check = await this.checkFile(a.absolute, a.path);
          content = check.problem !== undefined ? check : await this.readChecked(a.absolute, a.path, check);
          if (content.problem !== undefined) {
            this.notice('warning', content.problem, surface);
            continue;
          }
          if (content.image) {
            this.notice('warning', `${a.path} is now an image. Attach it again to send it as one.`, surface);
            continue;
          }
        } else {
          await resolveAndVerify(a.absolute, this.deps.workspace);
        }
        if (content.document) {
          const { markdown, truncated, format, detail } = content.document;
          out.push({
            kind: 'file',
            path: a.path,
            content: markdown.slice(0, MAX_ATTACHMENT_CHARS),
            truncated: truncated || markdown.length > MAX_ATTACHMENT_CHARS || undefined,
            format,
            ...(detail ? { detail } : {}),
            ...(a.external ? { external: true } : {}),
          });
          continue;
        }
        // UTF-8 goes through the workspace, which prefers the unsaved text of an open editor.
        const encoding = content.encoding ?? 'utf-8';
        const text =
          encoding === 'utf-8'
            ? await this.deps.workspace.readFile(a.absolute)
            : decodeText(await fs.readFile(a.absolute), encoding);
        out.push({
          kind: 'file',
          path: a.path,
          content: text.slice(0, MAX_ATTACHMENT_CHARS),
          truncated: text.length > MAX_ATTACHMENT_CHARS || undefined,
          ...(a.external ? { external: true } : {}),
        });
      } catch (e) {
        this.notice(
          'warning',
          `Could not attach ${a.path}: ${e instanceof Error ? e.message : String(e)}`,
          surface,
        );
      }
    }
    return out;
  }

  /** Quick pick of workspace files for the next message of `surface` (the last chat used, from the command). */
  async attachFiles(surface: Surface = this.target()) {
    const uris = await vscode.workspace.findFiles('**/*', '{**/node_modules/**,**/.git/**}', 5000);
    const multi = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
    const items = uris
      .map((u) => ({
        label: path.basename(u.fsPath),
        description: vscode.workspace.asRelativePath(u, multi),
        uri: u,
      }))
      .sort((a, b) => a.description.localeCompare(b.description));
    const picked = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      matchOnDescription: true,
      placeHolder: 'Add files to the next message',
      title: 'Sovran: Add Files to Context',
    });
    if (!picked?.length) return;
    for (const p of picked) await this.attachPath(surface, p.uri.fsPath, false);
    this.patchSurface(surface, { context: this.contextView(surface) });
  }

  /**
   * "Upload from computer" in the attach menu. Files inside the workspace follow the usual rules; files outside it are
   * accepted only from this host-owned dialog, never from a path the webview sends, so the user picks every one of them.
   */
  private async uploadFiles(surface: Surface) {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
      openLabel: 'Attach',
      title: 'Sovran: Attach Files to the Next Message',
    });
    if (!uris?.length) return;
    for (const uri of uris) {
      if (uri.scheme !== 'file') {
        this.notice(
          'warning',
          `${path.basename(uri.path)} is not a local file, so it cannot be attached.`,
          surface,
        );
        continue;
      }
      if (vscode.workspace.getWorkspaceFolder(uri)) {
        await this.attachPath(surface, uri.fsPath, false);
        continue;
      }
      await this.addAttachment(surface, uri.fsPath, displayPath(uri.fsPath, os.homedir()), true);
    }
    this.patchSurface(surface, { context: this.contextView(surface) });
  }

  /**
   * Whether a file can be attached (it exists, is not too large, and is text, a document Sovran converts or an image),
   * from its size and first bytes. The signature decides, not the extension.
   */
  private async checkFile(absolute: string, shown: string): Promise<FileCheck> {
    const stat = await this.deps.workspace.stat(absolute);
    if (stat?.type !== 'file') return { problem: `${shown} is not a file.` };
    const head = await readHead(absolute).catch(() => null);
    if (!head) return { problem: `${shown} could not be read.` };
    const sniffed = sniffFile(head);
    if (sniffed.kind === 'unsupported') return { problem: describeUnsupported(sniffed.family, shown) };
    if (sniffed.kind === 'image') {
      if (stat.size > IMAGE_LIMITS.maxBytes) return { problem: tooLargeImage(shown) };
      return { kind: 'image', mime: sniffed.mime, stat };
    }
    if (sniffed.kind === 'document') {
      if (stat.size <= DOCUMENT_LIMITS.maxFileBytes)
        return { kind: 'document', container: sniffed.container, textFallback: sniffed.textFallback, stat };
      if (!sniffed.textFallback)
        return {
          problem: `${shown} is larger than ${DOCUMENT_LIMITS.maxFileBytes / 1024 / 1024} MB. Attach a smaller excerpt of it.`,
        };
    }
    if (stat.size > MAX_ATTACHMENT_BYTES)
      return {
        problem: `${shown} is larger than 5 MB. Attach an excerpt, or ask Sovran to read the part you need.`,
      };
    return { kind: 'text', encoding: sniffed.kind === 'text' ? sniffed.encoding : 'utf-8' };
  }

  /**
   * What a checked file becomes in the message. Documents are converted (or taken from the cache). A file that only
   * looked like one (it is not a valid PDF or ZIP) and has no binary content is attached as text, as it was before
   * documents were supported; a valid document that cannot be read (no text, a password) is refused with the reason.
   */
  private async readChecked(
    absolute: string,
    shown: string,
    check: Exclude<FileCheck, { problem: string }>,
  ): Promise<FileContent> {
    if (check.kind === 'text') return { encoding: check.encoding };
    if (check.kind === 'image') {
      const data = new Uint8Array(await fs.readFile(absolute));
      const image = imageInfo(data);
      return image ? { image, data } : { problem: describeUnsupported('binary', shown) };
    }
    try {
      return { document: await this.convertDocument(absolute, check.stat) };
    } catch (e) {
      this.deps.logger.warn(`Could not convert ${shown}: ${e instanceof Error ? e.message : String(e)}`);
      const notADocument = e instanceof DocumentError && (e.code === 'corrupt' || e.code === 'unsupported');
      if (notADocument && check.textFallback && check.stat.size <= MAX_ATTACHMENT_BYTES)
        return { encoding: 'utf-8' };
      return { problem: describeDocumentError(e, shown, check.container === 'pdf' ? 'pdf' : undefined) };
    }
  }

  /** Converts a document in the worker, or returns the conversion of the same unchanged file. */
  private async convertDocument(absolute: string, stat: FileStat): Promise<DocumentResult> {
    return await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: `Sovran: Reading ${path.basename(absolute)}…` },
      () =>
        this.documentReader.read(
          absolute,
          stat,
          async () => new Uint8Array(await fs.readFile(absolute)),
          MAX_ATTACHMENT_CHARS,
        ),
    );
  }

  /**
   * Adds a file to the next message after checking it. Protected files ask first, as they would when the agent reads
   * them, and before a document is converted, so nothing is read from one the user did not confirm.
   */
  private async addAttachment(surface: Surface, absolute: string, shown: string, external = false) {
    if (surface.attachments.some((a) => a.absolute === absolute)) return;
    const check = await this.checkFile(absolute, shown);
    if (check.problem !== undefined) return this.notice('warning', check.problem, surface);
    if (check.kind === 'image' && this.imageCount(surface) >= IMAGE_LIMITS.maxPerMessage)
      return this.notice('warning', TOO_MANY_IMAGES, surface);
    const label = path.basename(absolute);
    if (isProtectedPath(shown, this.settings.agent.policy.protectedPaths)) {
      const choice = await vscode.window.showWarningMessage(
        `Attach ${label}?`,
        {
          modal: true,
          detail: `${shown} matches a protected-path pattern. Its contents are sent to the model with your next message.`,
        },
        'Attach',
      );
      if (choice !== 'Attach' || surface.attachments.some((a) => a.absolute === absolute)) return;
    }
    const content = await this.readChecked(absolute, shown, check);
    if (content.problem !== undefined) return this.notice('warning', content.problem, surface);
    if (surface.attachments.some((a) => a.absolute === absolute)) return;
    surface.attachments.push({
      id: randomUUID(),
      path: shown,
      label,
      absolute,
      ...(external ? { external: true } : {}),
      ...(content.document
        ? {
            format: content.document.format,
            ...(content.document.detail ? { detail: content.document.detail } : {}),
          }
        : {}),
      ...(content.encoding && content.encoding !== 'utf-8' ? { encoding: content.encoding } : {}),
      ...(content.image ? { image: imageView(content.image) } : {}),
    });
    if (content.image) this.warnIfImagesUnseen(surface);
  }

  private imageCount(surface: Surface): number {
    return surface.attachments.filter((a) => a.image).length;
  }

  /** Says so when the chat's model is known not to accept images, so the user is not surprised by its answer. */
  private warnIfImagesUnseen(surface: Surface) {
    const sel = this.effectiveModel();
    const model = sel
      ? this.providers.find((p) => p.id === sel.providerId)?.models?.find((m) => m.id === sel.modelId)
      : undefined;
    if (
      !sel ||
      !model ||
      resolveVision(model.vision, this.deps.capabilities.get(capabilityKey(sel.providerId, model.id)))
    )
      return;
    this.notice(
      'info',
      `${model.name ?? model.id} does not accept images: it will receive only the image's name. Choose a vision model to show it the image.`,
      surface,
    );
  }

  /** An image pasted into the chat input (a screenshot): checked like a file, kept in memory until the message is sent. */
  private attachPastedImage(surface: Surface, base64: string) {
    const data = new Uint8Array(Buffer.from(base64, 'base64'));
    const image = imageInfo(data);
    if (!image)
      return this.notice(
        'warning',
        'The pasted content is not an image Sovran can send. Paste a PNG, JPEG, WebP or GIF image.',
        surface,
      );
    if (data.length > IMAGE_LIMITS.maxBytes)
      return this.notice('warning', tooLargeImage('The pasted image'), surface);
    if (this.imageCount(surface) >= IMAGE_LIMITS.maxPerMessage)
      return this.notice('warning', TOO_MANY_IMAGES, surface);
    const id = imageId(data);
    // The same image pasted twice is attached once.
    if (surface.attachments.some((a) => a.absolute === `pasted:${id}`)) return;
    const name = `Pasted image ${surface.attachments.filter((a) => a.pasted).length + 1}`;
    surface.attachments.push({
      id: randomUUID(),
      path: name,
      label: name,
      absolute: `pasted:${id}`,
      pasted: data,
      image: { ...imageView(image), pasted: true },
    });
    this.warnIfImagesUnseen(surface);
    this.patchSurface(surface, { context: this.contextView(surface) });
  }

  /**
   * The images for the next message, stored in the chat's image store. Files are read again, and checked, at send
   * time (a file may have changed since it was attached); pasted images come from memory.
   */
  private async collectImages(surface: Surface, sessionId: string): Promise<ImageAttachment[]> {
    const out: ImageAttachment[] = [];
    for (const a of surface.attachments) {
      if (!a.image) continue;
      try {
        let data = a.pasted;
        if (!data) {
          if (!a.external) await resolveAndVerify(a.absolute, this.deps.workspace);
          const check = await this.checkFile(a.absolute, a.path);
          const content =
            check.problem !== undefined ? check : await this.readChecked(a.absolute, a.path, check);
          if (content.problem !== undefined || !content.image) {
            this.notice(
              'warning',
              content.problem ?? `${a.path} is no longer an image, so it was not attached.`,
              surface,
            );
            continue;
          }
          data = content.data;
        }
        const info = imageInfo(data);
        if (!info) continue;
        const id = imageId(data);
        if (out.some((i) => i.id === id)) continue;
        await this.deps.images.save(sessionId, id, info.mime, data);
        out.push({
          id,
          name: a.path,
          source: a.pasted ? 'pasted' : a.external ? 'external' : 'workspace',
          mime: info.mime,
          bytes: data.length,
          ...(info.width && info.height ? { width: info.width, height: info.height } : {}),
        });
      } catch (e) {
        this.notice(
          'warning',
          `Could not attach ${a.path}: ${e instanceof Error ? e.message : String(e)}`,
          surface,
        );
      }
    }
    return out;
  }

  /**
   * Data URLs of the images the model will receive in this chat, read from the image store. Nothing is loaded for a
   * model known not to accept images; an image that is gone is sent as its name only.
   */
  private async imageUrls(
    session: Session,
    model: ModelConfig,
    providerId: string,
  ): Promise<Map<string, string>> {
    const urls = new Map<string, string>();
    if (!resolveVision(model.vision, this.deps.capabilities.get(capabilityKey(providerId, model.id))))
      return urls;
    for (const m of messagesForModel(session)) {
      if (m.role !== 'user') continue;
      for (const img of m.images ?? []) {
        if (urls.has(img.id)) continue;
        const data = await this.deps.images.load(session.id, img.id, img.mime).catch(() => undefined);
        if (data) urls.set(img.id, `data:${img.mime};base64,${Buffer.from(data).toString('base64')}`);
      }
    }
    return urls;
  }

  /** `@` and attach-menu suggestions. Before anything is typed, the active editor and the open tabs come first. */
  private async suggestFiles(query: string): Promise<FileSuggestionView[]> {
    if (query.trim()) return this.deps.fileIndex.suggest(query);
    const multi = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
    const active = this.textEditor()?.document.uri;
    const activeAbs = active?.scheme === 'file' ? active.fsPath : undefined;
    const activeRel = activeAbs ? vscode.workspace.asRelativePath(activeAbs, multi) : undefined;
    // Open files outside the workspace and protected files are never suggested.
    const preferred = [...new Set([...(activeAbs ? [activeAbs] : []), ...this.deps.workspace.openEditors()])]
      .filter((abs) => vscode.workspace.getWorkspaceFolder(vscode.Uri.file(abs)))
      .map((abs) => vscode.workspace.asRelativePath(abs, multi))
      .filter((rel) => !isProtectedPath(rel, this.settings.agent.policy.protectedPaths));
    const open = new Set(preferred);
    const items = await this.deps.fileIndex.suggest('', 20, preferred);
    return items.map((i) =>
      open.has(i.path) ? { ...i, hint: i.path === activeRel ? 'active' : 'open' } : i,
    );
  }

  /** One folder of the workspace for the attach menu, confined to the workspace like every other path. */
  private async listDirectory(surface: Surface, requestId: string, requested: string) {
    const reply = (listing: DirectoryListingView) =>
      this.sendTo(surface, { type: 'directoryListing', requestId, listing });
    const roots = this.deps.workspace.roots();
    const dir = requested
      .trim()
      .replace(/^\.\/?$/, '')
      .replace(/\/+$/, '');
    if (!roots.length) return reply({ path: '', entries: [], error: 'Open a folder to browse its files.' });
    if (!dir && roots.length > 1) {
      return reply({
        path: '',
        entries: roots.map((r) => ({ name: r.name, path: r.name, type: 'directory' as const })),
      });
    }
    let resolved: ResolvedPath;
    try {
      resolved = await resolveAndVerify(dir || '.', this.deps.workspace);
    } catch (e) {
      return reply({
        path: dir,
        entries: [],
        error: e instanceof PathError ? e.message : `${dir} is not inside the workspace.`,
      });
    }
    let raw: DirEntry[];
    try {
      raw = await this.deps.workspace.readDirectory(resolved.absolute);
    } catch {
      return reply({ path: dir, entries: [], error: `${dir || 'The workspace folder'} could not be read.` });
    }
    // '.' is the root of a single-folder workspace; multi-root paths always start with the folder name.
    const base = resolved.relative === '.' ? '' : resolved.relative;
    const excluded = this.filesExclude(resolved.root);
    const protectedPaths = this.settings.agent.policy.protectedPaths;
    const entries: DirectoryEntryView[] = [];
    for (const e of raw) {
      if ((e.type !== 'file' && e.type !== 'directory') || BROWSE_HIDDEN.has(e.name)) continue;
      const inRoot = path
        .relative(resolved.root.path, path.join(resolved.absolute, e.name))
        .split(path.sep)
        .join('/');
      if (excluded(inRoot)) continue;
      const p = base ? `${base}/${e.name}` : e.name;
      entries.push({
        name: e.name,
        path: p,
        type: e.type,
        ...(e.type === 'file' && isProtectedPath(p, protectedPaths) ? { protected: true } : {}),
      });
    }
    entries.sort(compareEntries);
    reply({
      path: base,
      entries: entries.slice(0, MAX_LISTING),
      ...(entries.length > MAX_LISTING ? { truncated: true } : {}),
    });
  }

  /** The user's `files.exclude` patterns (those set to true) for one workspace folder, as the Explorer applies them. */
  private filesExclude(root: WorkspaceRoot): (pathInRoot: string) => boolean {
    const config =
      vscode.workspace
        .getConfiguration('files', vscode.Uri.file(root.path))
        .get<Record<string, unknown>>('exclude') ?? {};
    const globs = Object.entries(config)
      .filter(([, on]) => on === true)
      .map(([glob]) => glob);
    if (!globs.length) return () => false;
    const isMatch = picomatch(globs, { dot: true });
    return (p) => isMatch(p);
  }

  // ------------------------------------------------------------------ sessions

  /** Changes what a surface shows. Chats in editor tabs only show chats: lists and settings open in the view. */
  private async setView(surface: Surface, view: View) {
    if (surface.kind === 'panel' && view !== 'chat') {
      await this.setView(this.sidebar, view);
      return this.deps.reveal();
    }
    surface.view = view;
    this.patchSurface(surface, { view });
  }

  /** Shows a screen of the Activity Bar view (History, Settings, Providers). */
  showView(view: View) {
    void this.setView(this.sidebar, view);
  }

  focusComposer(surface: Surface = this.target(), text?: string) {
    void this.setView(surface, 'chat');
    this.sendTo(surface, { type: 'focusComposer', text });
  }

  /** "Ask Sovran About Selection": the last chat used shows it, with the active file or selection attached. */
  async askAboutSelection() {
    const surface = this.target();
    await this.revealSurface(surface);
    surface.includeEditor = true;
    this.patchSurface(surface, { context: this.contextView(surface) });
    this.focusComposer(surface);
  }

  /** Focuses the last Sovran surface used: the view, or the chat in an editor tab. */
  async focus() {
    await this.revealSurface(this.target());
  }

  /** Starts a new chat in `surface` (the view when called from its New Chat button or the command). */
  newSession(surface: Surface = this.sidebar) {
    if (surface.session.messages.length === 0) {
      void this.setView(surface, 'chat');
    } else {
      this.showSession(surface, this.blankSession());
    }
    this.sendTo(surface, { type: 'focusComposer' });
  }

  /** Shows a chat in `surface`. A chat already open in another tab or in the view is focused there instead. */
  private async openSession(surface: Surface, id: string) {
    const elsewhere = this.surfaceFor(id, surface);
    if (elsewhere) return this.revealSurface(elsewhere);
    if (surface.session.id === id) return this.setView(surface, 'chat');
    const s = await this.loadSession(id);
    if (!s) {
      this.notice('error', 'This chat could not be loaded. It may have been deleted.', surface);
      this.sessions = await this.deps.repo.list();
      this.patch({ sessions: this.sessions });
      return;
    }
    this.showSession(surface, s);
  }

  private async renameSession(id: string, title: string) {
    const s = this.loaded.get(id) ?? (await this.deps.repo.load(id));
    if (!s) return;
    s.title = title;
    s.updatedAt = Date.now();
    await this.persist(s);
    this.sessionChanged(s);
  }

  private async deleteSession(id: string) {
    const summary = this.sessions.find((s) => s.id === id);
    const choice = await vscode.window.showWarningMessage(
      `Delete "${summary?.title ?? 'this chat'}"?`,
      { modal: true, detail: 'This cannot be undone.' },
      'Delete',
    );
    if (choice !== 'Delete') return;
    this.deleted.add(id);
    this.cancel(id);
    this.cancelPersist(id);
    await this.deps.repo.delete(id);
    await this.deps.checkpoints.deleteForSession(id).catch(() => undefined);
    await this.deps.images.deleteForSession(id).catch(() => undefined);
    this.loaded.delete(id);
    this.grants.delete(id);
    this.sessions = await this.deps.repo.list();
    // The surface that showed it (the view or an editor tab) starts a new chat.
    const shown = this.surfaceFor(id);
    if (shown) this.showSession(shown, this.blankSession());
    this.patch({ sessions: this.sessions });
  }

  private schedulePersist(session: Session) {
    clearTimeout(this.persistTimers.get(session.id));
    this.persistTimers.set(
      session.id,
      setTimeout(() => {
        this.persistTimers.delete(session.id);
        void this.persist(session);
      }, 500),
    );
  }

  private cancelPersist(sessionId: string) {
    clearTimeout(this.persistTimers.get(sessionId));
    this.persistTimers.delete(sessionId);
  }

  private async persist(session: Session) {
    if (session.messages.length === 0 || this.deleted.has(session.id)) return;
    try {
      await this.deps.repo.save(session);
      this.sessions = await this.deps.repo.list();
      this.patch({ sessions: this.sessions });
    } catch (e) {
      this.deps.logger.error(`Saving session failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ------------------------------------------------------------------ modes & models

  setMode(mode: AgentMode) {
    if (mode === 'act' && !vscode.workspace.isTrusted) {
      this.notice(
        'warning',
        'Act mode needs a trusted workspace. Use "Manage Workspace Trust" to trust this folder.',
      );
      mode = 'plan';
    }
    this.mode = mode;
    // The mode is the window's, so it applies to every open chat.
    for (const s of this.surfaces.values()) s.session.mode = mode;
    this.updateStatusBar();
    this.patch({ mode });
    this.refreshTools();
  }

  toggleMode() {
    this.setMode(this.mode === 'plan' ? 'act' : 'plan');
  }

  /**
   * Changes how much Act mode may do without asking, for this window. Turning on Auto needs a native confirmation
   * once per window: it is an informed choice, and a compromised webview could not switch it on silently.
   */
  async setApprovalMode(mode: ApprovalMode): Promise<void> {
    if (mode !== 'ask' && !vscode.workspace.isTrusted) {
      this.notice(
        'warning',
        'Automatic approvals need a trusted workspace. Use "Manage Workspace Trust" to trust this folder.',
      );
      return this.patch({ approvalMode: this.approvalMode });
    }
    if (mode === 'auto' && !this.autoConfirmed) {
      const choice = await vscode.window.showWarningMessage(
        'Turn on Auto mode?',
        {
          modal: true,
          detail:
            'Sovran will edit files and run commands without asking.\n\n' +
            'It still asks for protected files, commands that delete, push, publish, use sudo, reach the network or leave the workspace, and anything with hidden characters. Every response can be undone with "Undo changes", but commands are not sandboxed.\n\n' +
            'Use Auto only in repositories you trust.',
        },
        'Turn On Auto',
      );
      if (choice !== 'Turn On Auto') return this.patch({ approvalMode: this.approvalMode });
      this.autoConfirmed = true;
    }
    // Plan mode stays read-only: the approval mode is remembered and applies when the user switches to Act.
    this.approvalMode = mode;
    this.deps.logger.info(`Approval mode: ${mode}`);
    this.updateStatusBar();
    this.patch({ approvalMode: mode });
  }

  async pickApprovalMode() {
    const options: Array<{ value: ApprovalMode; icon: string; description: string }> = [
      { value: 'ask', icon: 'shield', description: 'Approve every file change and command' },
      { value: 'edits', icon: 'edit', description: 'Apply file changes without asking; commands still ask' },
      { value: 'auto', icon: 'zap', description: 'No approvals, except protected files and risky commands' },
    ];
    const items = options.map((o) => ({
      value: o.value,
      label: `${o.value === this.approvalMode ? '$(check) ' : ''}$(${o.icon}) ${APPROVAL_LABEL[o.value]}`,
      description: o.description,
    }));
    const pick = await vscode.window.showQuickPick(items, {
      title: 'Sovran: Approvals in Act Mode',
      placeHolder: `Current: ${APPROVAL_LABEL[this.approvalMode]}`,
    });
    if (pick) await this.setApprovalMode(pick.value);
  }

  /** Sets the Act, Plan or title model explicitly (Settings view). A null Plan or title model means "the chat's model". */
  private async setModel(role: 'act' | 'plan' | 'title', sel: SelectedModel | null) {
    if (role === 'title') {
      if (sel && !this.exists(sel)) return;
      this.titleModel = sel;
      await writeTitleModel(sel ? `${sel.providerId}/${sel.modelId}` : '');
      return this.patch({ titleModel: sel });
    }
    if (role === 'plan') {
      if (sel && !this.exists(sel)) return;
      this.planModel = sel;
      await writePlanModel(sel ? `${sel.providerId}/${sel.modelId}` : '');
      this.patch({ planModel: sel });
    } else {
      if (!this.exists(sel)) return;
      this.selected = sel;
      await writeDefaultModel(`${sel.providerId}/${sel.modelId}`);
      this.patch({ selected: sel });
    }
    this.updateStatusBar();
    this.refreshTools();
  }

  /** Adds discovered or typed models to a provider (onboarding), optionally selecting one as the Act model. */
  private async addModels(providerId: string, modelIds: string[], select?: string) {
    const provider = this.settingsProviders.find((p) => p.id === providerId);
    if (!provider) return;
    const known = new Set((provider.models ?? []).map((m) => m.id));
    const added = [...new Set(modelIds)].filter((id) => !known.has(id));
    if (added.length) {
      provider.models = [...(provider.models ?? []), ...added.map((id) => ({ id }))];
      await writeProviders(this.settingsProviders);
      this.useProviders();
    }
    if (select && provider.models?.some((m) => m.id === select))
      await this.setModel('act', { providerId, modelId: select });
    this.patch({ providers: this.providerViews(), selected: this.selected });
  }

  private async updateSetting(update: SettingUpdate) {
    await writeSetting(update);
    if (update.key === 'sessions.persist') {
      const choice = await vscode.window.showInformationMessage(
        'Sovran: the chat history setting applies after the window reloads.',
        'Reload Window',
      );
      if (choice) await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
    // onDidChangeConfiguration refreshes the state and pushes it to the webview.
  }

  private validSelection(sel: SelectedModel | null): SelectedModel | null {
    const has = (s: SelectedModel | null) =>
      !!s && !!this.providers.find((p) => p.id === s.providerId)?.models?.some((m) => m.id === s.modelId);
    if (has(sel)) return sel;
    for (const p of this.providers) {
      const m = p.models?.[0];
      if (m) return { providerId: p.id, modelId: m.id };
    }
    return null;
  }

  private exists(sel: SelectedModel | null): sel is SelectedModel {
    return (
      !!sel &&
      !!this.providers.find((p) => p.id === sel.providerId)?.models?.some((m) => m.id === sel.modelId)
    );
  }

  private parseModelRef(ref: string): SelectedModel | null {
    const [providerId, ...rest] = ref.split('/');
    const sel = providerId && rest.length ? { providerId, modelId: rest.join('/') } : null;
    return this.exists(sel) ? sel : null;
  }

  /** The model used for the next request: the Plan model in Plan mode when one is set, else the Act model. */
  private effectiveModel(): SelectedModel | null {
    if (this.mode === 'plan' && this.exists(this.planModel)) return this.planModel;
    return this.validSelection(this.selected);
  }

  /** Selects the model for the *current* mode. */
  async selectModel(sel: SelectedModel) {
    if (!this.exists(sel)) return;
    if (this.mode === 'plan') {
      this.planModel = sel;
      await writePlanModel(`${sel.providerId}/${sel.modelId}`);
      this.patch({ planModel: sel });
    } else {
      this.selected = sel;
      await writeDefaultModel(`${sel.providerId}/${sel.modelId}`);
      this.patch({ selected: sel });
    }
    this.updateStatusBar();
    this.refreshTools();
  }

  async pickModel() {
    if (this.providers.length === 0) {
      await this.setView(this.sidebar, 'providers');
      await this.deps.reveal();
      return;
    }
    type Item = vscode.QuickPickItem & { sel?: SelectedModel; action?: 'discover' | 'manage' | 'same' };
    const items: Item[] = [];
    const effective = this.effectiveModel();
    if (this.mode === 'plan') {
      const act = this.validSelection(this.selected);
      items.push({
        label: `${this.planModel ? '' : '$(check) '}$(link) Same as Act model`,
        description: act ? this.modelLabel(act) : undefined,
        action: 'same',
      });
    }
    for (const p of this.providers) {
      items.push({ label: p.name, kind: vscode.QuickPickItemKind.Separator });
      for (const m of p.models ?? []) {
        const current =
          (this.mode !== 'plan' || this.planModel) &&
          effective?.providerId === p.id &&
          effective.modelId === m.id;
        items.push({
          label: `${current ? '$(check) ' : ''}${m.name ?? m.id}`,
          description: m.name ? m.id : undefined,
          sel: { providerId: p.id, modelId: m.id },
        });
      }
      if (!p.models?.length)
        items.push({
          label: '$(warning) No models configured',
          description: 'Use Discover models',
          action: 'discover',
        });
    }
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    items.push({ label: '$(refresh) Discover models from servers…', action: 'discover' });
    items.push({ label: '$(server-environment) Manage providers…', action: 'manage' });
    const pick = await vscode.window.showQuickPick(items, {
      title: this.mode === 'plan' ? 'Sovran: Select Model for Plan Mode' : 'Sovran: Select Model',
      placeHolder:
        this.mode === 'plan'
          ? 'Plan mode can use a different (e.g. larger) model than Act mode'
          : 'Choose the model for this chat',
    });
    if (!pick) return;
    if (pick.sel) return this.selectModel(pick.sel);
    if (pick.action === 'same') {
      this.planModel = null;
      await writePlanModel('');
      this.updateStatusBar();
      return this.patch({ planModel: null });
    }
    if (pick.action === 'manage') {
      await this.setView(this.sidebar, 'providers');
      return this.deps.reveal();
    }
    if (pick.action === 'discover') return this.discoverAndPick();
  }

  private async discoverAndPick() {
    const found = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Sovran: Discovering models…',
        cancellable: true,
      },
      async (_p, token) => {
        const ac = new AbortController();
        token.onCancellationRequested(() => ac.abort());
        const results: Array<{
          provider: ProviderConfig;
          models: string[];
          info?: ModelInfo[];
          error?: string;
        }> = [];
        await Promise.all(
          this.providers.map(async (provider) => {
            try {
              const info = await this.createProvider(provider).listModelInfo(ac.signal);
              results.push({ provider, models: info.map((m) => m.id), info });
            } catch (e) {
              const err = e instanceof ProviderError ? e : errorFromException(e, { url: provider.baseUrl });
              results.push({ provider, models: [], error: err.message });
            }
          }),
        );
        return results;
      },
    );
    type Item = vscode.QuickPickItem & { providerId?: string; modelId?: string };
    const items: Item[] = [];
    for (const r of found) {
      items.push({ label: r.provider.name, kind: vscode.QuickPickItemKind.Separator });
      if (r.error) items.push({ label: `$(error) ${r.error}` });
      for (const m of r.models) {
        const known = r.provider.models?.some((x) => x.id === m);
        items.push({
          label: m,
          description: known ? 'configured' : 'add',
          providerId: r.provider.id,
          modelId: m,
        });
      }
    }
    const pick = await vscode.window.showQuickPick(items, {
      title: 'Sovran: Discovered Models',
      placeHolder: 'Pick a model to add and select',
    });
    if (!pick?.providerId || !pick.modelId) return;
    const provider = this.providers.find((p) => p.id === pick.providerId);
    if (!provider) return;
    const info = found.find((r) => r.provider.id === provider.id)?.info;
    if (info) this.storeServerLimits(provider, info, pick.modelId);
    if (!provider.models?.some((m) => m.id === pick.modelId)) {
      const target = this.settingsProviders.find((p) => p.id === provider.id);
      if (!target) return;
      target.models = [...(target.models ?? []), { id: pick.modelId }];
      await writeProviders(this.settingsProviders);
      this.useProviders();
    }
    await this.selectModel({ providerId: provider.id, modelId: pick.modelId });
    this.patch({ providers: this.providerViews() });
  }

  // ------------------------------------------------------------------ providers

  private async reloadProviders() {
    this.settingsProviders = readProviders(this.deps.logger);
    this.useProviders();
    await Promise.all(
      this.providers.map(async (p) => this.keyStatus.set(p.id, await this.deps.secrets.has(p.id))),
    );
    this.detectServerLimits();
  }

  private useProviders() {
    this.providers = this.syncing && this.settingsStale ? this.fileProviders : this.settingsProviders;
  }

  // ------------------------------------------------------------------ config file (synced with Settings)

  private queueConfig(task: () => Promise<void>): Promise<void> {
    this.configQueue = this.configQueue.then(() =>
      task().catch((e) =>
        this.deps.logger.error(`config.yaml sync failed: ${e instanceof Error ? e.message : String(e)}`),
      ),
    );
    return this.configQueue;
  }

  /** `startup`/`change`: read the file; `enable`: the user turned the file back on, so Settings win the first merge. */
  private reloadConfigFile(trigger: 'startup' | 'change' | 'enable'): Promise<void> {
    return this.queueConfig(() => this.loadConfigFile(trigger));
  }

  private modelRefs(): Record<ModelChoiceKey, string> {
    const ref = (s: SelectedModel | null) => (s ? `${s.providerId}/${s.modelId}` : '');
    return {
      defaultModel: ref(this.selected),
      planModel: ref(this.planModel),
      titleModel: ref(this.titleModel),
    };
  }

  private settingsModelRefs(): Set<string> {
    return new Set(this.settingsProviders.flatMap((p) => (p.models ?? []).map((m) => `${p.id}/${m.id}`)));
  }

  /**
   * Writes `providers` into the file, keeping its comments. Never writes text the file would reject, and never over
   * unsaved edits in the editor; returns false (after telling the user) when it did not write.
   */
  private async writeConfigText(
    current: string,
    providers: readonly ProviderConfig[],
    what: string,
    choices: Partial<Record<ModelChoiceKey, string>> = {},
  ): Promise<boolean> {
    const file = this.deps.configFile;
    let next: string;
    try {
      next = updateConfigText(current, providers, choices);
    } catch (e) {
      this.notice(
        'warning',
        `${what} saved in Settings but not in ${file.displayPath}: ${e instanceof Error ? e.message : String(e)}`,
      );
      return false;
    }
    if (next === current) return true;
    const known = new Set([
      ...this.settingsModelRefs(),
      ...providers.flatMap((p) => (p.models ?? []).map((m) => `${p.id}/${m.id}`)),
    ]);
    const check = parseConfigFile(next, { otherModels: known });
    if (!check.ok) {
      this.notice(
        'warning',
        `${what} saved in Settings but cannot be written to ${file.displayPath}: ${check.problems[0]!.message}`,
      );
      return false;
    }
    try {
      await file.write(next);
    } catch (e) {
      const why =
        e instanceof ConfigFileBusyError
          ? `${e.message} Save or revert it; when you save it, its version wins.`
          : e instanceof Error
            ? e.message
            : String(e);
      this.notice('warning', `${what} saved in Settings but not in ${file.displayPath}. ${why}`);
      return false;
    }
    await file.markApplied(next);
    return true;
  }

  /** Settings changed while synced: write the difference into the file. A no-op when both already agree. */
  private async pushSettingsToFile() {
    if (!this.syncing) return;
    const read = await this.deps.configFile.read();
    if (read.kind !== 'text') return;
    if (!parseConfigFile(read.text, { otherModels: this.settingsModelRefs() }).ok) {
      if (!sameProviders(this.settingsProviders, this.fileProviders)) {
        this.notice(
          'warning',
          `Your change is saved in Settings. ${this.deps.configFile.displayPath} has problems, so it was not updated; when you fix it, its version wins.`,
        );
      }
      return;
    }
    if (this.deps.configFile.isNewContent(read.text)) {
      // The file changed too and Sovran has not applied it yet (its notification is still on the way). A hand edit is
      // never overwritten: apply the file first; it wins over the Settings change made in the same moment.
      const discarded = !sameProviders(this.settingsProviders, this.fileProviders);
      await this.loadConfigFile('change');
      if (discarded) {
        this.notice(
          'warning',
          `${this.deps.configFile.displayPath} changed at the same time and its version was applied. Repeat your change if you still need it.`,
        );
      }
      return;
    }
    // Model choices made in the UI go into the file too (only the ones it declares).
    if (await this.writeConfigText(read.text, this.settingsProviders, 'Your change is', this.modelRefs())) {
      this.fileProviders = this.settingsProviders;
    }
  }

  /**
   * Reads `config.yaml` and syncs it with Settings. While the file is enabled and valid the two mirror each other: a
   * saved file updates Settings, a Settings change updates the file (pushSettingsToFile). The first sync joins both
   * sides so nothing is lost. A file with problems is underlined and its last valid version stays in use.
   */
  private async loadConfigFile(trigger: 'startup' | 'change' | 'enable') {
    const file = this.deps.configFile;
    const read = await file.read();
    const view = (
      state: ConfigFileView['state'],
      problems: ConfigFileView['problems'] = [],
    ): ConfigFileView => ({
      path: file.displayPath,
      state,
      providers: this.syncing ? this.fileProviders.length : 0,
      problems,
    });
    const stopSyncing = async (state: ConfigFileView['state']) => {
      file.setProblems([]);
      // Settings already mirror the file, so nothing is lost; the next sync starts by joining both sides again.
      this.syncing = false;
      this.settingsStale = false;
      this.fileProviders = [];
      await file.setSynced(false);
      this.useProviders();
      this.configFileView = view(state);
      await this.refreshProviders();
    };

    if (!readConfigFileEnabled()) return stopSyncing(read.kind === 'missing' ? 'missing' : 'ignored');
    if (read.kind === 'missing') return stopSyncing('missing');

    const result =
      read.kind === 'text'
        ? parseConfigFile(read.text, { otherModels: this.settingsModelRefs() })
        : {
            ok: false as const,
            problems: [{ message: read.message, line: 0, column: 0, endLine: 0, endColumn: 0 }],
          };
    if (!result.ok) {
      file.setProblems(result.problems);
      this.configFileView = view(
        'error',
        result.problems.slice(0, 5).map((p) => ({ line: p.line + 1, message: p.message })),
      );
      this.patch({ configFile: this.configFileView });
      this.deps.logger.warn(
        `config.yaml has ${result.problems.length} problem(s); keeping the last valid version.`,
      );
      if (trigger !== 'startup') {
        const count = result.problems.length;
        void vscode.window
          .showWarningMessage(
            `Sovran: ${file.displayPath} has ${count} problem${count === 1 ? '' : 's'}. Sovran keeps using the last valid version.`,
            'Show Problems',
          )
          .then((c) => c && vscode.commands.executeCommand('workbench.actions.view.problems'));
      }
      return;
    }

    file.setProblems([]);
    const text = read.kind === 'text' ? read.text : '';
    if (this.syncing && trigger !== 'enable' && !file.isNewContent(text)) {
      // The file holds what was already synced (a repeated or late watcher event, Sovran's own write, Reload): it did
      // not change, so it must not undo a Settings change made since. Settings go to the file instead (a no-op when
      // they agree). Decided by content, not by event, so "the side that changed wins" holds whatever the watcher does.
      this.configFileView = view('ok');
      await this.pushSettingsToFile();
      await this.refreshProviders();
      return;
    }
    const ownWrite = file.isOwnWrite(text);
    const previous = new Map(this.fileProviders.map((p) => [p.id, JSON.stringify(p)]));
    let providers = result.config.providers;
    if (!file.isSynced() || trigger === 'enable') {
      // First sync: join both sides. A file turned back on is stale, so Settings win there; otherwise the file does.
      providers =
        trigger === 'enable'
          ? mergeProviders(providers, this.settingsProviders).providers
          : mergeProviders(this.settingsProviders, providers).providers;
      if (!sameProviders(providers, result.config.providers))
        await this.writeConfigText(text, providers, 'The providers from Settings are');
      await file.setSynced(true);
      if (trigger === 'enable')
        this.notice('info', `Using ${file.displayPath} again, in sync with Settings.`);
    }
    this.syncing = true;
    this.fileProviders = providers;
    this.settingsStale = false;
    if (!sameProviders(this.settingsProviders, providers)) {
      try {
        await writeProviders(providers);
      } catch (e) {
        // Sovran keeps working from the file; only the Settings copy is behind.
        this.settingsStale = true;
        this.notice(
          'warning',
          `Could not update Settings from ${file.displayPath}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    await this.reloadProviders();
    if (file.isNewContent(text)) {
      await this.applyModelChoices(result.config);
      await file.markApplied(text);
    }
    this.configFileView = view('ok');
    await this.refreshProviders();
    this.deps.logger.info(`config.yaml synced · ${providers.length} provider(s)`);
    if (trigger === 'change' && !ownWrite) {
      vscode.window.setStatusBarMessage(`$(check) Sovran: applied ${file.displayPath}`, 4000);
      const changed = providers.filter((p) => previous.get(p.id) !== JSON.stringify(p));
      for (const p of changed) void this.connectFileProvider(p);
    }
  }

  /** Opens the file, creating it from the providers in Settings when it does not exist yet. */
  private async openConfigFile() {
    if (!readConfigFileEnabled()) await writeConfigFileEnabled(true);
    const file = this.deps.configFile;
    if (await file.create(configFileTemplate(this.settingsProviders))) await this.reloadConfigFile('change');
    await file.open(() => configFileTemplate(this.settingsProviders));
  }

  /** Back to Settings only: keep the file but ignore it, or move it to the trash. Providers stay in Settings either way. */
  private async stopConfigFile() {
    const file = this.deps.configFile;
    const choice = await vscode.window.showWarningMessage(
      `Stop using ${file.displayPath}?`,
      {
        modal: true,
        detail:
          'Your providers stay in Sovran Settings, which already match the file, and you keep editing them there.\n\n' +
          'Keep the File: it stays on disk and is ignored. You can use it again later from Settings.\n' +
          'Move to Trash: it goes to the system trash, where you can still restore it.',
      },
      'Keep the File',
      'Move to Trash',
    );
    if (choice === 'Keep the File') {
      await writeConfigFileEnabled(false); // onDidChangeConfiguration stops the sync
    } else if (choice === 'Move to Trash') {
      await this.queueConfig(async () => {
        await file.trash();
        await file.setSynced(false);
      });
      await this.reloadConfigFile('startup');
      this.notice('info', `Moved ${file.displayPath} to the trash. Your providers stay in Settings.`);
    }
  }

  /** Selects the models the file names. Called only when the file content is new, so later picks in the UI stick. */
  private async applyModelChoices(config: FileConfig) {
    const act = config.defaultModel ? this.parseModelRef(config.defaultModel) : null;
    if (act) {
      this.selected = act;
      await writeDefaultModel(config.defaultModel!);
    }
    const plan = config.planModel ? this.parseModelRef(config.planModel) : null;
    if (plan) {
      this.planModel = plan;
      await writePlanModel(config.planModel!);
    }
    const title = config.titleModel ? this.parseModelRef(config.titleModel) : null;
    if (title) {
      this.titleModel = title;
      await writeTitleModel(config.titleModel!);
    }
  }

  /** Re-validates the selections against the current providers and pushes them to the UI. */
  private async refreshProviders() {
    this.selected = this.validSelection(this.selected);
    if (!this.exists(this.planModel)) this.planModel = null;
    if (!this.exists(this.titleModel)) this.titleModel = null;
    this.updateStatusBar();
    this.patch({
      providers: this.providerViews(),
      selected: this.selected,
      planModel: this.planModel,
      titleModel: this.titleModel,
      configFile: this.configFileView,
    });
  }

  /** After a save: asks for a missing key, then tests the connection and reports it where the user is (the editor). */
  private async connectFileProvider(p: ProviderConfig) {
    const needsKey = (p.auth?.type ?? 'bearer') !== 'none';
    if (needsKey && !this.keyStatus.get(p.id)) {
      const choice = await vscode.window.showInformationMessage(
        `Sovran: ${p.name} needs an API key. Keys are kept in VS Code Secret Storage, not in the file.`,
        'Set Key',
      );
      if (choice !== 'Set Key') return;
      await this.promptApiKey(p.id);
      if (!this.keyStatus.get(p.id)) return;
    }
    const current = this.providers.find((x) => x.id === p.id);
    if (!current) return;
    const result = await this.checkConnection(current);
    this.send({ type: 'providerTest', requestId: `config-${p.id}-${Date.now()}`, providerId: p.id, result });
    if (result.ok) {
      const noModels =
        !current.models?.length && result.models?.length ? ' Add the models you want under "models:".' : '';
      void vscode.window.showInformationMessage(`Sovran: ${p.name}: ${result.message}.${noModels}`);
    } else {
      void vscode.window.showWarningMessage(
        `Sovran: could not connect to ${p.name}. ${result.message}${result.hint ? ` ${result.hint}` : ''}`,
      );
    }
  }

  private createProvider(config: ProviderConfig) {
    return new OpenAICompatibleProvider({
      config,
      getApiKey: async () => {
        const key = await this.deps.secrets.get(config.id);
        this.deps.logger.addSecret(key);
        return key;
      },
    });
  }

  private slug(name: string): string {
    const base =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'provider';
    let id = base;
    for (let i = 2; this.providers.some((p) => p.id === id); i++) id = `${base}-${i}`;
    return id;
  }

  private async saveProvider(input: ProviderInput, requestId?: string, from: Surface = this.sidebar) {
    const existing = input.id ? this.settingsProviders.find((p) => p.id === input.id) : undefined;
    const id = existing?.id ?? this.slug(input.name);
    const config: ProviderConfig = {
      id,
      name: input.name,
      baseUrl: input.baseUrl.replace(/\/+$/, ''),
      auth: {
        type: input.authType,
        ...(input.authType === 'header' && input.headerName ? { headerName: input.headerName } : {}),
      },
      ...(existing?.headers ? { headers: existing.headers } : {}),
      ...(input.timeoutSeconds ? { timeoutSeconds: input.timeoutSeconds } : {}),
      models: input.models.map((m) => {
        // Keep what the form does not edit (name, temperature); the form's fields replace the old values, and an
        // emptied field removes them, so the model falls back to what the server reports or to the default.
        const {
          contextWindow: _c,
          maxOutputTokens: _o,
          toolMode: _t,
          ...kept
        } = existing?.models?.find((x) => x.id === m.id) ?? { id: m.id };
        return {
          ...kept,
          id: m.id,
          ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
          ...(m.maxOutputTokens ? { maxOutputTokens: m.maxOutputTokens } : {}),
          ...(m.toolMode && m.toolMode !== 'auto' ? { toolMode: m.toolMode } : {}),
        };
      }),
    };
    if (existing && existing.baseUrl !== config.baseUrl) {
      for (const m of existing.models ?? []) this.deps.capabilities.clear(capabilityKey(id, m.id));
    }
    this.settingsProviders = existing
      ? this.settingsProviders.map((p) => (p.id === id ? config : p))
      : [...this.settingsProviders, config];
    await writeProviders(this.settingsProviders);
    this.useProviders();
    if (config.auth?.type !== 'none' && !(await this.deps.secrets.has(id))) await this.promptApiKey(id);
    if (!this.selected) this.selected = this.validSelection(null);
    if (this.selected) await writeDefaultModel(`${this.selected.providerId}/${this.selected.modelId}`);
    this.updateStatusBar();
    this.patch({ providers: this.providerViews(), selected: this.selected });
    if (requestId) {
      // Guided setup: confirm the save, then test the connection and report the models the server offers.
      this.sendTo(from, { type: 'providerSaved', requestId, providerId: id });
      await this.testProvider(requestId, id, from);
    } else {
      this.notice('info', `Saved ${config.name}.`);
    }
  }

  private async deleteProvider(id: string) {
    const p = this.settingsProviders.find((x) => x.id === id);
    if (!p) return;
    const choice = await vscode.window.showWarningMessage(
      `Remove provider "${p.name}"?`,
      { modal: true, detail: 'Its stored API key is deleted too.' },
      'Remove',
    );
    if (choice !== 'Remove') return;
    this.settingsProviders = this.settingsProviders.filter((x) => x.id !== id);
    await writeProviders(this.settingsProviders);
    this.useProviders();
    await this.deps.secrets.delete(id);
    this.keyStatus.delete(id);
    this.selected = this.validSelection(this.selected);
    this.updateStatusBar();
    this.patch({ providers: this.providerViews(), selected: this.selected });
  }

  async promptApiKey(providerId?: string) {
    let id = providerId;
    if (!id) {
      const pick = await vscode.window.showQuickPick(
        this.providers.map((p) => ({ label: p.name, description: p.baseUrl, id: p.id })),
        { title: 'Sovran: Set Provider API Key' },
      );
      id = pick?.id;
    }
    const provider = this.providers.find((p) => p.id === id);
    if (!provider || !id) return;
    const value = await vscode.window.showInputBox({
      title: `API key for ${provider.name}`,
      prompt:
        'Paste the key only, without "Bearer ". Stored in VS Code Secret Storage, never in settings. Leave empty and press Enter to remove the key.',
      password: true,
      ignoreFocusOut: true,
    });
    if (value === undefined) return;
    const { key, notes } = normalizeApiKey(value);
    if (key) await this.deps.secrets.set(id, key);
    else await this.deps.secrets.delete(id);
    this.keyStatus.set(id, !!key);
    if (key) this.detectServerLimits();
    if (key && notes.length)
      this.notice('info', `Saved the key for ${provider.name} without ${notes.join(', ')}.`);
    this.patch({ providers: this.providerViews() });
  }

  /** Answers the surface that asked: request ids are only unique within one webview. */
  private async testProvider(requestId: string, providerId: string, from: Surface) {
    const config = this.providers.find((p) => p.id === providerId);
    if (!config) return;
    this.sendTo(from, {
      type: 'providerTest',
      requestId,
      providerId,
      result: await this.checkConnection(config),
    });
  }

  /** Lists the server's models, or (for gateways without /models) sends a one-token completion. */
  /** Lists the server's models, or (for gateways without /models, or that refuse it to the key) pings the chat. */
  private async checkConnection(config: ProviderConfig): Promise<ProviderTestResult> {
    const { info, ...result } = await probeConnection(
      this.createProvider(config),
      config.models?.[0]?.id,
      config.baseUrl,
    );
    if (info && this.storeServerLimits(config, info)) this.patch({ providers: this.providerViews() });
    return result;
  }

  // ------------------------------------------------------------------ model limits reported by servers

  private serverLimits(providerId: string, modelId: string): ServerLimits | undefined {
    const c = this.deps.capabilities.get(capabilityKey(providerId, modelId));
    return c?.contextWindow || c?.maxOutputTokens
      ? { contextWindow: c.contextWindow, maxOutputTokens: c.maxOutputTokens }
      : undefined;
  }

  /**
   * Remembers the limits a server declared for the provider's configured models (and `extra`). A model the server lists
   * without limits loses the old ones, since the server changed. Returns whether anything changed.
   */
  private storeServerLimits(provider: ProviderConfig, info: readonly ModelInfo[], extra?: string): boolean {
    const wanted = new Set([...(provider.models ?? []).map((m) => m.id), ...(extra ? [extra] : [])]);
    let changed = false;
    for (const m of info) {
      if (!wanted.has(m.id)) continue;
      const key = capabilityKey(provider.id, m.id);
      const {
        contextWindow: oldCtx,
        maxOutputTokens: oldOut,
        ...rest
      } = this.deps.capabilities.get(key) ?? { updatedAt: 0 };
      if (oldCtx === m.contextWindow && oldOut === m.maxOutputTokens) continue;
      this.deps.capabilities.set(key, {
        ...rest,
        ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
        ...(m.maxOutputTokens ? { maxOutputTokens: m.maxOutputTokens } : {}),
        updatedAt: Date.now(),
      });
      changed = true;
    }
    return changed;
  }

  /**
   * Reads the limits of every provider once per session (and again when its URL changes), in the background. Skips
   * providers that need a key Sovran does not have, and those whose models all have both limits set by the user.
   */
  private detectServerLimits() {
    for (const p of this.providers) {
      const key = `${p.id}|${p.baseUrl}`;
      if (this.limitsChecked.has(key) || !p.models?.length) continue;
      if ((p.auth?.type ?? 'bearer') !== 'none' && !this.keyStatus.get(p.id)) continue;
      if (p.models.every((m) => m.contextWindow && m.maxOutputTokens)) continue;
      this.limitsChecked.add(key);
      const provider = this.createProvider(p);
      void (async () => {
        try {
          const info = provider.listModelInfo
            ? await provider.listModelInfo(AbortSignal.timeout(15_000))
            : [];
          if (this.storeServerLimits(p, info)) this.patch({ providers: this.providerViews() });
        } catch (e) {
          this.deps.logger.debug(
            `Could not read model limits from ${p.id}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      })();
    }
  }

  // ------------------------------------------------------------------ runs

  private async sendPrompt(surface: Surface, text: string) {
    const session = surface.session;
    if (this.runs.has(session.id)) {
      this.notice(
        'warning',
        'Sovran is still working in this chat. Stop it before sending another message.',
        surface,
      );
      return;
    }
    const slash = parseSlash(text);
    const command = slash ? this.commands.find((c) => c.name === slash.name) : undefined;
    if (command?.kind === 'action') {
      if (command.name === 'compact') return this.compactNow(surface);
      if (command.name === 'new') return this.newSession(surface);
    }
    const user: UserMessage = {
      role: 'user',
      id: randomUUID(),
      content: command && slash ? expandCommand(command, slash.args) : text,
      ...(command ? { display: text } : {}),
      createdAt: Date.now(),
    };
    const attachments = await this.collectAttachments(surface);
    if (attachments.length) user.attachments = attachments;
    const images = await this.collectImages(surface, session.id);
    if (images.length) user.images = images;
    surface.attachments = [];
    this.patchSurface(surface, { context: this.contextView(surface) });
    await this.startRun(session, user);
  }

  private resolveModel(session: Session): { provider: ProviderConfig; model: ModelConfig } | undefined {
    const sel = this.effectiveModel();
    const provider = sel && this.providers.find((p) => p.id === sel.providerId);
    const model = sel && provider?.models?.find((m) => m.id === sel.modelId);
    if (!provider || !model) {
      this.notice('error', 'Add a model provider before chatting.', this.surfaceFor(session.id));
      void this.setView(this.sidebar, 'providers');
      return undefined;
    }
    // A copy: the limits the server reported are used for this run and never written back to settings or the file.
    return { provider, model: { ...model, serverLimits: this.serverLimits(provider.id, model.id) } };
  }

  /** A runner for one chat: its approval requests carry the chat, so they reach the surface that shows it. */
  private createRunner(provider: ProviderConfig, workspace: WorkspacePort, sessionId: string) {
    const approvals: ApprovalPort = {
      request: (request, signal) => this.request(sessionId, request, signal),
    };
    return new AgentRunner({
      provider: this.createProvider(provider),
      registry: this.registry,
      workspace,
      process: this.deps.process,
      approvals,
      capabilities: this.deps.capabilities,
      logger: this.deps.logger,
      documents: this.documentReader,
      web: this.deps.web,
    });
  }

  private beginRun(session: Session, activity: RunView['activity']): ActiveRun {
    const abort = new AbortController();
    const view: RunView = {
      sessionId: session.id,
      iteration: 0,
      maxIterations: this.settings.agent.maxIterations,
      startedAt: Date.now(),
      activity,
    };
    const run: ActiveRun = { sessionId: session.id, abort, view };
    this.runs.set(session.id, run);
    this.patchSession(session.id, { run: view });
    this.updateStatusBar();
    this.liveSessionsChanged();
    return run;
  }

  private endRun(session: Session) {
    this.runs.delete(session.id);
    this.updateStatusBar();
    this.liveSessionsChanged();
  }

  /** Settles the chat's pending approvals as rejected (its run ended or was stopped). Other chats keep theirs. */
  private dropApprovals(sessionId: string) {
    for (const a of [...this.approvals.values()])
      if (a.sessionId === sessionId) a.settle({ approved: false });
  }

  /** Appends `user` (if needed) and runs the agent for it. `mergeInto` keeps an earlier checkpoint when retrying. */
  private async startRun(session: Session, user: UserMessage, mergeInto?: Checkpoint) {
    // Checked again here, with nothing awaited before beginRun: two quick sends must not start two runs in one chat.
    if (this.runs.has(session.id)) return;
    const resolved = this.resolveModel(session);
    if (!resolved) return;
    const { provider, model } = resolved;
    if (provider.auth?.type !== 'none' && !this.keyStatus.get(provider.id)) {
      this.notice(
        'warning',
        `${provider.name} has no API key stored. Requests are sent without credentials.`,
        this.surfaceFor(session.id),
      );
    }

    if (!session.messages.includes(user)) session.messages.push(user);
    if (session.title === DEFAULT_TITLE) {
      // The first words are the title right away; a generated title replaces them when (and if) it arrives.
      session.title = deriveTitle(user.display ?? user.content);
      // The expanded text (a slash command's prompt) says more than what was typed; attachments are never sent.
      if (this.settings.generateTitles) void this.nameSession(session, user.content, { provider, model });
    }
    session.updatedAt = Date.now();
    session.providerId = provider.id;
    session.modelId = model.id;
    this.sendToSession(session.id, { type: 'messageUpsert', sessionId: session.id, message: user });
    this.sessionChanged(session);
    void this.persist(session);

    const mode: AgentMode = vscode.workspace.isTrusted ? this.mode : 'plan';
    const run = this.beginRun(session, { phase: 'thinking', label: 'Thinking' });
    const secret = await this.deps.secrets.get(provider.id);
    this.deps.logger.addSecret(secret);
    // Every write in this run goes through the recorder, so the run can be undone as a unit.
    const recorder = new CheckpointRecorder(this.deps.workspace);
    const runner = this.createRunner(provider, recorder, session.id);
    this.deps.logger.info(`Run started · ${provider.id}/${model.id} · ${mode} mode`);
    try {
      const outcome = await runner.run({
        session,
        providerId: provider.id,
        model,
        mode,
        settings: this.settings.agent,
        grants: this.grantsFor(session.id),
        signal: run.abort.signal,
        emit: (e) => this.onAgentEvent(session, e),
        projectInstructions: await this.projectInstructions(),
        // MCP tokens too: a server could echo its own token in a result, which would reach the model and the chat file.
        secrets: [secret, ...(this.deps.mcp?.secrets() ?? [])],
        autoCompact: this.settings.autoCompact,
        // Read live: switching the approval mode or allowing a command mid-run applies to the next action.
        policy: () => ({ ...this.settings.agent.policy, approvalMode: this.approvalMode }),
        images: await this.imageUrls(session, model, provider.id),
      });
      this.deps.logger.info(
        `Run finished · ${outcome.reason}${outcome.error ? ` · ${outcome.error.kind}` : ''}`,
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.deps.logger.error(`Run crashed: ${message}`);
      this.notice('error', `The run stopped unexpectedly: ${message}`, this.surfaceFor(session.id));
    } finally {
      this.flush();
      this.dropApprovals(session.id);
      this.endRun(session);
      await this.saveCheckpoint(session, user, recorder.changedFiles(), mergeInto);
      session.updatedAt = Date.now();
      this.cancelPersist(session.id);
      await this.persist(session);
      this.patchSession(session.id, {
        run: null,
        approvals: [],
        grants: { edits: this.grantsFor(session.id).edits },
      });
    }
  }

  /**
   * Asks the model for a short title, in parallel with the run (a few tokens, so it barely delays it). Runs on the
   * title model when one is set, else on the chat's model. The title is kept only if the user has not renamed the chat
   * or deleted it meanwhile; any failure keeps the first-words title.
   */
  private async nameSession(
    session: Session,
    text: string,
    chat: { provider: ProviderConfig; model: ModelConfig },
  ) {
    const derived = session.title;
    const sel = this.exists(this.titleModel) ? this.titleModel : null;
    const provider = sel ? this.providers.find((p) => p.id === sel.providerId) : chat.provider;
    const model = sel ? provider?.models?.find((m) => m.id === sel.modelId) : chat.model;
    if (!provider || !model) return;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 30_000);
    this.titleRequests.add(ac);
    try {
      const title = await generateTitle(this.createProvider(provider), model, text, ac.signal);
      if (!title || session.title !== derived || !this.loaded.has(session.id)) return;
      session.title = title;
      this.sessionChanged(session);
      await this.persist(session);
    } catch (e) {
      const err = e instanceof ProviderError ? e : errorFromException(e, { url: provider.baseUrl });
      this.deps.logger.warn(`Naming the chat with ${provider.id}/${model.id} failed: ${err.message}`);
    } finally {
      clearTimeout(timer);
      this.titleRequests.delete(ac);
    }
  }

  private async saveCheckpoint(
    session: Session,
    user: UserMessage,
    files: FileSnapshot[],
    mergeInto?: Checkpoint,
  ) {
    const merged = mergeInto ? mergeSnapshots(mergeInto.files, files) : files;
    if (merged.length === 0) return;
    const checkpoint: Checkpoint = {
      id: mergeInto?.id ?? randomUUID(),
      sessionId: session.id,
      userMessageId: user.id,
      createdAt: Date.now(),
      files: merged,
    };
    try {
      await this.deps.checkpoints.save(checkpoint);
    } catch (e) {
      this.deps.logger.error(`Saving checkpoint failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    user.checkpoint = { id: checkpoint.id, files: merged.map((f) => this.rel(f.absolutePath)) };
    this.sendToSession(session.id, { type: 'messageUpsert', sessionId: session.id, message: user });
  }

  // ------------------------------------------------------------------ rollback, retry, rewind

  private async restoreCheckpoint(surface: Surface, messageId: string) {
    const session = surface.session;
    if (this.runs.has(session.id))
      return this.notice('warning', 'Stop the current run before undoing changes.', surface);
    const user = session.messages.find((m): m is UserMessage => m.id === messageId && m.role === 'user');
    if (!user?.checkpoint || user.checkpoint.restoredAt) return;
    const checkpoint = await this.deps.checkpoints.load(session.id, user.checkpoint.id);
    if (!checkpoint)
      return this.notice('error', 'The snapshot for these changes is no longer available.', surface);
    const plan = await planRestore(checkpoint.files, this.deps.workspace);
    const modified = plan.filter((p) => p.state === 'modified');
    let includeModified = false;
    if (modified.length) {
      const names = modified
        .slice(0, 6)
        .map((p) => this.rel(p.snapshot.absolutePath))
        .join('\n');
      const choice = await vscode.window.showWarningMessage(
        `${modified.length} file${modified.length === 1 ? ' was' : 's were'} changed after Sovran edited ${modified.length === 1 ? 'it' : 'them'}.`,
        { modal: true, detail: `${names}\n\nRestoring discards those later changes.` },
        'Restore all',
        'Skip changed files',
      );
      if (!choice) return;
      includeModified = choice === 'Restore all';
    }
    const result = await restoreFiles(plan, this.deps.workspace, includeModified);
    user.checkpoint.restoredAt = Date.now();
    this.sendToSession(session.id, { type: 'messageUpsert', sessionId: session.id, message: user });
    await this.persist(session);
    this.notice(
      'info',
      `Undid changes to ${result.restored.length} file${result.restored.length === 1 ? '' : 's'}${result.skipped.length ? `; kept ${result.skipped.length} you changed` : ''}. Use Undo in the editor to reverse this.`,
      surface,
    );
  }

  /** Asks whether discarded responses should also have their file changes undone. */
  private async confirmRewind(users: readonly UserMessage[]): Promise<'none' | 'undo' | 'keep' | 'cancel'> {
    const pending = users.filter((u) => u.checkpoint && !u.checkpoint.restoredAt);
    if (pending.length === 0) return 'none';
    const files = [...new Set(pending.flatMap((u) => u.checkpoint!.files))];
    const choice = await vscode.window.showWarningMessage(
      `Also undo the file changes from the discarded response${pending.length === 1 ? '' : 's'}?`,
      {
        modal: true,
        detail: `${files.length} file${files.length === 1 ? '' : 's'} changed:\n${files.slice(0, 8).join('\n')}${files.length > 8 ? '\n…' : ''}`,
      },
      'Undo changes',
      'Keep changes',
    );
    return choice === 'Undo changes' ? 'undo' : choice === 'Keep changes' ? 'keep' : 'cancel';
  }

  private async undoMessages(session: Session, users: readonly UserMessage[], surface: Surface) {
    let skipped = 0;
    for (const u of [...users].reverse()) {
      if (!u.checkpoint || u.checkpoint.restoredAt) continue;
      const cp = await this.deps.checkpoints.load(session.id, u.checkpoint.id);
      if (!cp) continue;
      const result = await restoreFiles(
        await planRestore(cp.files, this.deps.workspace),
        this.deps.workspace,
        false,
      );
      skipped += result.skipped.length;
      u.checkpoint.restoredAt = Date.now();
    }
    if (skipped)
      this.notice(
        'warning',
        `Kept ${skipped} file${skipped === 1 ? '' : 's'} you changed after Sovran edited ${skipped === 1 ? 'it' : 'them'}.`,
        surface,
      );
  }

  /** Drops the compaction boundary when the message it points to no longer exists. */
  private fixCompaction(session: Session) {
    if (session.compaction && !session.messages.some((m) => m.id === session.compaction!.firstKeptId))
      delete session.compaction;
  }

  private async retry(surface: Surface) {
    const session = surface.session;
    if (this.runs.has(session.id))
      return this.notice('warning', 'Stop the current run before retrying.', surface);
    let i = session.messages.length - 1;
    while (i >= 0 && session.messages[i]!.role !== 'user') i--;
    if (i < 0) return;
    const user = session.messages[i] as UserMessage;
    const decision = await this.confirmRewind([user]);
    if (decision === 'cancel') return;
    let mergeInto: Checkpoint | undefined;
    if (decision === 'undo') {
      await this.undoMessages(session, [user], surface);
      delete user.checkpoint;
    } else if (decision === 'keep' && user.checkpoint) {
      mergeInto = await this.deps.checkpoints.load(session.id, user.checkpoint.id);
    }
    session.messages.length = i + 1;
    this.fixCompaction(session);
    this.resync(session);
    await this.startRun(session, user, mergeInto);
  }

  private async editMessage(surface: Surface, messageId: string, text: string) {
    const session = surface.session;
    if (this.runs.has(session.id))
      return this.notice('warning', 'Stop the current run before editing a message.', surface);
    const i = session.messages.findIndex((m) => m.id === messageId && m.role === 'user');
    if (i < 0) return;
    const original = session.messages[i] as UserMessage;
    const discarded = session.messages.slice(i).filter((m): m is UserMessage => m.role === 'user');
    const decision = await this.confirmRewind(discarded);
    if (decision === 'cancel') return;
    if (decision === 'undo') await this.undoMessages(session, discarded, surface);
    session.messages.length = i;
    this.fixCompaction(session);
    const slash = parseSlash(text);
    const command = slash
      ? this.commands.find((c) => c.name === slash.name && c.kind === 'prompt')
      : undefined;
    const user: UserMessage = {
      role: 'user',
      id: randomUUID(),
      content: command && slash ? expandCommand(command, slash.args) : text,
      ...(command ? { display: text } : {}),
      ...(original.attachments ? { attachments: original.attachments } : {}),
      ...(original.images ? { images: original.images } : {}),
      createdAt: Date.now(),
    };
    this.resync(session);
    await this.startRun(session, user);
  }

  /** Sends a full snapshot to the surface showing the chat, after its messages were cut (retry, edit). */
  private resync(session: Session) {
    const surface = this.surfaceFor(session.id);
    if (surface) this.sendState(surface);
  }

  /** Summarizes the older messages of `surface`'s chat (the last chat used, from the command). */
  async compactNow(surface: Surface = this.target()) {
    const session = surface.session;
    if (this.runs.has(session.id))
      return this.notice('warning', 'Stop the current run before compacting.', surface);
    if (!planCompaction(messagesForModel(session), 1)) {
      return this.notice('info', 'There is not enough conversation to summarize yet.', surface);
    }
    const resolved = this.resolveModel(session);
    if (!resolved) return;
    const run = this.beginRun(session, { phase: 'compacting', label: 'Summarizing earlier messages' });
    const secret = await this.deps.secrets.get(resolved.provider.id);
    try {
      await this.createRunner(resolved.provider, this.deps.workspace, session.id).compact(
        {
          session,
          model: resolved.model,
          settings: this.settings.agent,
          signal: run.abort.signal,
          emit: (e) => this.onAgentEvent(session, e),
          secrets: [secret],
        },
        1,
      );
    } finally {
      this.endRun(session);
      await this.persist(session);
      this.patchSession(session.id, { run: null });
    }
  }

  /** Attaches a workspace file named by the webview (`@` mention, attach menu) or picked in a dialog. */
  private async attachPath(surface: Surface, p: string, push = true) {
    let resolved;
    try {
      // Symlink-aware: a link inside the repository must not attach a file from outside it.
      resolved = await resolveAndVerify(p, this.deps.workspace);
    } catch (e) {
      return this.notice(
        'warning',
        e instanceof PathError ? e.message : `${p} is not inside the workspace.`,
        surface,
      );
    }
    await this.addAttachment(surface, resolved.absolute, resolved.relative);
    if (push) this.patchSurface(surface, { context: this.contextView(surface) });
  }

  /** Stops the run of one chat. Without an id ("Stop Agent"): the last chat used, or every run when it is idle. */
  cancel(sessionId?: string) {
    const ids = sessionId
      ? [sessionId]
      : this.runs.has(this.target().session.id)
        ? [this.target().session.id]
        : [...this.runs.keys()];
    for (const id of ids) {
      const run = this.runs.get(id);
      if (!run) continue;
      run.abort.abort();
      run.view = { ...run.view, activity: { phase: 'thinking', label: 'Stopping' } };
      this.patchSession(id, { run: run.view });
    }
  }

  private async projectInstructions(): Promise<string | undefined> {
    if (!this.settings.projectInstructions || !vscode.workspace.isTrusted) return undefined;
    const root = this.deps.workspace.roots()[0];
    if (!root) return undefined;
    try {
      return (await this.deps.workspace.readFile(path.join(root.path, 'AGENTS.md'))).slice(0, 8000);
    } catch {
      return undefined;
    }
  }

  /** Projects a run's events to the surface showing its chat. The chat may move between surfaces while it runs. */
  private onAgentEvent(session: Session, e: AgentEvent) {
    const visible = !!this.surfaceFor(session.id);
    const run = this.runs.get(session.id);
    const setActivity = (activity: RunView['activity'], extra: Partial<RunView> = {}) => {
      if (!run) return;
      run.view = { ...run.view, ...extra, activity };
      this.patchSession(session.id, { run: run.view });
    };
    switch (e.type) {
      case 'iteration':
        return setActivity(
          { phase: 'thinking', label: 'Thinking' },
          { iteration: e.iteration, maxIterations: e.maxIterations },
        );
      case 'message_started':
        this.sendToSession(session.id, { type: 'messageUpsert', sessionId: session.id, message: e.message });
        return;
      case 'text_delta':
      case 'reasoning_delta': {
        const field = e.type === 'text_delta' ? 'content' : 'reasoning';
        if (run && run.view.activity.phase === 'thinking' && field === 'content')
          setActivity({ phase: 'streaming', label: 'Writing' });
        if (!visible) return;
        const key = `${e.messageId}:${field}`;
        const prev = this.deltas.get(key);
        if (prev) prev.text += e.text;
        else
          this.deltas.set(key, {
            type: 'messageDelta',
            sessionId: session.id,
            messageId: e.messageId,
            field,
            text: e.text,
          });
        return this.scheduleFlush();
      }
      case 'tool_call_streaming':
        return setActivity({
          phase: 'streaming',
          label: `Preparing ${this.deps.mcp?.describe(e.name) ?? e.name.replace(/_/g, ' ')}`,
          toolName: e.name,
        });
      case 'message_committed':
        this.flush();
        this.sendToSession(session.id, { type: 'messageUpsert', sessionId: session.id, message: e.message });
        return this.schedulePersist(session);
      case 'message_removed':
        this.flush();
        this.sendToSession(session.id, {
          type: 'messageRemoved',
          sessionId: session.id,
          messageId: e.messageId,
        });
        return;
      case 'tool_phase':
        return setActivity({ phase: e.phase, label: e.label, toolName: e.toolName, callId: e.callId });
      case 'tool_output': {
        if (!visible) return;
        const prev = this.outputs.get(e.callId);
        if (prev) prev.chunk += e.chunk;
        else
          this.outputs.set(e.callId, {
            type: 'toolOutput',
            sessionId: session.id,
            callId: e.callId,
            chunk: e.chunk,
          });
        return this.scheduleFlush();
      }
      case 'notice':
        // A chat with no surface (its tab was closed) has nobody to tell; the log still has it.
        if (!visible) return this.deps.logger.info(`Notice in a chat that is not shown: ${e.message}`);
        return this.notice(e.level, e.message, this.surfaceFor(session.id));
      case 'context':
        session.usage = {
          tokens: e.estimatedTokens,
          contextWindow: e.contextWindow,
          source: 'estimate',
          updatedAt: Date.now(),
        };
        this.patchSession(session.id, { usage: this.usageView(session) });
        return;
      case 'usage':
        if (e.promptTokens && session.usage) {
          session.usage = {
            ...session.usage,
            tokens: e.promptTokens,
            source: 'server',
            updatedAt: Date.now(),
          };
          this.patchSession(session.id, { usage: this.usageView(session) });
        }
        return;
      case 'compaction_started':
        return setActivity({ phase: 'compacting', label: 'Summarizing earlier messages' });
      case 'compacted':
        this.patchSession(session.id, { compaction: this.compactionView(session) });
        if (visible) {
          this.notice(
            'info',
            `Summarized ${e.compaction.summarizedCount} earlier messages to free context. The full transcript is still shown here.`,
            this.surfaceFor(session.id),
          );
        }
        return this.schedulePersist(session);
    }
  }

  private scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flush(), DELTA_FLUSH_MS);
  }

  private flush() {
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    for (const d of this.deltas.values()) this.sendToSession(d.sessionId, d);
    for (const o of this.outputs.values()) this.sendToSession(o.sessionId, o);
    this.deltas.clear();
    this.outputs.clear();
  }

  // ------------------------------------------------------------------ approvals

  /** The approval port of one chat's runs (see createRunner): the request is shown by the surface showing that chat. */
  private request(
    sessionId: string,
    request: ApprovalRequest,
    signal: AbortSignal,
  ): Promise<ApprovalResponse> {
    return new Promise<ApprovalResponse>((resolve, reject) => {
      const d = request.detail;
      const view: ApprovalView = {
        id: request.id,
        callId: request.callId,
        toolName: request.toolName,
        title: request.title,
        detail:
          d.kind === 'web'
            ? { kind: 'web', url: d.url }
            : d.kind === 'git'
              ? {
                  kind: 'git',
                  operation: d.operation,
                  repository: d.repository,
                  branch: d.branch,
                  files: [...d.files],
                  ...(d.message !== undefined ? { message: d.message } : {}),
                  preview: d.preview,
                  warnings: [...d.warnings],
                }
              : d.kind === 'edit'
                ? {
                    kind: 'edit',
                    path: d.path,
                    isNew: d.isNew,
                    diff: d.diff,
                    added: d.added,
                    removed: d.removed,
                  }
                : d.kind === 'command'
                  ? {
                      kind: 'command',
                      command: d.command,
                      cwd: d.cwd,
                      warnings: d.warnings,
                      allowPrefix: d.warnings.length ? null : suggestAllowPrefix(d.command),
                    }
                  : d.kind === 'mcp'
                    ? {
                        kind: 'mcp',
                        server: d.server,
                        tool: d.tool,
                        ...(d.title ? { title: d.title } : {}),
                        arguments: d.arguments,
                        hints: d.hints,
                      }
                    : { kind: 'read', path: d.path, reason: d.reason },
        ...(request.reason ? { reason: request.reason } : {}),
      };
      const cleanup = () => {
        signal.removeEventListener('abort', onAbort);
        this.approvals.delete(request.id);
        if (d.kind === 'edit') void this.deps.diff.release(request.id);
        this.approvalsChanged(sessionId);
      };
      const onAbort = () => {
        cleanup();
        reject(new Error('cancelled'));
      };
      if (signal.aborted) return reject(new Error('cancelled'));
      signal.addEventListener('abort', onAbort, { once: true });
      this.approvals.set(request.id, {
        sessionId,
        view,
        request,
        settle: (r) => {
          cleanup();
          resolve(r);
        },
      });
      const shown = this.surfaceFor(sessionId);
      if (d.kind === 'edit') {
        this.deps.diff.register(request.id, d.proposedContent);
        if (this.settings.openDiffOnProposal)
          void this.deps.diff.show(request.id, d.path, d.absolutePath, d.isNew, this.editorColumn(shown));
      }
      this.approvalsChanged(sessionId);
      // Nobody sees the request: the view is collapsed, or the chat's tab is closed or behind another tab.
      if (!shown?.post || (shown.panel && !shown.panel.visible)) {
        void vscode.window
          .showInformationMessage(`Sovran needs your approval: ${request.title}`, 'Review')
          .then((c) => {
            if (!c) return;
            const s = this.surfaceFor(sessionId);
            void (s ? this.revealSurface(s) : this.openInEditor(sessionId));
          });
      }
    });
  }

  private approvalsChanged(sessionId: string) {
    this.patchSession(sessionId, { approvals: this.approvalsFor(sessionId) });
    this.liveSessionsChanged();
    // Enables Apply and Reject on the proposal's diff editor.
    void vscode.commands.executeCommand('setContext', 'sovran.approvalPending', this.approvals.size > 0);
  }

  private async showApprovalDiff(id: string) {
    const pending = this.approvals.get(id);
    const d = pending?.request.detail;
    if (pending && d?.kind === 'edit')
      await this.deps.diff.show(
        id,
        d.path,
        d.absolutePath,
        d.isNew,
        this.editorColumn(this.surfaceFor(pending.sessionId)),
      );
  }

  /**
   * Apply or Reject from a proposal's diff editor, or from the command palette. `uri` is the diff the button belongs
   * to; without it, the file change waiting in the last chat used (or the only one waiting).
   */
  async decideProposal(approved: boolean, uri?: unknown) {
    const edits = [...this.approvals.values()].filter((a) => a.request.detail.kind === 'edit');
    const fromDiff = DiffPresenter.approvalId(uri);
    const pending = fromDiff
      ? edits.find((a) => a.request.id === fromDiff)
      : (edits.find((a) => a.sessionId === this.target().session.id) ??
        (edits.length === 1 ? edits[0] : undefined));
    if (!pending) {
      void vscode.window.showInformationMessage('No file change is waiting for your approval.');
      return;
    }
    await this.resolveApproval(pending.request.id, { approved });
  }

  private async resolveApproval(
    id: string,
    response: ApprovalResponse,
    allowCommand?: string,
    allowTool?: boolean,
  ) {
    const pending = this.approvals.get(id);
    if (!pending) return;
    const detail = pending.request.detail;
    // Grants only apply to the kind of action they describe.
    if (response.grant === 'session-edits' && detail.kind !== 'edit') delete response.grant;
    if (response.approved && allowCommand && detail.kind === 'command') {
      // "Always allow": the entry must match the command being approved, so it cannot widen anything else.
      if (matchesAllowList(detail.command, [allowCommand])) {
        await addAllowedCommand(allowCommand);
        this.settings = readSettings(); // the running agent reads the policy live, so the next command benefits
        this.notice(
          'info',
          `Commands starting with "${allowCommand}" now run without asking. Manage the list in Settings.`,
          this.surfaceFor(pending.sessionId),
        );
      } else {
        this.deps.logger.warn('Ignored an allow-list entry that does not match the approved command.');
      }
    }
    // "Always allow" on an MCP tool: the tool named by the pending request, never one the webview names.
    if (response.approved && allowTool && detail.kind === 'mcp') {
      // The call runs either way: failing to save the choice must not leave the run waiting.
      await this.deps.mcp?.allowTool(detail.serverId, detail.tool).catch((e: unknown) => {
        this.notice(
          'error',
          `Could not save "always allow" for ${detail.tool}: ${e instanceof Error ? e.message : String(e)}`,
          this.surfaceFor(pending.sessionId),
        );
      });
    }
    pending.settle(response);
  }

  // ------------------------------------------------------------------ editor helpers

  /**
   * Where a file or diff opens for a chat in an editor tab: in the group of the code beside it, or a new group next to
   * it, never over the chat (that would hide the approval bar). Undefined for the view: the active group, as always.
   */
  private editorColumn(surface: Surface | undefined): vscode.ViewColumn | undefined {
    const column = surface?.panel?.viewColumn;
    if (!column) return undefined;
    const code = this.lastTextEditor?.viewColumn;
    return code && code !== column ? code : vscode.ViewColumn.Beside;
  }

  private async openFile(p: string, line: number | undefined, surface: Surface) {
    let resolved;
    try {
      resolved = resolveWorkspacePath(p, this.deps.workspace.roots());
    } catch {
      return this.notice('warning', `Cannot open ${p}: it is not inside the workspace.`, surface);
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(resolved.absolute));
    const pos = new vscode.Position(Math.max(0, (line ?? 1) - 1), 0);
    await vscode.window.showTextDocument(doc, {
      selection: new vscode.Range(pos, pos),
      preview: true,
      viewColumn: this.editorColumn(surface),
    });
  }

  private async openExternal(url: string) {
    let parsed: vscode.Uri;
    try {
      parsed = vscode.Uri.parse(url, true);
    } catch {
      return;
    }
    if (parsed.scheme !== 'https' && parsed.scheme !== 'http') return;
    await vscode.env.openExternal(parsed);
  }

  private async insertCode(code: string, surface: Surface) {
    const ed = this.textEditor();
    if (!ed) return this.notice('warning', 'Open a file to insert code.', surface);
    await ed.edit((b) => b.replace(ed.selection, code));
  }
}
