import * as vscode from 'vscode';
import type { Logger } from '../core/ports';
import type { CapabilityStore, LearnedCapabilities } from '../core/providers/capabilities';
import { redact } from '../core/security/redact';

/** API keys live only in VS Code SecretStorage (OS keychain-backed), keyed by provider id. */
export class ProviderSecrets {
  constructor(private readonly storage: vscode.SecretStorage) {}
  private key(id: string) {
    return `sovran.provider.${id}.apiKey`;
  }
  get(id: string) {
    return this.storage.get(this.key(id));
  }
  async has(id: string) {
    return !!(await this.storage.get(this.key(id)));
  }
  set(id: string, value: string) {
    return this.storage.store(this.key(id), value);
  }
  delete(id: string) {
    return this.storage.delete(this.key(id));
  }
}

export class MementoCapabilityStore implements CapabilityStore {
  private static readonly KEY = 'sovran.capabilities.v1';
  constructor(private readonly memento: vscode.Memento) {}
  private all(): Record<string, LearnedCapabilities> {
    return this.memento.get<Record<string, LearnedCapabilities>>(MementoCapabilityStore.KEY, {});
  }
  get(key: string) {
    return this.all()[key];
  }
  set(key: string, value: LearnedCapabilities) {
    void this.memento.update(MementoCapabilityStore.KEY, { ...this.all(), [key]: value });
  }
  clear(key: string) {
    const next = { ...this.all() };
    delete next[key];
    void this.memento.update(MementoCapabilityStore.KEY, next);
  }
}

export interface HostLogger extends Logger, vscode.Disposable {
  show(): void;
  /** Adds a value that must be masked in every log line. */
  addSecret(secret: string | undefined): void;
}

export function createLogger(): HostLogger {
  const channel = vscode.window.createOutputChannel('Sovran', { log: true });
  const secrets = new Set<string>();
  const clean = (m: string) => redact(m, [...secrets]);
  return {
    debug: (m) => channel.debug(clean(m)),
    info: (m) => channel.info(clean(m)),
    warn: (m) => channel.warn(clean(m)),
    error: (m) => channel.error(clean(m)),
    show: () => channel.show(true),
    addSecret: (s) => {
      if (s) secrets.add(s);
    },
    dispose: () => channel.dispose(),
  };
}

export class SovranStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('sovran.status', vscode.StatusBarAlignment.Right, 100);
  constructor() {
    this.item.name = 'Sovran';
    this.item.command = 'sovran.selectModel';
    this.update({ model: null, location: null, endpoint: null, mode: 'act', running: false });
    this.item.show();
  }
  /** Text format: `$(sovran-logo) sovran · <model> · <where requests go>`. */
  update(s: { model: string | null; location: string | null; endpoint: string | null; mode: 'plan' | 'act'; running: boolean }) {
    const icon = s.running ? '$(loading~spin)' : '$(sovran-logo)';
    this.item.text = [`${icon} sovran`, s.model ?? 'no model', ...(s.model && s.location ? [s.location] : [])].join(' · ');
    const tip = new vscode.MarkdownString(
      [
        `**Sovran** · ${s.mode === 'plan' ? 'Plan mode (read-only)' : 'Act mode'}`,
        `Model: ${s.model ?? 'none selected'}`,
        s.endpoint ? `Endpoint: \`${s.endpoint}\`` : '',
        'Click to change model.',
      ]
        .filter(Boolean)
        .join('\n\n'),
    );
    this.item.tooltip = tip;
    this.item.backgroundColor = s.model ? undefined : new vscode.ThemeColor('statusBarItem.warningBackground');
  }
  dispose() {
    this.item.dispose();
  }
}
