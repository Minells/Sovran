import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { CONFIG_FILE_MAX_BYTES, type ConfigProblem } from '../core/config/configFile';

export type ConfigFileRead =
  { kind: 'missing' } | { kind: 'text'; text: string } | { kind: 'error'; message: string };

const LAST_APPLIED_KEY = 'sovran.configFile.lastApplied';
const POLL_MS = 2000;
const SYNCED_KEY = 'sovran.configFile.synced';

/** The file is open in an editor with unsaved changes: writing it would fight with what the user is typing. */
export class ConfigFileBusyError extends Error {}

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
  /** Hash of the last content Sovran wrote, to tell its own writes from the user's when the watcher fires. */
  private lastWritten: string | undefined;
  /** Modification time and size seen by the last poll (`missing` when there is no file). */
  private lastStat: string | undefined;
  private readonly poller: ReturnType<typeof setInterval>;

  constructor(
    private readonly memento: vscode.Memento,
    file = defaultConfigPath(),
  ) {
    this.uri = vscode.Uri.file(file);
    this.watch();
    // File watching is not reliable for a file outside the workspace that no editor has open (events can be late on
    // macOS and missing on Linux), nor through symbolic links from a dotfiles repository. A cheap stat every 2 s makes
    // a save in any editor reach Sovran; duplicate notifications are harmless, since the controller compares content.
    void this.pollStat();
    this.poller = setInterval(() => void this.pollStat(), POLL_MS);
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

  /**
   * Creates the file (and its folder) with `initial` content when it does not exist. Returns whether it was created.
   * Never overwrites a file that appeared in the meantime.
   */
  async create(initial: string): Promise<boolean> {
    try {
      await fs.access(this.uri.fsPath);
      return false;
    } catch {
      await fs.mkdir(path.dirname(this.uri.fsPath), { recursive: true });
      try {
        this.lastWritten = hash(initial);
        await fs.writeFile(this.uri.fsPath, initial, { encoding: 'utf8', flag: 'wx' });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw e;
      }
      // A watcher created before the folder existed may never fire; start it again now that the folder is there.
      this.watch();
      return true;
    }
  }

  /** Opens the file in an editor, creating it with `initial()` first when it does not exist. */
  async open(initial: () => string): Promise<void> {
    await this.create(initial());
    await vscode.window.showTextDocument(this.uri, { preview: false });
  }

  /**
   * Replaces the file content (in place, so a symbolic link from a dotfiles repository keeps working). Refuses while
   * the file has unsaved changes in an editor; an open, saved editor reloads by itself.
   */
  async write(text: string): Promise<void> {
    if (vscode.workspace.textDocuments.some((d) => d.uri.fsPath === this.uri.fsPath && d.isDirty)) {
      throw new ConfigFileBusyError(`${this.displayPath} has unsaved changes in the editor.`);
    }
    this.lastWritten = hash(text);
    await fs.writeFile(this.uri.fsPath, text, 'utf8');
  }

  /** Whether `text` is what Sovran itself last wrote (a change the user did not make). */
  isOwnWrite(text: string): boolean {
    return this.lastWritten === hash(text);
  }

  /** Moves the file to the system trash, so the user can still get it back. */
  async trash(): Promise<void> {
    await vscode.workspace.fs.delete(this.uri, { useTrash: true });
  }

  /** Whether Settings and the file have been merged once; until then the first sync joins both sides. */
  isSynced(): boolean {
    return this.memento.get<boolean>(SYNCED_KEY) === true;
  }

  async setSynced(value: boolean): Promise<void> {
    await this.memento.update(SYNCED_KEY, value);
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

  private async pollStat() {
    let stat: string;
    try {
      const s = await fs.stat(this.uri.fsPath);
      stat = `${s.mtimeMs}:${s.size}`;
    } catch {
      stat = 'missing';
    }
    if (this.lastStat !== undefined && stat !== this.lastStat) this.fire();
    this.lastStat = stat;
  }

  dispose() {
    clearInterval(this.poller);
    clearTimeout(this.timer);
    this.watcher?.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
