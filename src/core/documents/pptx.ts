/**
 * PowerPoint (.pptx, .pptm, .ppsx, .potx) to Markdown: each slide in presentation order with its title, its text as
 * bullets (indented by level), its tables, and the speaker notes.
 */
import { markdownTable, tidy, type MarkdownBudget } from './markdown';
import { readRelationships } from './opc';
import { localName, parseXml } from './xml';
import type { ZipArchive } from './zip';

interface SlideText {
  title: string[];
  lines: string[];
  hidden: boolean;
}

const TITLE_PLACEHOLDERS = new Set(['title', 'ctrTitle']);

/** Text of one slide or notes part. `placeholders` limits it to shapes of those placeholder types (notes: `body`). */
function readSlide(xml: string, placeholders?: Set<string>): SlideText {
  const result: SlideText = { title: [], lines: [], hidden: false };
  /** Each open shape: its placeholder type, once seen. */
  const shapes: Array<{ ph?: string }> = [];
  let paragraph: { level: number; text: string } | undefined;
  let inText = false;
  let fallback = 0;
  let table: { rows: string[][]; row?: string[]; cell?: string[] } | undefined;
  for (const ev of parseXml(xml)) {
    if (ev.type === 'text') {
      if (inText && paragraph && !fallback) paragraph.text += ev.text;
      continue;
    }
    const n = localName(ev.name);
    if (n === 'Fallback') {
      if (ev.type === 'open' && !ev.selfClosing) fallback++;
      else if (ev.type === 'close') fallback = Math.max(0, fallback - 1);
      continue;
    }
    if (fallback) continue;
    if (ev.type === 'open') {
      switch (n) {
        case 'sld':
          result.hidden = ev.attrs.show === '0' || ev.attrs.show === 'false';
          break;
        case 'sp':
          if (!ev.selfClosing) shapes.push({});
          break;
        case 'ph': {
          const shape = shapes[shapes.length - 1];
          // A placeholder without a type is a content ("obj") placeholder.
          if (shape) shape.ph = ev.attrs.type ?? 'obj';
          break;
        }
        case 'p':
          if (!ev.selfClosing) paragraph = { level: 0, text: '' };
          break;
        case 'pPr':
          if (paragraph) paragraph.level = Math.min(8, Number(ev.attrs.lvl ?? 0) || 0);
          break;
        case 't':
          inText = !ev.selfClosing;
          break;
        case 'br':
          if (paragraph) paragraph.text += '\n';
          break;
        case 'tbl':
          table = { rows: [] };
          break;
        case 'tr':
          if (table) table.row = [];
          break;
        case 'tc':
          if (table) table.cell = [];
          break;
      }
      continue;
    }
    switch (n) {
      case 't':
        inText = false;
        break;
      case 'p': {
        const text = paragraph ? tidy(paragraph.text) : '';
        const level = paragraph?.level ?? 0;
        paragraph = undefined;
        if (!text) break;
        if (table?.cell) {
          table.cell.push(text);
          break;
        }
        const ph = shapes[shapes.length - 1]?.ph;
        if (placeholders && !(ph && placeholders.has(ph))) break;
        if (ph && TITLE_PLACEHOLDERS.has(ph)) result.title.push(text.replace(/\n/g, ' '));
        else result.lines.push(`${'  '.repeat(level)}- ${text.replace(/\n/g, ' ')}`);
        break;
      }
      case 'sp':
        shapes.pop();
        break;
      case 'tc':
        if (table?.row && table.cell) table.row.push(table.cell.join('\n'));
        if (table) table.cell = undefined;
        break;
      case 'tr':
        if (table?.row) table.rows.push(table.row);
        if (table) table.row = undefined;
        break;
      case 'tbl':
        if (table) {
          const md = markdownTable(table.rows);
          if (md) result.lines.push(md);
        }
        table = undefined;
        break;
    }
  }
  return result;
}

export function convertPptx(zip: ZipArchive, main: string, out: MarkdownBudget): { detail?: string } {
  const rels = readRelationships(zip, main);
  const byId = new Map(rels.map((r) => [r.id, r]));
  const slides: string[] = [];
  for (const ev of parseXml(zip.text(main) ?? '')) {
    if (ev.type === 'open' && localName(ev.name) === 'sldId') {
      const rel = byId.get(ev.attrs['r:id'] ?? '');
      if (rel && !rel.external) slides.push(rel.target);
    }
  }
  let read = 0;
  for (const [i, part] of slides.entries()) {
    if (out.full) break;
    read++;
    const slide = readSlide(zip.text(part) ?? '');
    const notesPart = readRelationships(zip, part).find(
      (r) => r.type === 'notesSlide' && !r.external,
    )?.target;
    const notes = notesPart ? readSlide(zip.text(notesPart) ?? '', new Set(['body'])) : undefined;
    const title = slide.title.join(' — ');
    const heading = `## Slide ${i + 1}${title ? `: ${title}` : ''}${slide.hidden ? ' (hidden)' : ''}`;
    const body = slide.lines.join('\n');
    const noteText = notes?.lines.map((l) => l.replace(/^\s*- /, '')).join('\n');
    if (!out.add([heading, body, noteText ? `Speaker notes:\n${noteText}` : ''].filter(Boolean).join('\n\n')))
      break;
  }
  if (read < slides.length) out.omit();
  return { detail: `${slides.length} ${slides.length === 1 ? 'slide' : 'slides'}` };
}
