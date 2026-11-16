/** Untrusted JavaScript runs only in QuickJS. This Node worker owns no MCP connections or credentials. */
import { readFile } from 'node:fs/promises';
import { parentPort, workerData } from 'node:worker_threads';
import variant from '@jitl/quickjs-wasmfile-release-sync';
import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
  type QuickJSDeferredPromise,
} from 'quickjs-emscripten-core';
import {
  CODE_LIMITS,
  type CodeWorkerJob,
  type CodeWorkerMessage,
  type CodeWorkerReply,
} from '../../core/codeMode/contracts';

const port = parentPort!;
const job = workerData as CodeWorkerJob;
const send = (message: CodeWorkerMessage) => port.postMessage(message);

async function main() {
  const bytes = await readFile(job.wasmPath);
  const module = await newQuickJSWASMModuleFromVariant(
    newVariant(variant, {
      wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    }),
  );
  const runtime = module.newRuntime();
  runtime.setMemoryLimit(CODE_LIMITS.memoryBytes);
  runtime.setMaxStackSize(CODE_LIMITS.stackBytes);
  // No module loader is installed. Guest code never receives Node objects.
  let consumed = 0;
  let entered = performance.now();
  runtime.setInterruptHandler(() => consumed + performance.now() - entered > job.cpuMs);
  const context = runtime.newContext();
  const pending = new Map<string, QuickJSDeferredPromise>();
  let sequence = 0;
  let stopped = false;
  let scheduled = false;
  const errorText = (handle: Parameters<typeof context.dump>[0]) => {
    const value: unknown = context.dump(handle);
    return value && typeof value === 'object' && 'message' in value ? String(value.message) : String(value);
  };
  const rpc = context.newFunction('call', (tool, args) => {
    const name = context.getString(tool);
    const argumentsJson = context.getString(args);
    if (name.length > 64 || Buffer.byteLength(argumentsJson) > CODE_LIMITS.argumentBytes)
      throw new Error('LIMIT_EXCEEDED: RPC arguments are too large.');
    const promise = context.newPromise();
    const id = String(++sequence);
    pending.set(id, promise);
    send({ type: 'call', id, tool: name, argumentsJson });
    return promise.handle;
  });
  context.setProp(context.global, '__rpc', rpc);
  rpc.dispose();
  context
    .unwrapResult(
      context.evalCode(`(() => {
    const rpc = globalThis.__rpc;
    delete globalThis.__rpc;
    Object.defineProperty(globalThis, 'tools', { value: Object.freeze({
      call: (id, args = {}) => {
        if (typeof id !== 'string') throw new TypeError('toolId must be a string');
        return rpc(id, JSON.stringify(args)).then(JSON.parse);
      }
    }), writable: false, configurable: false });
  })()`),
    )
    .dispose();

  entered = performance.now();
  const evaluated = context.evalCode(
    `(async () => {
    const value = await (async () => {\n${job.code}\n})();
    const json = JSON.stringify(value);
    if (json === undefined) throw new TypeError('Return a JSON value.');
    return json;
  })()`,
    'sovran-code-mode.js',
  );
  consumed += performance.now() - entered;
  const root = context.unwrapResult(evaluated);
  const finish = () => {
    stopped = true;
    port.removeAllListeners('message');
    for (const promise of pending.values()) if (promise.alive) promise.dispose();
    pending.clear();
    root.dispose();
    context.dispose();
    runtime.dispose();
  };
  const complete = (message: CodeWorkerMessage) => {
    try {
      finish();
      send(message);
    } catch (error) {
      send({ type: 'error', code: 'CLEANUP_FAILED', message: String(error).slice(0, 1000) });
    }
  };
  const schedule = () => {
    if (stopped || scheduled) return;
    scheduled = true;
    setImmediate(pump);
  };
  const pump = () => {
    scheduled = false;
    if (stopped) return;
    try {
      entered = performance.now();
      const jobs = runtime.executePendingJobs(64);
      consumed += performance.now() - entered;
      if (jobs.error) {
        const message = errorText(jobs.error);
        jobs.error.dispose();
        throw new Error(message);
      }
      jobs.dispose();
      const state = context.getPromiseState(root);
      if (state.type === 'fulfilled') {
        const json = context.getString(state.value);
        state.value.dispose();
        if (Buffer.byteLength(json) > job.maxOutputBytes) {
          complete({
            type: 'error',
            code: 'LIMIT_EXCEEDED',
            message: 'Result is too large. Return counts or a smaller sample.',
          });
        } else complete({ type: 'result', json });
      } else if (state.type === 'rejected') {
        const message = errorText(state.error);
        state.error.dispose();
        complete({
          type: 'error',
          code: consumed >= job.cpuMs ? 'TIMEOUT' : 'INVALID_CODE',
          message: message.slice(0, 1000),
        });
      } else if (runtime.hasPendingJob()) schedule();
    } catch (e) {
      complete({ type: 'error', code: 'INVALID_CODE', message: String(e).slice(0, 1000) });
    }
  };
  port.on('message', (reply: CodeWorkerReply) => {
    const promise = pending.get(reply.id);
    if (!promise || stopped) return;
    pending.delete(reply.id);
    const value = context.newString(reply.ok ? reply.json : `${reply.code}: ${reply.message}`);
    if (reply.ok) promise.resolve(value);
    else promise.reject(value);
    value.dispose();
    promise.dispose();
    schedule();
  });
  schedule();
}

void main().catch((e: unknown) =>
  send({ type: 'error', code: 'INVALID_CODE', message: String(e).slice(0, 1000) }),
);
