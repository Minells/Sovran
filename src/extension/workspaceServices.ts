import * as vscode from 'vscode';
import * as path from 'node:path';
import { mergeCommands, parseCustomCommand, type SlashCommand } from '../core/commands/slashCommands';
import { rankFuzzy } from '../core/util/fuzzy';

const EXCLUDE = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/.venv/**,**/__pycache__/**}';

/** Cached list of workspace files for `@` mentions, invalidated when files are created or deleted. */
export class FileIndex implements vscode.Disposable {
  private files: Promise<string[]> | undefined;
  private readonly watcher = vscode.workspace.createFileSystemWatcher('**/*', false, true, false);

  constructor() {
    this.watcher.onDidCreate(() => (this.files = undefined));
    this.watcher.onDidDelete(() => (this.files = undefined));
  }

  private list(): Promise<string[]> {
    if (!this.files) {
      this.files = Promise.resolve(vscode.workspace.findFiles('**/*', EXCLUDE, 20_000)).then((uris) => {
        const multi = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
        return uris.map((u) => vscode.workspace.asRelativePath(u, multi)).sort();
      });
    }
    return this.files;
  }

  async suggest(query: string, limit = 20): Promise<Array<{ path: string; label: string }>> {
    const all = await this.list();
    const ranked = query.trim() ? rankFuzzy(query, all, limit) : all.slice(0, limit);
    return ranked.map((p) => ({ path: p, label: path.basename(p) }));
  }

  dispose() {
    this.watcher.dispose();
  }
}

/** Loads `.sovran/commands/*.md` from trusted workspaces and merges them with the built-in commands. */
export class CommandLoader implements vscode.Disposable {
  private readonly watcher = vscode.workspace.createFileSystemWatcher('**/.sovran/commands/*.md');
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor() {
    for (const ev of [this.watcher.onDidCreate, this.watcher.onDidChange, this.watcher.onDidDelete]) ev(() => this.emitter.fire());
  }

  async load(): Promise<SlashCommand[]> {
    if (!vscode.workspace.isTrusted) return mergeCommands([]);
    const uris = await vscode.workspace.findFiles('.sovran/commands/*.md', undefined, 100);
    const custom: SlashCommand[] = [];
    for (const uri of uris) {
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        if (bytes.byteLength > 20_000) continue;
        const cmd = parseCustomCommand(path.basename(uri.fsPath), new TextDecoder().decode(bytes));
        if (cmd) custom.push(cmd);
      } catch {
        /* unreadable file: skip */
      }
    }
    return mergeCommands(custom);
  }

  dispose() {
    this.watcher.dispose();
    this.emitter.dispose();
  }
}
