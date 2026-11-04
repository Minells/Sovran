import * as vscode from 'vscode';
import * as fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { webviewMessageSchema, type SurfaceKind, type WebviewMessage } from '../shared/protocol';
import type { HostLogger } from './services';

/** Options shared by every Sovran webview: scripts on, command links off, resources from the build and media only. */
export function webviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
  return {
    enableScripts: true,
    enableCommandUris: false,
    localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist', 'webview'), vscode.Uri.joinPath(extensionUri, 'media')],
  };
}

/**
 * The page that hosts the React UI, with a strict CSP (a nonce for the one script, no inline styles). The same bundle
 * runs in the Activity Bar view and in editor tabs; `data-surface` lets the stylesheet match the surrounding editor
 * before the first state arrives.
 */
export function webviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, surface: SurfaceKind): string {
  const dist = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
  const media = vscode.Uri.joinPath(extensionUri, 'media');
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
<body data-surface="${surface}">
<div id="root"></div>
<script type="module" nonce="${nonce}" src="${webview.asWebviewUri(script)}"></script>
</body>
</html>`;
}

/** Validates a message from a webview. Invalid ones are dropped and logged by type only: the payload may hold user text. */
export function parseWebviewMessage(raw: unknown, logger: HostLogger): WebviewMessage | undefined {
  const parsed = webviewMessageSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const type = typeof raw === 'object' && raw && 'type' in raw ? String((raw as { type: unknown }).type).slice(0, 40) : 'unknown';
  logger.warn(`Dropped invalid webview message (type: ${type}).`);
  return undefined;
}
