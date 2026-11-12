/**
 * Ports: the only way the portable core reaches the outside world.
 * The VS Code host implements them in src/extension/adapters; tests use in-memory fakes;
 * a future CLI would implement them with node:fs and child_process.
 */

import type { DocumentResult } from './documents/types';
import type { ImageMime } from './images/images';

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

export interface FileDiagnostics {
  /** Absolute file-system path. Non-file URI schemes must not be included. */
  path: string;
  diagnostics: readonly EditorDiagnostic[];
}

/** One-based position, with columns measured in UTF-16 code units. */
export interface SourcePosition {
  line: number;
  column: number;
}

export type SemanticQuery =
  | { kind: 'symbols'; path: string }
  | ({ kind: 'definition' | 'references'; path: string } & SourcePosition);

export interface SemanticLocation extends SourcePosition {
  /** Absolute file path. Hosts omit locations without a filesystem path. */
  path: string;
  /** Present for document symbols. */
  name?: string;
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
  /** The file's bytes as saved on disk (documents, images, text that is not UTF-8). Optional for hosts without it. */
  readBytes?(absPath: string): Promise<Uint8Array>;
  readDirectory(absPath: string): Promise<DirEntry[]>;
  /** Glob search relative to the workspace roots. Returns absolute paths. */
  findFiles(include: string, options: { maxResults: number; signal?: AbortSignal }): Promise<string[]>;
  /** Replaces (or creates) a file. Implementations should make the change undoable. */
  writeFile(absPath: string, content: string): Promise<void>;
  /** Deletes a file (used by checkpoint rollback). Implementations should make the change undoable. */
  deleteFile(absPath: string): Promise<void>;
  /** Optional fast text search (e.g. ripgrep). Callers fall back to scanning files when absent. */
  searchText?(options: TextSearchOptions): Promise<TextSearchResult>;
  /** Whether a saved-file operation would ignore unsaved editor changes. */
  isDirty?(absPath: string): boolean;
  /** Paths of unsaved file-backed documents known to the editor. */
  dirtyFiles?(): string[];
  activeEditor(): EditorContext | null;
  /** Cached editor diagnostics, including unopened files. Never opens documents or starts analysis.
   * When supplied, absPath selects one exact file. Callers enforce workspace/protected-path boundaries.
   */
  diagnostics?(absPath?: string): readonly FileDiagnostics[];
  /** Queries an existing editor language provider. The query path is absolute. */
  querySemantic?(query: SemanticQuery, signal: AbortSignal): Promise<Iterable<SemanticLocation>>;
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

export interface ProcessOptions {
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal;
  maxOutputChars: number;
  onOutput?: (chunk: string) => void;
}

export interface FileProcessOptions extends ProcessOptions {
  /** Structured processes inherit a minimal host environment; these trusted overrides are applied last. */
  env?: Readonly<Record<string, string>>;
  /** Explicit host keys requested by trusted code (e.g. signing-agent locations), never model-controlled. */
  inheritEnv?: readonly string[];
  /** Never resolve an executable from these workspace roots, even through a PATH symlink. */
  disallowedExecutableRoots?: readonly string[];
  /** Final synchronous runtime authorization check after executable resolution, immediately before spawning. */
  beforeSpawn?: () => void;
}

export interface FileProcessResult extends ProcessResult {
  /** Kept separate and decoded incrementally; structured output must not be mixed with diagnostics. */
  stdout: string;
  stderr: string;
}

export interface ProcessPort {
  run(command: string, options: ProcessOptions): Promise<ProcessResult>;
  /** Execute an executable and literal argv without a shell, using the host PATH outside workspace roots. */
  runFile(executable: string, argv: readonly string[], options: FileProcessOptions): Promise<FileProcessResult>;
}

export interface GitApprovalDetail {
  kind: 'git';
  operation: 'stage' | 'unstage' | 'commit' | 'fetch' | 'push' | 'pull' | 'rebase';
  repository: string;
  branch: string;
  files: string[];
  message?: string;
  target?: { destination: string; refs: string[] };
  preview: string;
  warnings: string[];
}

export type ApprovalDetail =
  | GitApprovalDetail
  | { kind: 'web'; url: string }
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
  | { kind: 'read'; path: string; reason: string }
  | {
      kind: 'mcp';
      serverId: string;
      /** The server's display name. */
      server: string;
      tool: string;
      title?: string;
      /** The arguments, as indented JSON. */
      arguments: string;
      /** What the server says about the tool (MCP annotations). Only claims the server made explicitly. */
      hints: McpToolHint[];
      requiresApproval?: true;
    };

/** MCP tool annotations as the user reads them. They come from the server, so they are claims, not guarantees. */
export type McpToolHint = 'read-only' | 'destructive' | 'open-world';

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

/**
 * Where the images of a chat are kept, by their SHA-256 id: out of the session file (they can be megabytes) and
 * deleted with the chat.
 */
export interface ImageStorePort {
  save(sessionId: string, id: string, mime: ImageMime, data: Uint8Array): Promise<void>;
  /** The image's bytes, or undefined when it is gone. */
  load(sessionId: string, id: string, mime: ImageMime): Promise<Uint8Array | undefined>;
  deleteForSession(sessionId: string): Promise<void>;
}

export interface DocumentConverterPort {
  /**
   * Converts a document (PDF, Office Open XML, OpenDocument, ZIP) to Markdown. Rejects with a `DocumentError`.
   * Implementations must isolate the parsers from the caller (the VS Code host runs them in a worker thread).
   */
  convert(data: Uint8Array, options: { maxChars: number; signal?: AbortSignal }): Promise<DocumentResult>;
}

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const nullLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
