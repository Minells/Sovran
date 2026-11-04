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
    private readonly controller: SovranController,
    private readonly logger: HostLogger,
  ) {}

  get visible() {
    return !!this.view?.visible;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = webviewOptions(this.extensionUri);
    view.webview.html = webviewHtml(view.webview, this.extensionUri, 'sidebar');

    view.webview.onDidReceiveMessage((raw: unknown) => {
      const msg = parseWebviewMessage(raw, this.logger);
      if (msg) void this.controller.handle(msg);
    });
    this.controller.attach((m) => void view.webview.postMessage(m));
    view.onDidDispose(() => {
      this.controller.detach();
      this.view = undefined;
    });
  }

  async reveal() {
    if (this.view) this.view.show(true);
    else await vscode.commands.executeCommand(`${SovranViewProvider.viewId}.focus`);
  }
}
