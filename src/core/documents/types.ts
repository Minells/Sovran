/**
 * Documents Sovran converts to Markdown before they reach the model: PDF, Office Open XML, OpenDocument and ZIP
 * archives (listed, not extracted). The conversion parses untrusted files, so the host runs it in an isolated worker
 * (see `convert.ts`); this module holds only the shared types, so importing it never loads a parser.
 */

export type DocumentFormat = 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'odt' | 'ods' | 'odp' | 'zip';

/** How each format is named to the user and to the model. */
export const FORMAT_LABELS: Record<DocumentFormat, string> = {
  pdf: 'PDF document',
  docx: 'Word document',
  xlsx: 'Excel workbook',
  pptx: 'PowerPoint presentation',
  odt: 'OpenDocument text',
  ods: 'OpenDocument spreadsheet',
  odp: 'OpenDocument presentation',
  zip: 'ZIP archive',
};

export interface ConvertOptions {
  /** Characters of Markdown to produce at most. Converters stop reading once they have enough. */
  maxChars: number;
}

export interface DocumentResult {
  format: DocumentFormat;
  markdown: string;
  /** Short facts for the model and the chip: "12 pages", "pages 1–40 of 300", "3 sheets". */
  detail?: string;
  /** The Markdown stops before the end of the document. */
  truncated: boolean;
}

export type DocumentErrorCode =
  /** Not a format Sovran converts. */
  | 'unsupported'
  /** Password-protected. */
  | 'encrypted'
  /** Readable, but without any text (a scanned PDF, an empty workbook). */
  | 'empty'
  /** Damaged, or not what its signature claims. */
  | 'corrupt'
  /** Bigger than the limits below, once decompressed. */
  | 'too_large'
  | 'timeout'
  | 'cancelled'
  /** The reader itself failed (for example, it could not start). */
  | 'failed';

export class DocumentError extends Error {
  constructor(
    readonly code: DocumentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DocumentError';
  }
}

/**
 * Limits that keep a hostile file (a ZIP bomb, a table with a million repeated rows) from exhausting memory. Sizes
 * are the uncompressed sizes an archive declares: the ZIP reader never inflates an entry past its declared size.
 */
export const DOCUMENT_LIMITS = {
  /** Largest document read from disk. Presentations and PDFs carry images, so this is well above the text limit. */
  maxFileBytes: 50 * 1024 * 1024,
  /** Largest single part inside an archive (one worksheet, the main document XML). */
  maxEntryBytes: 64 * 1024 * 1024,
  /** All parts inflated for one document together. */
  maxTotalBytes: 160 * 1024 * 1024,
  /** Entries in one archive. */
  maxEntries: 20_000,
  /** Columns of a spreadsheet shown; wider sheets say which columns were left out. */
  maxColumns: 60,
  /** Archive entries listed for a ZIP file. */
  maxListedEntries: 1_000,
} as const;
