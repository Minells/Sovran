import type { WorkspacePort } from '../ports';
import { contentHash } from '../tools/edits';

/** State of one file before the agent first touched it during a run, and what the agent left behind. */
export interface FileSnapshot {
  absolutePath: string;
  existed: boolean;
  /** Original content ('' when the file did not exist). */
  before: string;
  /** Hash of the content the agent wrote last; null when the agent deleted the file. */
  afterHash: string | null;
}

export interface Checkpoint {
  id: string;
  sessionId: string;
  userMessageId: string;
  createdAt: number;
  files: FileSnapshot[];
}

/**
 * Decorates a WorkspacePort and snapshots every file right before its first modification in a run.
 * Tools stay unaware of checkpoints: rollback is a cross-cutting concern of the runtime.
 */
export class CheckpointRecorder implements WorkspacePort {
  private readonly snapshots = new Map<string, FileSnapshot>();
  readonly searchText: WorkspacePort['searchText'];
  /** Optional capabilities pass through as the inner workspace has them (read_file needs readBytes for documents). */
  readonly readBytes: WorkspacePort['readBytes'];
  readonly isDirty: WorkspacePort['isDirty'];
  readonly diagnostics: WorkspacePort['diagnostics'];
  readonly querySemantic: WorkspacePort['querySemantic'];

  constructor(private readonly inner: WorkspacePort) {
    this.searchText = inner.searchText?.bind(inner);
    this.readBytes = inner.readBytes?.bind(inner);
    this.isDirty = inner.isDirty?.bind(inner);
    this.diagnostics = inner.diagnostics?.bind(inner);
    this.querySemantic = inner.querySemantic?.bind(inner);
  }

  private async snapshot(absPath: string): Promise<FileSnapshot> {
    let snap = this.snapshots.get(absPath);
    if (!snap) {
      const stat = await this.inner.stat(absPath);
      const existed = stat?.type === 'file';
      snap = { absolutePath: absPath, existed, before: existed ? await this.inner.readFile(absPath) : '', afterHash: null };
      this.snapshots.set(absPath, snap);
    }
    return snap;
  }

  async writeFile(absPath: string, content: string): Promise<void> {
    const snap = await this.snapshot(absPath);
    await this.inner.writeFile(absPath, content);
    snap.afterHash = contentHash(content);
  }

  async deleteFile(absPath: string): Promise<void> {
    const snap = await this.snapshot(absPath);
    await this.inner.deleteFile(absPath);
    snap.afterHash = null;
  }

  /** Files whose final state differs from their original state. */
  changedFiles(): FileSnapshot[] {
    return [...this.snapshots.values()].filter((s) => (s.existed ? s.afterHash !== contentHash(s.before) : s.afterHash !== null));
  }

  roots = () => this.inner.roots();
  isTrusted = () => this.inner.isTrusted();
  stat = (p: string) => this.inner.stat(p);
  realpath = (p: string) => this.inner.realpath(p);
  readFile = (p: string) => this.inner.readFile(p);
  readDirectory = (p: string) => this.inner.readDirectory(p);
  findFiles = (include: string, options: { maxResults: number; signal?: AbortSignal }) => this.inner.findFiles(include, options);
  activeEditor = () => this.inner.activeEditor();
  openEditors = () => this.inner.openEditors();
  environment = () => this.inner.environment();
}

export interface RestorePlanItem {
  snapshot: FileSnapshot;
  /** 'modified' when the file no longer matches what the agent left (the user changed it since). */
  state: 'clean' | 'modified';
}

export async function planRestore(files: readonly FileSnapshot[], workspace: WorkspacePort): Promise<RestorePlanItem[]> {
  const plan: RestorePlanItem[] = [];
  for (const snapshot of files) {
    const stat = await workspace.stat(snapshot.absolutePath);
    const currentHash = stat?.type === 'file' ? contentHash(await workspace.readFile(snapshot.absolutePath)) : null;
    plan.push({ snapshot, state: currentHash === snapshot.afterHash ? 'clean' : 'modified' });
  }
  return plan;
}

export interface RestoreResult {
  restored: string[];
  skipped: string[];
}

/** Puts files back to their pre-run state. Modified files are skipped unless `includeModified`. */
export async function restoreFiles(plan: readonly RestorePlanItem[], workspace: WorkspacePort, includeModified: boolean): Promise<RestoreResult> {
  const result: RestoreResult = { restored: [], skipped: [] };
  for (const { snapshot, state } of plan) {
    if (state === 'modified' && !includeModified) {
      result.skipped.push(snapshot.absolutePath);
      continue;
    }
    if (snapshot.existed) {
      await workspace.writeFile(snapshot.absolutePath, snapshot.before);
    } else if ((await workspace.stat(snapshot.absolutePath))?.type === 'file') {
      await workspace.deleteFile(snapshot.absolutePath);
    }
    result.restored.push(snapshot.absolutePath);
  }
  return result;
}
