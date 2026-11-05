/**
 * Converts a document to Markdown for the model. This is the only entry point to the parsers: the extension host runs
 * it in the document worker (`src/extension/documents/documentWorker.ts`), never in its own thread, because the input
 * is untrusted and pdf.js installs browser stand-ins on `globalThis` (see `pdf.ts`). A lint rule enforces it.
 */
import { sniffFile } from './detect';
import { convertDocx } from './docx';
import { MarkdownBudget } from './markdown';
import { convertOdf, odfKind } from './odf';
import { mainPart } from './opc';
import { convertPptx } from './pptx';
import {
  DOCUMENT_LIMITS,
  DocumentError,
  type ConvertOptions,
  type DocumentFormat,
  type DocumentResult,
} from './types';
import { convertXlsx } from './xlsx';
import { ZipArchive } from './zip';

const formatSize = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1024 * 1024
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1024 / 1024).toFixed(1)} MB`;

/** A plain archive: what it contains, since the files themselves are not extracted. */
function listZip(zip: ZipArchive, out: MarkdownBudget): { detail: string } {
  const files = zip.entries.filter((e) => !e.directory);
  const total = files.reduce((n, e) => n + e.size, 0);
  const shown = files.slice(0, DOCUMENT_LIMITS.maxListedEntries);
  out.add(
    `Files in this archive (${files.length}, ${formatSize(total)} uncompressed). Their contents are not included.`,
  );
  out.add(shown.map((e) => `- ${e.name} (${formatSize(e.size)})`).join('\n'));
  if (shown.length < files.length) {
    out.omit();
    out.add(`…and ${files.length - shown.length} more files.`);
  }
  return { detail: `${files.length} ${files.length === 1 ? 'file' : 'files'}` };
}

/** Which Office Open XML document a main part is, from the folder Office puts it in. */
function ooxmlFormat(main: string): DocumentFormat | undefined {
  const folder = main.slice(0, main.indexOf('/') + 1).toLowerCase();
  return folder === 'word/' ? 'docx' : folder === 'xl/' ? 'xlsx' : folder === 'ppt/' ? 'pptx' : undefined;
}

async function convert(
  data: Uint8Array,
  out: MarkdownBudget,
): Promise<{ format: DocumentFormat; detail?: string }> {
  const sniffed = sniffFile(data.subarray(0, 8000));
  if (sniffed.kind !== 'document')
    throw new DocumentError('unsupported', 'The file is not a PDF or a ZIP container.');
  if (sniffed.container === 'pdf') {
    const { convertPdf } = await import('./pdf');
    return { format: 'pdf', ...(await convertPdf(data, out)) };
  }
  const zip = ZipArchive.open(data);
  const main = mainPart(zip);
  const ooxml = main ? ooxmlFormat(main) : undefined;
  if (main && ooxml === 'docx') return { format: 'docx', ...convertDocx(zip, main, out) };
  if (main && ooxml === 'xlsx') return { format: 'xlsx', ...convertXlsx(zip, main, out) };
  if (main && ooxml === 'pptx') return { format: 'pptx', ...convertPptx(zip, main, out) };
  const odf = odfKind(zip);
  if (odf) return { format: odf, ...convertOdf(zip, odf, out) };
  // Office files encrypted with a password are not ZIPs at all, so an archive here is a plain one.
  return { format: 'zip', ...listZip(zip, out) };
}

export async function convertDocument(data: Uint8Array, options: ConvertOptions): Promise<DocumentResult> {
  const out = new MarkdownBudget(options.maxChars);
  const { format, detail } = await convert(data, out);
  if (out.isEmpty) throw new DocumentError('empty', 'The document has no text.');
  return { format, markdown: out.toString(), truncated: out.truncated, ...(detail ? { detail } : {}) };
}
