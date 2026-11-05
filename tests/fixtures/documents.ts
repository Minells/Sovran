/**
 * Small, valid documents built in code, so the tests need no binary fixtures: a PDF writer with one text line per
 * entry, and Office Open XML / OpenDocument packages assembled with fflate.
 */
import { strToU8, zipSync, type Zippable } from 'fflate';

/** A PDF with one page per entry; each string is a line of Helvetica text (WinAnsi, so Latin accents work). */
export function makePdf(pages: string[][], options: { prefix?: string } = {}): Uint8Array {
  const objects: string[] = [];
  const add = (body: string) => objects.push(body);
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const pagesId = 1 + pages.length * 2 + 1;
  const kids: number[] = [];
  for (const lines of pages) {
    const ops = lines
      .map((l, i) => `BT /F1 12 Tf 72 ${720 - i * 16} Td (${l.replace(/[()\\]/g, (c) => `\\${c}`)}) Tj ET`)
      .join('\n');
    add(`<< /Length ${Buffer.byteLength(ops, 'latin1')} >>\nstream\n${ops}\nendstream`);
    const content = objects.length;
    add(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 1 0 R >> >> /Contents ${content} 0 R >>`,
    );
    kids.push(objects.length);
  }
  add(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`);
  add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  const catalog = objects.length;
  let out = `${options.prefix ?? ''}%PDF-1.4\n`;
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}

export const zip = (files: Record<string, string | Uint8Array>): Uint8Array =>
  zipSync(
    Object.fromEntries(
      Object.entries(files).map(([name, v]) => [name, typeof v === 'string' ? strToU8(v) : v]),
    ) as Zippable,
  );

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const rels = (items: Array<[id: string, type: string, target: string, external?: boolean]>) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items
    .map(
      ([id, type, target, external]) =>
        `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"${external ? ' TargetMode="External"' : ''}/>`,
    )
    .join('')}</Relationships>`;

const W =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

/** A .docx whose body is `body` (WordprocessingML inside `<w:body>`), with Italian-named heading styles. */
export function makeDocx(
  body: string,
  extra: { numbering?: string; links?: Record<string, string> } = {},
): Uint8Array {
  const styles = `<w:styles ${W}>
    <w:style w:type="paragraph" w:styleId="Titolo1"><w:name w:val="heading 1"/></w:style>
    <w:style w:type="paragraph" w:styleId="Titolo2"><w:name w:val="heading 2"/></w:style>
    <w:style w:type="paragraph" w:styleId="Capitolo"><w:name w:val="Capitolo"/><w:basedOn w:val="Titolo2"/></w:style>
    <w:style w:type="paragraph" w:styleId="Normale"><w:name w:val="Normal"/></w:style>
  </w:styles>`;
  const docRels: Array<[string, string, string, boolean?]> = [
    ['rIdS', 'styles', 'styles.xml'],
    ['rIdN', 'numbering', 'numbering.xml'],
  ];
  for (const [id, url] of Object.entries(extra.links ?? {})) docRels.push([id, 'hyperlink', url, true]);
  return zip({
    '[Content_Types].xml':
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    '_rels/.rels': rels([['rId1', 'officeDocument', 'word/document.xml']]),
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${body}<w:sectPr/></w:body></w:document>`,
    'word/_rels/document.xml.rels': rels(docRels),
    'word/styles.xml': styles,
    'word/numbering.xml':
      extra.numbering ??
      `<w:numbering ${W}>
        <w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>
        <w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="lowerLetter"/></w:lvl></w:abstractNum>
        <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
        <w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
      </w:numbering>`,
  });
}

/** `<w:p>` with an optional style and list numbering around the given runs (plain strings become text runs). */
export const wp = (runs: string | string[], opts: { style?: string; numId?: number; ilvl?: number } = {}) => {
  const ppr =
    opts.style || opts.numId !== undefined
      ? `<w:pPr>${opts.style ? `<w:pStyle w:val="${opts.style}"/>` : ''}${opts.numId !== undefined ? `<w:numPr><w:ilvl w:val="${opts.ilvl ?? 0}"/><w:numId w:val="${opts.numId}"/></w:numPr>` : ''}</w:pPr>`
      : '';
  const body = (Array.isArray(runs) ? runs : [runs])
    .map((r) => (r.startsWith('<') ? r : `<w:r><w:t xml:space="preserve">${r}</w:t></w:r>`))
    .join('');
  return `<w:p>${ppr}${body}</w:p>`;
};

export interface SheetSpec {
  name: string;
  /** Raw `<row>` elements. */
  rows: string;
  hidden?: boolean;
}

/** A .xlsx with shared strings and a style table whose index 1 is a date format and index 2 a custom date. */
export function makeXlsx(
  sheets: SheetSpec[],
  options: { sharedStrings?: string[]; date1904?: boolean } = {},
): Uint8Array {
  const S =
    'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const files: Record<string, string> = {
    '[Content_Types].xml':
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    '_rels/.rels': rels([['rId1', 'officeDocument', 'xl/workbook.xml']]),
    'xl/workbook.xml': `<workbook ${S}><workbookPr${options.date1904 ? ' date1904="1"' : ''}/><sheets>${sheets
      .map(
        (s, i) =>
          `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rIdSheet${i + 1}"${s.hidden ? ' state="hidden"' : ''}/>`,
      )
      .join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': rels([
      ...sheets.map((_, i): [string, string, string] => [
        `rIdSheet${i + 1}`,
        'worksheet',
        `worksheets/sheet${i + 1}.xml`,
      ]),
      ['rIdSst', 'sharedStrings', 'sharedStrings.xml'],
      ['rIdStyles', 'styles', 'styles.xml'],
    ]),
    'xl/sharedStrings.xml': `<sst ${S}>${(options.sharedStrings ?? []).map((s) => (s.startsWith('<') ? `<si>${s}</si>` : `<si><t>${s}</t></si>`)).join('')}</sst>`,
    'xl/styles.xml': `<styleSheet ${S}><numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy;@"/></numFmts>
      <cellStyleXfs count="1"><xf numFmtId="14"/></cellStyleXfs>
      <cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/></cellXfs></styleSheet>`,
  };
  sheets.forEach(
    (s, i) =>
      (files[`xl/worksheets/sheet${i + 1}.xml`] =
        `<worksheet ${S}><sheetData>${s.rows}</sheetData></worksheet>`),
  );
  return zip(files);
}

const P =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

/** A shape: a title placeholder, a body placeholder or a plain text box, with one paragraph per entry. */
export const pshape = (
  kind: 'title' | 'body' | 'box',
  paragraphs: Array<string | [text: string, level: number]>,
) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="2" name="s"/><p:cNvSpPr/><p:nvPr>${kind === 'title' ? '<p:ph type="title"/>' : kind === 'body' ? '<p:ph idx="1"/>' : ''}</p:nvPr></p:nvSpPr><p:txBody>${paragraphs
    .map((p) => {
      const [text, level] = Array.isArray(p) ? p : [p, 0];
      return `<a:p>${level ? `<a:pPr lvl="${level}"/>` : ''}<a:r><a:t>${text}</a:t></a:r></a:p>`;
    })
    .join('')}</p:txBody></p:sp>`;

/** A .pptx; slides are listed in `order` (indexes into `slides`) to prove the presentation order wins. */
export function makePptx(
  slides: Array<{ shapes: string; notes?: string; hidden?: boolean }>,
  order = slides.map((_, i) => i),
): Uint8Array {
  const files: Record<string, string> = {
    '[Content_Types].xml':
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    '_rels/.rels': rels([['rId1', 'officeDocument', 'ppt/presentation.xml']]),
    'ppt/presentation.xml': `<p:presentation ${P}><p:sldIdLst>${order.map((i) => `<p:sldId id="${256 + i}" r:id="rIdSlide${i + 1}"/>`).join('')}</p:sldIdLst></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': rels(
      slides.map((_, i): [string, string, string] => [
        `rIdSlide${i + 1}`,
        'slide',
        `slides/slide${i + 1}.xml`,
      ]),
    ),
  };
  slides.forEach((s, i) => {
    files[`ppt/slides/slide${i + 1}.xml`] =
      `<p:sld ${P}${s.hidden ? ' show="0"' : ''}><p:cSld><p:spTree>${s.shapes}</p:spTree></p:cSld></p:sld>`;
    if (s.notes) {
      files[`ppt/slides/_rels/slide${i + 1}.xml.rels`] = rels([
        ['rIdN', 'notesSlide', `../notesSlides/notesSlide${i + 1}.xml`],
      ]);
      files[`ppt/notesSlides/notesSlide${i + 1}.xml`] = `<p:notes ${P}><p:cSld><p:spTree>
        <p:sp><p:nvSpPr><p:cNvPr id="2" name="img"/><p:cNvSpPr/><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr></p:sp>
        <p:sp><p:nvSpPr><p:cNvPr id="3" name="notes"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${s.notes}</a:t></a:r></a:p></p:txBody></p:sp>
        <p:sp><p:nvSpPr><p:cNvPr id="4" name="num"/><p:cNvSpPr/><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>7</a:t></a:r></a:p></p:txBody></p:sp>
      </p:spTree></p:cSld></p:notes>`;
    }
  });
  return zip(files);
}

const ODF_NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0"';

/** An OpenDocument package: `kind` sets the `mimetype`, `body` goes inside `<office:body>`. */
export function makeOdf(kind: 'text' | 'spreadsheet' | 'presentation', body: string): Uint8Array {
  return zip({
    mimetype: `application/vnd.oasis.opendocument.${kind}`,
    'content.xml': `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${ODF_NS}><office:automatic-styles><style:style/></office:automatic-styles><office:body><office:${kind}>${body}</office:${kind}></office:body></office:document-content>`,
    'META-INF/manifest.xml': '<manifest:manifest/>',
  });
}
