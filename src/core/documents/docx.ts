/**
 * Word (.docx, .docm, .dotx) to Markdown: headings, lists, tables and links, in reading order. Deleted tracked
 * changes, field codes and the fallback copies of text boxes are left out, so text never appears twice.
 */
import { markdownTable, tidy, type MarkdownBudget } from './markdown';
import { readRelationships } from './opc';
import { localName, parseXml } from './xml';
import type { ZipArchive } from './zip';

interface Paragraph {
  style?: string;
  outline?: number;
  numId?: string;
  level: number;
  text: string;
}

interface Table {
  rows: string[][];
  row?: string[];
  cell?: string[];
  span: number;
}

/** Heading level of each paragraph style, following `basedOn` so a custom style based on Heading 2 is a heading. */
function headingStyles(xml: string | undefined): Map<string, number> {
  const styles = new Map<string, { name?: string; outline?: number; basedOn?: string }>();
  if (xml) {
    let current: { name?: string; outline?: number; basedOn?: string } | undefined;
    for (const ev of parseXml(xml)) {
      if (ev.type === 'open') {
        const n = localName(ev.name);
        if (n === 'style') {
          current = ev.attrs['w:type'] === 'paragraph' && ev.attrs['w:styleId'] ? {} : undefined;
          if (current) styles.set(ev.attrs['w:styleId']!, current);
        } else if (current && n === 'name') current.name = ev.attrs['w:val'];
        else if (current && n === 'basedOn') current.basedOn = ev.attrs['w:val'];
        else if (current && n === 'outlineLvl') current.outline = Number(ev.attrs['w:val']);
      } else if (ev.type === 'close' && localName(ev.name) === 'style') current = undefined;
    }
  }
  const levelOf = (id: string, depth = 0): number | undefined => {
    const s = styles.get(id);
    if (!s || depth > 8) return undefined;
    // Built-in style names are English in every language ("heading 1"), unlike their ids ("Titolo1").
    const name = s.name?.toLowerCase() ?? '';
    if (name === 'title') return 1;
    const m = /^heading (\d)$/.exec(name);
    if (m) return Math.min(6, Number(m[1]));
    if (s.outline !== undefined && s.outline >= 0 && s.outline < 6) return s.outline + 1;
    return s.basedOn ? levelOf(s.basedOn, depth + 1) : undefined;
  };
  const out = new Map<string, number>();
  for (const id of styles.keys()) {
    const level = levelOf(id);
    if (level) out.set(id, level);
  }
  return out;
}

/** `numId:ilvl` of each numbered (not bulleted) list level. */
function orderedLevels(xml: string | undefined): Set<string> {
  const out = new Set<string>();
  if (!xml) return out;
  const abstractOrdered = new Map<string, Set<string>>();
  const numToAbstract = new Map<string, string>();
  let abstract: string | undefined;
  let level: string | undefined;
  let num: string | undefined;
  for (const ev of parseXml(xml)) {
    if (ev.type === 'open') {
      const n = localName(ev.name);
      if (n === 'abstractNum') abstract = ev.attrs['w:abstractNumId'];
      else if (n === 'lvl' && abstract !== undefined) level = ev.attrs['w:ilvl'];
      else if (
        n === 'numFmt' &&
        abstract !== undefined &&
        level !== undefined &&
        ev.attrs['w:val'] &&
        ev.attrs['w:val'] !== 'bullet' &&
        ev.attrs['w:val'] !== 'none'
      ) {
        if (!abstractOrdered.has(abstract)) abstractOrdered.set(abstract, new Set());
        abstractOrdered.get(abstract)!.add(level);
      } else if (n === 'num' && !ev.selfClosing) num = ev.attrs['w:numId'];
      else if (n === 'abstractNumId' && num !== undefined && ev.attrs['w:val'] !== undefined)
        numToAbstract.set(num, ev.attrs['w:val']);
    } else if (ev.type === 'close') {
      const n = localName(ev.name);
      if (n === 'abstractNum') abstract = undefined;
      else if (n === 'lvl') level = undefined;
      else if (n === 'num') num = undefined;
    }
  }
  for (const [n, a] of numToAbstract) for (const l of abstractOrdered.get(a) ?? []) out.add(`${n}:${l}`);
  return out;
}

/** Elements whose content is never shown as text. */
const SKIPPED = new Set([
  'del',
  'moveFrom',
  'instrText',
  'delInstrText',
  'Fallback',
  'tabs',
  'rPr',
  'sectPr',
  'footnoteReference',
  'commentReference',
]);

export function convertDocx(zip: ZipArchive, main: string, out: MarkdownBudget): { detail?: string } {
  const rels = readRelationships(zip, main);
  const partOf = (type: string) => rels.find((r) => r.type === type && !r.external)?.target;
  const stylesPart = partOf('styles');
  const numberingPart = partOf('numbering');
  const headings = headingStyles(stylesPart ? zip.text(stylesPart) : undefined);
  const ordered = orderedLevels(numberingPart ? zip.text(numberingPart) : undefined);
  const links = new Map(
    rels.filter((r) => r.type === 'hyperlink' && r.external).map((r) => [r.id, r.target]),
  );
  const xml = zip.text(main) ?? '';

  const paragraphs: Paragraph[] = [];
  const tables: Table[] = [];
  /** Open hyperlinks: their URL and where their text starts in the paragraph. */
  const linkStack: Array<{ url?: string; start: number }> = [];
  let skip = 0;
  let inText = false;
  let runDepth = 0;

  const emit = (block: string, listItem = false) => {
    const table = tables[tables.length - 1];
    if (table?.cell) table.cell.push(block.trim());
    else if (!out.add(block, { listItem })) return false;
    return true;
  };

  const flushParagraph = (p: Paragraph): boolean => {
    const text = tidy(p.text);
    if (!text) return true;
    const level =
      (p.style ? headings.get(p.style) : undefined) ??
      (p.outline !== undefined && p.outline < 6 ? p.outline + 1 : undefined);
    if (tables.length) return emit(text);
    if (level) return emit(`${'#'.repeat(level)} ${text.replace(/\n/g, ' ')}`);
    if (p.numId && p.numId !== '0') {
      const marker = ordered.has(`${p.numId}:${p.level}`) ? '1.' : '-';
      return emit(`${'  '.repeat(p.level)}${marker} ${text.replace(/\n/g, ' ')}`, true);
    }
    return emit(text);
  };

  for (const ev of parseXml(xml)) {
    if (out.full) break;
    if (ev.type === 'text') {
      if (inText && !skip && paragraphs.length) paragraphs[paragraphs.length - 1]!.text += ev.text;
      continue;
    }
    const n = localName(ev.name);
    if (ev.type === 'close') {
      if (SKIPPED.has(n)) {
        skip = Math.max(0, skip - 1);
        continue;
      }
      if (skip) continue;
      if (n === 't') inText = false;
      else if (n === 'r') runDepth = Math.max(0, runDepth - 1);
      else if (n === 'hyperlink') {
        const link = linkStack.pop();
        const p = paragraphs[paragraphs.length - 1];
        if (link?.url && p) {
          const label = p.text.slice(link.start).trim();
          if (label) p.text = `${p.text.slice(0, link.start)}[${label}](${link.url})`;
        }
      } else if (n === 'p') {
        const p = paragraphs.pop();
        if (p && !flushParagraph(p)) break;
      } else if (n === 'tc') {
        const t = tables[tables.length - 1];
        if (t?.row && t.cell) {
          t.row.push(t.cell.join('\n'));
          for (let i = 1; i < t.span; i++) t.row.push('');
        }
        if (t) t.cell = undefined;
      } else if (n === 'tr') {
        const t = tables[tables.length - 1];
        if (t?.row) t.rows.push(t.row);
        if (t) t.row = undefined;
      } else if (n === 'tbl') {
        const t = tables.pop();
        if (!t) continue;
        if (tables.length) {
          // A table inside a cell: its rows become lines of that cell.
          emit(
            t.rows
              .map((r) => r.filter(Boolean).join(' · '))
              .filter(Boolean)
              .join('\n'),
          );
        } else if (!out.add(markdownTable(t.rows))) break;
      }
      continue;
    }
    // Opening (or self-closing) tags.
    if (SKIPPED.has(n)) {
      if (!ev.selfClosing) skip++;
      continue;
    }
    if (skip) continue;
    const p = paragraphs[paragraphs.length - 1];
    switch (n) {
      case 'p':
        if (!ev.selfClosing) paragraphs.push({ level: 0, text: '' });
        break;
      case 'pStyle':
        if (p) p.style = ev.attrs['w:val'];
        break;
      case 'outlineLvl':
        if (p) p.outline = Number(ev.attrs['w:val']);
        break;
      case 'numId':
        if (p) p.numId = ev.attrs['w:val'];
        break;
      case 'ilvl':
        if (p) p.level = Math.min(8, Number(ev.attrs['w:val']) || 0);
        break;
      case 'r':
        if (!ev.selfClosing) runDepth++;
        break;
      case 't':
        inText = !ev.selfClosing;
        break;
      case 'tab':
        if (p && runDepth) p.text += '\t';
        break;
      case 'br':
      case 'cr':
        if (p && runDepth) p.text += '\n';
        break;
      case 'noBreakHyphen':
        if (p && runDepth) p.text += '-';
        break;
      case 'hyperlink':
        if (!ev.selfClosing)
          linkStack.push({ url: links.get(ev.attrs['r:id'] ?? ''), start: p?.text.length ?? 0 });
        break;
      case 'tbl':
        tables.push({ rows: [], span: 1 });
        break;
      case 'tr': {
        const t = tables[tables.length - 1];
        if (t) t.row = [];
        break;
      }
      case 'tc': {
        const t = tables[tables.length - 1];
        if (t) {
          t.cell = [];
          t.span = 1;
        }
        break;
      }
      case 'gridSpan': {
        const t = tables[tables.length - 1];
        if (t?.cell) t.span = Math.min(64, Math.max(1, Number(ev.attrs['w:val']) || 1));
        break;
      }
    }
  }
  return {};
}
