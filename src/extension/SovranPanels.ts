import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import type { PanelHost, SovranController } from './SovranController';
import type { HostLogger } from './services';
import { parseWebviewMessage, webviewHtml, webviewOptions } from './webviewHtml';

/** The chat a restored tab showed, from the state its webview saved (untrusted: checked like any webview input). */
export function restoredSessionId(state: unknown): string | undefined {
  if (!state || typeof state !== 'object') return undefined;
  const id = (state as { sessionId?: unknown }).sessionId;
  return typeof id === 'string' && /^[\w-]{1,200}$/.test(id) ? id : undefined;
}

/**
 * Chats in editor tabs ("Open Chat in Editor"). Each tab is one more surface of the controller, with the same bundle,
 * CSP and message validation as the Activity Bar view. Tabs come back after a window reload with the chat they showed.
 */
export class SovranPanels implements vscode.WebviewPanelSerializer, vscode.Disposable {
  static readonly viewType = 'sovran.chatPanel';
  private readonly panels = new Map<string, vscode.WebviewPanel>();
  private readonly registration: vscode.Disposable;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: SovranController,
    private readonly logger: HostLogger,
  ) {
    this.registration = vscode.window.registerWebviewPanelSerializer(SovranPanels.viewType, this);
  }

  /** Opens a chat (a new one when `sessionId` is undefined) in a new editor tab and focuses it. */
  async open(sessionId?: string) {
    const panel = vscode.window.createWebviewPanel(SovranPanels.viewType, 'Sovran', { viewColumn: this.column(), preserveFocus: false }, webviewOptions(this.extensionUri));
    await this.connect(panel, sessionId);
  }

  async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown) {
    panel.webview.options = webviewOptions(this.extensionUri);
    await this.connect(panel, restoredSessionId(state));
  }

  /** Chat tabs stay together in one group; the first opens beside the code, so the code stays in view. */
  private column(): vscode.ViewColumn {
    for (const p of this.panels.values()) if (p.viewColumn) return p.viewColumn;
    return vscode.window.activeTextEditor ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active;
  }

  private async connect(panel: vscode.WebviewPanel, sessionId: string | undefined) {
    const id = randomUUID();
    this.panels.set(id, panel);
    const icon = (file: string) => vscode.Uri.joinPath(this.extensionUri, 'media', 'brand', file);
    panel.iconPath = { light: icon('sovran-mark.svg'), dark: icon('sovran-mark-on-dark.svg') };
    const host: PanelHost = {
      reveal: () => panel.reveal(panel.viewColumn, false),
      setTitle: (title) => {
        panel.title = title;
      },
      get active() {
        return panel.active;
      },
      get visible() {
        return panel.visible;
      },
      get viewColumn() {
        return panel.viewColumn;
      },
    };
    const subscriptions = [
      panel.webview.onDidReceiveMessage((raw: unknown) => {
        const msg = parseWebviewMessage(raw, this.logger);
        if (msg) void this.controller.handle(msg, id);
      }),
      panel.onDidChangeViewState(() => {
        if (panel.active) this.controller.surfaceFocused(id);
      }),
    ];
    panel.onDidDispose(() => {
      for (const d of subscriptions) d.dispose();
      this.panels.delete(id);
      this.controller.removePanel(id);
    });
    await this.controller.addPanel(id, (m) => void panel.webview.postMessage(m), host, sessionId);
    // Loaded only once the surface is registered, so the webview's first message ("ready") finds it.
    panel.webview.html = webviewHtml(panel.webview, this.extensionUri, 'panel');
  }

  /**
   * Only the serializer is released. Tabs are left to VS Code: disposing them while the window closes would close
   * them for good instead of restoring them on the next start.
   */
  dispose() {
    this.registration.dispose();
  }
}
