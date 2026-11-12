import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DirEntry, EditorContext, EditorDiagnostic, FileDiagnostics, FileStat, TextSearchOptions, TextSearchResult, WorkspacePort, WorkspaceRoot } from '../../core/ports';
import type { RipgrepSearch } from './RipgrepSearch';
import { querySemantic } from './VscodeSemanticNavigation';

const DEFAULT_EXCLUDES = ['**/node_modules/**', '**/.git/**', '**/.hg/**', '**/.svn/**', '**/__pycache__/**', '**/.venv/**', '**/venv/**'];
const SEVERITY: Record<vscode.DiagnosticSeverity, EditorDiagnostic['severity']> = {
  [vscode.DiagnosticSeverity.Error]: 'error',
  [vscode.DiagnosticSeverity.Warning]: 'warning',
  [vscode.DiagnosticSeverity.Information]: 'info',
  [vscode.DiagnosticSeverity.Hint]: 'hint',
};

export function shellPath(): string {
  return vscode.env.shell || process.env.SHELL || (process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : '/bin/sh');
}

function platformName(): string {
  const names: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };
  return `${names[process.platform] ?? process.platform} ${os.release()} (${process.arch})`;
}

/** WorkspacePort backed by the VS Code workspace: buffer-aware reads, undoable writes. */
export class VscodeWorkspace implements WorkspacePort {
  readonly querySemantic = querySemantic;
  readonly searchText?: (o: TextSearchOptions) => Promise<TextSearchResult>;

  constructor(ripgrep?: RipgrepSearch) {
    if (ripgrep) this.searchText = (o) => ripgrep.search(o, this.roots().map((r) => r.path));
  }

  roots(): WorkspaceRoot[] {
    return (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => ({ name: f.name, path: f.uri.fsPath }));
  }

  isTrusted(): boolean {
    return vscode.workspace.isTrusted;
  }

  async stat(absPath: string): Promise<FileStat | null> {
    try {
      const s = await vscode.workspace.fs.stat(vscode.Uri.file(absPath));
      const type = s.type & vscode.FileType.Directory ? 'directory' : s.type & vscode.FileType.File ? 'file' : 'other';
      return { type, size: s.size, mtimeMs: s.mtime };
    } catch {
      return null;
    }
  }

  realpath(absPath: string): Promise<string> {
    return fs.realpath(absPath);
  }

  private openDocument(absPath: string): vscode.TextDocument | undefined {
    return vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && d.uri.fsPath === absPath);
  }

  async readFile(absPath: string): Promise<string> {
    const open = this.openDocument(absPath);
    if (open) return open.getText();
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(absPath));
    return new TextDecoder('utf-8').decode(bytes);
  }

  /** The bytes on disk (an open editor's unsaved text does not apply to documents or images). */
  readBytes(absPath: string): Promise<Uint8Array> {
    return Promise.resolve(vscode.workspace.fs.readFile(vscode.Uri.file(absPath)));
  }

  async readDirectory(absPath: string): Promise<DirEntry[]> {
    const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(absPath));
    return entries.map(([name, t]) => ({ name, type: t & vscode.FileType.Directory ? 'directory' : t & vscode.FileType.File ? 'file' : 'other' }));
  }

  async findFiles(include: string, options: { maxResults: number; signal?: AbortSignal }): Promise<string[]> {
    const userExcludes = Object.entries(vscode.workspace.getConfiguration('files').get<Record<string, boolean>>('exclude') ?? {})
      .filter(([, on]) => on === true)
      .map(([glob]) => glob);
    const exclude = `{${[...DEFAULT_EXCLUDES, ...userExcludes].join(',')}}`;
    const cts = new vscode.CancellationTokenSource();
    const onAbort = () => cts.cancel();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const results: string[] = [];
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        if (folder.uri.scheme !== 'file') continue;
        const remaining = options.maxResults - results.length;
        if (remaining <= 0) break;
        const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, include), exclude, remaining, cts.token);
        results.push(...uris.map((u) => u.fsPath));
      }
      return results;
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
      cts.dispose();
    }
  }

  async writeFile(absPath: string, content: string): Promise<void> {
    const uri = vscode.Uri.file(absPath);
    const exists = (await this.stat(absPath)) !== null;
    if (!exists) {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(absPath)));
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
      return;
    }
    // Existing files: apply as a WorkspaceEdit so the change is undoable and open editors stay in sync.
    const doc = await vscode.workspace.openTextDocument(uri);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), content);
    if (!(await vscode.workspace.applyEdit(edit))) throw new Error(`VS Code refused the edit to ${vscode.workspace.asRelativePath(uri)}.`);
    await doc.save();
  }

  async deleteFile(absPath: string): Promise<void> {
    const edit = new vscode.WorkspaceEdit();
    edit.deleteFile(vscode.Uri.file(absPath), { ignoreIfNotExists: true });
    if (!(await vscode.workspace.applyEdit(edit))) throw new Error(`VS Code refused to delete ${vscode.workspace.asRelativePath(absPath)}.`);
  }

  isDirty(absPath: string): boolean {
    return vscode.workspace.textDocuments.some(
      (doc) => doc.uri.scheme === 'file' && path.relative(doc.uri.fsPath, absPath) === '' && doc.isDirty,
    );
  }

  activeEditor(): EditorContext | null {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') return null;
    const doc = editor.document;
    const sel = editor.selection;
    return {
      path: doc.uri.fsPath,
      languageId: doc.languageId,
      lineCount: doc.lineCount,
      isDirty: doc.isDirty,
      selection: sel.isEmpty ? undefined : { startLine: sel.start.line + 1, endLine: sel.end.line + 1, text: doc.getText(sel) },
      diagnostics: vscode.languages.getDiagnostics(doc.uri).map((d) => ({
        line: d.range.start.line + 1,
        severity: SEVERITY[d.severity],
        message: d.message,
        source: d.source,
      })),
    };
  }

  diagnostics(absPath?: string): FileDiagnostics[] {
    // Read only the existing Problems collection. Do not open files or invoke language providers.
    const entries: readonly [vscode.Uri, readonly vscode.Diagnostic[]][] =
      absPath === undefined
        ? vscode.languages.getDiagnostics()
        : [[vscode.Uri.file(absPath), vscode.languages.getDiagnostics(vscode.Uri.file(absPath))]];
    return entries
      .filter(([uri]) => uri.scheme === 'file')
      .map(([uri, diagnostics]) => ({
        path: uri.fsPath,
        diagnostics: diagnostics.map((d) => ({
          line: d.range.start.line + 1,
          severity: SEVERITY[d.severity],
          message: d.message,
          source: d.source,
        })),
      }));
  }

  openEditors(): string[] {
    const paths = new Set<string>();
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputText && tab.input.uri.scheme === 'file') paths.add(tab.input.uri.fsPath);
      }
    }
    return [...paths];
  }

  environment() {
    return { os: platformName(), shell: path.basename(shellPath()) };
  }
}
