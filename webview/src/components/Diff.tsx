import { useState } from 'react';

export interface DiffRow {
  kind: 'add' | 'del' | 'ctx' | 'hunk' | 'note';
  text: string;
  /** Line number in the new file (added and unchanged lines) or in the old file (removed lines). */
  line?: number;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Parses a unified diff into rows with line numbers. Everything before the first hunk is the file header and is
 * skipped: matching `--- `/`+++ ` anywhere would also drop a removed line that starts with "-- " (a SQL comment).
 */
export function parseDiff(diff: string): DiffRow[] {
  const rows: DiffRow[] = [];
  const lines = diff.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  let inHunk = false;
  let oldNo = 0;
  let newNo = 0;
  for (const l of lines) {
    const hunk = HUNK.exec(l);
    if (hunk) {
      inHunk = true;
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      rows.push({ kind: 'hunk', text: l });
    } else if (!inHunk) {
      continue;
    } else if (l.startsWith('\\')) {
      rows.push({ kind: 'note', text: l.slice(1).trim() });
    } else if (l.startsWith('+')) {
      rows.push({ kind: 'add', text: l.slice(1), line: newNo++ });
    } else if (l.startsWith('-')) {
      rows.push({ kind: 'del', text: l.slice(1), line: oldNo++ });
    } else {
      oldNo++;
      rows.push({ kind: 'ctx', text: l.startsWith(' ') ? l.slice(1) : l, line: newNo++ });
    }
  }
  return rows;
}

const SIGN: Record<DiffRow['kind'], string> = { add: '+', del: '−', ctx: '', hunk: '', note: '' };

/**
 * A diff that reads in a narrow view: line numbers, long lines wrapped instead of scrolled sideways, and no scroll area
 * of its own (the chat scrolls, so the wheel never gets stuck inside the diff). Long diffs show the first `limit` rows
 * and expand on request; the diff editor shows everything side by side.
 */
export function DiffView({ diff, limit = 80, label = 'Proposed changes' }: { diff: string; limit?: number; label?: string }) {
  const rows = parseDiff(diff);
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? rows : rows.slice(0, limit);
  const hidden = rows.length - shown.length;
  return (
    <div className="sv-diff" role="group" aria-label={label}>
      {shown.map((r, i) => (
        <div key={i} className="sv-diff__row" data-kind={r.kind}>
          <span className="sv-diff__no" aria-hidden="true">
            {r.line ?? ''}
          </span>
          <span className="sv-diff__sign">{SIGN[r.kind]}</span>
          <code className="sv-diff__text">{r.text || ' '}</code>
        </div>
      ))}
      {hidden > 0 ? (
        <button type="button" className="sv-diff__more" onClick={() => setExpanded(true)}>
          Show {hidden} more line{hidden === 1 ? '' : 's'}
        </button>
      ) : null}
    </div>
  );
}
