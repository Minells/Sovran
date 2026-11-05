/**
 * Read-only access to the parts of a ZIP container (Office Open XML, OpenDocument, plain archives), bounded by
 * `DOCUMENT_LIMITS`. fflate inflates an entry into a buffer of the size the archive declares and never grows it, so
 * checking declared sizes before inflating bounds memory even when an entry lies about its size.
 */
import { unzipSync } from 'fflate';
import { DOCUMENT_LIMITS, DocumentError } from './types';
import { decodeXml } from './xml';

export interface ZipEntry {
  /** Path inside the archive, with forward slashes and no leading slash. */
  name: string;
  /** Uncompressed size the archive declares. */
  size: number;
  directory: boolean;
}

export interface ZipLimits {
  maxEntryBytes: number;
  maxTotalBytes: number;
  maxEntries: number;
}

const normalize = (name: string) => name.replace(/\\/g, '/').replace(/^\/+/, '');

/** Thrown from fflate's filter to stop scanning an archive with too many entries. */
class TooManyEntries extends Error {}

export class ZipArchive {
  private inflated = 0;
  /** Lower-cased names to the names as stored: part names are case-insensitive in Office files. */
  private readonly byLowerName = new Map<string, string>();

  private constructor(
    private readonly data: Uint8Array,
    readonly entries: readonly ZipEntry[],
    private readonly limits: ZipLimits,
  ) {
    for (const e of entries)
      if (!this.byLowerName.has(e.name.toLowerCase())) this.byLowerName.set(e.name.toLowerCase(), e.name);
  }

  /** Lists the archive without inflating anything. */
  static open(data: Uint8Array, limits: ZipLimits = DOCUMENT_LIMITS): ZipArchive {
    const entries: ZipEntry[] = [];
    try {
      unzipSync(data, {
        filter: (f) => {
          if (entries.length >= limits.maxEntries) throw new TooManyEntries();
          entries.push({ name: normalize(f.name), size: f.originalSize, directory: f.name.endsWith('/') });
          return false;
        },
      });
    } catch (e) {
      if (e instanceof TooManyEntries)
        throw new DocumentError('too_large', `The archive has more than ${limits.maxEntries} entries.`);
      throw new DocumentError(
        'corrupt',
        `Not a readable ZIP archive: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return new ZipArchive(data, entries, limits);
  }

  /** The stored name of a part, matched without regard to case. */
  find(name: string): string | undefined {
    return this.byLowerName.get(normalize(name).toLowerCase());
  }

  /** Inflates the named parts that exist (missing names are left out of the result). */
  read(names: readonly string[]): Map<string, Uint8Array> {
    const wanted = new Set(names.map((n) => this.find(n)).filter((n): n is string => !!n));
    const out = new Map<string, Uint8Array>();
    if (!wanted.size) return out;
    // An archive may store a name twice: only the first copy is inflated (and counted).
    const taken = new Set<string>();
    let files: Record<string, Uint8Array>;
    try {
      files = unzipSync(this.data, {
        filter: (f) => {
          const name = normalize(f.name);
          if (!wanted.has(name) || taken.has(name)) return false;
          taken.add(name);
          if (
            f.originalSize > this.limits.maxEntryBytes ||
            this.inflated + f.originalSize > this.limits.maxTotalBytes
          ) {
            throw new DocumentError(
              'too_large',
              `${name} declares ${f.originalSize} bytes once decompressed.`,
            );
          }
          this.inflated += f.originalSize;
          return true;
        },
      });
    } catch (e) {
      if (e instanceof DocumentError) throw e;
      throw new DocumentError(
        'corrupt',
        `A part of the archive could not be decompressed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    for (const [name, bytes] of Object.entries(files)) out.set(normalize(name), bytes);
    return out;
  }

  /** One part as text, or undefined when the archive does not have it. */
  text(name: string): string | undefined {
    const stored = this.find(name);
    if (!stored) return undefined;
    const bytes = this.read([stored]).get(stored);
    return bytes ? decodeXml(bytes) : undefined;
  }
}
