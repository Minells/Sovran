/** Markdown output shared by the converters: a size budget and table rendering. */

/**
 * Collects Markdown blocks up to a number of characters. Converters check `full` to stop reading early, so a long
 * document costs no more than the part that is sent.
 */
export class MarkdownBudget {
  private readonly blocks: string[] = [];
  private used = 0;
  private exhausted = false;
  /** The last block was a list item, so the next list item joins it with a single line break. */
  private inList = false;
  /** The output leaves something out: a block did not fit, or a converter said so with `omit`. */
  truncated = false;

  constructor(private readonly maxChars: number) {}

  /** No more text fits. */
  get full(): boolean {
    return this.exhausted || this.used >= this.maxChars;
  }

  /**
   * Adds a block, separated from the previous one by a blank line (list items that follow each other by a line
   * break, so they stay one list). Leading spaces are kept: they indent nested list items. A block that does not fit
   * is cut after its last whole line that does, so a table never ends in half a row. Returns false once the budget is
   * spent.
   */
  add(block: string, options: { listItem?: boolean } = {}): boolean {
    const text = block
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^\s*\n/, '')
      .trimEnd();
    if (!text.trim()) return !this.full;
    if (this.full) {
      this.exhausted = this.truncated = true;
      return false;
    }
    const tight = !!options.listItem && this.inList && this.blocks.length > 0;
    const remaining = this.maxChars - this.used;
    let piece = text;
    if (text.length > remaining) {
      const lineEnd = text.lastIndexOf('\n', remaining);
      piece = lineEnd > 0 ? text.slice(0, lineEnd) : text.slice(0, remaining);
      this.exhausted = this.truncated = true;
    }
    if (tight) this.blocks[this.blocks.length - 1] += `\n${piece}`;
    else this.blocks.push(piece);
    this.used += piece.length + (tight ? 1 : 2);
    this.inList = !!options.listItem;
    return !this.exhausted;
  }

  /** Marks the output as incomplete without stopping it (for example, a sheet whose last columns are left out). */
  omit() {
    this.truncated = true;
  }

  get isEmpty(): boolean {
    return this.blocks.length === 0;
  }

  toString(): string {
    return this.blocks.join('\n\n');
  }
}

/** Collapses runs of spaces and tabs, trims each line and drops blank lines at the ends. */
export function tidy(text: string): string {
  return text
    .split('\n')
    .map((l) => l.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const cell = (s: string) => tidy(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n+/g, '<br>');

/**
 * A Markdown table. The first row is the header; rows are padded to the widest one, and empty trailing columns and
 * empty rows are dropped. Returns '' for a table without any text.
 */
export function markdownTable(rows: readonly (readonly string[])[]): string {
  const cleaned = rows.map((r) => r.map(cell)).filter((r) => r.some((c) => c));
  if (!cleaned.length) return '';
  let width = 0;
  for (const r of cleaned) for (let i = r.length - 1; i >= width; i--) if (r[i]) width = i + 1;
  const pad = (r: string[]) => Array.from({ length: width }, (_, i) => r[i] ?? '');
  const line = (r: string[]) => `| ${pad(r).join(' | ')} |`;
  const [head, ...body] = cleaned;
  return [line(head!), `|${' --- |'.repeat(width)}`, ...body.map(line)].join('\n');
}

/** Spreadsheet column letters: 0 → A, 25 → Z, 26 → AA. */
export function columnName(index: number): string {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Column index of a cell reference: `C7` → 2, `AA1` → 26. Undefined for anything else. */
export function columnIndex(ref: string): number | undefined {
  const m = /^\$?([A-Za-z]{1,3})\$?\d*$/.exec(ref);
  if (!m) return undefined;
  let n = 0;
  for (const ch of m[1]!.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
