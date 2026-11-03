import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Checkpoint, FileSnapshot } from '../../core/checkpoints/checkpoints';

const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

/** Stores file snapshots for rollback, one JSON file per checkpoint, deleted together with the session. */
export class FsCheckpointRepository {
  constructor(private readonly dir: string) {}

  private file(sessionId: string, id: string) {
    if (!ID_RE.test(sessionId) || !ID_RE.test(id)) throw new Error('Invalid checkpoint id.');
    return path.join(this.dir, `${sessionId}--${id}.json`);
  }

  async save(cp: Checkpoint): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const target = this.file(cp.sessionId, cp.id);
    const tmp = `${target}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(cp), 'utf8');
    await fs.rename(tmp, target);
  }

  async load(sessionId: string, id: string): Promise<Checkpoint | undefined> {
    try {
      const cp = JSON.parse(await fs.readFile(this.file(sessionId, id), 'utf8')) as Checkpoint;
      return cp && Array.isArray(cp.files) ? cp : undefined;
    } catch {
      return undefined;
    }
  }

  async deleteForSession(sessionId: string): Promise<void> {
    if (!ID_RE.test(sessionId)) return;
    const entries = await fs.readdir(this.dir).catch(() => [] as string[]);
    await Promise.all(entries.filter((f) => f.startsWith(`${sessionId}--`)).map((f) => fs.rm(path.join(this.dir, f), { force: true })));
  }
}

/**
 * Merges a later run's changes into an earlier checkpoint for the same message (retry while keeping files):
 * the earliest "before" wins, the latest "after" wins, so Undo still returns to the original state.
 */
export function mergeSnapshots(earlier: readonly FileSnapshot[], later: readonly FileSnapshot[]): FileSnapshot[] {
  const byPath = new Map(earlier.map((f) => [f.absolutePath, { ...f }]));
  for (const f of later) {
    const prev = byPath.get(f.absolutePath);
    byPath.set(f.absolutePath, prev ? { ...prev, afterHash: f.afterHash } : { ...f });
  }
  return [...byPath.values()];
}
