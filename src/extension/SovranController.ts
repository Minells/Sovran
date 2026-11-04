import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import picomatch from 'picomatch';
import { AgentRunner } from '../core/agent/agentRunner';
import { CheckpointRecorder, planRestore, restoreFiles, type Checkpoint, type FileSnapshot } from '../core/checkpoints/checkpoints';
import { expandCommand, mergeCommands, parseSlash, type SlashCommand } from '../core/commands/slashCommands';
import { planCompaction } from '../core/context/compaction';
import { configFileTemplate, mergeProviders, parseConfigFile, sameProviders, updateConfigText, type FileConfig, type ModelChoiceKey } from '../core/config/configFile';
import type { AgentEvent } from '../core/agent/events';
import { matchesAllowList, suggestAllowPrefix } from '../core/permissions/commands';
import type { AgentMode, ApprovalMode, SessionGrants } from '../core/permissions/policy';
import { isProtectedPath } from '../core/permissions/policy';
import type { ApprovalPort, ApprovalRequest, ApprovalResponse, DirEntry, WorkspacePort, WorkspaceRoot } from '../core/ports';
import { capabilityKey, type CapabilityStore } from '../core/providers/capabilities';
import { ProviderError, errorFromException } from '../core/providers/errors';
import { OpenAICompatibleProvider } from '../core/providers/openaiCompatible';
import { normalizeApiKey, probeConnection } from '../core/providers/connection';
import type { ModelInfo, ServerLimits } from '../core/providers/limits';
import type { ModelConfig, ProviderConfig } from '../core/providers/types';
import { PathError, resolveAndVerify, resolveWorkspacePath, type ResolvedPath } from '../core/security/paths';
import { compareEntries, displayPath, looksBinary } from '../core/util/files';
import {
  DEFAULT_TITLE,
  deriveTitle,
  messagesForModel,
  repairInterruptedSession,
  type ContextAttachment,
  type Session,
  type SessionRepository,
  type SessionSummary,
  type UserMessage,
} from '../core/sessions/model';
import { generateTitle } from '../core/sessions/titles';
import { createBuiltinRegistry } from '../core/tools/builtin';
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
  ProviderInput,
  ProviderTestResult,
  ProviderView,
  RunView,
  SelectedModel,
  SettingUpdate,
  View,
  WebviewMessage,
} from '../shared/protocol';
import { endpointLocation } from '../shared/endpoints';
import type { DiffPresenter } from './adapters/DiffPresenter';
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
  writePlanModel,
  writeProviders,
  writeSetting,
  writeTitleModel,
  type HostSettings,
} from './config';
import { ConfigFileBusyError, type ConfigFileHost } from './configFileHost';
import type { HostLogger, ProviderSecrets, SovranStatusBar } from './services';

const MAX_ATTACHMENT_CHARS = 50_000;
const MAX_EDITOR_FILE_CHARS = 12_000;
/** Larger files are refused rather than read into memory only to be truncated to MAX_ATTACHMENT_CHARS. */
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
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
  reveal: () => Promise<void>;
}

interface PendingApproval {
  view: ApprovalView;
  settle: (r: ApprovalResponse) => void;
  request: ApprovalRequest;
}

interface ActiveRun {
  sessionId: string;
  abort: AbortController;
  view: RunView;
}

const APPROVAL_LABEL: Record<ApprovalMode, string> = { ask: 'Ask', edits: 'Auto-edit', auto: 'Auto' };

const newSession = (mode: AgentMode): Session => {
  const now = Date.now();
  return { id: randomUUID(), title: DEFAULT_TITLE, createdAt: now, updatedAt: now, mode, messages: [] };
};

/**
 * Host-side authority: owns sessions, runs, approvals and provider configuration, and projects
 * them to the webview as AppState snapshots plus incremental messages.
 */
export class SovranController implements ApprovalPort, vscode.Disposable {
  private post: ((m: HostMessage) => void) | undefined;
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
  private view: View = 'chat';
  private sessions: SessionSummary[] = [];
  private session: Session = newSession('act');
  private readonly loaded = new Map<string, Session>();
  private run: ActiveRun | null = null;
  private readonly approvals = new Map<string, PendingApproval>();
  private attachments: Array<AttachmentView & { absolute: string }> = [];
  private includeEditor = true;
  private editor: EditorContextView | null = null;
  private readonly grants = new Map<string, SessionGrants>();
  private readonly registry = createBuiltinRegistry();
  private readonly deltas = new Map<string, Extract<HostMessage, { type: 'messageDelta' }>>();
  private readonly outputs = new Map<string, Extract<HostMessage, { type: 'toolOutput' }>>();
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private editorTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly deps: ControllerDeps) {}

  // ------------------------------------------------------------------ lifecycle

  async init() {
    this.includeEditor = this.settings.includeActiveEditor;
    this.approvalMode = this.settings.agent.policy.approvalMode;
    // Choosing Auto as the start-up default in settings is itself the informed choice.
    this.autoConfirmed = this.approvalMode === 'auto';
    this.configFileView.path = this.deps.configFile.displayPath;
    await this.reloadProviders();
    await this.reloadConfigFile('startup');
    const def = readDefaultModel();
    const [pid, ...rest] = def.split('/');
    this.selected = this.validSelection(pid && rest.length ? { providerId: pid, modelId: rest.join('/') } : null);
    this.planModel = this.parseModelRef(readPlanModel());
    this.titleModel = this.parseModelRef(readTitleModel());
    this.commands = await this.deps.commandLoader.load().catch(() => mergeCommands([]));
    if (!vscode.workspace.isTrusted) this.mode = 'plan';
    this.session.mode = this.mode;
    this.loaded.set(this.session.id, this.session);
    this.sessions = await this.deps.repo.list().catch(() => []);
    this.updateEditorContext();
    this.updateStatusBar();

    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.scheduleEditorUpdate()),
      vscode.window.onDidChangeTextEditorSelection(() => this.scheduleEditorUpdate()),
      vscode.workspace.onDidGrantWorkspaceTrust(async () => {
        this.commands = await this.deps.commandLoader.load();
        this.patch({ workspace: this.workspaceView(), commands: this.commandViews() });
      }),
      this.deps.commandLoader.onDidChange(async () => {
        this.commands = await this.deps.commandLoader.load();
        this.patch({ commands: this.commandViews() });
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.patch({ workspace: this.workspaceView() })),
      this.deps.configFile.onDidChange(() => void this.reloadConfigFile('change')),
      vscode.workspace.onDidChangeConfiguration(async (e) => {
        if (!e.affectsConfiguration('sovran')) return;
        this.settings = readSettings();
        await this.reloadProviders();
        if (e.affectsConfiguration('sovran.configFile.enabled')) void this.reloadConfigFile(readConfigFileEnabled() ? 'enable' : 'startup');
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
          context: this.contextView(),
        });
      }),
    );
  }

  attach(post: (m: HostMessage) => void) {
    this.post = post;
  }

  detach() {
    this.post = undefined;
  }

  dispose() {
    this.run?.abort.abort();
    for (const ac of this.titleRequests) ac.abort();
    for (const d of this.disposables) d.dispose();
    clearTimeout(this.flushTimer);
    clearTimeout(this.persistTimer);
    clearTimeout(this.editorTimer);
  }

  // ------------------------------------------------------------------ webview messages

  async handle(msg: WebviewMessage): Promise<void> {
    try {
      switch (msg.type) {
        case 'ready':
          return this.send({ type: 'state', state: this.snapshot() });
        case 'send':
          return await this.sendPrompt(msg.text);
        case 'cancel':
          return this.cancel();
        case 'approval':
          return await this.resolveApproval(msg.id, { approved: msg.approved, grant: msg.grant, feedback: msg.feedback }, msg.allowCommand);
        case 'openApprovalDiff': {
          const pending = this.approvals.get(msg.id);
          const d = pending?.request.detail;
          if (d?.kind === 'edit') await this.deps.diff.show(msg.id, d.path, d.absolutePath, d.isNew);
          return;
        }
        case 'newSession':
          return this.newSession();
        case 'openSession':
          return await this.openSession(msg.id);
        case 'renameSession':
          return await this.renameSession(msg.id, msg.title);
        case 'deleteSession':
          return await this.deleteSession(msg.id);
        case 'setMode':
          return this.setMode(msg.mode);
        case 'setApprovalMode':
          return await this.setApprovalMode(msg.mode);
        case 'pickModel':
          return await this.pickModel();
        case 'selectModel':
          return await this.selectModel({ providerId: msg.providerId, modelId: msg.modelId });
        case 'setModel':
          return await this.setModel(msg.role, msg.providerId && msg.modelId ? { providerId: msg.providerId, modelId: msg.modelId } : null);
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
        case 'showLogs':
          return this.deps.logger.show();
        case 'attachFiles':
          return await this.attachFiles();
        case 'removeAttachment':
          this.attachments = this.attachments.filter((a) => a.id !== msg.id);
          return this.patch({ context: this.contextView() });
        case 'setIncludeEditor':
          this.includeEditor = msg.value;
          return this.patch({ context: this.contextView() });
        case 'openFile':
          return await this.openFile(msg.path, msg.line);
        case 'openExternal':
          return await this.openExternal(msg.url);
        case 'insertCode':
          return await this.insertCode(msg.code);
        case 'setView':
          return this.setView(msg.view);
        case 'saveProvider':
          return await this.saveProvider(msg.provider, msg.requestId);
        case 'deleteProvider':
          return await this.deleteProvider(msg.id);
        case 'testProvider':
          return await this.testProvider(msg.requestId, msg.providerId);
        case 'setApiKey':
          return await this.promptApiKey(msg.providerId);
        case 'openSettings':
          await vscode.commands.executeCommand('workbench.action.openSettings', 'sovran');
          return;
        case 'restoreCheckpoint':
          return await this.restoreCheckpoint(msg.messageId);
        case 'retry':
          return await this.retry();
        case 'editMessage':
          return await this.editMessage(msg.messageId, msg.text);
        case 'compact':
          return await this.compactNow();
        case 'suggestFiles':
          return this.send({ type: 'fileSuggestions', requestId: msg.requestId, items: await this.suggestFiles(msg.query) });
        case 'attachPath':
          return await this.attachPath(msg.path);
        case 'listDirectory':
          return await this.listDirectory(msg.requestId, msg.path);
        case 'uploadFiles':
          return await this.uploadFiles();
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.deps.logger.error(`Failed to handle ${msg.type}: ${message}`);
      this.notice('error', message);
    }
  }

  // ------------------------------------------------------------------ state projection

  snapshot(): AppState {
    return {
      view: this.view,
      workspace: this.workspaceView(),
      providers: this.providerViews(),
      selected: this.selected,
      mode: this.mode,
      approvalMode: this.approvalMode,
      sessions: this.sessions,
      session: { id: this.session.id, title: this.session.title, messages: this.session.messages },
      run: this.run && this.run.sessionId === this.session.id ? this.run.view : null,
      approvals: this.visibleApprovals(),
      context: this.contextView(),
      grants: { edits: this.grantsFor(this.session.id).edits },
      planModel: this.planModel,
      titleModel: this.titleModel,
      usage: this.usageView(this.session),
      compaction: this.compactionView(this.session),
      commands: this.commandViews(),
      settings: readSettingsView(this.settings),
      configFile: this.configFileView,
    };
  }

  private usageView(s: Session): AppState['usage'] {
    return s.usage ? { tokens: s.usage.tokens, contextWindow: s.usage.contextWindow, source: s.usage.source } : null;
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

  private send(m: HostMessage) {
    this.post?.(m);
  }

  private patch(p: Partial<AppState>) {
    this.send({ type: 'patch', patch: p });
  }

  private notice(level: 'info' | 'warning' | 'error', message: string) {
    this.send({ type: 'notice', id: randomUUID(), level, message });
  }

  private workspaceView(): AppState['workspace'] {
    const folders = vscode.workspace.workspaceFolders ?? [];
    return { name: vscode.workspace.name ?? null, trusted: vscode.workspace.isTrusted, hasFolder: folders.length > 0 };
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

  private visibleApprovals(): ApprovalView[] {
    return this.run && this.run.sessionId === this.session.id ? [...this.approvals.values()].map((a) => a.view) : [];
  }

  private contextView() {
    return {
      editor: this.editor,
      includeEditor: this.includeEditor,
      attachments: this.attachments.map(({ id, path: p, label, external }) => ({ id, path: p, label, ...(external ? { external } : {}) })),
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
    const baseUrl = effective ? this.providers.find((p) => p.id === effective.providerId)?.baseUrl : undefined;
    this.deps.statusBar.update({
      model,
      location: endpointLocation(baseUrl),
      endpoint: baseUrl ?? null,
      mode: this.mode,
      approvalMode: this.approvalMode,
      running: !!this.run,
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

  private updateEditorContext(push = false) {
    const ed = vscode.window.activeTextEditor;
    let next: EditorContextView | null = null;
    if (ed && ed.document.uri.scheme === 'file') {
      const rel = vscode.workspace.asRelativePath(ed.document.uri, (vscode.workspace.workspaceFolders?.length ?? 0) > 1);
      const sel = ed.selection;
      const base = path.basename(ed.document.uri.fsPath);
      const blocked = this.editorBlock(ed.document.uri, rel);
      next = sel.isEmpty
        ? { path: rel, label: base }
        : { path: rel, label: `${base}:${sel.start.line + 1}-${sel.end.line + 1}`, startLine: sel.start.line + 1, endLine: sel.end.line + 1 };
      if (blocked) next.blocked = blocked;
    }
    if (JSON.stringify(next) === JSON.stringify(this.editor)) return;
    this.editor = next;
    if (push) this.patch({ context: this.contextView() });
  }

  private async collectAttachments(): Promise<ContextAttachment[]> {
    const out: ContextAttachment[] = [];
    const ed = vscode.window.activeTextEditor;
    if (this.includeEditor && ed && ed.document.uri.scheme === 'file') {
      const rel = vscode.workspace.asRelativePath(ed.document.uri, (vscode.workspace.workspaceFolders?.length ?? 0) > 1);
      // The lexical check drives the chip; the send-time check also follows symbolic links.
      const allowed = !this.editorBlock(ed.document.uri, rel) && (await resolveAndVerify(ed.document.uri.fsPath, this.deps.workspace).then(() => true, () => false));
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
          out.push({ kind: 'file', path: rel, content: text.slice(0, MAX_EDITOR_FILE_CHARS), truncated: text.length > MAX_EDITOR_FILE_CHARS || undefined });
        }
      }
    }
    for (const a of this.attachments) {
      if (out.some((o) => o.path === a.path && o.kind === 'file')) continue;
      try {
        if (a.external) {
          // Picked by the user in the system dialog. It may have changed since: check it is still a text file.
          const problem = await this.fileProblem(a.absolute, a.path);
          if (problem) {
            this.notice('warning', problem);
            continue;
          }
        } else {
          // Re-verified at send time: a symbolic link must not smuggle a file from outside the workspace.
          await resolveAndVerify(a.absolute, this.deps.workspace);
        }
        const text = await this.deps.workspace.readFile(a.absolute);
        out.push({
          kind: 'file',
          path: a.path,
          content: text.slice(0, MAX_ATTACHMENT_CHARS),
          truncated: text.length > MAX_ATTACHMENT_CHARS || undefined,
          ...(a.external ? { external: true } : {}),
        });
      } catch (e) {
        this.notice('warning', `Could not attach ${a.path}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return out;
  }

  async attachFiles() {
    const uris = await vscode.workspace.findFiles('**/*', '{**/node_modules/**,**/.git/**}', 5000);
    const multi = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
    const items = uris
      .map((u) => ({ label: path.basename(u.fsPath), description: vscode.workspace.asRelativePath(u, multi), uri: u }))
      .sort((a, b) => a.description.localeCompare(b.description));
    const picked = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      matchOnDescription: true,
      placeHolder: 'Add files to the next message',
      title: 'Sovran: Add Files to Context',
    });
    if (!picked?.length) return;
    for (const p of picked) await this.attachPath(p.uri.fsPath, false);
    this.patch({ context: this.contextView() });
  }

  /**
   * "Upload from computer" in the attach menu. Files inside the workspace follow the usual rules; files outside it are
   * accepted only from this host-owned dialog, never from a path the webview sends, so the user picks every one of them.
   */
  private async uploadFiles() {
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
        this.notice('warning', `${path.basename(uri.path)} is not a local file, so it cannot be attached.`);
        continue;
      }
      if (vscode.workspace.getWorkspaceFolder(uri)) {
        await this.attachPath(uri.fsPath, false);
        continue;
      }
      const shown = displayPath(uri.fsPath, os.homedir());
      const problem = await this.fileProblem(uri.fsPath, shown);
      if (problem) {
        this.notice('warning', problem);
        continue;
      }
      await this.addAttachment(uri.fsPath, shown, true);
    }
    this.patch({ context: this.contextView() });
  }

  /** Why a file cannot be attached (missing, too large or binary), or undefined when it can. */
  private async fileProblem(absolute: string, shown: string): Promise<string | undefined> {
    const stat = await this.deps.workspace.stat(absolute);
    if (stat?.type !== 'file') return `${shown} is not a file.`;
    if (stat.size > MAX_ATTACHMENT_BYTES) return `${shown} is larger than 5 MB. Attach an excerpt, or ask Sovran to read the part you need.`;
    const head = await readHead(absolute).catch(() => null);
    if (!head) return `${shown} could not be read.`;
    if (looksBinary(head)) return `${shown} looks like a binary file. Sovran can attach text files only.`;
    return undefined;
  }

  /** Adds a checked file to the next message. Protected files ask first, as they would when the agent reads them. */
  private async addAttachment(absolute: string, shown: string, external = false) {
    if (this.attachments.some((a) => a.absolute === absolute)) return;
    const label = path.basename(absolute);
    if (isProtectedPath(shown, this.settings.agent.policy.protectedPaths)) {
      const choice = await vscode.window.showWarningMessage(
        `Attach ${label}?`,
        { modal: true, detail: `${shown} matches a protected-path pattern. Its contents are sent to the model with your next message.` },
        'Attach',
      );
      if (choice !== 'Attach' || this.attachments.some((a) => a.absolute === absolute)) return;
    }
    this.attachments.push({ id: randomUUID(), path: shown, label, absolute, ...(external ? { external: true } : {}) });
  }

  /** `@` and attach-menu suggestions. Before anything is typed, the active editor and the open tabs come first. */
  private async suggestFiles(query: string): Promise<FileSuggestionView[]> {
    if (query.trim()) return this.deps.fileIndex.suggest(query);
    const multi = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
    const active = vscode.window.activeTextEditor?.document.uri;
    const activeAbs = active?.scheme === 'file' ? active.fsPath : undefined;
    const activeRel = activeAbs ? vscode.workspace.asRelativePath(activeAbs, multi) : undefined;
    // Open files outside the workspace and protected files are never suggested.
    const preferred = [...new Set([...(activeAbs ? [activeAbs] : []), ...this.deps.workspace.openEditors()])]
      .filter((abs) => vscode.workspace.getWorkspaceFolder(vscode.Uri.file(abs)))
      .map((abs) => vscode.workspace.asRelativePath(abs, multi))
      .filter((rel) => !isProtectedPath(rel, this.settings.agent.policy.protectedPaths));
    const open = new Set(preferred);
    const items = await this.deps.fileIndex.suggest('', 20, preferred);
    return items.map((i) => (open.has(i.path) ? { ...i, hint: i.path === activeRel ? 'active' : 'open' } : i));
  }

  /** One folder of the workspace for the attach menu, confined to the workspace like every other path. */
  private async listDirectory(requestId: string, requested: string) {
    const reply = (listing: DirectoryListingView) => this.send({ type: 'directoryListing', requestId, listing });
    const roots = this.deps.workspace.roots();
    const dir = requested.trim().replace(/^\.\/?$/, '').replace(/\/+$/, '');
    if (!roots.length) return reply({ path: '', entries: [], error: 'Open a folder to browse its files.' });
    if (!dir && roots.length > 1) {
      return reply({ path: '', entries: roots.map((r) => ({ name: r.name, path: r.name, type: 'directory' as const })) });
    }
    let resolved: ResolvedPath;
    try {
      resolved = await resolveAndVerify(dir || '.', this.deps.workspace);
    } catch (e) {
      return reply({ path: dir, entries: [], error: e instanceof PathError ? e.message : `${dir} is not inside the workspace.` });
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
      const inRoot = path.relative(resolved.root.path, path.join(resolved.absolute, e.name)).split(path.sep).join('/');
      if (excluded(inRoot)) continue;
      const p = base ? `${base}/${e.name}` : e.name;
      entries.push({ name: e.name, path: p, type: e.type, ...(e.type === 'file' && isProtectedPath(p, protectedPaths) ? { protected: true } : {}) });
    }
    entries.sort(compareEntries);
    reply({ path: base, entries: entries.slice(0, MAX_LISTING), ...(entries.length > MAX_LISTING ? { truncated: true } : {}) });
  }

  /** The user's `files.exclude` patterns (those set to true) for one workspace folder, as the Explorer applies them. */
  private filesExclude(root: WorkspaceRoot): (pathInRoot: string) => boolean {
    const config = vscode.workspace.getConfiguration('files', vscode.Uri.file(root.path)).get<Record<string, unknown>>('exclude') ?? {};
    const globs = Object.entries(config)
      .filter(([, on]) => on === true)
      .map(([glob]) => glob);
    if (!globs.length) return () => false;
    const isMatch = picomatch(globs, { dot: true });
    return (p) => isMatch(p);
  }

  // ------------------------------------------------------------------ sessions

  private setView(view: View) {
    this.view = view;
    this.patch({ view });
  }

  showView(view: View) {
    this.setView(view);
  }

  focusComposer(text?: string) {
    this.setView('chat');
    this.send({ type: 'focusComposer', text });
  }

  newSession() {
    if (this.session.messages.length === 0) {
      this.setView('chat');
      this.send({ type: 'focusComposer' });
      return;
    }
    this.session = newSession(this.mode);
    this.loaded.set(this.session.id, this.session);
    this.view = 'chat';
    this.send({ type: 'state', state: this.snapshot() });
    this.send({ type: 'focusComposer' });
  }

  private async openSession(id: string) {
    let s = this.loaded.get(id);
    if (!s) {
      const stored = await this.deps.repo.load(id);
      if (!stored) {
        this.notice('error', 'This chat could not be loaded. It may have been deleted.');
        this.sessions = await this.deps.repo.list();
        this.patch({ sessions: this.sessions });
        return;
      }
      s = repairInterruptedSession(stored, Date.now());
      this.loaded.set(id, s);
    }
    this.session = s;
    this.view = 'chat';
    this.send({ type: 'state', state: this.snapshot() });
  }

  private async renameSession(id: string, title: string) {
    const s = this.loaded.get(id) ?? (await this.deps.repo.load(id));
    if (!s) return;
    s.title = title;
    s.updatedAt = Date.now();
    await this.persist(s);
    if (s.id === this.session.id) this.patch({ session: { id: s.id, title: s.title, messages: s.messages } });
  }

  private async deleteSession(id: string) {
    const summary = this.sessions.find((s) => s.id === id);
    const choice = await vscode.window.showWarningMessage(`Delete "${summary?.title ?? 'this chat'}"?`, { modal: true, detail: 'This cannot be undone.' }, 'Delete');
    if (choice !== 'Delete') return;
    if (this.run?.sessionId === id) this.cancel();
    await this.deps.repo.delete(id);
    await this.deps.checkpoints.deleteForSession(id).catch(() => undefined);
    this.loaded.delete(id);
    this.grants.delete(id);
    this.sessions = await this.deps.repo.list();
    if (this.session.id === id) {
      this.session = newSession(this.mode);
      this.loaded.set(this.session.id, this.session);
      this.send({ type: 'state', state: this.snapshot() });
    } else {
      this.patch({ sessions: this.sessions });
    }
  }

  private schedulePersist(session: Session) {
    clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => void this.persist(session), 500);
  }

  private async persist(session: Session) {
    if (session.messages.length === 0) return;
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
      this.notice('warning', 'Act mode needs a trusted workspace. Use "Manage Workspace Trust" to trust this folder.');
      mode = 'plan';
    }
    this.mode = mode;
    this.session.mode = mode;
    this.updateStatusBar();
    this.patch({ mode });
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
      this.notice('warning', 'Automatic approvals need a trusted workspace. Use "Manage Workspace Trust" to trust this folder.');
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
    const pick = await vscode.window.showQuickPick(items, { title: 'Sovran: Approvals in Act Mode', placeHolder: `Current: ${APPROVAL_LABEL[this.approvalMode]}` });
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
    if (select && provider.models?.some((m) => m.id === select)) await this.setModel('act', { providerId, modelId: select });
    this.patch({ providers: this.providerViews(), selected: this.selected });
  }

  private async updateSetting(update: SettingUpdate) {
    await writeSetting(update);
    if (update.key === 'sessions.persist') {
      const choice = await vscode.window.showInformationMessage('Sovran: the chat history setting applies after the window reloads.', 'Reload Window');
      if (choice) await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
    // onDidChangeConfiguration refreshes the state and pushes it to the webview.
  }

  private validSelection(sel: SelectedModel | null): SelectedModel | null {
    const has = (s: SelectedModel | null) => !!s && !!this.providers.find((p) => p.id === s.providerId)?.models?.some((m) => m.id === s.modelId);
    if (has(sel)) return sel;
    for (const p of this.providers) {
      const m = p.models?.[0];
      if (m) return { providerId: p.id, modelId: m.id };
    }
    return null;
  }

  private exists(sel: SelectedModel | null): sel is SelectedModel {
    return !!sel && !!this.providers.find((p) => p.id === sel.providerId)?.models?.some((m) => m.id === sel.modelId);
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
  }

  async pickModel() {
    if (this.providers.length === 0) {
      this.setView('providers');
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
        const current = (this.mode !== 'plan' || this.planModel) && effective?.providerId === p.id && effective.modelId === m.id;
        items.push({ label: `${current ? '$(check) ' : ''}${m.name ?? m.id}`, description: m.name ? m.id : undefined, sel: { providerId: p.id, modelId: m.id } });
      }
      if (!p.models?.length) items.push({ label: '$(warning) No models configured', description: 'Use Discover models', action: 'discover' });
    }
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    items.push({ label: '$(refresh) Discover models from servers…', action: 'discover' });
    items.push({ label: '$(server-environment) Manage providers…', action: 'manage' });
    const pick = await vscode.window.showQuickPick(items, {
      title: this.mode === 'plan' ? 'Sovran: Select Model for Plan Mode' : 'Sovran: Select Model',
      placeHolder: this.mode === 'plan' ? 'Plan mode can use a different (e.g. larger) model than Act mode' : 'Choose the model for this chat',
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
      this.setView('providers');
      return this.deps.reveal();
    }
    if (pick.action === 'discover') return this.discoverAndPick();
  }

  private async discoverAndPick() {
    const found = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Sovran: Discovering models…', cancellable: true },
      async (_p, token) => {
        const ac = new AbortController();
        token.onCancellationRequested(() => ac.abort());
        const results: Array<{ provider: ProviderConfig; models: string[]; info?: ModelInfo[]; error?: string }> = [];
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
        items.push({ label: m, description: known ? 'configured' : 'add', providerId: r.provider.id, modelId: m });
      }
    }
    const pick = await vscode.window.showQuickPick(items, { title: 'Sovran: Discovered Models', placeHolder: 'Pick a model to add and select' });
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
    await Promise.all(this.providers.map(async (p) => this.keyStatus.set(p.id, await this.deps.secrets.has(p.id))));
    this.detectServerLimits();
  }

  private useProviders() {
    this.providers = this.syncing && this.settingsStale ? this.fileProviders : this.settingsProviders;
  }

  // ------------------------------------------------------------------ config file (synced with Settings)

  private queueConfig(task: () => Promise<void>): Promise<void> {
    this.configQueue = this.configQueue.then(() =>
      task().catch((e) => this.deps.logger.error(`config.yaml sync failed: ${e instanceof Error ? e.message : String(e)}`)),
    );
    return this.configQueue;
  }

  /** `startup`/`change`: read the file; `enable`: the user turned the file back on, so Settings win the first merge. */
  private reloadConfigFile(trigger: 'startup' | 'change' | 'enable'): Promise<void> {
    return this.queueConfig(() => this.loadConfigFile(trigger));
  }

  private modelRefs(): Record<ModelChoiceKey, string> {
    const ref = (s: SelectedModel | null) => (s ? `${s.providerId}/${s.modelId}` : '');
    return { defaultModel: ref(this.selected), planModel: ref(this.planModel), titleModel: ref(this.titleModel) };
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
      this.notice('warning', `${what} saved in Settings but not in ${file.displayPath}: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
    if (next === current) return true;
    const known = new Set([...this.settingsModelRefs(), ...providers.flatMap((p) => (p.models ?? []).map((m) => `${p.id}/${m.id}`))]);
    const check = parseConfigFile(next, { otherModels: known });
    if (!check.ok) {
      this.notice('warning', `${what} saved in Settings but cannot be written to ${file.displayPath}: ${check.problems[0]!.message}`);
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
    const view = (state: ConfigFileView['state'], problems: ConfigFileView['problems'] = []): ConfigFileView => ({
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
        : { ok: false as const, problems: [{ message: read.message, line: 0, column: 0, endLine: 0, endColumn: 0 }] };
    if (!result.ok) {
      file.setProblems(result.problems);
      this.configFileView = view(
        'error',
        result.problems.slice(0, 5).map((p) => ({ line: p.line + 1, message: p.message })),
      );
      this.patch({ configFile: this.configFileView });
      this.deps.logger.warn(`config.yaml has ${result.problems.length} problem(s); keeping the last valid version.`);
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
    const ownWrite = file.isOwnWrite(text);
    const previous = new Map(this.fileProviders.map((p) => [p.id, JSON.stringify(p)]));
    let providers = result.config.providers;
    if (!file.isSynced() || trigger === 'enable') {
      // First sync: join both sides. A file turned back on is stale, so Settings win there; otherwise the file does.
      providers =
        trigger === 'enable'
          ? mergeProviders(providers, this.settingsProviders).providers
          : mergeProviders(this.settingsProviders, providers).providers;
      if (!sameProviders(providers, result.config.providers)) await this.writeConfigText(text, providers, 'The providers from Settings are');
      await file.setSynced(true);
      if (trigger === 'enable') this.notice('info', `Using ${file.displayPath} again, in sync with Settings.`);
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
        this.notice('warning', `Could not update Settings from ${file.displayPath}: ${e instanceof Error ? e.message : String(e)}`);
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
      const noModels = !current.models?.length && result.models?.length ? ' Add the models you want under "models:".' : '';
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
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'provider';
    let id = base;
    for (let i = 2; this.providers.some((p) => p.id === id); i++) id = `${base}-${i}`;
    return id;
  }

  private async saveProvider(input: ProviderInput, requestId?: string) {
    const existing = input.id ? this.settingsProviders.find((p) => p.id === input.id) : undefined;
    const id = existing?.id ?? this.slug(input.name);
    const config: ProviderConfig = {
      id,
      name: input.name,
      baseUrl: input.baseUrl.replace(/\/+$/, ''),
      auth: { type: input.authType, ...(input.authType === 'header' && input.headerName ? { headerName: input.headerName } : {}) },
      ...(existing?.headers ? { headers: existing.headers } : {}),
      ...(input.timeoutSeconds ? { timeoutSeconds: input.timeoutSeconds } : {}),
      models: input.models.map((m) => {
        // Keep what the form does not edit (name, temperature); the form's fields replace the old values, and an
        // emptied field removes them, so the model falls back to what the server reports or to the default.
        const { contextWindow: _c, maxOutputTokens: _o, toolMode: _t, ...kept } = existing?.models?.find((x) => x.id === m.id) ?? { id: m.id };
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
    this.settingsProviders = existing ? this.settingsProviders.map((p) => (p.id === id ? config : p)) : [...this.settingsProviders, config];
    await writeProviders(this.settingsProviders);
    this.useProviders();
    if (config.auth?.type !== 'none' && !(await this.deps.secrets.has(id))) await this.promptApiKey(id);
    if (!this.selected) this.selected = this.validSelection(null);
    if (this.selected) await writeDefaultModel(`${this.selected.providerId}/${this.selected.modelId}`);
    this.updateStatusBar();
    this.patch({ providers: this.providerViews(), selected: this.selected });
    if (requestId) {
      // Guided setup: confirm the save, then test the connection and report the models the server offers.
      this.send({ type: 'providerSaved', requestId, providerId: id });
      await this.testProvider(requestId, id);
    } else {
      this.notice('info', `Saved ${config.name}.`);
    }
  }

  private async deleteProvider(id: string) {
    const p = this.settingsProviders.find((x) => x.id === id);
    if (!p) return;
    const choice = await vscode.window.showWarningMessage(`Remove provider "${p.name}"?`, { modal: true, detail: 'Its stored API key is deleted too.' }, 'Remove');
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
      prompt: 'Paste the key only, without "Bearer ". Stored in VS Code Secret Storage, never in settings. Leave empty and press Enter to remove the key.',
      password: true,
      ignoreFocusOut: true,
    });
    if (value === undefined) return;
    const { key, notes } = normalizeApiKey(value);
    if (key) await this.deps.secrets.set(id, key);
    else await this.deps.secrets.delete(id);
    this.keyStatus.set(id, !!key);
    if (key) this.detectServerLimits();
    if (key && notes.length) this.notice('info', `Saved the key for ${provider.name} without ${notes.join(', ')}.`);
    this.patch({ providers: this.providerViews() });
  }

  private async testProvider(requestId: string, providerId: string) {
    const config = this.providers.find((p) => p.id === providerId);
    if (!config) return;
    this.send({ type: 'providerTest', requestId, providerId, result: await this.checkConnection(config) });
  }

  /** Lists the server's models, or (for gateways without /models) sends a one-token completion. */
  /** Lists the server's models, or (for gateways without /models, or that refuse it to the key) pings the chat. */
  private async checkConnection(config: ProviderConfig): Promise<ProviderTestResult> {
    const { info, ...result } = await probeConnection(this.createProvider(config), config.models?.[0]?.id, config.baseUrl);
    if (info && this.storeServerLimits(config, info)) this.patch({ providers: this.providerViews() });
    return result;
  }

  // ------------------------------------------------------------------ model limits reported by servers

  private serverLimits(providerId: string, modelId: string): ServerLimits | undefined {
    const c = this.deps.capabilities.get(capabilityKey(providerId, modelId));
    return c?.contextWindow || c?.maxOutputTokens ? { contextWindow: c.contextWindow, maxOutputTokens: c.maxOutputTokens } : undefined;
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
      const { contextWindow: oldCtx, maxOutputTokens: oldOut, ...rest } = this.deps.capabilities.get(key) ?? { updatedAt: 0 };
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
          const info = provider.listModelInfo ? await provider.listModelInfo(AbortSignal.timeout(15_000)) : [];
          if (this.storeServerLimits(p, info)) this.patch({ providers: this.providerViews() });
        } catch (e) {
          this.deps.logger.debug(`Could not read model limits from ${p.id}: ${e instanceof Error ? e.message : String(e)}`);
        }
      })();
    }
  }

  // ------------------------------------------------------------------ runs

  private async sendPrompt(text: string) {
    if (this.run) {
      this.notice('warning', 'Sovran is still working. Stop the current run before sending another message.');
      return;
    }
    const slash = parseSlash(text);
    const command = slash ? this.commands.find((c) => c.name === slash.name) : undefined;
    if (command?.kind === 'action') {
      if (command.name === 'compact') return this.compactNow();
      if (command.name === 'new') return this.newSession();
    }
    const user: UserMessage = {
      role: 'user',
      id: randomUUID(),
      content: command && slash ? expandCommand(command, slash.args) : text,
      ...(command ? { display: text } : {}),
      createdAt: Date.now(),
    };
    const attachments = await this.collectAttachments();
    if (attachments.length) user.attachments = attachments;
    this.attachments = [];
    this.patch({ context: this.contextView() });
    await this.startRun(this.session, user);
  }

  private resolveModel(): { provider: ProviderConfig; model: ModelConfig } | undefined {
    const sel = this.effectiveModel();
    const provider = sel && this.providers.find((p) => p.id === sel.providerId);
    const model = sel && provider?.models?.find((m) => m.id === sel.modelId);
    if (!provider || !model) {
      this.notice('error', 'Add a model provider before chatting.');
      this.setView('providers');
      return undefined;
    }
    // A copy: the limits the server reported are used for this run and never written back to settings or the file.
    return { provider, model: { ...model, serverLimits: this.serverLimits(provider.id, model.id) } };
  }

  private createRunner(provider: ProviderConfig, workspace: WorkspacePort) {
    return new AgentRunner({
      provider: this.createProvider(provider),
      registry: this.registry,
      workspace,
      process: this.deps.process,
      approvals: this,
      capabilities: this.deps.capabilities,
      logger: this.deps.logger,
    });
  }

  private beginRun(session: Session, activity: RunView['activity']): ActiveRun {
    const abort = new AbortController();
    const view: RunView = { sessionId: session.id, iteration: 0, maxIterations: this.settings.agent.maxIterations, startedAt: Date.now(), activity };
    this.run = { sessionId: session.id, abort, view };
    this.patch({ run: view });
    this.updateStatusBar();
    return this.run;
  }

  /** Appends `user` (if needed) and runs the agent for it. `mergeInto` keeps an earlier checkpoint when retrying. */
  private async startRun(session: Session, user: UserMessage, mergeInto?: Checkpoint) {
    const resolved = this.resolveModel();
    if (!resolved) return;
    const { provider, model } = resolved;
    if (provider.auth?.type !== 'none' && !this.keyStatus.get(provider.id)) {
      this.notice('warning', `${provider.name} has no API key stored. Requests are sent without credentials.`);
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
    this.send({ type: 'messageUpsert', sessionId: session.id, message: user });
    if (session.id === this.session.id) this.patch({ session: { id: session.id, title: session.title, messages: session.messages } });
    void this.persist(session);

    const mode: AgentMode = vscode.workspace.isTrusted ? this.mode : 'plan';
    const run = this.beginRun(session, { phase: 'thinking', label: 'Thinking' });
    const secret = await this.deps.secrets.get(provider.id);
    this.deps.logger.addSecret(secret);
    // Every write in this run goes through the recorder, so the run can be undone as a unit.
    const recorder = new CheckpointRecorder(this.deps.workspace);
    const runner = this.createRunner(provider, recorder);
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
        secrets: [secret],
        autoCompact: this.settings.autoCompact,
        // Read live: switching the approval mode or allowing a command mid-run applies to the next action.
        policy: () => ({ ...this.settings.agent.policy, approvalMode: this.approvalMode }),
      });
      this.deps.logger.info(`Run finished · ${outcome.reason}${outcome.error ? ` · ${outcome.error.kind}` : ''}`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.deps.logger.error(`Run crashed: ${message}`);
      this.notice('error', `The run stopped unexpectedly: ${message}`);
    } finally {
      this.flush();
      for (const [id, a] of this.approvals) {
        a.settle({ approved: false });
        this.approvals.delete(id);
      }
      this.run = null;
      await this.saveCheckpoint(session, user, recorder.changedFiles(), mergeInto);
      session.updatedAt = Date.now();
      clearTimeout(this.persistTimer);
      await this.persist(session);
      this.updateStatusBar();
      if (session.id === this.session.id) {
        this.patch({ run: null, approvals: [], grants: { edits: this.grantsFor(session.id).edits } });
      }
    }
  }

  /**
   * Asks the model for a short title, in parallel with the run (a few tokens, so it barely delays it). Runs on the
   * title model when one is set, else on the chat's model. The title is kept only if the user has not renamed the chat
   * or deleted it meanwhile; any failure keeps the first-words title.
   */
  private async nameSession(session: Session, text: string, chat: { provider: ProviderConfig; model: ModelConfig }) {
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
      if (session.id === this.session.id) this.patch({ session: { id: session.id, title: session.title, messages: session.messages } });
      await this.persist(session);
    } catch (e) {
      const err = e instanceof ProviderError ? e : errorFromException(e, { url: provider.baseUrl });
      this.deps.logger.warn(`Naming the chat with ${provider.id}/${model.id} failed: ${err.message}`);
    } finally {
      clearTimeout(timer);
      this.titleRequests.delete(ac);
    }
  }

  private async saveCheckpoint(session: Session, user: UserMessage, files: FileSnapshot[], mergeInto?: Checkpoint) {
    const merged = mergeInto ? mergeSnapshots(mergeInto.files, files) : files;
    if (merged.length === 0) return;
    const checkpoint: Checkpoint = { id: mergeInto?.id ?? randomUUID(), sessionId: session.id, userMessageId: user.id, createdAt: Date.now(), files: merged };
    try {
      await this.deps.checkpoints.save(checkpoint);
    } catch (e) {
      this.deps.logger.error(`Saving checkpoint failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    user.checkpoint = { id: checkpoint.id, files: merged.map((f) => this.rel(f.absolutePath)) };
    this.send({ type: 'messageUpsert', sessionId: session.id, message: user });
  }

  // ------------------------------------------------------------------ rollback, retry, rewind

  private async restoreCheckpoint(messageId: string) {
    if (this.run?.sessionId === this.session.id) return this.notice('warning', 'Stop the current run before undoing changes.');
    const user = this.session.messages.find((m): m is UserMessage => m.id === messageId && m.role === 'user');
    if (!user?.checkpoint || user.checkpoint.restoredAt) return;
    const checkpoint = await this.deps.checkpoints.load(this.session.id, user.checkpoint.id);
    if (!checkpoint) return this.notice('error', 'The snapshot for these changes is no longer available.');
    const plan = await planRestore(checkpoint.files, this.deps.workspace);
    const modified = plan.filter((p) => p.state === 'modified');
    let includeModified = false;
    if (modified.length) {
      const names = modified.slice(0, 6).map((p) => this.rel(p.snapshot.absolutePath)).join('\n');
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
    this.send({ type: 'messageUpsert', sessionId: this.session.id, message: user });
    await this.persist(this.session);
    this.notice(
      'info',
      `Undid changes to ${result.restored.length} file${result.restored.length === 1 ? '' : 's'}${result.skipped.length ? `; kept ${result.skipped.length} you changed` : ''}. Use Undo in the editor to reverse this.`,
    );
  }

  /** Asks whether discarded responses should also have their file changes undone. */
  private async confirmRewind(users: readonly UserMessage[]): Promise<'none' | 'undo' | 'keep' | 'cancel'> {
    const pending = users.filter((u) => u.checkpoint && !u.checkpoint.restoredAt);
    if (pending.length === 0) return 'none';
    const files = [...new Set(pending.flatMap((u) => u.checkpoint!.files))];
    const choice = await vscode.window.showWarningMessage(
      `Also undo the file changes from the discarded response${pending.length === 1 ? '' : 's'}?`,
      { modal: true, detail: `${files.length} file${files.length === 1 ? '' : 's'} changed:\n${files.slice(0, 8).join('\n')}${files.length > 8 ? '\n…' : ''}` },
      'Undo changes',
      'Keep changes',
    );
    return choice === 'Undo changes' ? 'undo' : choice === 'Keep changes' ? 'keep' : 'cancel';
  }

  private async undoMessages(session: Session, users: readonly UserMessage[]) {
    let skipped = 0;
    for (const u of [...users].reverse()) {
      if (!u.checkpoint || u.checkpoint.restoredAt) continue;
      const cp = await this.deps.checkpoints.load(session.id, u.checkpoint.id);
      if (!cp) continue;
      const result = await restoreFiles(await planRestore(cp.files, this.deps.workspace), this.deps.workspace, false);
      skipped += result.skipped.length;
      u.checkpoint.restoredAt = Date.now();
    }
    if (skipped) this.notice('warning', `Kept ${skipped} file${skipped === 1 ? '' : 's'} you changed after Sovran edited ${skipped === 1 ? 'it' : 'them'}.`);
  }

  /** Drops the compaction boundary when the message it points to no longer exists. */
  private fixCompaction(session: Session) {
    if (session.compaction && !session.messages.some((m) => m.id === session.compaction!.firstKeptId)) delete session.compaction;
  }

  private async retry() {
    if (this.run) return this.notice('warning', 'Stop the current run before retrying.');
    const session = this.session;
    let i = session.messages.length - 1;
    while (i >= 0 && session.messages[i]!.role !== 'user') i--;
    if (i < 0) return;
    const user = session.messages[i] as UserMessage;
    const decision = await this.confirmRewind([user]);
    if (decision === 'cancel') return;
    let mergeInto: Checkpoint | undefined;
    if (decision === 'undo') {
      await this.undoMessages(session, [user]);
      delete user.checkpoint;
    } else if (decision === 'keep' && user.checkpoint) {
      mergeInto = await this.deps.checkpoints.load(session.id, user.checkpoint.id);
    }
    session.messages.length = i + 1;
    this.fixCompaction(session);
    this.send({ type: 'state', state: this.snapshot() });
    await this.startRun(session, user, mergeInto);
  }

  private async editMessage(messageId: string, text: string) {
    if (this.run) return this.notice('warning', 'Stop the current run before editing a message.');
    const session = this.session;
    const i = session.messages.findIndex((m) => m.id === messageId && m.role === 'user');
    if (i < 0) return;
    const original = session.messages[i] as UserMessage;
    const discarded = session.messages.slice(i).filter((m): m is UserMessage => m.role === 'user');
    const decision = await this.confirmRewind(discarded);
    if (decision === 'cancel') return;
    if (decision === 'undo') await this.undoMessages(session, discarded);
    session.messages.length = i;
    this.fixCompaction(session);
    const slash = parseSlash(text);
    const command = slash ? this.commands.find((c) => c.name === slash.name && c.kind === 'prompt') : undefined;
    const user: UserMessage = {
      role: 'user',
      id: randomUUID(),
      content: command && slash ? expandCommand(command, slash.args) : text,
      ...(command ? { display: text } : {}),
      ...(original.attachments ? { attachments: original.attachments } : {}),
      createdAt: Date.now(),
    };
    this.send({ type: 'state', state: this.snapshot() });
    await this.startRun(session, user);
  }

  private async compactNow() {
    if (this.run) return this.notice('warning', 'Stop the current run before compacting.');
    const session = this.session;
    if (!planCompaction(messagesForModel(session), 1)) {
      return this.notice('info', 'There is not enough conversation to summarize yet.');
    }
    const resolved = this.resolveModel();
    if (!resolved) return;
    const run = this.beginRun(session, { phase: 'compacting', label: 'Summarizing earlier messages' });
    const secret = await this.deps.secrets.get(resolved.provider.id);
    try {
      await this.createRunner(resolved.provider, this.deps.workspace).compact(
        { session, model: resolved.model, settings: this.settings.agent, signal: run.abort.signal, emit: (e) => this.onAgentEvent(session, e), secrets: [secret] },
        1,
      );
    } finally {
      this.run = null;
      await this.persist(session);
      this.updateStatusBar();
      if (session.id === this.session.id) this.patch({ run: null });
    }
  }

  /** Attaches a workspace file named by the webview (`@` mention, attach menu) or picked in a dialog. */
  private async attachPath(p: string, push = true) {
    let resolved;
    try {
      // Symlink-aware: a link inside the repository must not attach a file from outside it.
      resolved = await resolveAndVerify(p, this.deps.workspace);
    } catch (e) {
      return this.notice('warning', e instanceof PathError ? e.message : `${p} is not inside the workspace.`);
    }
    const problem = await this.fileProblem(resolved.absolute, resolved.relative);
    if (problem) return this.notice('warning', problem);
    await this.addAttachment(resolved.absolute, resolved.relative);
    if (push) this.patch({ context: this.contextView() });
  }

  cancel() {
    if (!this.run) return;
    this.run.abort.abort();
    this.run.view = { ...this.run.view, activity: { phase: 'thinking', label: 'Stopping' } };
    this.patch({ run: this.run.view });
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

  private onAgentEvent(session: Session, e: AgentEvent) {
    const visible = session.id === this.session.id;
    const run = this.run;
    const setActivity = (activity: RunView['activity'], extra: Partial<RunView> = {}) => {
      if (!run) return;
      run.view = { ...run.view, ...extra, activity };
      if (visible) this.patch({ run: run.view });
    };
    switch (e.type) {
      case 'iteration':
        return setActivity({ phase: 'thinking', label: 'Thinking' }, { iteration: e.iteration, maxIterations: e.maxIterations });
      case 'message_started':
        if (visible) this.send({ type: 'messageUpsert', sessionId: session.id, message: e.message });
        return;
      case 'text_delta':
      case 'reasoning_delta': {
        const field = e.type === 'text_delta' ? 'content' : 'reasoning';
        if (run && run.view.activity.phase === 'thinking' && field === 'content') setActivity({ phase: 'streaming', label: 'Writing' });
        if (!visible) return;
        const key = `${e.messageId}:${field}`;
        const prev = this.deltas.get(key);
        if (prev) prev.text += e.text;
        else this.deltas.set(key, { type: 'messageDelta', sessionId: session.id, messageId: e.messageId, field, text: e.text });
        return this.scheduleFlush();
      }
      case 'tool_call_streaming':
        return setActivity({ phase: 'streaming', label: `Preparing ${e.name.replace(/_/g, ' ')}`, toolName: e.name });
      case 'message_committed':
        this.flush();
        if (visible) this.send({ type: 'messageUpsert', sessionId: session.id, message: e.message });
        return this.schedulePersist(session);
      case 'message_removed':
        this.flush();
        if (visible) this.send({ type: 'messageRemoved', sessionId: session.id, messageId: e.messageId });
        return;
      case 'tool_phase':
        return setActivity({ phase: e.phase, label: e.label, toolName: e.toolName, callId: e.callId });
      case 'tool_output': {
        if (!visible) return;
        const prev = this.outputs.get(e.callId);
        if (prev) prev.chunk += e.chunk;
        else this.outputs.set(e.callId, { type: 'toolOutput', sessionId: session.id, callId: e.callId, chunk: e.chunk });
        return this.scheduleFlush();
      }
      case 'notice':
        return this.notice(e.level, e.message);
      case 'context':
        session.usage = { tokens: e.estimatedTokens, contextWindow: e.contextWindow, source: 'estimate', updatedAt: Date.now() };
        if (visible) this.patch({ usage: this.usageView(session) });
        return;
      case 'usage':
        if (e.promptTokens && session.usage) {
          session.usage = { ...session.usage, tokens: e.promptTokens, source: 'server', updatedAt: Date.now() };
          if (visible) this.patch({ usage: this.usageView(session) });
        }
        return;
      case 'compaction_started':
        return setActivity({ phase: 'compacting', label: 'Summarizing earlier messages' });
      case 'compacted':
        if (visible) this.patch({ compaction: this.compactionView(session) });
        this.notice('info', `Summarized ${e.compaction.summarizedCount} earlier messages to free context. The full transcript is still shown here.`);
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
    for (const d of this.deltas.values()) this.send(d);
    for (const o of this.outputs.values()) this.send(o);
    this.deltas.clear();
    this.outputs.clear();
  }

  // ------------------------------------------------------------------ approvals (ApprovalPort)

  request(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalResponse> {
    return new Promise<ApprovalResponse>((resolve, reject) => {
      const d = request.detail;
      const view: ApprovalView = {
        id: request.id,
        callId: request.callId,
        toolName: request.toolName,
        title: request.title,
        detail:
          d.kind === 'edit'
            ? { kind: 'edit', path: d.path, isNew: d.isNew, diff: d.diff, added: d.added, removed: d.removed }
            : d.kind === 'command'
              ? { kind: 'command', command: d.command, cwd: d.cwd, warnings: d.warnings, allowPrefix: d.warnings.length ? null : suggestAllowPrefix(d.command) }
              : { kind: 'read', path: d.path, reason: d.reason },
        ...(request.reason ? { reason: request.reason } : {}),
      };
      const cleanup = () => {
        signal.removeEventListener('abort', onAbort);
        this.approvals.delete(request.id);
        if (d.kind === 'edit') void this.deps.diff.release(request.id);
        this.patch({ approvals: this.visibleApprovals() });
      };
      const onAbort = () => {
        cleanup();
        reject(new Error('cancelled'));
      };
      if (signal.aborted) return reject(new Error('cancelled'));
      signal.addEventListener('abort', onAbort, { once: true });
      this.approvals.set(request.id, {
        view,
        request,
        settle: (r) => {
          cleanup();
          resolve(r);
        },
      });
      if (d.kind === 'edit') {
        this.deps.diff.register(request.id, d.proposedContent);
        if (this.settings.openDiffOnProposal) void this.deps.diff.show(request.id, d.path, d.absolutePath, d.isNew);
      }
      this.patch({ approvals: this.visibleApprovals() });
      if (!this.post) {
        void vscode.window.showInformationMessage(`Sovran needs your approval: ${request.title}`, 'Review').then((c) => {
          if (c) void this.deps.reveal();
        });
      }
    });
  }

  private async resolveApproval(id: string, response: ApprovalResponse, allowCommand?: string) {
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
        this.notice('info', `Commands starting with "${allowCommand}" now run without asking. Manage the list in Settings.`);
      } else {
        this.deps.logger.warn('Ignored an allow-list entry that does not match the approved command.');
      }
    }
    pending.settle(response);
  }

  // ------------------------------------------------------------------ editor helpers

  private async openFile(p: string, line?: number) {
    let resolved;
    try {
      resolved = resolveWorkspacePath(p, this.deps.workspace.roots());
    } catch {
      return this.notice('warning', `Cannot open ${p}: it is not inside the workspace.`);
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(resolved.absolute));
    const pos = new vscode.Position(Math.max(0, (line ?? 1) - 1), 0);
    await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos), preview: true });
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

  private async insertCode(code: string) {
    const ed = vscode.window.activeTextEditor;
    if (!ed) return this.notice('warning', 'Open a file to insert code.');
    await ed.edit((b) => b.replace(ed.selection, code));
  }
}
