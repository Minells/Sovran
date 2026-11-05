/**
 * OpenDocument (LibreOffice, and what many public administrations publish) to Markdown: text documents (.odt) with
 * headings, lists and tables; spreadsheets (.ods) as one table per sheet; presentations (.odp) slide by slide with
 * speaker notes. Comments, tracked deletions and footnote bodies are left out.
 */
import { DOCUMENT_LIMITS } from './types';
import { columnName, markdownTable, tidy, type MarkdownBudget } from './markdown';
import { localName, parseXml } from './xml';
import type { ZipArchive } from './zip';

export type OdfKind = 'odt' | 'ods' | 'odp';

/** The kind of OpenDocument from its `mimetype` entry (templates included), or undefined. */
export function odfKind(zip: ZipArchive): OdfKind | undefined {
  const mime = zip.text('mimetype')?.trim() ?? '';
  const m = /^application\/vnd\.oasis\.opendocument\.(text|spreadsheet|presentation)(-template)?$/.exec(mime);
  if (!m) return undefined;
  return m[1] === 'text' ? 'odt' : m[1] === 'spreadsheet' ? 'ods' : 'odp';
}

/** Subtrees that hold no visible body text. */
const SKIPPED = new Set([
  'tracked-changes',
  'annotation',
  'note-body',
  'notes-configuration',
  'sequence-decls',
  'forms',
  'scripts',
  'font-face-decls',
  'automatic-styles',
  'title',
  'desc',
]);

/** Repeated rows or columns (ODF stores 1 048 576 empty rows as one row repeated) are expanded only up to this. */
const MAX_REPEAT = 100;

interface Table {
  name: string;
  /** Sparse rows: column index → text. */
  rows: Array<Map<number, string>>;
  row?: Map<number, string>;
  rowRepeat: number;
  column: number;
  cell?: string[];
  cellRepeat: number;
  maxColumn: number;
}

export function convertOdf(zip: ZipArchive, kind: OdfKind, out: MarkdownBudget): { detail?: string } {
  const xml = zip.text('content.xml') ?? '';
  let skip = 0;
  /** Open paragraphs and headings (a frame inside a paragraph holds its own paragraphs). */
  const blocks: Array<{ heading?: number; text: string }> = [];
  const tables: Table[] = [];
  let listDepth = 0;
  let pages = 0;
  let sheets = 0;
  let inNotes = 0;
  let notes: string[] = [];
  let slide: { title: string[]; lines: string[]; frameClass?: string } | undefined;
  let frameClass: string | undefined;

  // Totals up front, so the detail stays right when the budget stops the conversion early.
  const totalSheets = kind === 'ods' ? (xml.match(/<table:table[\s>]/g)?.length ?? 0) : 0;
  const totalSlides = kind === 'odp' ? (xml.match(/<draw:page[\s>]/g)?.length ?? 0) : 0;

  const emitText = (text: string, heading?: number): boolean => {
    const table = tables[tables.length - 1];
    if (table?.cell) {
      table.cell.push(text);
      return true;
    }
    if (slide) {
      if (inNotes) notes.push(text);
      else if (frameClass === 'title') slide.title.push(text.replace(/\n/g, ' '));
      else slide.lines.push(`- ${text.replace(/\n/g, ' ')}`);
      return true;
    }
    if (heading) return out.add(`${'#'.repeat(Math.min(6, heading))} ${text.replace(/\n/g, ' ')}`);
    if (listDepth)
      return out.add(`${'  '.repeat(listDepth - 1)}- ${text.replace(/\n/g, ' ')}`, { listItem: true });
    return out.add(text);
  };

  const finishTable = (t: Table): boolean => {
    const width = Math.min(t.maxColumn, DOCUMENT_LIMITS.maxColumns - 1);
    const rows = t.rows.map((r) => Array.from({ length: width + 1 }, (_, i) => r.get(i) ?? ''));
    const md = markdownTable(rows);
    if (tables.length) {
      // A table nested in a cell: its rows become lines of that cell.
      tables[tables.length - 1]!.cell?.push(
        rows
          .map((r) => r.filter(Boolean).join(' · '))
          .filter(Boolean)
          .join('\n'),
      );
      return true;
    }
    if (slide) {
      if (md) slide.lines.push(md);
      return true;
    }
    if (kind === 'ods') {
      sheets++;
      const note =
        t.maxColumn > width
          ? ` Columns ${columnName(width + 1)}–${columnName(t.maxColumn)} are not shown.`
          : '';
      if (note) out.omit();
      return out.add(`## Sheet: ${t.name}\n\n${md ? `${note.trim()}\n\n${md}` : '(empty)'}`);
    }
    return out.add(md);
  };

  for (const ev of parseXml(xml)) {
    if (out.full) break;
    if (ev.type === 'text') {
      if (!skip && blocks.length) blocks[blocks.length - 1]!.text += ev.text;
      continue;
    }
    const n = localName(ev.name);
    if (SKIPPED.has(n)) {
      if (ev.type === 'open' && !ev.selfClosing) skip++;
      else if (ev.type === 'close') skip = Math.max(0, skip - 1);
      continue;
    }
    if (skip) continue;
    const block = blocks[blocks.length - 1];
    const table = tables[tables.length - 1];
    if (ev.type === 'open') {
      switch (n) {
        case 'p':
        case 'h':
          if (!ev.selfClosing)
            blocks.push({
              heading: n === 'h' ? Number(ev.attrs['text:outline-level'] ?? 1) || 1 : undefined,
              text: '',
            });
          break;
        case 's':
          if (block) block.text += ' '.repeat(Math.min(100, Number(ev.attrs['text:c'] ?? 1) || 1));
          break;
        case 'tab':
          if (block) block.text += '\t';
          break;
        case 'line-break':
          if (block) block.text += '\n';
          break;
        case 'list':
          if (!ev.selfClosing) listDepth++;
          break;
        case 'page':
          if (kind === 'odp' && !ev.selfClosing) {
            pages++;
            slide = { title: [], lines: [] };
            notes = [];
          }
          break;
        case 'notes':
          if (!ev.selfClosing) inNotes++;
          break;
        case 'frame':
          frameClass = ev.attrs['presentation:class'];
          break;
        case 'table':
          if (!ev.selfClosing)
            tables.push({
              name: ev.attrs['table:name'] ?? `Sheet ${sheets + 1}`,
              rows: [],
              rowRepeat: 1,
              column: 0,
              cellRepeat: 1,
              maxColumn: -1,
            });
          break;
        case 'table-row':
          if (table) {
            table.row = new Map();
            table.column = 0;
            table.rowRepeat = Math.max(1, Number(ev.attrs['table:number-rows-repeated'] ?? 1) || 1);
            if (ev.selfClosing) table.row = undefined;
          }
          break;
        case 'table-cell':
        case 'covered-table-cell':
          if (table?.row) {
            table.cellRepeat = Math.max(1, Number(ev.attrs['table:number-columns-repeated'] ?? 1) || 1);
            if (ev.selfClosing) table.column += table.cellRepeat;
            else table.cell = [];
          }
          break;
      }
      continue;
    }
    switch (n) {
      case 'p':
      case 'h': {
        const b = blocks.pop();
        const text = b ? tidy(b.text) : '';
        if (text) emitText(text, b?.heading);
        break;
      }
      case 'list':
        listDepth = Math.max(0, listDepth - 1);
        break;
      case 'notes':
        inNotes = Math.max(0, inNotes - 1);
        break;
      case 'frame':
        frameClass = undefined;
        break;
      case 'page':
        if (slide) {
          const heading = `## Slide ${pages}${slide.title.length ? `: ${slide.title.join(' — ')}` : ''}`;
          out.add(
            [heading, slide.lines.join('\n'), notes.length ? `Speaker notes:\n${notes.join('\n')}` : '']
              .filter(Boolean)
              .join('\n\n'),
          );
        }
        slide = undefined;
        break;
      case 'table-cell':
      case 'covered-table-cell':
        if (table?.row && table.cell) {
          const text = table.cell.join('\n');
          if (text) {
            for (let i = 0; i < Math.min(table.cellRepeat, MAX_REPEAT); i++)
              table.row.set(table.column + i, text);
            table.maxColumn = Math.max(
              table.maxColumn,
              table.column + Math.min(table.cellRepeat, MAX_REPEAT) - 1,
            );
          }
          table.column += table.cellRepeat;
          table.cell = undefined;
        }
        break;
      case 'table-row':
        if (table?.row) {
          // Empty rows are dropped (as in every table); a repeated row with text is shown up to MAX_REPEAT times.
          if (table.row.size)
            for (let i = 0; i < Math.min(table.rowRepeat, MAX_REPEAT); i++) table.rows.push(table.row);
          table.row = undefined;
        }
        break;
      case 'table': {
        const t = tables.pop();
        if (t) finishTable(t);
        break;
      }
    }
  }
  if (kind === 'ods') return { detail: `${totalSheets} ${totalSheets === 1 ? 'sheet' : 'sheets'}` };
  if (kind === 'odp') return { detail: `${totalSlides} ${totalSlides === 1 ? 'slide' : 'slides'}` };
  return {};
}
