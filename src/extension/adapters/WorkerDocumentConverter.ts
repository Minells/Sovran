/**
 * `DocumentConverterPort` for the VS Code host: each conversion runs in a fresh worker thread (`documentWorker.ts`)
 * with its own heap limit and a timeout, and is terminated as soon as it answers, fails or is cancelled.
 */
import { Worker } from 'node:worker_threads';
import { DocumentError, type DocumentResult } from '../../core/documents/types';
import type { DocumentConverterPort } from '../../core/ports';
import type { DocumentJob, DocumentReply } from './documentWorker';

export interface WorkerConverterOptions {
  timeoutMs?: number;
  /** Heap of the worker thread. Decompressed parts and their text live here. */
  maxHeapMb?: number;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function isReply(value: unknown): value is DocumentReply {
  if (!value || typeof value !== 'object') return false;
  const r = value as Partial<{ ok: boolean; result: Partial<DocumentResult>; code: string }>;
  return r.ok === true
    ? typeof r.result?.markdown === 'string' && typeof r.result.format === 'string'
    : r.ok === false && typeof r.code === 'string';
}

export class WorkerDocumentConverter implements DocumentConverterPort {
  constructor(
    /** Absolute path of the bundled worker script. */
    private readonly script: string,
    private readonly options: WorkerConverterOptions = {},
  ) {}

  convert(
    data: Uint8Array,
    { maxChars, signal }: { maxChars: number; signal?: AbortSignal },
  ): Promise<DocumentResult> {
    const timeoutMs = this.options.timeoutMs ?? 60_000;
    return new Promise<DocumentResult>((resolve, reject) => {
      if (signal?.aborted)
        return reject(new DocumentError('cancelled', 'Cancelled before the conversion started.'));
      let worker: Worker;
      try {
        worker = new Worker(this.script, {
          workerData: { data, maxChars } satisfies DocumentJob,
          resourceLimits: { maxOldGenerationSizeMb: this.options.maxHeapMb ?? 768 },
          // Nothing of the host's command line (an inspector port, for example) applies to the worker.
          execArgv: [],
          stdout: true,
          stderr: true,
        });
      } catch (e) {
        return reject(new DocumentError('failed', `The document worker could not start: ${message(e)}`));
      }
      // Its output is discarded, not piped into the extension host's.
      worker.stdout.resume();
      worker.stderr.resume();
      let settled = false;
      const onAbort = () =>
        finish(() => reject(new DocumentError('cancelled', 'The conversion was cancelled.')));
      const finish = (settle: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        void worker.terminate();
        settle();
      };
      // `finish` only runs from these callbacks, all of which fire after this line.
      const timer = setTimeout(
        () => finish(() => reject(new DocumentError('timeout', `No result after ${timeoutMs} ms.`))),
        timeoutMs,
      );
      signal?.addEventListener('abort', onAbort, { once: true });
      worker.once('message', (reply: unknown) =>
        finish(() => {
          if (!isReply(reply))
            reject(new DocumentError('failed', 'The document worker sent an unexpected reply.'));
          else if (reply.ok) resolve(reply.result);
          else reject(new DocumentError(reply.code, reply.message));
        }),
      );
      worker.once('error', (e) => {
        const outOfMemory = (e as { code?: string }).code === 'ERR_WORKER_OUT_OF_MEMORY';
        finish(() => reject(new DocumentError(outOfMemory ? 'too_large' : 'failed', message(e))));
      });
      worker.once('exit', (code) =>
        finish(() =>
          reject(
            new DocumentError('failed', `The document worker stopped (exit code ${code}) without a result.`),
          ),
        ),
      );
    });
  }
}
