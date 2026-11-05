/**
 * Document conversions shared by attachments and the `read_file` tool, cached by file: a document attached again,
 * sent, or read page after page by the agent is converted once while it does not change.
 */
import type { DocumentConverterPort, FileStat } from '../ports';
import type { DocumentResult } from './types';

interface Entry {
  size: number;
  mtimeMs: number;
  result: Promise<DocumentResult>;
}

export class DocumentReader {
  /** Oldest first, so the first key is the one to evict. */
  private readonly cache = new Map<string, Entry>();

  constructor(
    private readonly converter: DocumentConverterPort,
    private readonly capacity = 16,
  ) {}

  /**
   * The Markdown of the document at `path`, converted with at most `maxChars` characters. `load` reads its bytes,
   * only when there is no conversion of the same size and modification time. Two calls for the same file share one
   * conversion, and a failed conversion is not kept.
   */
  read(
    path: string,
    stat: Pick<FileStat, 'size' | 'mtimeMs'>,
    load: () => Promise<Uint8Array>,
    maxChars: number,
    signal?: AbortSignal,
  ): Promise<DocumentResult> {
    const key = `${maxChars}\u0000${path}`;
    const hit = this.cache.get(key);
    if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit.result;
    }
    const result = load().then((data) => this.converter.convert(data, { maxChars, signal }));
    const entry: Entry = { size: stat.size, mtimeMs: stat.mtimeMs, result };
    this.cache.delete(key);
    this.cache.set(key, entry);
    if (this.cache.size > this.capacity) this.cache.delete(this.cache.keys().next().value!);
    result.catch(() => {
      if (this.cache.get(key) === entry) this.cache.delete(key);
    });
    return result;
  }
}
