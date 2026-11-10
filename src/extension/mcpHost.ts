/**
 * MCP in the VS Code host: reads the servers from user settings, keeps their tokens in Secret Storage, starts them only
 * in trusted workspaces, and projects their state for the Settings view. The connections themselves are the core's
 * `McpHub`; this class is the glue around it, so the controller only forwards messages.
 */
import * as vscode from 'vscode';
import * as os from 'node:os';
import { ManagedMcpPackages } from './adapters/ManagedMcpPackages';
import {
  integration,
  integrationArguments,
  integrationHeaders,
  PROFILE_LABELS,
  type ManagedIntegration,
  type IntegrationId,
  type IntegrationProfile,
} from '../core/mcp/catalog';
import {
  fromEntry,
  mcpServerEntrySchema,
  MCP_TIMEOUT_SECONDS,
  newServerId,
  toEntry,
  transportOf,
  type McpServerConfig,
  type McpToolPolicy,
} from '../core/mcp/config';
import { McpHub, type McpServerState, type McpTransportFactory } from '../core/mcp/hub';
import { normalizeApiKey } from '../core/providers/connection';
import type { McpServerInput, McpServerView, McpView } from '../shared/protocol';
import { sendsKeyInsecurely } from '../shared/endpoints';
import { NodeMcpTransports } from './adapters/McpTransports';
import { readMcpServers, writeMcpServers } from './config';
import type { HostLogger, McpSecrets } from './services';

const MAX_DESCRIPTION_SHOWN = 2000;

export interface McpHostDeps {
  managed?: { resources: string; storage: string; host: string; remote?: boolean };
  secrets: McpSecrets;
  logger: HostLogger;
  /** Sovran's version, sent to servers when connecting. */
  version: string;
  /** Tells the user something (the controller shows it in every surface). */
  notify: (level: 'info' | 'warning' | 'error', message: string) => void;
  /** How servers are reached. Defaults to the SDK's stdio and Streamable HTTP transports; tests connect in memory. */
  transports?: McpTransportFactory;
}

export class McpHost implements vscode.Disposable {
  readonly hub: McpHub;
  private readonly packages?: ManagedMcpPackages;
  private servers: McpServerConfig[] = [];
  /** Tokens of the configured servers, kept to mask them in logs and errors. */
  private readonly tokens = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  private readonly disposables: vscode.Disposable[] = [];
  /** Settings writes run one after the other, each on the latest list, so quick changes never undo each other. */
  private writes: Promise<unknown> = Promise.resolve();
  /** Reloads run one after the other, each reading the settings at its turn, so the last applied is the latest. */
  private reloading: Promise<void> = Promise.resolve();

  constructor(private readonly deps: McpHostDeps) {
    if (deps.managed)
      this.packages = new ManagedMcpPackages({
        ...deps.managed,
        roots: () => (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
        authorize: () => this.requireTrust(),
        changed: () => this.changed(),
      });
    this.hub = new McpHub({
      transports:
        deps.transports ??
        new NodeMcpTransports({
          managedLaunch: (server) => {
            if (!this.packages) throw new Error('Managed integrations are unavailable in this host.');
            return this.packages.launch(server);
          },
          variables: () => ({
            workspaceFolder: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
            userHome: os.homedir(),
            env: process.env,
          }),
          token: async (id) => this.tokens.get(id) ?? (await this.deps.secrets.get(id)),
        }),
      logger: deps.logger,
      client: { name: 'sovran', version: deps.version },
      onChange: () => this.changed(),
      secrets: () => [...this.tokens.values()],
    });
  }

  async init(): Promise<void> {
    await this.packages?.inspect();
    await this.reload();
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('sovran.mcp.servers')) void this.reload();
      }),
      // Servers start only in trusted workspaces: MCP tools exist only in Act mode, and Restricted Mode is Plan only.
      vscode.workspace.onDidGrantWorkspaceTrust(() => void this.reload()),
    );
  }

  /** Reads the settings again and applies them. */
  private reload(): Promise<void> {
    const next = this.reloading.then(
      () => this.apply(),
      () => this.apply(),
    );
    this.reloading = next.catch((e: unknown) =>
      this.deps.logger.error(
        `Applying the MCP settings failed: ${e instanceof Error ? e.message : String(e)}`,
      ),
    );
    return next;
  }

  private async apply(): Promise<void> {
    const servers = readMcpServers(this.deps.logger);
    const tokens = await Promise.all(
      servers.map(
        async (s) => [s.id, s.auth.type === 'none' ? undefined : await this.deps.secrets.get(s.id)] as const,
      ),
    );
    this.servers = servers;
    this.tokens.clear();
    for (const [id, token] of tokens) {
      if (!token) continue;
      this.tokens.set(id, token);
      this.deps.logger.addSecret(token);
    }
    this.hub.update(servers, vscode.workspace.isTrusted);
  }

  /** The servers' tokens, to mask in anything the agent sends to the model or saves (a server may echo its token). */
  secrets(): string[] {
    return [...this.tokens.values()];
  }

  onDidChange(listener: () => void): vscode.Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  private changed() {
    for (const l of this.listeners) l();
  }

  // ------------------------------------------------------------------------------------------ view

  view(): McpView {
    return {
      active: vscode.workspace.isTrusted,
      servers: this.hub.states().map((s) => this.serverView(s)),
      ...(this.packages && this.deps.managed
        ? {
            catalog: {
              host: this.deps.managed.host,
              remote: this.deps.managed.remote,
              entries: this.packages.states(),
            },
          }
        : {}),
    };
  }

  private serverView({ config: c, status, error, server, tools }: McpServerState): McpServerView {
    const offered = tools.filter((t) => t.policy !== 'off');
    return {
      id: c.id,
      ...(c.managed ? { managed: c.managed } : {}),
      name: c.name,
      enabled: c.enabled,
      transport: transportOf(c),
      ...(c.command ? { command: c.command } : {}),
      ...(c.args ? { args: c.args } : {}),
      ...(c.env ? { env: c.env } : {}),
      ...(c.cwd ? { cwd: c.cwd } : {}),
      ...(c.url ? { url: c.url } : {}),
      ...(c.headers ? { headers: c.headers } : {}),
      auth: c.auth,
      hasToken: this.tokens.has(c.id),
      insecure: !!c.url && sendsKeyInsecurely(c.url, c.auth.type === 'env' ? 'none' : c.auth.type),
      timeoutSeconds: c.timeoutSeconds,
      status,
      ...(error ? { error } : {}),
      ...(server ? { server } : {}),
      tools: tools.map((t) => ({
        name: t.name,
        ...(t.title ? { title: t.title } : {}),
        ...(t.description ? { description: t.description.slice(0, MAX_DESCRIPTION_SHOWN) } : {}),
        modelName: t.modelName,
        policy: t.policy,
        hints: t.hints,
      })),
      toolTokens: offered.reduce((sum, t) => sum + t.definitionTokens, 0),
    };
  }

  /** "create_issue · GitHub" for a model-facing tool name, or undefined when it is not an MCP tool. */
  describe(modelName: string): string | undefined {
    const d = this.hub.describe(modelName);
    return d && `${d.tool} · ${d.server}`;
  }

  // ------------------------------------------------------------------------------------------ changes

  /** Applies `change` to the latest server list in settings and writes it. Returns what `change` returns. */
  private mutate<T>(
    change: (servers: McpServerConfig[]) => { servers: McpServerConfig[]; result: T } | undefined,
  ): Promise<T | undefined> {
    const run = this.writes.then(async () => {
      const outcome = change(readMcpServers());
      if (!outcome) return undefined;
      await writeMcpServers(outcome.servers);
      await this.reload();
      return outcome.result;
    });
    this.writes = run.catch(() => undefined);
    return run;
  }

  /** Adds a server or replaces one. A new token goes to Secret Storage; tool policies and the on/off state are kept. */
  async save(input: McpServerInput): Promise<void> {
    const managed = input.id && this.servers.find((s) => s.id === input.id)?.managed;
    if (
      managed &&
      (await vscode.window.showWarningMessage(
        'Save this integration as a custom server?',
        {
          modal: true,
          detail:
            'Your command and connection fields will be used directly. Sovran will no longer manage its package or profile. Tool permissions are preserved.',
        },
        'Save custom server',
      )) !== 'Save custom server'
    )
      return;
    const config = await this.mutate((servers) => {
      const existing = input.id ? servers.find((s) => s.id === input.id) : undefined;
      if (input.id && !existing) throw new Error(`The MCP server "${input.name}" was removed meanwhile.`);
      const id = existing?.id ?? newServerId(input.name, new Set(servers.map((s) => s.id)));
      const local = input.transport === 'stdio';
      const entry = mcpServerEntrySchema.safeParse(
        toEntry({
          id,
          name: input.name.trim(),
          enabled: existing?.enabled ?? true,
          ...(local
            ? { command: input.command, args: input.args, env: input.env, cwd: input.cwd }
            : { url: input.url, headers: input.headers }),
          auth: input.auth,
          timeoutSeconds: input.timeoutSeconds ?? existing?.timeoutSeconds ?? MCP_TIMEOUT_SECONDS.default,
          allowedTools: existing?.allowedTools ?? [],
          disabledTools: existing?.disabledTools ?? [],
        }),
      );
      if (!entry.success) throw new Error(entry.error.issues.map((i) => i.message).join(' '));
      const config = fromEntry(entry.data);
      const next = existing ? servers.map((s) => (s.id === id ? config : s)) : [...servers, config];
      return { servers: next, result: config };
    });
    if (!config) return;
    if (config.auth.type === 'none') {
      // Changing the auth type reconnects by itself; a token left from before is only removed.
      await this.deps.secrets.delete(config.id);
      this.tokens.delete(config.id);
    } else if (input.token?.trim()) {
      const { key } = normalizeApiKey(input.token);
      await this.deps.secrets.set(config.id, key);
      this.tokens.set(config.id, key);
      this.deps.logger.addSecret(key);
      // The settings were applied before the token was stored: connect again with it.
      await this.hub.restart(config.id);
    }
    if (config.auth.type !== 'none' && !this.tokens.has(config.id)) {
      this.deps.notify(
        'info',
        `${config.name} needs a token before it can connect. Use Set token on its card in Settings → Tools.`,
      );
    }
    this.changed();
  }

  async remove(id: string): Promise<void> {
    const server = this.servers.find((s) => s.id === id);
    if (!server) return;
    const choice = await vscode.window.showWarningMessage(
      `Remove the MCP server "${server.name}"?`,
      {
        modal: true,
        detail: 'Sovran stops it and deletes its stored token. Its tools are no longer offered to the model.',
      },
      'Remove',
    );
    if (choice !== 'Remove') return;
    await this.mutate((servers) => ({ servers: servers.filter((s) => s.id !== id), result: true }));
    await this.deps.secrets.delete(id);
    this.tokens.delete(id);
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const selected = this.servers.find((s) => s.id === id);
    if (enabled && selected?.managed) {
      this.requireTrust();
      if (!this.packages) throw new Error('Managed integrations are unavailable in this host.');
      if (selected.auth.type !== 'none' && !this.tokens.has(id))
        throw new Error('Set the integration token before connecting.');
      await this.packages.launch(selected);
      const snapshot = JSON.stringify(toEntry(selected));
      const choice = await vscode.window.showWarningMessage(
        `Connect ${selected.name}?`,
        {
          modal: true,
          detail: `${integration(selected.managed.id).description}\nRuns on ${this.deps.managed?.host ?? 'the extension host'}. ${PROFILE_LABELS[selected.managed.profile]}.${selected.managed.profile === 'extension' ? ` Chrome profile: ${selected.managed.browserProfile}. Requires the Playwright companion extension and its tab confirmation. Approved tabs can expose signed-in accounts and session data.` : ''}${selected.managed.profile === 'collaboration' ? ' Issue and pull request writes are available and start on Ask.' : ''} Browser tools act outside native Web safeguards and ask unless you allow them. While enabled, it starts again in trusted windows.`,
        },
        'Connect',
      );
      if (choice !== 'Connect') return;
      this.requireTrust();
      if (JSON.stringify(toEntry(readMcpServers().find((s) => s.id === id) ?? selected)) !== snapshot)
        throw new Error('The integration changed while awaiting confirmation. Connect again.');
    }
    await this.mutate((servers) =>
      servers.some((s) => s.id === id)
        ? { servers: servers.map((s) => (s.id === id ? { ...s, enabled } : s)), result: true }
        : undefined,
    );
  }

  async setToolPolicy(id: string, tool: string, policy: McpToolPolicy): Promise<void> {
    await this.mutate((servers) => {
      if (!servers.some((s) => s.id === id)) return undefined;
      const next = servers.map((s) =>
        s.id !== id
          ? s
          : {
              ...s,
              allowedTools:
                policy === 'allow'
                  ? [...new Set([...s.allowedTools, tool])]
                  : s.allowedTools.filter((t) => t !== tool),
              disabledTools:
                policy === 'off'
                  ? [...new Set([...s.disabledTools, tool])]
                  : s.disabledTools.filter((t) => t !== tool),
            },
      );
      return { servers: next, result: true };
    });
  }

  /** "Always allow" on an approval: the tool runs without asking from now on. */
  async allowTool(serverId: string, tool: string): Promise<void> {
    const server = this.servers.find((s) => s.id === serverId);
    if (!server) return;
    await this.setToolPolicy(serverId, tool, 'allow');
    this.deps.notify(
      'info',
      `${tool} of ${server.name} now runs without asking. Change it in Settings → Tools.`,
    );
  }

  async restart(id: string): Promise<void> {
    await this.hub.restart(id);
  }

  /** Asks for the token in a password box. An empty answer removes it. */
  async promptToken(id: string): Promise<void> {
    const server = this.servers.find((s) => s.id === id);
    if (!server || server.auth.type === 'none') return;
    const where =
      server.auth.type === 'bearer'
        ? 'Sent as "Authorization: Bearer <token>". Paste the token only.'
        : server.auth.type === 'header'
          ? `Sent in the ${server.auth.headerName} header.`
          : `Given to the server as the ${server.auth.envName} environment variable.`;
    const value = await vscode.window.showInputBox({
      title: `Token for ${server.name}`,
      prompt: `${where} Stored in VS Code Secret Storage, never in settings. Leave empty and press Enter to remove it.`,
      password: true,
      ignoreFocusOut: true,
    });
    if (value === undefined) return;
    const { key } = normalizeApiKey(value);
    if (key) {
      await this.deps.secrets.set(id, key);
      this.tokens.set(id, key);
      this.deps.logger.addSecret(key);
    } else {
      await this.deps.secrets.delete(id);
      this.tokens.delete(id);
    }
    await this.hub.restart(id);
    this.changed();
  }

  async dispose(): Promise<void> {
    this.packages?.dispose();
    for (const d of this.disposables) d.dispose();
    this.listeners.clear();
    await this.hub.dispose();
  }

  private requireTrust(): void {
    if (!vscode.workspace.isTrusted)
      throw new Error('Trust the workspace before installing or connecting integrations.');
  }

  async addIntegration(id: IntegrationId, profile: IntegrationProfile): Promise<void> {
    const item = integration(id);
    const managed: ManagedIntegration = { id, profile, version: item.version };
    if (profile === 'extension') {
      if (this.deps.managed?.remote)
        throw new Error(
          'Existing desktop Chrome profiles are unavailable on Remote hosts. Use a separate browser on the extension host or configure an explicit custom bridge.',
        );
      const browserProfile = await vscode.window.showInputBox({
        title: 'Choose the Chrome profile for Playwright',
        prompt:
          'Enter the profile directory name shown in chrome://version (for example Profile 2). Install the Playwright companion extension there. Approved tabs can expose signed-in accounts. No automatic profile selection.',
        ignoreFocusOut: true,
        validateInput: (value) =>
          /^[a-zA-Z0-9 _-]{1,80}$/.test(value)
            ? undefined
            : 'Enter a profile directory name without path separators.',
      });
      if (browserProfile === undefined) return;
      managed.browserProfile = browserProfile;
    }
    integrationArguments(managed);
    await this.mutate((servers) => {
      const server = fromEntry({
        id: newServerId(item.name, new Set(servers.map((s) => s.id))),
        name: item.name,
        enabled: false,
        managed,
        ...(id === 'github'
          ? {
              url: 'https://api.githubcopilot.com/mcp/',
              headers: integrationHeaders(profile),
              auth: { type: 'bearer' as const },
            }
          : { command: 'node', args: [], auth: { type: 'none' as const } }),
      });
      return { servers: [...servers, server], result: true };
    });
  }

  async installIntegration(id: IntegrationId): Promise<void> {
    this.requireTrust();
    if (!this.packages) throw new Error('Managed installations are unavailable in this host.');
    if (this.servers.some((s) => s.enabled && s.managed?.id === id))
      throw new Error('Disconnect this integration before installing its dependencies.');
    const item = integration(id);
    if (!item.package) return;
    const choice = await vscode.window.showWarningMessage(
      `Install ${item.name} dependencies?`,
      {
        modal: true,
        detail: `Downloads ${item.package}@${item.version} and its locked dependencies from npm to extension storage on ${this.deps.managed?.host}. npm install scripts are disabled. No browser is downloaded and nothing connects.`,
      },
      'Install',
    );
    if (choice !== 'Install') return;
    this.requireTrust();
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Installing ${item.name}`, cancellable: true },
      async (_progress, cancellation) => {
        const abort = new AbortController();
        const listener = cancellation.onCancellationRequested(() => abort.abort());
        try {
          await this.packages!.install(id, abort.signal);
        } finally {
          listener.dispose();
        }
      },
    );
  }
}
