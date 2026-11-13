import { createHash } from 'node:crypto';
import { createTwoFilesPatch } from 'diff';
import { ToolError } from './types';

export interface SearchReplace {
  search: string;
  replace: string;
  replaceAll?: boolean;
}

export const contentHash = (text: string) => createHash('sha256').update(text).digest('hex');

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) count++;
  return count;
}

function locateHint(text: string, search: string): string {
  const firstLine = search.split('\n').find((l) => l.trim().length > 0)?.trim();
  if (!firstLine) return '';
  const lines = text.split('\n');
  const idx = lines.findIndex((l) => l.trim() === firstLine);
  return idx === -1
    ? ' Its first line does not appear in the file either.'
    : ` Its first line appears at line ${idx + 1}; compare the following lines (whitespace and indentation must match exactly).`;
}

/**
 * Applies exact search/replace edits atomically. Line endings are normalized for matching and the
 * file's original EOL style is preserved on output. Throws ToolError with actionable guidance.
 */
export function applySearchReplace(original: string, edits: readonly SearchReplace[]): string {
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  let text = original.replace(/\r\n/g, '\n');
  edits.forEach((edit, i) => {
    const label = edits.length > 1 ? `Edit #${i + 1}: ` : '';
    const search = edit.search.replace(/\r\n/g, '\n');
    const replace = edit.replace.replace(/\r\n/g, '\n');
    if (search.length === 0) throw new ToolError(`${label}the search text is empty. Use write_file to create or replace a whole file.`);
    const count = countOccurrences(text, search);
    if (count === 0) {
      throw new ToolError(`${label}the search text was not found. Re-read the file and copy the exact text.${locateHint(text, search)}`);
    }
    if (count > 1 && !edit.replaceAll) {
      throw new ToolError(`${label}the search text matches ${count} places. Include more surrounding lines to make it unique, or set replace_all.`);
    }
    text = edit.replaceAll ? text.split(search).join(replace) : text.replace(search, () => replace);
  });
  return eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text;
}

export interface DiffSummary {
  diff: string;
  added: number;
  removed: number;
}

export function makeDiff(path: string, before: string, after: string): DiffSummary {
  const diff = createTwoFilesPatch(`a/${path}`, `b/${path}`, before.replace(/\r\n/g, '\n'), after.replace(/\r\n/g, '\n'), '', '', {
    context: 3,
  });
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++;
    else if (line.startsWith('-') && !line.startsWith('---')) removed++;
  }
  // Drop the "Index:"/"====" preamble jsdiff emits; keep from the --- header on.
  const start = diff.indexOf('--- ');
  return { diff: start > 0 ? diff.slice(start) : diff, added, removed };
}

/** Keeps head and tail of long text so both the start and the end (e.g. errors) stay visible. */
export function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.6);
  const tail = maxChars - head;
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n\n[… ${omitted.toLocaleString('en-US')} characters omitted …]\n\n${text.slice(text.length - tail)}`;
}

export const isProbablyBinary = (text: string) => text.slice(0, 8000).includes('\0');

export function isValidUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}
