/**
 * PDF to text with Mozilla's pdf.js, page by page. Only the text layer is read: nothing is rendered, scripts and
 * fonts are never evaluated (`isEvalSupported: false`, the fix for CVE-2024-4367), and pages without text are named
 * so the model knows something is missing.
 *
 * pdf.js expects a few browser globals, so this module installs harmless stand-ins. Load it only in an isolated
 * thread (the document worker) or in tests, never in the shared extension host.
 *
 * pdfjs-dist stays on 5.4: later versions need Node 20.19, and VS Code 1.95 (the oldest version Sovran supports)
 * runs Node 20.18.
 */
import type * as PdfJsModule from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { TextContent, TextItem } from 'pdfjs-dist/types/src/display/api';
import type { MarkdownBudget } from './markdown';
import { DocumentError } from './types';

type PdfJs = typeof PdfJsModule;

let loaded: Promise<PdfJs> | undefined;

/** pdf.js builds a DOMMatrix when it loads, and reads `navigator` (Node 20 has none). Text extraction needs neither. */
function installGlobals() {
  const g = globalThis as Record<string, unknown>;
  if (!g.DOMMatrix) {
    g.DOMMatrix = class DOMMatrix {
      a: number;
      b: number;
      c: number;
      d: number;
      e: number;
      f: number;
      constructor(init?: unknown) {
        const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = Array.isArray(init) ? (init as number[]) : [];
        this.a = a;
        this.b = b;
        this.c = c;
        this.d = d;
        this.e = e;
        this.f = f;
      }
    };
  }
  if (!g.navigator) g.navigator = { language: 'en-US', platform: '', userAgent: '' };
}

function loadPdfJs(): Promise<PdfJs> {
  loaded ??= (async () => {
    installGlobals();
    const [pdfjs, worker] = await Promise.all([
      import('pdfjs-dist/legacy/build/pdf.mjs'),
      import('pdfjs-dist/legacy/build/pdf.worker.mjs'),
    ]);
    // The parser runs in this thread: pdf.js uses the handler it finds here instead of starting a web worker.
    (globalThis as Record<string, unknown>).pdfjsWorker = worker;
    return pdfjs;
  })();
  return loaded;
}

const isTextItem = (item: TextContent['items'][number]): item is TextItem => 'str' in item;

function pageText(content: TextContent): string {
  let text = '';
  for (const item of content.items) {
    if (!isTextItem(item)) continue;
    text += item.str;
    if (item.hasEOL) text += '\n';
  }
  return text
    .replaceAll('\0', '')
    .split('\n')
    .map((l) => l.replace(/[ \t\u00a0]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function convertPdf(data: Uint8Array, out: MarkdownBudget): Promise<{ detail?: string }> {
  const pdfjs = await loadPdfJs();
  const task = pdfjs.getDocument({
    // pdf.js takes ownership of the buffer it is given.
    data: data.slice(),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    enableXfa: false,
    stopAtErrors: false,
    verbosity: pdfjs.VerbosityLevel.ERRORS,
  });
  let doc;
  try {
    doc = await task.promise;
  } catch (e) {
    const name = e instanceof Error ? e.name : '';
    if (name === 'PasswordException') throw new DocumentError('encrypted', 'The PDF is password-protected.');
    throw new DocumentError(
      'corrupt',
      `pdf.js could not open the file: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  try {
    const total = doc.numPages;
    let read = 0;
    let withText = 0;
    for (let i = 1; i <= total && !out.full; i++) {
      const page = await doc.getPage(i);
      const text = pageText(await page.getTextContent());
      page.cleanup();
      read = i;
      if (text) withText++;
      out.add(`## Page ${i}\n\n${text || '(No text on this page. It may be a scanned image or a picture.)'}`);
    }
    if (!withText && read === total) throw new DocumentError('empty', 'The PDF has no text layer.');
    if (read < total) out.omit();
    const pages = `${total} ${total === 1 ? 'page' : 'pages'}`;
    return { detail: read < total ? `pages 1–${read} of ${total}` : pages };
  } finally {
    await doc.destroy();
  }
}
