/**
 * Document attachments in the core: recognizing files by their signature, the safe XML and ZIP readers, and the
 * conversion of each format to Markdown. Fixtures are built in code (tests/fixtures/documents.ts).
 */
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { convertDocument } from '../../src/core/documents/convert';
import {
  decodeText,
  describeDocumentError,
  describeUnsupported,
  sniffFile,
} from '../../src/core/documents/detect';
import { MarkdownBudget, columnIndex, columnName, markdownTable } from '../../src/core/documents/markdown';
import { DocumentError } from '../../src/core/documents/types';
import { excelDate, isDateFormat } from '../../src/core/documents/xlsx';
import { parseXml, type XmlEvent } from '../../src/core/documents/xml';
import { ZipArchive } from '../../src/core/documents/zip';
import { makeDocx, makeOdf, makePdf, makePptx, makeXlsx, pshape, wp, zip } from '../fixtures/documents';

const bytes = (...values: number[]) => Uint8Array.from(values);
const ascii = (s: string) => new TextEncoder().encode(s);
const md = async (data: Uint8Array, maxChars = 50_000) =>
  (await convertDocument(data, { maxChars })).markdown;
const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as DocumentError;
  }
  throw new Error('expected the conversion to fail');
};

describe('sniffFile', () => {
  it('keeps text as UTF-8 text, as before documents were supported', () => {
    expect(sniffFile(ascii('export const ok = "naïve ✓";\n'))).toEqual({ kind: 'text', encoding: 'utf-8' });
    expect(sniffFile(new Uint8Array())).toEqual({ kind: 'text', encoding: 'utf-8' });
    // A note that quotes a PDF header after some text stays a note.
    expect(
      sniffFile(ascii('# How PDFs start\n\nEvery file begins with %PDF-1.7 and a binary comment.')),
    ).toEqual({ kind: 'text', encoding: 'utf-8' });
  });

  it('recognizes PDFs and ZIP containers by signature, whatever the extension', () => {
    expect(sniffFile(makePdf([['x']]))).toEqual({ kind: 'document', container: 'pdf', textFallback: true });
    expect(sniffFile(bytes(...ascii('%PDF-1.7\n%'), 0, 0xe2, 0xe3))).toEqual({
      kind: 'document',
      container: 'pdf',
      textFallback: false,
    });
    // Junk before the header counts in a binary file (Acrobat accepts the header within the first 1024 bytes).
    expect(sniffFile(bytes(0, 1, 2, ...ascii('%PDF-1.4')))).toMatchObject({
      kind: 'document',
      container: 'pdf',
    });
    expect(sniffFile(zip({ 'a.txt': 'a' }))).toEqual({
      kind: 'document',
      container: 'zip',
      textFallback: false,
    });
    expect(sniffFile(bytes(0x50, 0x4b, 0x05, 0x06, 0, 0))).toMatchObject({
      kind: 'document',
      container: 'zip',
    });
  });

  it('reads UTF-16 text with a byte-order mark (what Windows PowerShell writes with >)', () => {
    const le = bytes(0xff, 0xfe, ...[...'Hi\r\n'].flatMap((c) => [c.charCodeAt(0), 0]));
    const be = bytes(0xfe, 0xff, ...[...'Ok'].flatMap((c) => [0, c.charCodeAt(0)]));
    expect(sniffFile(le)).toEqual({ kind: 'text', encoding: 'utf-16le' });
    expect(sniffFile(be)).toEqual({ kind: 'text', encoding: 'utf-16be' });
    expect(decodeText(le, 'utf-16le')).toBe('Hi\r\n');
    expect(decodeText(be, 'utf-16be')).toBe('Ok');
    // A surrogate pair cut by the end of the sample is still text.
    expect(sniffFile(bytes(0xff, 0xfe, 0x41, 0, 0x3d, 0xd8))).toEqual({ kind: 'text', encoding: 'utf-16le' });
  });

  it('does not take binary data behind a FF FE mark for text, nor UTF-32', () => {
    expect(sniffFile(bytes(0xff, 0xfe, 0x01, 0x00, 0x02, 0x00))).toEqual({
      kind: 'unsupported',
      family: 'binary',
    });
    expect(sniffFile(bytes(0xff, 0xfe, 0x00, 0x00, 0x41, 0, 0, 0))).toEqual({
      kind: 'unsupported',
      family: 'binary',
    });
  });

  it('names what it refuses', () => {
    const family = (b: Uint8Array) => (sniffFile(b) as { family?: string }).family;
    expect(family(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d))).toBe('image');
    expect(family(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10))).toBe('image');
    expect(family(bytes(...ascii('GIF89a'), 1, 0))).toBe('image');
    expect(family(bytes(...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBPVP8 ')))).toBe('image');
    expect(family(bytes(0, 0, 0, 0x18, ...ascii('ftypheic')))).toBe('image');
    expect(family(bytes(0, 0, 0, 0x18, ...ascii('ftypisom')))).toBe('video');
    expect(family(bytes(0, 0, 0, 0x18, ...ascii('ftypM4A ')))).toBe('audio');
    expect(family(bytes(...ascii('ID3'), 4, 0, 0))).toBe('audio');
    expect(family(bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0))).toBe('legacy-office');
    expect(family(bytes(0x1f, 0x8b, 8, 0))).toBe('archive');
    expect(family(bytes(0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0))).toBe('executable');
    expect(family(bytes(...ascii('MZ'), 0x90, 0))).toBe('executable');
    expect(family(bytes(0, 1, 2, 3))).toBe('binary');
  });

  it('explains each refusal and each failed conversion with what to do', () => {
    expect(describeUnsupported('image', 'shot.png')).toMatch(
      /^shot\.png is an image\. Sovran cannot send images/,
    );
    expect(describeUnsupported('legacy-office', 'old.doc')).toMatch(
      /Save it as \.docx, \.xlsx, \.pptx or PDF/,
    );
    expect(describeUnsupported('binary', 'blob.bin')).toBe(
      'blob.bin looks like a binary file. Sovran can attach text files and documents (PDF, Word, Excel, PowerPoint, OpenDocument, ZIP).',
    );
    expect(describeDocumentError(new DocumentError('empty', ''), 'scan.pdf', 'pdf')).toMatch(
      /probably a scanned image/,
    );
    expect(describeDocumentError(new DocumentError('encrypted', ''), 'a.pdf', 'pdf')).toMatch(
      /password-protected/,
    );
    expect(describeDocumentError(new DocumentError('corrupt', ''), 'a.docx')).toBe(
      'a.docx could not be read as a document: the file may be damaged.',
    );
    expect(describeDocumentError(new Error('boom'), 'a.pdf')).toMatch(/Check the Sovran log/);
  });
});

describe('parseXml', () => {
  const events = (xml: string) => [...parseXml(xml)];
  const texts = (xml: string) => events(xml).flatMap((e) => (e.type === 'text' ? [e.text] : []));

  it('reads tags, attributes, text, CDATA and character references', () => {
    expect(
      events(
        '<?xml version="1.0"?><a x="1 &amp; 2" y=\'>\'><b/>t&lt;&#x41;&#66;&nbsp;<![CDATA[<raw>]]><!-- no --></a>',
      ),
    ).toEqual<XmlEvent[]>([
      { type: 'open', name: 'a', attrs: expect.objectContaining({ x: '1 & 2', y: '>' }), selfClosing: false },
      { type: 'open', name: 'b', attrs: expect.any(Object), selfClosing: true },
      { type: 'text', text: 't<AB&nbsp;' },
      { type: 'text', text: '<raw>' },
      { type: 'close', name: 'a' },
    ]);
  });

  it('never expands entities a document defines (no billion laughs, no external entities)', () => {
    const bomb =
      '<!DOCTYPE x [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;"><!ENTITY ext SYSTEM "file:///etc/passwd">]><x>&b;&ext;</x>';
    expect(texts(bomb)).toEqual(['&b;&ext;']);
  });

  it('keeps attribute names off the object prototype', () => {
    const open = events('<a __proto__="x" constructor="y"/>')[0] as Extract<XmlEvent, { type: 'open' }>;
    expect(Object.getPrototypeOf(open.attrs)).toBeNull();
    expect(open.attrs.__proto__).toBe('x');
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it('stops quietly on malformed input', () => {
    expect(events('<a>text<b attr="never closed')).toEqual([
      expect.objectContaining({ type: 'open', name: 'a' }),
      { type: 'text', text: 'text' },
    ]);
    expect(events('<!-- open comment')).toEqual([]);
    expect(texts('&#0;&#xD800;&#x110000;')).toEqual(['���']);
  });
});

describe('ZipArchive', () => {
  it('lists entries without inflating them, and finds parts without regard to case', () => {
    const z = ZipArchive.open(
      zip({ 'Word/Document.xml': '<w/>', 'dir/': new Uint8Array(), 'a.txt': 'hello' }),
    );
    expect(z.entries.map((e) => [e.name, e.size, e.directory])).toEqual([
      ['Word/Document.xml', 4, false],
      ['dir/', 0, true],
      ['a.txt', 5, false],
    ]);
    expect(z.text('word/document.xml')).toBe('<w/>');
    expect(z.text('missing.xml')).toBeUndefined();
  });

  it('refuses parts that would inflate past the limits before inflating them (ZIP bombs)', () => {
    const data = zipSync({ 'big.xml': new Uint8Array(2 * 1024 * 1024) }); // 2 MB of zeros compress to a few KB
    expect(data.length).toBeLessThan(20_000);
    const limits = { maxEntryBytes: 1024 * 1024, maxTotalBytes: 4 * 1024 * 1024, maxEntries: 10 };
    expect(() => ZipArchive.open(data, limits).read(['big.xml'])).toThrow(
      expect.objectContaining({ code: 'too_large' }),
    );
    const two = zipSync({ 'a.xml': new Uint8Array(600_000), 'b.xml': new Uint8Array(600_000) });
    const archive = ZipArchive.open(two, { ...limits, maxTotalBytes: 1_000_000 });
    expect(archive.read(['a.xml']).get('a.xml')).toHaveLength(600_000);
    expect(() => archive.read(['b.xml'])).toThrow(expect.objectContaining({ code: 'too_large' }));
    const many = zipSync(Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`f${i}`, strToU8('x')])));
    expect(() => ZipArchive.open(many, limits)).toThrow(expect.objectContaining({ code: 'too_large' }));
  });

  it('never inflates an entry past the size it declares, even when the declaration lies', () => {
    const data = zipSync({ 'lie.xml': new Uint8Array(1024 * 1024).fill(0x61) });
    // Rewrite the uncompressed size in the central directory (offset 24 of its entry) to 16 bytes.
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let central = -1;
    for (let i = data.length - 22; i >= 0; i--) if (view.getUint32(i, true) === 0x02014b50) central = i;
    view.setUint32(central + 24, 16, true);
    let inflated: Uint8Array | undefined;
    try {
      inflated = ZipArchive.open(data).read(['lie.xml']).get('lie.xml');
    } catch (e) {
      expect(e).toMatchObject({ code: 'corrupt' });
    }
    expect(inflated?.length ?? 0).toBeLessThanOrEqual(16);
  });

  it('reports a damaged archive as corrupt', () => {
    expect(() => ZipArchive.open(bytes(0x50, 0x4b, 0x03, 0x04, 1, 2, 3))).toThrow(
      expect.objectContaining({ code: 'corrupt' }),
    );
  });
});

describe('Markdown helpers', () => {
  it('stops at the budget after the last whole line, and says so', () => {
    const out = new MarkdownBudget(21);
    expect(out.add('first block')).toBe(true);
    expect(out.add('line one\nline two\nline three')).toBe(false);
    expect(out.full).toBe(true);
    expect(out.truncated).toBe(true);
    expect(out.toString()).toBe('first block\n\nline one');
    expect(out.add('more')).toBe(false);
    // A single line longer than what is left is cut where the budget ends.
    const line = new MarkdownBudget(10);
    line.add('a sentence that goes on');
    expect(line.toString()).toBe('a sentence');
  });

  it('keeps list items together and indented, and lets a converter mark an omission without stopping', () => {
    const out = new MarkdownBudget(1000);
    out.add('Intro');
    out.add('- one', { listItem: true });
    out.add('  - nested', { listItem: true });
    out.add('After');
    out.omit();
    expect(out.add('still added')).toBe(true);
    expect(out.toString()).toBe('Intro\n\n- one\n  - nested\n\nAfter\n\nstill added');
    expect(out.truncated).toBe(true);
  });

  it('renders tables with escaped cells, padded rows and no empty rows or trailing columns', () => {
    expect(markdownTable([['Name', 'Note', ''], ['a|b', 'line\nbreak', ''], ['', '', ''], ['c\\d']])).toBe(
      '| Name | Note |\n| --- | --- |\n| a\\|b | line<br>break |\n| c\\\\d |  |',
    );
    expect(markdownTable([['', ' ']])).toBe('');
  });

  it('converts spreadsheet column names', () => {
    expect([0, 25, 26, 701, 702].map(columnName)).toEqual(['A', 'Z', 'AA', 'ZZ', 'AAA']);
    expect(['A1', 'z9', 'AA10', '$C$7', 'A1B'].map(columnIndex)).toEqual([0, 25, 26, 2, undefined]);
  });
});

describe('convertDocument: PDF', () => {
  it('reads every page, and names pages without text', async () => {
    const r = await convertDocument(makePdf([['Relazione tecnica', 'Prezzo: 12,50 (àèìòù)'], [], ['Fine']]), {
      maxChars: 50_000,
    });
    expect(r).toMatchObject({ format: 'pdf', detail: '3 pages', truncated: false });
    expect(r.markdown).toBe(
      '## Page 1\n\nRelazione tecnica\nPrezzo: 12,50 (àèìòù)\n\n## Page 2\n\n(No text on this page. It may be a scanned image or a picture.)\n\n## Page 3\n\nFine',
    );
  });

  it('stops reading once the budget is spent, and says how far it got', async () => {
    const pages = Array.from({ length: 30 }, (_, i) => [`Page ${i + 1} ${'lorem ipsum '.repeat(8)}`]);
    const r = await convertDocument(makePdf(pages), { maxChars: 400 });
    expect(r.truncated).toBe(true);
    expect(r.detail).toMatch(/^pages 1–\d of 30$/);
    expect(r.markdown.length).toBeLessThanOrEqual(400);
  });

  it('refuses a PDF without any text (a scan), and a damaged one', async () => {
    expect(await failure(convertDocument(makePdf([[], []]), { maxChars: 1000 }))).toMatchObject({
      code: 'empty',
    });
    expect(
      await failure(convertDocument(ascii('%PDF-1.4\nnot really a pdf'), { maxChars: 1000 })),
    ).toMatchObject({ code: 'corrupt' });
  });
});

describe('convertDocument: Word', () => {
  it('keeps headings (also localized or inherited styles), lists, links and tables in reading order', async () => {
    const body =
      wp('Relazione tecnica', { style: 'Titolo1' }) +
      wp('Introduzione', { style: 'Capitolo' }) +
      wp([
        'Vedi ',
        '<w:hyperlink r:id="rL1"><w:r><w:t>il sito</w:t></w:r></w:hyperlink>',
        ' per i dettagli.',
      ]) +
      wp('punto', { numId: 1 }) +
      wp('passo', { numId: 2 }) +
      wp('sotto-passo', { numId: 2, ilvl: 1 }) +
      '<w:tbl><w:tr><w:tc>' +
      wp('Voce|A') +
      '</w:tc><w:tc>' +
      wp('Valore') +
      '</w:tc></w:tr>' +
      '<w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr>' +
      wp('Totale') +
      '</w:tc></w:tr></w:tbl>';
    expect(await md(makeDocx(body, { links: { rL1: 'https://example.com/spec' } }))).toBe(
      [
        '# Relazione tecnica',
        '## Introduzione',
        'Vedi [il sito](https://example.com/spec) per i dettagli.',
        '- punto\n1. passo\n  1. sotto-passo',
        '| Voce\\|A | Valore |\n| --- | --- |\n| Totale |  |',
      ].join('\n\n'),
    );
  });

  it('leaves out deleted changes, field codes, tab stops and the fallback copy of text boxes', async () => {
    const body =
      '<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr>' +
      '<w:r><w:t>kept</w:t></w:r><w:del><w:r><w:delText>deleted</w:delText></w:r></w:del>' +
      '<w:ins><w:r><w:t> inserted</w:t></w:r></w:ins>' +
      '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>PAGE \\* MERGEFORMAT</w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>' +
      '</w:p>' +
      wp([
        '<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><w:txbxContent>' +
          wp('in the box') +
          '</w:txbxContent></w:drawing></mc:Choice>' +
          '<mc:Fallback><w:pict><w:txbxContent>' +
          wp('in the box') +
          '</w:txbxContent></w:pict></mc:Fallback></mc:AlternateContent></w:r>',
        'after',
      ]);
    expect(await md(makeDocx(body))).toBe('kept inserted\n\nin the box\n\nafter');
  });

  it('refuses a document without text', async () => {
    expect(await failure(convertDocument(makeDocx(wp('')), { maxChars: 1000 }))).toMatchObject({
      code: 'empty',
    });
  });
});

describe('convertDocument: Excel', () => {
  it('shows each sheet in workbook order with shared strings, types and dates', async () => {
    const data = makeXlsx(
      [
        {
          name: 'Dati',
          rows:
            '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="inlineStr"><is><t>Note</t></is></c></row>' +
            '<row r="3"><c r="A3" t="s"><v>2</v></c><c r="B3" s="1"><v>45966</v></c><c r="C3" t="b"><v>1</v></c><c r="D3"><v>3.5</v></c></row>' +
            '<row r="4"><c r="A4" t="e"><v>#DIV/0!</v></c><c r="B4" s="2"><v>45966.5</v></c><c r="C4" t="str"><f>A1&amp;"!"</f><v>Nome!</v></c></row>',
        },
        { name: 'Vuoto', hidden: true, rows: '' },
      ],
      { sharedStrings: ['Nome', 'Data', '<r><t>Mario</t></r><r><t>|Rossi</t></r><rPh><t>ルビ</t></rPh>'] },
    );
    const r = await convertDocument(data, { maxChars: 50_000 });
    expect(r).toMatchObject({ format: 'xlsx', detail: '2 sheets', truncated: false });
    expect(r.markdown).toBe(
      [
        '## Sheet: Dati',
        'Rows 1–4, columns A–D.',
        '| Nome | Data |  | Note |\n| --- | --- | --- | --- |\n| Mario\\|Rossi | 2025-11-05 | TRUE | 3.5 |\n| #DIV/0! | 2025-11-05 12:00 | Nome! |  |',
        '## Sheet: Vuoto (hidden)',
        '(empty)',
      ].join('\n\n'),
    );
  });

  it('says which columns of a wide sheet are left out', async () => {
    const cells = Array.from(
      { length: 70 },
      (_, i) => `<c r="${columnName(i)}1" t="inlineStr"><is><t>c${i}</t></is></c>`,
    ).join('');
    const r = await convertDocument(makeXlsx([{ name: 'Wide', rows: `<row r="1">${cells}</row>` }]), {
      maxChars: 50_000,
    });
    expect(r.markdown).toContain('Rows 1–1, columns A–BH. Columns BI–BR are not shown.');
    expect(r.markdown).not.toContain('c60');
    expect(r.truncated).toBe(true);
  });

  it('reads 1904-based dates and tells date formats from number formats', () => {
    expect(excelDate(45966, false)).toBe('2025-11-05');
    expect(excelDate(44504, true)).toBe('2025-11-05');
    expect(excelDate(0.75, false)).toBe('18:00');
    expect(excelDate(0.75, true)).toBe('18:00');
    expect(['dd/mm/yyyy;@', 'h:mm AM/PM', '[h]:mm:ss', 'yyyy-mm-dd hh:mm'].map(isDateFormat)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(['0.00', '#,##0 "days"', '[Red]0.0', 'General', '0%'].map(isDateFormat)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });
});

describe('convertDocument: PowerPoint', () => {
  it('follows the presentation order, with titles, bullet levels, tables and speaker notes', async () => {
    const table =
      '<p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>KPI</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>Q3</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>';
    const data = makePptx(
      [
        {
          shapes: pshape('title', ['Risultati']) + pshape('body', ['Crescita', ['Nord', 1]]) + table,
          notes: 'Citare il budget',
        },
        { shapes: pshape('title', ['Agenda']) + pshape('box', ['Note a margine']), hidden: true },
      ],
      [1, 0],
    );
    const r = await convertDocument(data, { maxChars: 50_000 });
    expect(r).toMatchObject({ format: 'pptx', detail: '2 slides' });
    expect(r.markdown).toBe(
      [
        '## Slide 1: Agenda (hidden)',
        '- Note a margine',
        '## Slide 2: Risultati',
        '- Crescita\n  - Nord\n| KPI | Q3 |\n| --- | --- |',
        'Speaker notes:\nCitare il budget',
      ].join('\n\n'),
    );
  });
});

describe('convertDocument: OpenDocument', () => {
  it('reads text documents with headings, spacing, nested lists and tables, without comments', async () => {
    const body =
      '<text:h text:outline-level="2">Capitolo</text:h>' +
      '<text:p>Uno<text:s text:c="3"/>due<text:tab/>tre<office:annotation><text:p>un commento</text:p></office:annotation></text:p>' +
      '<text:list><text:list-item><text:p>voce</text:p><text:list><text:list-item><text:p>sotto</text:p></text:list-item></text:list></text:list-item></text:list>' +
      '<table:table table:name="T"><table:table-row><table:table-cell><text:p>a</text:p></table:table-cell><table:table-cell><text:p>b</text:p></table:table-cell></table:table-row></table:table>';
    const r = await convertDocument(makeOdf('text', body), { maxChars: 50_000 });
    expect(r.format).toBe('odt');
    expect(r.markdown).toBe('## Capitolo\n\nUno due tre\n\n- voce\n  - sotto\n\n| a | b |\n| --- | --- |');
  });

  it('reads spreadsheets without expanding a million repeated empty rows', async () => {
    const body =
      '<table:table table:name="Foglio1"><table:table-column table:number-columns-repeated="16384"/>' +
      '<table:table-row><table:table-cell><text:p>Nome</text:p></table:table-cell><table:table-cell table:number-columns-repeated="2"><text:p>x</text:p></table:table-cell></table:table-row>' +
      '<table:table-row table:number-rows-repeated="1048570"><table:table-cell table:number-columns-repeated="16384"/></table:table-row>' +
      '<table:table-row><table:table-cell table:number-columns-repeated="3"/><table:table-cell><text:p>fondo</text:p></table:table-cell></table:table-row></table:table>';
    const r = await convertDocument(makeOdf('spreadsheet', body), { maxChars: 50_000 });
    expect(r).toMatchObject({ format: 'ods', detail: '1 sheet' });
    expect(r.markdown).toBe(
      '## Sheet: Foglio1\n\n| Nome | x | x |  |\n| --- | --- | --- | --- |\n|  |  |  | fondo |',
    );
  });

  it('reads presentations slide by slide with speaker notes', async () => {
    const body =
      '<draw:page draw:name="page1"><draw:frame presentation:class="title"><draw:text-box><text:p>Titolo</text:p></draw:text-box></draw:frame>' +
      '<draw:frame presentation:class="outline"><draw:text-box><text:list><text:list-item><text:p>punto</text:p></text:list-item></text:list></draw:text-box></draw:frame>' +
      '<presentation:notes><draw:frame presentation:class="notes"><draw:text-box><text:p>nota</text:p></draw:text-box></draw:frame></presentation:notes></draw:page>';
    const r = await convertDocument(makeOdf('presentation', body), { maxChars: 50_000 });
    expect(r).toMatchObject({ format: 'odp', detail: '1 slide' });
    expect(r.markdown).toBe('## Slide 1: Titolo\n\n- punto\n\nSpeaker notes:\nnota');
  });
});

describe('convertDocument: archives and other files', () => {
  it('lists a plain ZIP archive without extracting it', async () => {
    const r = await convertDocument(
      zip({ 'src/a.ts': 'export {}', 'dir/': new Uint8Array(), 'README.md': '# x' }),
      { maxChars: 50_000 },
    );
    expect(r).toMatchObject({ format: 'zip', detail: '2 files' });
    expect(r.markdown).toBe(
      'Files in this archive (2, 12 B uncompressed). Their contents are not included.\n\n- src/a.ts (9 B)\n- README.md (3 B)',
    );
  });

  it('refuses what is neither a PDF nor a ZIP container', async () => {
    expect(await failure(convertDocument(ascii('plain text'), { maxChars: 1000 }))).toMatchObject({
      code: 'unsupported',
    });
  });
});
