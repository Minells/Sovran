import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Checkpoint, CheckpointRepository } from '../../core/checkpoints/checkpoints';

const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

/** Stores file snapshots for rollback, one JSON file per checkpoint, deleted together with the session. */
export class FsCheckpointRepository implements CheckpointRepository {
  constructor(private readonly dir: string) {}

  private file(sessionId: string, id: string) {
    if (!ID_RE.test(sessionId) || !ID_RE.test(id)) throw new Error('Invalid checkpoint id.');
    return path.join(this.dir, `${sessionId}--${id}.json`);
  }

  async save(cp: Checkpoint): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const target = this.file(cp.sessionId, cp.id);
    // Unique per write: two saves of the same checkpoint must not share (and corrupt) one temporary file.
    const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
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

export class SwitchingCheckpointRepository implements CheckpointRepository {
  private readonly memory = new Map<string, Map<string, Checkpoint>>();

  constructor(private readonly disk: CheckpointRepository, private readonly persist: () => boolean) {}

  async save(checkpoint: Checkpoint): Promise<void> {
    const entries = this.memory.get(checkpoint.sessionId);
    if (this.persist()) {
      await this.disk.save(checkpoint);
      entries?.delete(checkpoint.id);
      return;
    }
    const next = entries ?? new Map();
    next.set(checkpoint.id, structuredClone(checkpoint));
    this.memory.set(checkpoint.sessionId, next);
  }

  async load(sessionId: string, id: string): Promise<Checkpoint | undefined> {
    const saved = this.memory.get(sessionId)?.get(id);
    return saved ? structuredClone(saved) : this.disk.load(sessionId, id);
  }

  async deleteForSession(sessionId: string): Promise<void> {
    this.memory.delete(sessionId);
    await this.disk.deleteForSession(sessionId);
  }
}
