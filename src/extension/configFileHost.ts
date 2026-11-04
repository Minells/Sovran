import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { CONFIG_FILE_MAX_BYTES, CONFIG_FILE_TEMPLATE, type ConfigProblem } from '../core/config/configFile';

export type ConfigFileRead =
  { kind: 'missing' } | { kind: 'text'; text: string } | { kind: 'error'; message: string };

const LAST_APPLIED_KEY = 'sovran.configFile.lastApplied';

/** `~/.sovran/config.yaml`: in the user's home, never in the workspace, so a cloned repository cannot ship one. */
export const defaultConfigPath = () => path.join(os.homedir(), '.sovran', 'config.yaml');

/**
 * The config file on disk: reading it, creating it from the template, watching it for changes made in VS Code or
 * elsewhere, and showing its problems in the editor and the Problems panel.
 */
export class ConfigFileHost implements vscode.Disposable {
  readonly uri: vscode.Uri;
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('sovran-config');
  private readonly changed = new vscode.EventEmitter<void>();
  /** Fires (debounced) when the file is created, saved or deleted. */
  readonly onDidChange = this.changed.event;
  private watcher: vscode.FileSystemWatcher | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly memento: vscode.Memento,
    file = defaultConfigPath(),
  ) {
    this.uri = vscode.Uri.file(file);
    this.watch();
    this.disposables.push(
      this.diagnostics,
      this.changed,
      // A save in VS Code is the common case and is reported even where file watching is limited.
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (doc.uri.fsPath === this.uri.fsPath) this.fire();
      }),
    );
  }

  /** The path as shown to the user, with the home folder as `~`. */
  get displayPath(): string {
    const home = os.homedir();
    const p = this.uri.fsPath;
    return home && p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
  }

  async read(): Promise<ConfigFileRead> {
    try {
      const stat = await fs.stat(this.uri.fsPath);
      if (!stat.isFile()) return { kind: 'error', message: `${this.displayPath} is not a file.` };
      if (stat.size > CONFIG_FILE_MAX_BYTES)
        return { kind: 'error', message: `The file is larger than ${CONFIG_FILE_MAX_BYTES / 1024} KB.` };
      return { kind: 'text', text: await fs.readFile(this.uri.fsPath, 'utf8') };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
      return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Opens the file in an editor, creating it (and its folder) from the commented template first when missing. */
  async open(): Promise<void> {
    const dir = path.dirname(this.uri.fsPath);
    let created = false;
    try {
      await fs.access(this.uri.fsPath);
    } catch {
      await fs.mkdir(dir, { recursive: true });
      // 'wx' never overwrites a file created in the meantime.
      await fs
        .writeFile(this.uri.fsPath, CONFIG_FILE_TEMPLATE, { encoding: 'utf8', flag: 'wx' })
        .catch((e: NodeJS.ErrnoException) => {
          if (e.code !== 'EEXIST') throw e;
        });
      created = true;
    }
    // A watcher created before the folder existed may never fire; start it again now that the folder is there.
    if (created) this.watch();
    await vscode.window.showTextDocument(this.uri, { preview: false });
  }

  /** Shows problems where they are in the file (squiggles) and in the Problems panel. Empty clears them. */
  setProblems(problems: readonly ConfigProblem[]) {
    this.diagnostics.set(
      this.uri,
      problems.map((p) => {
        const d = new vscode.Diagnostic(
          new vscode.Range(p.line, p.column, p.endLine, p.endColumn),
          p.message,
          vscode.DiagnosticSeverity.Error,
        );
        d.source = 'Sovran';
        return d;
      }),
    );
  }

  /**
   * Whether this exact content was applied before. Model choices in the file (defaultModel…) are applied once per
   * content change, so a model picked later in the UI is not reverted at every start-up.
   */
  isNewContent(text: string): boolean {
    return this.memento.get<string>(LAST_APPLIED_KEY) !== hash(text);
  }

  async markApplied(text: string): Promise<void> {
    await this.memento.update(LAST_APPLIED_KEY, hash(text));
  }

  private watch() {
    this.watcher?.dispose();
    const folder = vscode.Uri.file(path.dirname(this.uri.fsPath));
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folder, path.basename(this.uri.fsPath)),
    );
    this.watcher.onDidCreate(() => this.fire());
    this.watcher.onDidChange(() => this.fire());
    this.watcher.onDidDelete(() => this.fire());
  }

  /** A save can produce both a save event and a watcher event; one reload is enough. */
  private fire() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.changed.fire(), 200);
  }

  dispose() {
    clearTimeout(this.timer);
    this.watcher?.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
