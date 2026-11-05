/**
 * What a file is, from its first bytes. The signature decides, never the extension: a `report.pdf` that is really a
 * ZIP is read as a ZIP, and a renamed image is still refused as an image.
 */
import { looksBinary } from '../util/files';
import { DocumentError, FORMAT_LABELS, type DocumentErrorCode, type DocumentFormat } from './types';

export type TextEncodingName = 'utf-8' | 'utf-16le' | 'utf-16be';

export type UnsupportedFamily =
  'image' | 'audio' | 'video' | 'legacy-office' | 'archive' | 'executable' | 'binary';

export type Sniffed =
  | { kind: 'text'; encoding: TextEncodingName }
  /**
   * `textFallback`: the file would pass as text (no NUL byte), so it is attached as text if the conversion fails.
   * A Markdown file that happens to start with `%PDF-` keeps working as it did before documents were supported.
   */
  | { kind: 'document'; container: 'pdf' | 'zip'; textFallback: boolean }
  | { kind: 'unsupported'; family: UnsupportedFamily };

const at = (b: Uint8Array, offset: number, sig: readonly number[]) =>
  sig.every((v, i) => b[offset + i] === v);
const ascii = (b: Uint8Array, offset: number, s: string) =>
  at(
    b,
    offset,
    [...s].map((c) => c.charCodeAt(0)),
  );

/** `%PDF-` may follow a little junk (Acrobat accepts it within the first 1024 bytes). */
function pdfHeaderAt(head: Uint8Array): number {
  const end = Math.min(head.length - 5, 1024);
  for (let i = 0; i <= end; i++) if (head[i] === 0x25 && ascii(head, i, '%PDF-')) return i;
  return -1;
}

/** ISO base media files (MP4, MOV, HEIC, AVIF) carry `ftyp` and a brand at offset 4. */
function isoMediaFamily(head: Uint8Array): UnsupportedFamily | undefined {
  if (!ascii(head, 4, 'ftyp')) return undefined;
  const brand = String.fromCharCode(...head.subarray(8, 12));
  if (/^(heic|heix|hevc|hevx|heim|heis|mif1|msf1|avif|avis)$/.test(brand)) return 'image';
  if (/^M4[AB] $/.test(brand)) return 'audio';
  return 'video';
}

function binaryFamily(head: Uint8Array): UnsupportedFamily {
  if (at(head, 0, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'legacy-office';
  if (
    at(head, 0, [0x89, 0x50, 0x4e, 0x47]) ||
    at(head, 0, [0xff, 0xd8, 0xff]) ||
    ascii(head, 0, 'GIF87a') ||
    ascii(head, 0, 'GIF89a') ||
    (ascii(head, 0, 'RIFF') && ascii(head, 8, 'WEBP')) ||
    ascii(head, 0, 'BM') ||
    at(head, 0, [0x49, 0x49, 0x2a, 0x00]) ||
    at(head, 0, [0x4d, 0x4d, 0x00, 0x2a]) ||
    at(head, 0, [0x00, 0x00, 0x01, 0x00]) ||
    ascii(head, 0, '8BPS')
  ) {
    return 'image';
  }
  const iso = isoMediaFamily(head);
  if (iso) return iso;
  if (
    ascii(head, 0, 'ID3') ||
    ascii(head, 0, 'OggS') ||
    ascii(head, 0, 'fLaC') ||
    (ascii(head, 0, 'RIFF') && ascii(head, 8, 'WAVE')) ||
    (ascii(head, 0, 'FORM') && ascii(head, 8, 'AIFF'))
  ) {
    return 'audio';
  }
  if (
    (ascii(head, 0, 'RIFF') && ascii(head, 8, 'AVI ')) ||
    at(head, 0, [0x1a, 0x45, 0xdf, 0xa3]) ||
    ascii(head, 0, 'FLV')
  )
    return 'video';
  if (
    at(head, 0, [0x1f, 0x8b]) ||
    at(head, 0, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) ||
    ascii(head, 0, 'Rar!') ||
    at(head, 0, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]) ||
    ascii(head, 0, 'BZh') ||
    at(head, 0, [0x28, 0xb5, 0x2f, 0xfd]) ||
    ascii(head, 257, 'ustar')
  ) {
    return 'archive';
  }
  if (
    ascii(head, 0, 'MZ') ||
    at(head, 0, [0x7f, 0x45, 0x4c, 0x46]) ||
    at(head, 0, [0xfe, 0xed, 0xfa, 0xce]) ||
    at(head, 0, [0xfe, 0xed, 0xfa, 0xcf]) ||
    at(head, 0, [0xce, 0xfa, 0xed, 0xfe]) ||
    at(head, 0, [0xcf, 0xfa, 0xed, 0xfe]) ||
    at(head, 0, [0xca, 0xfe, 0xba, 0xbe]) ||
    at(head, 0, [0x00, 0x61, 0x73, 0x6d])
  ) {
    return 'executable';
  }
  return 'binary';
}

/**
 * Text in UTF-16 with a byte-order mark: what Windows PowerShell 5 writes with `>`, and what some editors save. Its
 * ASCII characters carry NUL bytes, so the binary heuristic alone would refuse it. The sample must decode cleanly and
 * hold no control characters other than whitespace, so a binary file that merely starts with FF FE is not mistaken
 * for text.
 */
function utf16Encoding(head: Uint8Array): 'utf-16le' | 'utf-16be' | undefined {
  // FF FE 00 00 is the UTF-32 LE mark, which TextDecoder does not support.
  const encoding =
    at(head, 0, [0xff, 0xfe]) && !at(head, 2, [0x00, 0x00])
      ? 'utf-16le'
      : at(head, 0, [0xfe, 0xff])
        ? 'utf-16be'
        : undefined;
  if (!encoding) return undefined;
  // Keep whole code units, and drop a final lead surrogate whose pair lies past the sample.
  let sample = head.subarray(2, 2 + ((head.length - 2) & ~1));
  if (sample.length >= 2) {
    const last = encoding === 'utf-16le' ? sample[sample.length - 1]! : sample[sample.length - 2]!;
    if (last >= 0xd8 && last <= 0xdb) sample = sample.subarray(0, sample.length - 2);
  }
  try {
    const text = new TextDecoder(encoding, { fatal: true }).decode(sample);
    // eslint-disable-next-line no-control-regex
    return /[\u0000-\u0008\u000e-\u001f]/.test(text) ? undefined : encoding;
  } catch {
    return undefined;
  }
}

/** Classifies a file from its first bytes (8000 are enough: the window `looksBinary` inspects). */
export function sniffFile(head: Uint8Array): Sniffed {
  const binary = looksBinary(head);
  const pdf = pdfHeaderAt(head);
  // Junk before the header only counts in a binary file, so a note that quotes `%PDF-` stays a note.
  if (pdf === 0 || (pdf > 0 && binary)) return { kind: 'document', container: 'pdf', textFallback: !binary };
  if (at(head, 0, [0x50, 0x4b, 0x03, 0x04]) || at(head, 0, [0x50, 0x4b, 0x05, 0x06])) {
    return { kind: 'document', container: 'zip', textFallback: !binary };
  }
  if (!binary) return { kind: 'text', encoding: 'utf-8' };
  const utf16 = utf16Encoding(head);
  if (utf16) return { kind: 'text', encoding: utf16 };
  return { kind: 'unsupported', family: binaryFamily(head) };
}

/** Decodes a whole text file in the encoding `sniffFile` found, without its byte-order mark. */
export function decodeText(bytes: Uint8Array, encoding: TextEncodingName): string {
  return new TextDecoder(encoding).decode(bytes);
}

const SUPPORTED = 'text files and documents (PDF, Word, Excel, PowerPoint, OpenDocument, ZIP)';

/** Why a file of this family cannot be attached, and what to do instead. */
export function describeUnsupported(family: UnsupportedFamily, shown: string): string {
  switch (family) {
    case 'image':
      return `${shown} is an image. Sovran cannot send images to the model yet: describe what matters in your message, or attach the text it shows.`;
    case 'audio':
    case 'video':
      return `${shown} is an ${family} file. Sovran can attach ${SUPPORTED}.`;
    case 'legacy-office':
      return `${shown} is an Office file in the old binary format (.doc, .xls, .ppt), or a password-protected one. Save it as .docx, .xlsx, .pptx or PDF without a password, then attach that.`;
    case 'archive':
      return `${shown} is a compressed archive Sovran cannot open (only ZIP archives are supported). Extract it and attach the files you need.`;
    case 'executable':
      return `${shown} is a compiled program or library, so it has no text to read.`;
    case 'binary':
      return `${shown} looks like a binary file. Sovran can attach ${SUPPORTED}.`;
  }
}

const ERRORS: Record<DocumentErrorCode, (shown: string, kind: string) => string> = {
  unsupported: (shown) => `${shown} is not a document Sovran can read. It can attach ${SUPPORTED}.`,
  encrypted: (shown) => `${shown} is password-protected. Save a copy without the password, then attach that.`,
  empty: (shown, kind) =>
    kind === 'PDF document'
      ? `${shown} has no text to read: it is probably a scanned image. Attach a PDF with selectable text, or paste the text you need.`
      : `${shown} has no text to read.`,
  corrupt: (shown, kind) =>
    `${shown} could not be read as ${/^[AEIOU]/.test(kind) ? 'an' : 'a'} ${kind}: the file may be damaged.`,
  too_large: (shown) => `${shown} is too large to read once decompressed. Attach a smaller excerpt of it.`,
  timeout: (shown) => `Reading ${shown} took too long, so Sovran stopped. Attach a smaller excerpt of it.`,
  cancelled: (shown) => `Reading ${shown} was cancelled.`,
  failed: (shown) => `Sovran could not read ${shown}. Check the Sovran log for details.`,
};

/** The message shown when converting `shown` failed. `format` names the kind of document when it is known. */
export function describeDocumentError(error: unknown, shown: string, format?: DocumentFormat): string {
  const code = error instanceof DocumentError ? error.code : 'failed';
  return ERRORS[code](shown, format ? FORMAT_LABELS[format] : 'document');
}
