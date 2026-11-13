import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { normalizeExcludedGroups } from '../../core/tools/groups';
import { normalizeToolUnits } from '../../core/tools/loading';
import {
  summarize,
  type Session,
  type SessionRepository,
  type SessionSummary,
} from '../../core/sessions/model';

const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * One JSON file per session plus an index, in VS Code's per-workspace storage.
 * Writes are atomic (temp file + rename) and serialized to avoid interleaving.
 */
export class FsSessionRepository implements SessionRepository {
  private index: SessionSummary[] | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly dir: string) {}

  private file(id: string) {
    if (!ID_RE.test(id)) throw new Error('Invalid session id.');
    return path.join(this.dir, `session-${id}.json`);
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async writeAtomic(file: string, data: string) {
    await fs.mkdir(this.dir, { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, data, 'utf8');
    await fs.rename(tmp, file);
  }

  private async loadIndex(): Promise<SessionSummary[]> {
    if (this.index) return this.index;
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(this.dir, 'index.json'), 'utf8')) as unknown;
      this.index = Array.isArray(parsed)
        ? (parsed.filter((s) => s && typeof s.id === 'string' && ID_RE.test(s.id)) as SessionSummary[])
        : [];
    } catch {
      this.index = [];
    }
    return this.index;
  }

  async list(): Promise<SessionSummary[]> {
    return [...(await this.loadIndex())].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async load(id: string): Promise<Session | undefined> {
    try {
      const s = JSON.parse(await fs.readFile(this.file(id), 'utf8')) as Session;
      if (s?.excludedToolGroups !== undefined)
        s.excludedToolGroups = normalizeExcludedGroups(s.excludedToolGroups);
      if (s?.toolUnits !== undefined) s.toolUnits = normalizeToolUnits(s.toolUnits);
      if (s?.toolUnitsBasis !== undefined && (typeof s.toolUnitsBasis !== 'string' || s.toolUnitsBasis.length > 400))
        delete s.toolUnitsBasis;
      return s && s.id === id && Array.isArray(s.messages) ? s : undefined;
    } catch {
      return undefined;
    }
  }

  save(session: Session): Promise<void> {
    return this.serialize(async () => {
      await this.writeAtomic(this.file(session.id), JSON.stringify(session));
      const index = (await this.loadIndex()).filter((s) => s.id !== session.id);
      index.push(summarize(session));
      this.index = index;
      await this.writeAtomic(path.join(this.dir, 'index.json'), JSON.stringify(index));
    });
  }

  delete(id: string): Promise<void> {
    return this.serialize(async () => {
      await fs.rm(this.file(id), { force: true });
      this.index = (await this.loadIndex()).filter((s) => s.id !== id);
      await this.writeAtomic(path.join(this.dir, 'index.json'), JSON.stringify(this.index));
    });
  }
}

/** Used when persistence is disabled: sessions live only for the window's lifetime. */
export class MemorySessionRepository implements SessionRepository {
  private readonly map = new Map<string, Session>();
  async list() {
    return [...this.map.values()].map(summarize).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async load(id: string) {
    return this.map.get(id);
  }
  async save(s: Session) {
    this.map.set(s.id, structuredClone(s));
  }
  async delete(id: string) {
    this.map.delete(id);
  }
}

/**
 * Follows `sovran.sessions.persist` while the window is open: chats are saved on disk while it is on and only in
 * memory from the moment it is turned off, without waiting for a reload. The history lists the chats of the current
 * place; deleting a chat removes it from both.
 */
export class SwitchingSessionRepository implements SessionRepository {
  constructor(
    private readonly persistent: SessionRepository,
    private readonly memory: SessionRepository,
    private readonly persist: () => boolean,
  ) {}
  private get current() {
    return this.persist() ? this.persistent : this.memory;
  }
  list() {
    return this.current.list();
  }
  async load(id: string) {
    const [first, second] = this.persist() ? [this.persistent, this.memory] : [this.memory, this.persistent];
    return (await first.load(id)) ?? (await second.load(id));
  }
  save(session: Session) {
    return this.current.save(session);
  }
  async delete(id: string) {
    await Promise.all([this.persistent.delete(id), this.memory.delete(id)]);
  }
}
