import * as vscode from 'vscode';
import type { SovranController } from './SovranController';
import type { HostLogger } from './services';
import { parseWebviewMessage, webviewHtml, webviewOptions } from './webviewHtml';

/** Hosts the React UI in the Activity Bar view with a strict CSP and validated messaging. */
export class SovranViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'sovran.chat';
  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly getController: () => Promise<SovranController>,
    private readonly logger: HostLogger,
  ) {}

  get visible() {
    return !!this.view?.visible;
  }

  async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
    this.view = view;
    const state: { disposed: boolean; detach?: () => void } = { disposed: false };
    view.onDidDispose(() => {
      state.disposed = true;
      if (this.view === view) {
        state.detach?.();
        this.view = undefined;
      }
    });
    const controller = await this.getController();
    if (state.disposed || this.view !== view) return;
    view.webview.options = webviewOptions(this.extensionUri);
    view.webview.html = webviewHtml(view.webview, this.extensionUri, 'sidebar');

    view.webview.onDidReceiveMessage((raw: unknown) => {
      const msg = parseWebviewMessage(raw, this.logger);
      if (msg) void controller.handle(msg);
    });
    controller.attach((m) => void view.webview.postMessage(m));
    state.detach = () => controller.detach();
  }

  async reveal() {
    if (this.view) this.view.show(true);
    else await vscode.commands.executeCommand(`${SovranViewProvider.viewId}.focus`);
  }
}
