import type { WorkspacePort } from '../ports';
import { resolveAndVerify } from '../security/paths';
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

export interface CheckpointRepository {
  save(checkpoint: Checkpoint): Promise<void>;
  load(sessionId: string, id: string): Promise<Checkpoint | undefined>;
  deleteForSession(sessionId: string): Promise<void>;
}

export function followsSnapshot(earlier: FileSnapshot, later: FileSnapshot): boolean {
  return earlier.afterHash === (later.existed ? contentHash(later.before) : null);
}

/** The first baseline wins for contiguous writes. A resumed edit after an external change starts a new baseline. */
export function mergeSnapshots(
  earlier: readonly FileSnapshot[],
  later: readonly FileSnapshot[],
  preserveExternalEdits = false,
): FileSnapshot[] {
  const byPath = new Map(earlier.map((f) => [f.absolutePath, { ...f }]));
  for (const file of later) {
    const previous = byPath.get(file.absolutePath);
    byPath.set(file.absolutePath, previous && (!preserveExternalEdits || followsSnapshot(previous, file))
      ? { ...previous, afterHash: file.afterHash } : { ...file });
  }
  return [...byPath.values()].filter((file) => file.afterHash !== (file.existed ? contentHash(file.before) : null));
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
  readonly dirtyFiles: WorkspacePort['dirtyFiles'];
  readonly diagnostics: WorkspacePort['diagnostics'];
  readonly querySemantic: WorkspacePort['querySemantic'];

  /** `onChange` runs after every write or delete, so the host can save the checkpoint while the run is going. */
  constructor(
    private readonly inner: WorkspacePort,
    private readonly onChange?: (snapshot: FileSnapshot, after: string) => void,
  ) {
    this.searchText = inner.searchText?.bind(inner);
    this.readBytes = inner.readBytes?.bind(inner);
    this.isDirty = inner.isDirty?.bind(inner);
    this.dirtyFiles = inner.dirtyFiles?.bind(inner);
    this.diagnostics = inner.diagnostics?.bind(inner);
    this.querySemantic = inner.querySemantic?.bind(inner);
  }

  private async snapshot(absPath: string): Promise<FileSnapshot> {
    let snap = this.snapshots.get(absPath);
    if (!snap) {
      const stat = await this.inner.stat(absPath);
      const existed = stat?.type === 'file';
      const before = existed ? await this.inner.readFile(absPath) : '';
      snap = { absolutePath: absPath, existed, before, afterHash: existed ? contentHash(before) : null };
      this.snapshots.set(absPath, snap);
    }
    return snap;
  }

  async writeFile(absPath: string, content: string): Promise<void> {
    const snap = await this.snapshot(absPath);
    await this.inner.writeFile(absPath, content);
    // What the file holds after the write, not what was asked for: format-on-save or the document's line endings may
    // change it, and Undo must still recognize the file as the one the agent left.
    const after = await this.inner.readFile(absPath).catch(() => content);
    snap.afterHash = contentHash(after);
    this.onChange?.(snap, after);
  }

  async deleteFile(absPath: string): Promise<void> {
    const snap = await this.snapshot(absPath);
    await this.inner.deleteFile(absPath);
    snap.afterHash = null;
    this.onChange?.(snap, '');
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
  currentHash: string | null | undefined;
}

async function currentFileHash(path: string, workspace: WorkspacePort): Promise<string | null | undefined> {
  try {
    await resolveAndVerify(path, workspace);
    const stat = await workspace.stat(path);
    if (!stat) return null;
    if (stat.type === 'file') return contentHash(await workspace.readFile(path));
  } catch {
    // Unverifiable paths are never overwritten, even when the user allows restoring modified files.
  }
  return undefined;
}

export async function planRestore(files: readonly FileSnapshot[], workspace: WorkspacePort): Promise<RestorePlanItem[]> {
  const plan: RestorePlanItem[] = [];
  for (const snapshot of files) {
    const currentHash = await currentFileHash(snapshot.absolutePath, workspace);
    plan.push({ snapshot, currentHash, state: currentHash === snapshot.afterHash ? 'clean' : 'modified' });
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
  for (const { snapshot, state, currentHash } of plan) {
    if (currentHash === undefined || (state === 'modified' && !includeModified) ||
        (await currentFileHash(snapshot.absolutePath, workspace)) !== currentHash) {
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
