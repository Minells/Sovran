import * as vscode from 'vscode';
import * as path from 'node:path';

/** Serves proposed file contents as read-only virtual documents and opens them in the native diff editor. */
export class DiffPresenter implements vscode.TextDocumentContentProvider, vscode.Disposable {
  static readonly scheme = 'sovran-proposal';
  private readonly contents = new Map<string, string>();
  private readonly registration: vscode.Disposable;

  constructor() {
    this.registration = vscode.workspace.registerTextDocumentContentProvider(DiffPresenter.scheme, this);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.query) ?? '';
  }

  private uri(relPath: string, key: string) {
    return vscode.Uri.from({ scheme: DiffPresenter.scheme, path: `/${relPath.replace(/^\/+/, '')}`, query: key });
  }

  register(id: string, proposed: string) {
    this.contents.set(id, proposed);
    this.contents.set(`${id}:empty`, '');
  }

  async show(id: string, relPath: string, absolutePath: string, isNew: boolean) {
    if (!this.contents.has(id)) return;
    const left = isNew ? this.uri(relPath, `${id}:empty`) : vscode.Uri.file(absolutePath);
    const right = this.uri(relPath, id);
    const title = `${path.basename(relPath)} ${isNew ? '(new file)' : ''} ↔ Sovran proposal`.replace(/\s+/g, ' ');
    await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true, preserveFocus: true });
  }

  async release(id: string) {
    this.contents.delete(id);
    this.contents.delete(`${id}:empty`);
    const tabs = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .filter((t) => t.input instanceof vscode.TabInputTextDiff && t.input.modified.scheme === DiffPresenter.scheme && t.input.modified.query === id);
    if (tabs.length) await vscode.window.tabGroups.close(tabs, true);
  }

  dispose() {
    this.registration.dispose();
    this.contents.clear();
  }
}
