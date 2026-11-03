import * as vscode from 'vscode';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentRunner } from '../core/agent/agentRunner';
import { CheckpointRecorder, planRestore, restoreFiles, type Checkpoint, type FileSnapshot } from '../core/checkpoints/checkpoints';
import { expandCommand, mergeCommands, parseSlash, type SlashCommand } from '../core/commands/slashCommands';
import { planCompaction } from '../core/context/compaction';
import type { AgentEvent } from '../core/agent/events';
import { matchesAllowList, suggestAllowPrefix } from '../core/permissions/commands';
import type { AgentMode, ApprovalMode, SessionGrants } from '../core/permissions/policy';
import { isProtectedPath } from '../core/permissions/policy';
import type { ApprovalPort, ApprovalRequest, ApprovalResponse, WorkspacePort } from '../core/ports';
import { capabilityKey, type CapabilityStore } from '../core/providers/capabilities';
import { ProviderError, errorFromException } from '../core/providers/errors';
import { OpenAICompatibleProvider } from '../core/providers/openaiCompatible';
import type { ModelConfig, ProviderConfig } from '../core/providers/types';
import { PathError, resolveAndVerify, resolveWorkspacePath } from '../core/security/paths';
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
import { createBuiltinRegistry } from '../core/tools/builtin';
import type {
  AppState,
  ApprovalView,
  AttachmentView,
  EditorContextView,
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
  readProviders,
  readSettings,
  readSettingsView,
  writeDefaultModel,
  writePlanModel,
  writeProviders,
  writeSetting,
  type HostSettings,
} from './config';
import type { HostLogger, ProviderSecrets, SovranStatusBar } from './services';

const MAX_ATTACHMENT_CHARS = 50_000;
const MAX_EDITOR_FILE_CHARS = 12_000;
const DELTA_FLUSH_MS = 40;

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
  private providers: ProviderConfig[] = [];
  private keyStatus = new Map<string, boolean>();
  private selected: SelectedModel | null = null;
  private planModel: SelectedModel | null = null;
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
    await this.reloadProviders();
    const def = readDefaultModel();
    const [pid, ...rest] = def.split('/');
    this.selected = this.validSelection(pid && rest.length ? { providerId: pid, modelId: rest.join('/') } : null);
    this.planModel = this.parseModelRef(readPlanModel());
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
      vscode.workspace.onDidChangeConfiguration(async (e) => {
        if (!e.affectsConfiguration('sovran')) return;
        this.settings = readSettings();
        await this.reloadProviders();
        this.selected = this.validSelection(this.selected);
        this.planModel = this.parseModelRef(readPlanModel());
        this.updateStatusBar();
        this.updateEditorContext();
        this.patch({
          providers: this.providerViews(),
          selected: this.selected,
          planModel: this.planModel,
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
          return this.send({ type: 'fileSuggestions', requestId: msg.requestId, items: await this.deps.fileIndex.suggest(msg.query) });
        case 'attachPath':
          return await this.attachPath(msg.path);
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
      usage: this.usageView(this.session),
      compaction: this.compactionView(this.session),
      commands: this.commandViews(),
      settings: readSettingsView(this.settings),
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
      attachments: this.attachments.map(({ id, path: p, label }) => ({ id, path: p, label })),
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
        // Re-verified at send time: a symbolic link must not smuggle a file from outside the workspace.
        await resolveAndVerify(a.absolute, this.deps.workspace);
        const text = await this.deps.workspace.readFile(a.absolute);
        out.push({ kind: 'file', path: a.path, content: text.slice(0, MAX_ATTACHMENT_CHARS), truncated: text.length > MAX_ATTACHMENT_CHARS || undefined });
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
    for (const p of picked) {
      if (this.attachments.some((a) => a.absolute === p.uri.fsPath)) continue;
      this.attachments.push({ id: randomUUID(), path: p.description, label: p.label, absolute: p.uri.fsPath });
    }
    this.patch({ context: this.contextView() });
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

  /** Sets the Act or Plan model explicitly (Settings view). A null Plan model means "same as Act". */
  private async setModel(role: 'act' | 'plan', sel: SelectedModel | null) {
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
    const provider = this.providers.find((p) => p.id === providerId);
    if (!provider) return;
    const known = new Set((provider.models ?? []).map((m) => m.id));
    const added = [...new Set(modelIds)].filter((id) => !known.has(id));
    if (added.length) {
      provider.models = [...(provider.models ?? []), ...added.map((id) => ({ id }))];
      await writeProviders(this.providers);
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
        const results: Array<{ provider: ProviderConfig; models: string[]; error?: string }> = [];
        await Promise.all(
          this.providers.map(async (provider) => {
            try {
              results.push({ provider, models: await this.createProvider(provider).listModels(ac.signal) });
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
    if (!provider.models?.some((m) => m.id === pick.modelId)) {
      provider.models = [...(provider.models ?? []), { id: pick.modelId }];
      await writeProviders(this.providers);
    }
    await this.selectModel({ providerId: provider.id, modelId: pick.modelId });
    this.patch({ providers: this.providerViews() });
  }

  // ------------------------------------------------------------------ providers

  private async reloadProviders() {
    this.providers = readProviders(this.deps.logger);
    await Promise.all(this.providers.map(async (p) => this.keyStatus.set(p.id, await this.deps.secrets.has(p.id))));
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
    const existing = input.id ? this.providers.find((p) => p.id === input.id) : undefined;
    const id = existing?.id ?? this.slug(input.name);
    const config: ProviderConfig = {
      id,
      name: input.name,
      baseUrl: input.baseUrl.replace(/\/+$/, ''),
      auth: { type: input.authType, ...(input.authType === 'header' && input.headerName ? { headerName: input.headerName } : {}) },
      ...(existing?.headers ? { headers: existing.headers } : {}),
      ...(input.timeoutSeconds ? { timeoutSeconds: input.timeoutSeconds } : {}),
      models: input.models.map((m) => {
        const prev = existing?.models?.find((x) => x.id === m.id);
        return {
          ...prev,
          id: m.id,
          ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
          ...(m.toolMode && m.toolMode !== 'auto' ? { toolMode: m.toolMode } : {}),
        };
      }),
    };
    if (existing && existing.baseUrl !== config.baseUrl) {
      for (const m of existing.models ?? []) this.deps.capabilities.clear(capabilityKey(id, m.id));
    }
    this.providers = existing ? this.providers.map((p) => (p.id === id ? config : p)) : [...this.providers, config];
    await writeProviders(this.providers);
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
    const p = this.providers.find((x) => x.id === id);
    if (!p) return;
    const choice = await vscode.window.showWarningMessage(`Remove provider "${p.name}"?`, { modal: true, detail: 'Its stored API key is deleted too.' }, 'Remove');
    if (choice !== 'Remove') return;
    this.providers = this.providers.filter((x) => x.id !== id);
    await writeProviders(this.providers);
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
      prompt: 'Stored in VS Code Secret Storage, never in settings. Leave empty and press Enter to remove the key.',
      password: true,
      ignoreFocusOut: true,
    });
    if (value === undefined) return;
    if (value.trim()) await this.deps.secrets.set(id, value.trim());
    else await this.deps.secrets.delete(id);
    this.keyStatus.set(id, !!value.trim());
    this.patch({ providers: this.providerViews() });
  }

  private async testProvider(requestId: string, providerId: string) {
    const config = this.providers.find((p) => p.id === providerId);
    if (!config) return;
    const provider = this.createProvider(config);
    const started = Date.now();
    let result: ProviderTestResult;
    try {
      const models = await provider.listModels();
      result = { ok: true, latencyMs: Date.now() - started, models, message: `Connected · ${models.length} model${models.length === 1 ? '' : 's'} available` };
    } catch (e) {
      const err = e instanceof ProviderError ? e : errorFromException(e, { url: config.baseUrl });
      const firstModel = config.models?.[0]?.id;
      if (err.kind === 'not_found' && firstModel) {
        // Some gateways do not implement /models; fall back to a one-token completion.
        try {
          const ac = new AbortController();
          for await (const ev of provider.streamChat({ model: firstModel, messages: [{ role: 'user', content: 'ping' }], maxTokens: 1 }, ac.signal)) {
            if (ev.type === 'text') break;
          }
          ac.abort();
          result = { ok: true, latencyMs: Date.now() - started, message: 'Connected · this server does not list models' };
        } catch (e2) {
          const err2 = e2 instanceof ProviderError ? e2 : errorFromException(e2, { url: config.baseUrl });
          result = { ok: false, message: err2.message, hint: err2.hint };
        }
      } else {
        result = { ok: false, message: err.message, hint: err.hint };
      }
    }
    this.send({ type: 'providerTest', requestId, providerId, result });
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
    return { provider, model };
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
    if (session.title === DEFAULT_TITLE) session.title = deriveTitle(user.display ?? user.content);
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

  private async attachPath(p: string) {
    let resolved;
    try {
      // Symlink-aware: a link inside the repository must not attach a file from outside it.
      resolved = await resolveAndVerify(p, this.deps.workspace);
    } catch (e) {
      return this.notice('warning', e instanceof PathError ? e.message : `${p} is not inside the workspace.`);
    }
    const stat = await this.deps.workspace.stat(resolved.absolute);
    if (stat?.type !== 'file') return this.notice('warning', `${resolved.relative} is not a file.`);
    if (!this.attachments.some((a) => a.absolute === resolved.absolute)) {
      this.attachments.push({ id: randomUUID(), path: resolved.relative, label: path.basename(resolved.absolute), absolute: resolved.absolute });
    }
    this.patch({ context: this.contextView() });
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
