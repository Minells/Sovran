/** Helpers for files the user browses and attaches. Portable: no VS Code or DOM dependencies. */
import * as path from 'node:path';
import { isInside } from '../security/paths';

/** Bytes inspected by `looksBinary`: the same window Git uses to decide that a file is binary. */
const BINARY_SAMPLE = 8000;

/** A NUL byte near the start means binary content (Git's heuristic). Sovran attaches text files only. */
export function looksBinary(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, BINARY_SAMPLE);
  for (let i = 0; i < end; i++) if (bytes[i] === 0) return true;
  return false;
}

/**
 * How a file outside the workspace is named to the user and the model: `~/…` under the home folder (shorter, and it
 * does not reveal the account name), otherwise the full path. Separators are always forward slashes.
 */
export function displayPath(absolute: string, home: string | undefined, p: path.PlatformPath = path): string {
  if (home && isInside(home, absolute, p)) {
    const rel = p.relative(home, absolute);
    return rel ? `~/${rel.split(p.sep).join('/')}` : '~';
  }
  return absolute.split(p.sep).join('/');
}

export interface BrowseEntry {
  name: string;
  type: 'file' | 'directory';
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** Folders first, then files, each in natural order (`file2` before `file10`, case-insensitive), like the Explorer. */
export function compareEntries(a: BrowseEntry, b: BrowseEntry): number {
  if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
  return collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}
