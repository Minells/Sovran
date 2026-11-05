/**
 * The document worker as it ships: bundled by esbuild into one CommonJS file (as scripts/build-host.mjs does) and run
 * in a real worker thread, so pdf.js's loading under CommonJS, the browser stand-ins and the reply protocol are all
 * exercised. Also the runner's limits: timeout, cancellation, a missing script and a worker out of memory.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as esbuild from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WorkerDocumentConverter } from '../../src/extension/adapters/WorkerDocumentConverter';
import { makeDocx, makePdf, wp } from '../fixtures/documents';

let dir: string;
let script: string;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sovran-worker-'));
  script = path.join(dir, 'documentWorker.js');
  // The options of scripts/build-host.mjs that shape the output (the production build also minifies).
  await esbuild.build({
    entryPoints: ['src/extension/adapters/documentWorker.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    minify: true,
    outfile: script,
    logLevel: 'silent',
  });
}, 60_000);

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as { code?: string; message: string };
  }
  throw new Error('expected the conversion to fail');
};

describe('WorkerDocumentConverter with the bundled worker', () => {
  it('converts a PDF and a Word document in a worker thread', async () => {
    const converter = new WorkerDocumentConverter(script);
    expect(
      await converter.convert(makePdf([['Hello from the worker'], ['Second page']]), { maxChars: 10_000 }),
    ).toEqual({
      format: 'pdf',
      markdown: '## Page 1\n\nHello from the worker\n\n## Page 2\n\nSecond page',
      detail: '2 pages',
      truncated: false,
    });
    expect(await converter.convert(makeDocx(wp('Ciao', { style: 'Titolo1' })), { maxChars: 10_000 })).toEqual(
      { format: 'docx', markdown: '# Ciao', truncated: false },
    );
  });

  it('passes conversion errors back with their code', async () => {
    const converter = new WorkerDocumentConverter(script);
    expect(
      await failure(converter.convert(new TextEncoder().encode('just text'), { maxChars: 100 })),
    ).toMatchObject({ code: 'unsupported' });
    expect(await failure(converter.convert(makePdf([[]]), { maxChars: 100 }))).toMatchObject({
      code: 'empty',
    });
  });
});

describe('WorkerDocumentConverter limits', () => {
  const scriptWith = async (name: string, body: string) => {
    const file = path.join(dir, name);
    await fs.writeFile(file, body);
    return file;
  };

  it('stops a worker that does not answer in time', async () => {
    const hang = await scriptWith('hang.js', 'setInterval(() => {}, 1000);');
    const started = Date.now();
    expect(
      await failure(
        new WorkerDocumentConverter(hang, { timeoutMs: 200 }).convert(new Uint8Array(1), { maxChars: 10 }),
      ),
    ).toMatchObject({ code: 'timeout' });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('stops when the caller cancels', async () => {
    const hang = await scriptWith('hang2.js', 'setInterval(() => {}, 1000);');
    const abort = new AbortController();
    const pending = new WorkerDocumentConverter(hang).convert(new Uint8Array(1), {
      maxChars: 10,
      signal: abort.signal,
    });
    setTimeout(() => abort.abort(), 50);
    expect(await failure(pending)).toMatchObject({ code: 'cancelled' });
    const aborted = new AbortController();
    aborted.abort();
    expect(
      await failure(
        new WorkerDocumentConverter(hang).convert(new Uint8Array(1), {
          maxChars: 10,
          signal: aborted.signal,
        }),
      ),
    ).toMatchObject({ code: 'cancelled' });
  });

  it('reports a worker that cannot start, exits without a reply or answers nonsense', async () => {
    expect(
      await failure(
        new WorkerDocumentConverter(path.join(dir, 'missing.js')).convert(new Uint8Array(1), {
          maxChars: 10,
        }),
      ),
    ).toMatchObject({ code: 'failed' });
    const exit = await scriptWith('exit.js', 'process.exit(3);');
    expect(
      await failure(new WorkerDocumentConverter(exit).convert(new Uint8Array(1), { maxChars: 10 })),
    ).toMatchObject({ code: 'failed', message: expect.stringMatching(/exit code 3/) });
    const odd = await scriptWith(
      'odd.js',
      "require('node:worker_threads').parentPort.postMessage({ ok: true, result: { markdown: 1 } });",
    );
    expect(
      await failure(new WorkerDocumentConverter(odd).convert(new Uint8Array(1), { maxChars: 10 })),
    ).toMatchObject({ code: 'failed', message: expect.stringMatching(/unexpected reply/) });
  });

  it('treats a worker that runs out of memory as a document too large to read', async () => {
    const hog = await scriptWith(
      'hog.js',
      'const keep = []; for (;;) keep.push(new Array(1e5).fill({ x: Math.random() }));',
    );
    expect(
      await failure(
        new WorkerDocumentConverter(hog, { maxHeapMb: 32, timeoutMs: 30_000 }).convert(new Uint8Array(1), {
          maxChars: 10,
        }),
      ),
    ).toMatchObject({ code: 'too_large' });
  }, 40_000);
});
