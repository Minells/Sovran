import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { IMAGE_EXTENSIONS, type ImageMime } from '../../core/images/images';
import type { ImageStorePort } from '../../core/ports';

const SESSION_RE = /^[A-Za-z0-9_-]{1,100}$/;
const IMAGE_RE = /^[a-f0-9]{64}$/;

/**
 * Images of chats as files in the workspace storage: `<session>/<sha256>.<ext>`, written atomically, stored once per
 * chat however often they are sent, and deleted with the chat.
 */
export class FsImageStore implements ImageStorePort {
  constructor(private readonly dir: string) {}

  private file(sessionId: string, id: string, mime: ImageMime) {
    if (!SESSION_RE.test(sessionId) || !IMAGE_RE.test(id) || !IMAGE_EXTENSIONS[mime])
      throw new Error('Invalid image id.');
    return path.join(this.dir, sessionId, `${id}.${IMAGE_EXTENSIONS[mime]}`);
  }

  async save(sessionId: string, id: string, mime: ImageMime, data: Uint8Array): Promise<void> {
    const target = this.file(sessionId, id, mime);
    if (
      await fs.stat(target).then(
        () => true,
        () => false,
      )
    )
      return;
    await fs.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, target);
  }

  async load(sessionId: string, id: string, mime: ImageMime): Promise<Uint8Array | undefined> {
    try {
      return new Uint8Array(await fs.readFile(this.file(sessionId, id, mime)));
    } catch {
      return undefined;
    }
  }

  async deleteForSession(sessionId: string): Promise<void> {
    if (!SESSION_RE.test(sessionId)) return;
    await fs.rm(path.join(this.dir, sessionId), { recursive: true, force: true });
  }
}

/** For windows that do not persist chats (`sovran.sessions.persist: false`): images live as long as the window. */
export class MemoryImageStore implements ImageStorePort {
  private readonly images = new Map<string, Uint8Array>();

  async save(sessionId: string, id: string, _mime: ImageMime, data: Uint8Array): Promise<void> {
    this.images.set(`${sessionId}/${id}`, data);
  }

  async load(sessionId: string, id: string): Promise<Uint8Array | undefined> {
    return this.images.get(`${sessionId}/${id}`);
  }

  async deleteForSession(sessionId: string): Promise<void> {
    for (const key of [...this.images.keys()]) if (key.startsWith(`${sessionId}/`)) this.images.delete(key);
  }
}

/** The images follow the chats (see `SwitchingSessionRepository`): on disk while chats are persisted, else in memory. */
export class SwitchingImageStore implements ImageStorePort {
  constructor(
    private readonly persistent: ImageStorePort,
    private readonly memory: ImageStorePort,
    private readonly persist: () => boolean,
  ) {}
  save(sessionId: string, id: string, mime: ImageMime, data: Uint8Array) {
    return (this.persist() ? this.persistent : this.memory).save(sessionId, id, mime, data);
  }
  async load(sessionId: string, id: string, mime: ImageMime) {
    return (await this.memory.load(sessionId, id, mime)) ?? (await this.persistent.load(sessionId, id, mime));
  }
  async deleteForSession(sessionId: string) {
    await Promise.all([this.persistent.deleteForSession(sessionId), this.memory.deleteForSession(sessionId)]);
  }
}
