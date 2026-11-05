/**
 * Excel (.xlsx, .xlsm, .xltx) to Markdown: one table per worksheet, in workbook order, with the values Excel last
 * calculated. Dates are shown as dates (Excel stores them as numbers formatted as dates).
 */
import { DOCUMENT_LIMITS } from './types';
import { columnIndex, columnName, markdownTable, type MarkdownBudget } from './markdown';
import { readRelationships } from './opc';
import { localName, parseXml } from './xml';
import type { ZipArchive } from './zip';

function sharedStrings(xml: string | undefined): string[] {
  const out: string[] = [];
  if (!xml) return out;
  let current: string | undefined;
  let inText = false;
  let phonetic = 0;
  for (const ev of parseXml(xml)) {
    if (ev.type === 'text') {
      if (inText && !phonetic && current !== undefined) current += ev.text;
      continue;
    }
    const n = localName(ev.name);
    if (ev.type === 'open') {
      if (n === 'si') current = ev.selfClosing ? (out.push(''), undefined) : '';
      else if (n === 't') inText = !ev.selfClosing;
      // Phonetic guides (Japanese ruby text) repeat the reading of the string.
      else if (n === 'rPh' && !ev.selfClosing) phonetic++;
    } else if (n === 'si') {
      out.push(current ?? '');
      current = undefined;
    } else if (n === 't') inText = false;
    else if (n === 'rPh') phonetic = Math.max(0, phonetic - 1);
  }
  return out;
}

/** Built-in number formats that show a date or a time. */
const DATE_FORMAT_IDS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54,
  55, 56, 57, 58,
]);

export function isDateFormat(code: string): boolean {
  // Ignore quoted text, escaped characters and [colour]/[locale] sections; keep elapsed time like [h].
  const stripped = code
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/\[(?![hms]+\])[^\]]*\]/gi, '');
  return /[dmyhs]/i.test(stripped) && !/^general$/i.test(stripped.trim());
}

/** Style index → whether the cell format is a date. */
function dateStyles(xml: string | undefined): boolean[] {
  if (!xml) return [];
  const custom = new Map<number, string>();
  const out: boolean[] = [];
  let inCellXfs = false;
  for (const ev of parseXml(xml)) {
    if (ev.type === 'text') continue;
    const n = localName(ev.name);
    if (ev.type === 'close') {
      if (n === 'cellXfs') inCellXfs = false;
      continue;
    }
    if (n === 'numFmt') custom.set(Number(ev.attrs.numFmtId), ev.attrs.formatCode ?? '');
    else if (n === 'cellXfs') inCellXfs = !ev.selfClosing;
    else if (n === 'xf' && inCellXfs) {
      const id = Number(ev.attrs.numFmtId ?? 0);
      out.push(DATE_FORMAT_IDS.has(id) || (custom.has(id) && isDateFormat(custom.get(id)!)));
    }
  }
  return out;
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * An Excel serial date as ISO text. 1900-based workbooks count from 1899-12-30, which absorbs Lotus's leap-year bug;
 * 1904-based ones (old Mac workbooks) start 1462 days later. A value below 1 is a time of day.
 */
export function excelDate(serial: number, date1904: boolean): string {
  if (!Number.isFinite(serial) || serial < 0 || serial > 2_958_465) return String(serial);
  const ms = Math.round((serial + (date1904 ? 1462 : 0)) * 86_400_000) + Date.UTC(1899, 11, 30);
  const d = new Date(ms);
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}${d.getUTCSeconds() ? `:${pad(d.getUTCSeconds())}` : ''}`;
  if (serial < 1) return time;
  return Number.isInteger(serial) ? date : `${date} ${time}`;
}

interface SheetRef {
  name: string;
  part?: string;
  hidden: boolean;
}

/** Reads one worksheet into rows of cell text; stops at `maxCells` cells with a value. */
function readSheet(
  xml: string,
  strings: string[],
  dates: boolean[],
  date1904: boolean,
  maxCells: number,
): { rows: string[][]; maxColumn: number; firstRow?: number; lastRow?: number; cut: boolean } {
  const rows: string[][] = [];
  let row: string[] | undefined;
  let rowNumber = 0;
  let firstRow: number | undefined;
  let lastRow: number | undefined;
  let column = -1;
  let cell: { type?: string; style: number; value?: string; inline?: string } | undefined;
  let into: 'v' | 'is' | undefined;
  let inT = false;
  let cells = 0;
  let maxColumn = -1;
  let cut = false;
  const finishCell = () => {
    if (!cell || !row) return;
    let text: string;
    const v = cell.value;
    switch (cell.type) {
      case 's':
        text = strings[Number(v)] ?? '';
        break;
      case 'inlineStr':
        text = cell.inline ?? '';
        break;
      case 'b':
        text = v === '1' ? 'TRUE' : v === '0' ? 'FALSE' : (v ?? '');
        break;
      case 'str':
      case 'e':
      case 'd':
        text = v ?? '';
        break;
      default:
        text = v !== undefined && v !== '' && dates[cell.style] ? excelDate(Number(v), date1904) : (v ?? '');
    }
    if (text && column >= 0) {
      if (column < DOCUMENT_LIMITS.maxColumns) row[column] = text;
      maxColumn = Math.max(maxColumn, column);
      cells++;
    }
    cell = undefined;
  };
  for (const ev of parseXml(xml)) {
    if (ev.type === 'text') {
      if (!cell) continue;
      if (into === 'v') cell.value = (cell.value ?? '') + ev.text;
      else if (into === 'is' && inT) cell.inline = (cell.inline ?? '') + ev.text;
      continue;
    }
    const n = localName(ev.name);
    if (ev.type === 'open') {
      if (n === 'row') {
        rowNumber = Number(ev.attrs.r) || rowNumber + 1;
        row = [];
        column = -1;
        if (ev.selfClosing) row = undefined;
      } else if (n === 'c' && row) {
        column = columnIndex(ev.attrs.r ?? '') ?? column + 1;
        cell = { type: ev.attrs.t, style: Number(ev.attrs.s ?? 0) };
        if (ev.selfClosing) finishCell();
      } else if (n === 'v' && cell) into = ev.selfClosing ? undefined : 'v';
      else if (n === 'is' && cell) into = 'is';
      else if (n === 't' && into === 'is') inT = !ev.selfClosing;
      continue;
    }
    if (n === 'c') finishCell();
    else if (n === 'v') into = undefined;
    else if (n === 'is') into = undefined;
    else if (n === 't') inT = false;
    else if (n === 'row' && row) {
      if (row.some(Boolean)) {
        rows.push(row);
        firstRow ??= rowNumber;
        lastRow = rowNumber;
      }
      row = undefined;
      if (cells >= maxCells) {
        cut = true;
        break;
      }
    }
  }
  return { rows, maxColumn, firstRow, lastRow, cut };
}

export function convertXlsx(zip: ZipArchive, main: string, out: MarkdownBudget): { detail?: string } {
  const rels = readRelationships(zip, main);
  const byId = new Map(rels.map((r) => [r.id, r]));
  const partOf = (type: string) => rels.find((r) => r.type === type && !r.external)?.target;
  const sst = partOf('sharedStrings');
  const styles = partOf('styles');
  const strings = sharedStrings(sst ? zip.text(sst) : undefined);
  const dates = dateStyles(styles ? zip.text(styles) : undefined);

  const sheets: SheetRef[] = [];
  let date1904 = false;
  for (const ev of parseXml(zip.text(main) ?? '')) {
    if (ev.type !== 'open') continue;
    const n = localName(ev.name);
    if (n === 'workbookPr') date1904 = ev.attrs.date1904 === '1' || ev.attrs.date1904 === 'true';
    else if (n === 'sheet') {
      const rel = byId.get(ev.attrs['r:id'] ?? '');
      sheets.push({
        name: ev.attrs.name ?? `Sheet ${sheets.length + 1}`,
        part: rel && !rel.external ? rel.target : undefined,
        hidden: !!ev.attrs.state && ev.attrs.state !== 'visible',
      });
    }
  }

  let read = 0;
  for (const sheet of sheets) {
    if (out.full) break;
    const xml = sheet.part ? zip.text(sheet.part) : undefined;
    read++;
    const title = `## Sheet: ${sheet.name}${sheet.hidden ? ' (hidden)' : ''}`;
    if (!xml) {
      out.add(`${title}\n\n(This sheet has no cells: it may be a chart sheet.)`);
      continue;
    }
    // A cell costs at least a few characters, so this bounds the work for a sheet far larger than the budget.
    const { rows, maxColumn, firstRow, lastRow, cut } = readSheet(xml, strings, dates, date1904, 200_000);
    if (!rows.length) {
      out.add(`${title}\n\n(empty)`);
      continue;
    }
    const lastShown = Math.min(maxColumn, DOCUMENT_LIMITS.maxColumns - 1);
    const notes = [`Rows ${firstRow}–${lastRow}, columns A–${columnName(lastShown)}.`];
    if (maxColumn > lastShown)
      notes.push(`Columns ${columnName(lastShown + 1)}–${columnName(maxColumn)} are not shown.`);
    if (cut) notes.push('The rest of the sheet is not shown.');
    if (maxColumn > lastShown || cut) out.omit();
    // The budget cuts a block at a whole line, so a sheet larger than it still shows its first complete rows.
    out.add(`${title}\n\n${notes.join(' ')}\n\n${markdownTable(rows)}`);
  }
  if (read < sheets.length) out.omit();
  return { detail: `${sheets.length} ${sheets.length === 1 ? 'sheet' : 'sheets'}` };
}
