import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import * as esbuild from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QuickJSExecutor } from '../../src/extension/adapters/QuickJSExecutor';
import type { SandboxOptions } from '../../src/core/codeMode/contracts';

const require = createRequire(import.meta.url);
let dir: string;
let script: string;
let wasm: string;
beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sovran-code-worker-'));
  script = path.join(dir, 'codeModeWorker.js');
  wasm = path.join(dir, 'quickjs.wasm');
  await fs.copyFile(require.resolve('@jitl/quickjs-wasmfile-release-sync/wasm'), wasm);
  await esbuild.build({
    entryPoints: ['src/extension/adapters/codeModeWorker.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    minify: true,
    outfile: script,
    logLevel: 'silent',
    alias: {
      '@jitl/quickjs-wasmfile-release-sync/emscripten-module':
        require.resolve('@jitl/quickjs-wasmfile-release-sync/emscripten-module'),
    },
  });
}, 30_000);
afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const options = (over: Partial<SandboxOptions> = {}): SandboxOptions => ({
  signal: new AbortController().signal,
  maxOutputBytes: 1024,
  call: async (_id, args) => ({ data: args, contentTypes: ['text'] }),
  ...over,
});
const executor = () => new QuickJSExecutor(script, wasm, { activeMs: 1500, wallMs: 2000, cpuMs: 100 });

describe('real QuickJS worker', () => {
  it('enforces the QuickJS heap limit before allowing an 80 MiB allocation', async () => {
    const sandbox = new QuickJSExecutor(script, wasm, { activeMs: 2000, wallMs: 3000, cpuMs: 1000 });
    await expect(sandbox.execute('return "x".repeat(80 * 1024 * 1024).length;', options())).rejects.toThrow(
      /memory|allocation/i,
    );
  });

  it('returns synchronous host callback failures as RPC errors instead of crashing the host', async () => {
    const result = await executor().execute(
      'try { await tools.call("broken"); } catch(e) { return String(e); }',
      options({
        call: () => {
          throw new Error('host failure');
        },
      }),
    );
    expect(result).toContain('host failure');
  });

  it('returns JSON, supports await and concurrent RPC without Asyncify', async () => {
    const result = await executor().execute(
      `
      const results = await Promise.all([tools.call('one', {n: 1}), tools.call('two', {n: 2})]);
      return results.map(r => r.data.n).reduce((a,b) => a+b,0);`,
      options(),
    );
    expect(result).toBe(3);
  });

  it('exposes no host globals, even via a function constructor', async () => {
    expect(
      await executor().execute(
        `return [typeof process, typeof require, typeof fetch, typeof WebSocket, typeof Buffer,
      tools.call.constructor('return typeof process')()];`,
        options(),
      ),
    ).toEqual(Array(6).fill('undefined'));
    expect(await executor().execute('return Object.isFrozen(tools);', options())).toBe(true);
  });

  it.each([
    'return require("node:fs");',
    'return await import("node:fs");',
    'return fetch("https://example.com");',
    'throw new Error("test");',
    'return 1n;',
    'const a={};a.self=a;return a;',
  ])('rejects unavailable APIs and invalid results: %s', async (code) => {
    await expect(executor().execute(code, options())).rejects.toBeInstanceOf(Error);
  });

  it.each([
    'while(true) {}',
    'const spin = () => Promise.resolve().then(spin); await spin();',
    'const a=[]; while(true) a.push("x".repeat(10000));',
  ])('interrupts runaway computation and can execute again: %s', async (code) => {
    const sandbox = executor();
    await expect(sandbox.execute(code, options())).rejects.toBeInstanceOf(Error);
    expect(await sandbox.execute('return 42;', options())).toBe(42);
  });

  it('has no globals shared between executions', async () => {
    const sandbox = executor();
    await sandbox.execute('globalThis.saved = 42; return true;', options());
    expect(await sandbox.execute('return typeof saved;', options())).toBe('undefined');
  });

  it('enforces output limits and a host deadline on never-settling promises', async () => {
    await expect(executor().execute('return "x".repeat(3000);', options())).rejects.toMatchObject({
      code: 'LIMIT_EXCEEDED',
    });
    const sandbox = new QuickJSExecutor(script, wasm, { activeMs: 150, wallMs: 1000, cpuMs: 100 });
    await expect(sandbox.execute('return await new Promise(() => {});', options())).rejects.toMatchObject({
      code: 'TIMEOUT',
    });
  });

  it('cancels MCP work and a blocked worker, then releases the window lock', async () => {
    const abort = new AbortController();
    let rpcSignal: AbortSignal | undefined;
    const sandbox = executor();
    const job = sandbox.execute(
      'return await tools.call("slow");',
      options({
        signal: abort.signal,
        call: async (_id, _args, signal) => {
          rpcSignal = signal;
          abort.abort();
          return new Promise(() => {});
        },
      }),
    );
    await expect(job).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(rpcSignal?.aborted).toBe(true);
    expect(await sandbox.execute('return 7;', options())).toBe(7);
  });

  it('does not claim completion when the program forgets to await an RPC', async () => {
    await expect(
      executor().execute('tools.call("slow"); return true;', options({ call: () => new Promise(() => {}) })),
    ).rejects.toMatchObject({ code: 'INVALID_CODE' });
  });

  it('pauses only the active deadline while awaiting approval, not the absolute deadline', async () => {
    const sandbox = new QuickJSExecutor(script, wasm, { activeMs: 80, wallMs: 250, cpuMs: 100 });
    await expect(
      sandbox.execute('return await new Promise(() => {});', options({ waitingForApproval: () => true })),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
});
