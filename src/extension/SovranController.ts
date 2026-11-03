import * as vscode from 'vscode';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentRunner } from '../core/agent/agentRunner';
import type { AgentEvent } from '../core/agent/events';
import type { AgentMode, SessionGrants } from '../core/permissions/policy';
import { isProtectedPath } from '../core/permissions/policy';
import type { ApprovalPort, ApprovalRequest, ApprovalResponse } from '../core/ports';
import { capabilityKey, type CapabilityStore } from '../core/providers/capabilities';
import { ProviderError, errorFromException } from '../core/providers/errors';
import { OpenAICompatibleProvider } from '../core/providers/openaiCompatible';
import type { ProviderConfig } from '../core/providers/types';
import { resolveWorkspacePath } from '../core/security/paths';
import {
  DEFAULT_TITLE,
  deriveTitle,
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
  View,
  WebviewMessage,
} from '../shared/protocol';
import type { DiffPresenter } from './adapters/DiffPresenter';
import type { NodeProcessRunner } from './adapters/NodeProcessRunner';
import type { VscodeWorkspace } from './adapters/VscodeWorkspace';
import { readDefaultModel, readProviders, readSettings, writeDefaultModel, writeProviders, type HostSettings } from './config';
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
  private mode: AgentMode = 'act';
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
    await this.reloadProviders();
    const def = readDefaultModel();
    const [pid, ...rest] = def.split('/');
    this.selected = this.validSelection(pid && rest.length ? { providerId: pid, modelId: rest.join('/') } : null);
    if (!vscode.workspace.isTrusted) this.mode = 'plan';
    this.session.mode = this.mode;
    this.loaded.set(this.session.id, this.session);
    this.sessions = await this.deps.repo.list().catch(() => []);
    this.updateEditorContext();
    this.updateStatusBar();

    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.scheduleEditorUpdate()),
      vscode.window.onDidChangeTextEditorSelection(() => this.scheduleEditorUpdate()),
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.patch({ workspace: this.workspaceView() })),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.patch({ workspace: this.workspaceView() })),
      vscode.workspace.onDidChangeConfiguration(async (e) => {
        if (!e.affectsConfiguration('sovran')) return;
        this.settings = readSettings();
        await this.reloadProviders();
        this.selected = this.validSelection(this.selected);
        this.updateStatusBar();
        this.patch({ providers: this.providerViews(), selected: this.selected, fileEdits: this.settings.agent.policy.fileEdits });
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
          return this.resolveApproval(msg.id, { approved: msg.approved, grant: msg.grant, feedback: msg.feedback });
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
        case 'pickModel':
          return await this.pickModel();
        case 'selectModel':
          return await this.selectModel({ providerId: msg.providerId, modelId: msg.modelId });
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
          return await this.saveProvider(msg.provider);
        case 'deleteProvider':
          return await this.deleteProvider(msg.id);
        case 'testProvider':
          return await this.testProvider(msg.requestId, msg.providerId);
        case 'setApiKey':
          return await this.promptApiKey(msg.providerId);
        case 'openSettings':
          await vscode.commands.executeCommand('workbench.action.openSettings', 'sovran');
          return;
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
      sessions: this.sessions,
      session: { id: this.session.id, title: this.session.title, messages: this.session.messages },
      run: this.run && this.run.sessionId === this.session.id ? this.run.view : null,
      approvals: this.visibleApprovals(),
      context: this.contextView(),
      grants: { edits: this.grantsFor(this.session.id).edits },
      fileEdits: this.settings.agent.policy.fileEdits,
    };
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
    const model = this.selected ? this.modelLabel(this.selected) : null;
    this.deps.statusBar.update({ model, mode: this.mode, running: !!this.run });
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

  private updateEditorContext(push = false) {
    const ed = vscode.window.activeTextEditor;
    let next: EditorContextView | null = null;
    if (ed && ed.document.uri.scheme === 'file') {
      const rel = vscode.workspace.asRelativePath(ed.document.uri, (vscode.workspace.workspaceFolders?.length ?? 0) > 1);
      const sel = ed.selection;
      const base = path.basename(ed.document.uri.fsPath);
      next = sel.isEmpty
        ? { path: rel, label: base }
        : { path: rel, label: `${base}:${sel.start.line + 1}-${sel.end.line + 1}`, startLine: sel.start.line + 1, endLine: sel.end.line + 1 };
    }
    if (JSON.stringify(next) === JSON.stringify(this.editor)) return;
    this.editor = next;
    if (push) this.patch({ context: this.contextView() });
  }

  private async collectAttachments(): Promise<ContextAttachment[]> {
    const out: ContextAttachment[] = [];
    const protectedPaths = this.settings.agent.policy.protectedPaths;
    const ed = vscode.window.activeTextEditor;
    if (this.includeEditor && ed && ed.document.uri.scheme === 'file') {
      const rel = vscode.workspace.asRelativePath(ed.document.uri, (vscode.workspace.workspaceFolders?.length ?? 0) > 1);
      if (!isProtectedPath(rel, protectedPaths)) {
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
      title: 'SOVRAN: Add Files to Context',
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

  private validSelection(sel: SelectedModel | null): SelectedModel | null {
    const has = (s: SelectedModel | null) => !!s && !!this.providers.find((p) => p.id === s.providerId)?.models?.some((m) => m.id === s.modelId);
    if (has(sel)) return sel;
    for (const p of this.providers) {
      const m = p.models?.[0];
      if (m) return { providerId: p.id, modelId: m.id };
    }
    return null;
  }

  async selectModel(sel: SelectedModel) {
    if (!this.validSelection(sel) || this.validSelection(sel)?.modelId !== sel.modelId) return;
    this.selected = sel;
    await writeDefaultModel(`${sel.providerId}/${sel.modelId}`);
    this.updateStatusBar();
    this.patch({ selected: sel });
  }

  async pickModel() {
    if (this.providers.length === 0) {
      this.setView('providers');
      await this.deps.reveal();
      return;
    }
    type Item = vscode.QuickPickItem & { sel?: SelectedModel; action?: 'discover' | 'manage' };
    const items: Item[] = [];
    for (const p of this.providers) {
      items.push({ label: p.name, kind: vscode.QuickPickItemKind.Separator });
      for (const m of p.models ?? []) {
        const current = this.selected?.providerId === p.id && this.selected.modelId === m.id;
        items.push({ label: `${current ? '$(check) ' : ''}${m.name ?? m.id}`, description: m.name ? m.id : undefined, sel: { providerId: p.id, modelId: m.id } });
      }
      if (!p.models?.length) items.push({ label: '$(warning) No models configured', description: 'Use Discover models', action: 'discover' });
    }
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    items.push({ label: '$(refresh) Discover models from servers…', action: 'discover' });
    items.push({ label: '$(server-environment) Manage providers…', action: 'manage' });
    const pick = await vscode.window.showQuickPick(items, { title: 'SOVRAN: Select Model', placeHolder: 'Choose the model for this chat' });
    if (!pick) return;
    if (pick.sel) return this.selectModel(pick.sel);
    if (pick.action === 'manage') {
      this.setView('providers');
      return this.deps.reveal();
    }
    if (pick.action === 'discover') return this.discoverAndPick();
  }

  private async discoverAndPick() {
    const found = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'SOVRAN: Discovering models…', cancellable: true },
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
    const pick = await vscode.window.showQuickPick(items, { title: 'SOVRAN: Discovered Models', placeHolder: 'Pick a model to add and select' });
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

  private async saveProvider(input: ProviderInput) {
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
    this.notice('info', `Saved ${config.name}.`);
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
        { title: 'SOVRAN: Set Provider API Key' },
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
      this.notice('warning', 'SOVRAN is still working. Stop the current run before sending another message.');
      return;
    }
    const sel = this.validSelection(this.selected);
    if (!sel) {
      this.notice('error', 'Add a model provider before chatting.');
      this.setView('providers');
      return;
    }
    const provider = this.providers.find((p) => p.id === sel.providerId)!;
    const model = provider.models!.find((m) => m.id === sel.modelId)!;
    if (provider.auth?.type !== 'none' && !this.keyStatus.get(provider.id) && provider.auth?.type) {
      this.notice('warning', `${provider.name} has no API key stored. Requests are sent without credentials.`);
    }

    const session = this.session;
    const user: UserMessage = { role: 'user', id: randomUUID(), content: text, createdAt: Date.now() };
    const attachments = await this.collectAttachments();
    if (attachments.length) user.attachments = attachments;
    session.messages.push(user);
    if (session.title === DEFAULT_TITLE) session.title = deriveTitle(text);
    session.updatedAt = Date.now();
    session.providerId = sel.providerId;
    session.modelId = sel.modelId;
    this.attachments = [];
    this.send({ type: 'messageUpsert', sessionId: session.id, message: user });
    this.patch({ context: this.contextView(), session: { id: session.id, title: session.title, messages: session.messages } });
    void this.persist(session);

    const mode: AgentMode = vscode.workspace.isTrusted ? this.mode : 'plan';
    const abort = new AbortController();
    const runView: RunView = {
      sessionId: session.id,
      iteration: 0,
      maxIterations: this.settings.agent.maxIterations,
      startedAt: Date.now(),
      activity: { phase: 'thinking', label: 'Thinking' },
    };
    this.run = { sessionId: session.id, abort, view: runView };
    this.patch({ run: runView });
    this.updateStatusBar();

    const secret = await this.deps.secrets.get(provider.id);
    this.deps.logger.addSecret(secret);
    const runner = new AgentRunner({
      provider: this.createProvider(provider),
      registry: this.registry,
      workspace: this.deps.workspace,
      process: this.deps.process,
      approvals: this,
      capabilities: this.deps.capabilities,
      logger: this.deps.logger,
    });
    this.deps.logger.info(`Run started · ${provider.id}/${model.id} · ${mode} mode`);
    try {
      const outcome = await runner.run({
        session,
        providerId: provider.id,
        model,
        mode,
        settings: this.settings.agent,
        grants: this.grantsFor(session.id),
        signal: abort.signal,
        emit: (e) => this.onAgentEvent(session, e),
        projectInstructions: await this.projectInstructions(),
        secrets: [secret],
      });
      this.deps.logger.info(`Run finished · ${outcome.reason}${outcome.error ? ` · ${outcome.error.kind}` : ''}`);
      if (outcome.reason === 'max_iterations') this.updateTitleIfNeeded(session);
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
      session.updatedAt = Date.now();
      clearTimeout(this.persistTimer);
      await this.persist(session);
      this.updateStatusBar();
      if (session.id === this.session.id) {
        this.patch({ run: null, approvals: [], grants: { edits: this.grantsFor(session.id).edits } });
      }
    }
  }

  private updateTitleIfNeeded(session: Session) {
    if (session.title === DEFAULT_TITLE) session.title = deriveTitle(session.messages.find((m) => m.role === 'user')?.content ?? '');
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
              ? { kind: 'command', command: d.command, cwd: d.cwd, warnings: d.warnings }
              : { kind: 'read', path: d.path, reason: d.reason },
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
        void vscode.window.showInformationMessage(`SOVRAN needs your approval: ${request.title}`, 'Review').then((c) => {
          if (c) void this.deps.reveal();
        });
      }
    });
  }

  private resolveApproval(id: string, response: ApprovalResponse) {
    this.approvals.get(id)?.settle(response);
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
