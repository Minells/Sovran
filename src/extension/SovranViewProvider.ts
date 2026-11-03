import * as vscode from 'vscode';
import * as fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { webviewMessageSchema } from '../shared/protocol';
import type { SovranController } from './SovranController';
import type { HostLogger } from './services';

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
    const dist = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview');
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    view.webview.options = { enableScripts: true, enableCommandUris: false, localResourceRoots: [dist, media] };
    view.webview.html = this.html(view.webview, dist, media);

    view.webview.onDidReceiveMessage((raw: unknown) => {
      const parsed = webviewMessageSchema.safeParse(raw);
      if (!parsed.success) {
        // Never log the payload: it may contain user text.
        const type = typeof raw === 'object' && raw && 'type' in raw ? String((raw as { type: unknown }).type).slice(0, 40) : 'unknown';
        this.logger.warn(`Dropped invalid webview message (type: ${type}).`);
        return;
      }
      void this.controller.handle(parsed.data);
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

  private html(webview: vscode.Webview, dist: vscode.Uri, media: vscode.Uri): string {
    const nonce = randomBytes(16).toString('base64');
    const script = vscode.Uri.joinPath(dist, 'assets', 'index.js');
    const style = vscode.Uri.joinPath(dist, 'assets', 'index.css');
    // Brand tokens and logo artwork load first; the UI stylesheet consumes the --sovran-* tokens.
    const brand = vscode.Uri.joinPath(media, 'sovran.css');
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    if (!fs.existsSync(script.fsPath)) {
      return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none';"></head>
<body style="font-family: var(--vscode-font-family); padding: 12px;">The Sovran interface has not been built. Run <code>npm run build</code> and reload the window.</body></html>`;
    }
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${webview.asWebviewUri(brand)}">
<link rel="stylesheet" href="${webview.asWebviewUri(style)}">
<title>Sovran</title>
</head>
<body>
<div id="root"></div>
<script type="module" nonce="${nonce}" src="${webview.asWebviewUri(script)}"></script>
</body>
</html>`;
  }
}
