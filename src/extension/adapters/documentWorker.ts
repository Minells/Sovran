/**
 * Entry point of the document worker, bundled on its own as `dist/documentWorker.js`. It runs one conversion in a
 * worker thread and exits, so a hostile or pathological file can at worst exhaust this thread's memory limit or time
 * out; the extension host it was started from is never blocked, and the browser stand-ins pdf.js needs stay here.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { convertDocument } from '../../core/documents/convert';
import { DocumentError, type DocumentErrorCode, type DocumentResult } from '../../core/documents/types';

export interface DocumentJob {
  data: Uint8Array;
  maxChars: number;
}

export type DocumentReply =
  { ok: true; result: DocumentResult } | { ok: false; code: DocumentErrorCode; message: string };

// pdf.js warns on every load that it cannot render (no canvas). Nothing here is for the user, so it stays silent.
for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
  // eslint-disable-next-line no-console
  console[method] = () => {};
}

async function run(job: DocumentJob): Promise<DocumentReply> {
  try {
    return { ok: true, result: await convertDocument(job.data, { maxChars: job.maxChars }) };
  } catch (e) {
    if (e instanceof DocumentError) return { ok: false, code: e.code, message: e.message };
    return { ok: false, code: 'failed', message: e instanceof Error ? e.message : String(e) };
  }
}

if (parentPort) {
  const port = parentPort;
  void run(workerData as DocumentJob).then((reply) => port.postMessage(reply));
}
