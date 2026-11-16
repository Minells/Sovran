import { Worker } from 'node:worker_threads';
import {
  CODE_LIMITS,
  CodeModeError,
  type CodeSandboxPort,
  type CodeWorkerJob,
  type CodeWorkerReply,
  type SandboxOptions,
} from '../../core/codeMode/contracts';

/** One job per window. The host, not the worker or model, owns deadlines, quotas and cancellation. */
export class QuickJSExecutor implements CodeSandboxPort {
  private busy = false;
  constructor(
    private readonly script: string,
    private readonly wasmPath: string,
    private readonly limits: { activeMs: number; wallMs: number; cpuMs: number } = {
      activeMs: CODE_LIMITS.activeMs,
      wallMs: CODE_LIMITS.wallMs,
      cpuMs: CODE_LIMITS.cpuMs,
    },
  ) {}

  async execute(code: string, options: SandboxOptions): Promise<unknown> {
    if (this.busy) throw new CodeModeError('BUSY', 'Another Code Mode job is running in this window.');
    if (Buffer.byteLength(code) > CODE_LIMITS.codeBytes)
      throw new CodeModeError('LIMIT_EXCEEDED', 'Code exceeds 32 KiB.');
    if (options.signal.aborted) throw new CodeModeError('CANCELLED', 'Cancelled before execution.');
    this.busy = true;
    try {
      return await this.run(code, options);
    } finally {
      this.busy = false;
    }
  }

  private run(code: string, options: SandboxOptions): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const abort = new AbortController();
      const worker = new Worker(this.script, {
        workerData: {
          code,
          wasmPath: this.wasmPath,
          cpuMs: this.limits.cpuMs,
          maxOutputBytes: options.maxOutputBytes,
        } satisfies CodeWorkerJob,
        resourceLimits: { maxOldGenerationSizeMb: 128 },
        execArgv: [],
        env: {},
        stdout: true,
        stderr: true,
      });
      worker.stdout.resume();
      worker.stderr.resume();
      let settled = false;
      let active = 0;
      const started = performance.now();
      let previous = started;
      const ids = new Set<string>();
      const finish = (value: unknown, error?: Error) => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        options.signal.removeEventListener('abort', onAbort);
        abort.abort();
        void worker.terminate().then(() => (error ? reject(error) : resolve(value)), reject);
      };
      const fail = (code: string, message: string) => finish(undefined, new CodeModeError(code, message));
      const onAbort = () => fail('CANCELLED', 'Cancelled by the user.');
      const timer = setInterval(() => {
        const now = performance.now();
        if (!options.waitingForApproval?.()) active += now - previous;
        previous = now;
        if (now - started > this.limits.wallMs || active > this.limits.activeMs)
          fail('TIMEOUT', 'Code Mode reached its time limit.');
      }, 25);
      options.signal.addEventListener('abort', onAbort, { once: true });
      if (options.signal.aborted) return onAbort();
      worker.on('message', (value: unknown) => {
        if (settled) return;
        if (!value || typeof value !== 'object') return fail('INVALID_RPC', 'Invalid worker message.');
        const message = value as Record<string, unknown>;
        if (message.type === 'result' && typeof message.json === 'string') {
          if (ids.size && pending > 0) return fail('INVALID_CODE', 'Await every tool call before returning.');
          if (Buffer.byteLength(message.json) > options.maxOutputBytes)
            return fail('LIMIT_EXCEEDED', 'Result exceeds output budget.');
          try {
            finish(JSON.parse(message.json));
          } catch {
            fail('INVALID_RESULT', 'Result is not JSON.');
          }
        } else if (
          message.type === 'error' &&
          typeof message.code === 'string' &&
          typeof message.message === 'string'
        ) {
          fail(message.code.slice(0, 80), message.message.slice(0, 1000));
        } else if (
          message.type === 'call' &&
          typeof message.id === 'string' &&
          typeof message.tool === 'string' &&
          typeof message.argumentsJson === 'string'
        ) {
          const { id, tool, argumentsJson } = message;
          if (
            id.length > 12 ||
            tool.length > 64 ||
            ids.has(id) ||
            ids.size >= CODE_LIMITS.calls ||
            Buffer.byteLength(argumentsJson) > CODE_LIMITS.argumentBytes
          )
            return fail('LIMIT_EXCEEDED', 'Invalid or excessive RPC requests.');
          ids.add(id);
          let args: unknown;
          try {
            args = JSON.parse(argumentsJson);
          } catch {
            return fail('INVALID_RPC', 'Arguments must be JSON.');
          }
          pending++;
          void Promise.resolve()
            .then(() => options.call(tool, args, abort.signal))
            .then(
              (result) => ({ id, ok: true, json: JSON.stringify(result) }) satisfies CodeWorkerReply,
              (error: unknown) =>
                ({
                  id,
                  ok: false,
                  code: error instanceof CodeModeError ? error.code : 'MCP_ERROR',
                  message: error instanceof Error ? error.message.slice(0, 1000) : 'Tool failed.',
                }) satisfies CodeWorkerReply,
            )
            .then((reply) => {
              pending--;
              if (!settled) worker.postMessage(reply);
            })
            .catch(() => fail('INVALID_RESULT', 'Could not serialize RPC response.'));
        } else fail('INVALID_RPC', 'Unexpected worker message.');
      });
      let pending = 0;
      worker.once('error', (e) => fail('WORKER_ERROR', e.message));
      worker.once('exit', () => {
        if (!settled) fail('WORKER_ERROR', 'Worker stopped without a result.');
      });
    });
  }
}
