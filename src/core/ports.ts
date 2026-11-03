/**
 * Ports: the only way the portable core reaches the outside world.
 * The VS Code host implements them in src/extension/adapters; tests use in-memory fakes;
 * a future CLI would implement them with node:fs and child_process.
 */

export interface WorkspaceRoot {
  /** Display name (folder name in multi-root workspaces). */
  name: string;
  /** Absolute file-system path. */
  path: string;
}

export interface FileStat {
  type: 'file' | 'directory' | 'other';
  size: number;
  mtimeMs: number;
}

export interface DirEntry {
  name: string;
  type: 'file' | 'directory' | 'other';
}

export interface EditorDiagnostic {
  line: number;
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  source?: string;
}

export interface EditorContext {
  /** Absolute path of the active document (file scheme only). */
  path: string;
  languageId: string;
  lineCount: number;
  isDirty: boolean;
  selection?: { startLine: number; endLine: number; text: string };
  diagnostics: EditorDiagnostic[];
}

export interface TextSearchOptions {
  query: string;
  isRegex: boolean;
  caseSensitive: boolean;
  /** Glob of files to search, relative to the workspace roots. */
  include: string;
  /** Globs never to search (protected paths). */
  excludes: readonly string[];
  maxResults: number;
  signal?: AbortSignal;
}

export interface TextSearchResult {
  matches: Array<{ path: string; line: number; text: string }>;
  limitHit: boolean;
}

export interface WorkspacePort {
  roots(): WorkspaceRoot[];
  isTrusted(): boolean;
  stat(absPath: string): Promise<FileStat | null>;
  realpath(absPath: string): Promise<string>;
  /** Returns the current text, preferring unsaved editor buffers when the file is open. */
  readFile(absPath: string): Promise<string>;
  readDirectory(absPath: string): Promise<DirEntry[]>;
  /** Glob search relative to the workspace roots. Returns absolute paths. */
  findFiles(include: string, options: { maxResults: number; signal?: AbortSignal }): Promise<string[]>;
  /** Replaces (or creates) a file. Implementations should make the change undoable. */
  writeFile(absPath: string, content: string): Promise<void>;
  /** Deletes a file (used by checkpoint rollback). Implementations should make the change undoable. */
  deleteFile(absPath: string): Promise<void>;
  /** Optional fast text search (e.g. ripgrep). Callers fall back to scanning files when absent. */
  searchText?(options: TextSearchOptions): Promise<TextSearchResult>;
  activeEditor(): EditorContext | null;
  openEditors(): string[];
  environment(): { os: string; shell: string };
}

export interface ProcessResult {
  exitCode: number | null;
  signal: string | null;
  output: string;
  truncated: boolean;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
}

export interface ProcessPort {
  run(
    command: string,
    options: {
      cwd: string;
      timeoutMs: number;
      signal: AbortSignal;
      maxOutputChars: number;
      onOutput?: (chunk: string) => void;
    },
  ): Promise<ProcessResult>;
}

export type ApprovalDetail =
  | {
      kind: 'edit';
      path: string;
      absolutePath: string;
      isNew: boolean;
      diff: string;
      added: number;
      removed: number;
      originalContent: string;
      proposedContent: string;
    }
  | { kind: 'command'; command: string; cwd: string; warnings: string[] }
  | { kind: 'read'; path: string; reason: string };

export interface ApprovalRequest {
  id: string;
  callId: string;
  toolName: string;
  title: string;
  detail: ApprovalDetail;
  /** Why the policy asks (e.g. "Deletes files and folders recursively."), shown when the approval mode would otherwise allow it. */
  reason?: string;
}

export interface ApprovalResponse {
  approved: boolean;
  /** Grant that applies to the rest of the session. */
  grant?: 'session-edits';
  feedback?: string;
}

export interface ApprovalPort {
  /** Resolves when the user decides. Must reject (or resolve unapproved) when `signal` aborts. */
  request(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalResponse>;
}

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const nullLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
