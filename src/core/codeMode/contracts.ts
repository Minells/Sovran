/** Limits belong to trusted host code; programs cannot increase them. */
export const CODE_LIMITS = Object.freeze({
  codeBytes: 32 * 1024,
  memoryBytes: 64 * 1024 * 1024,
  stackBytes: 512 * 1024,
  cpuMs: 5000,
  activeMs: 120_000,
  wallMs: 300_000,
  calls: 64,
  runCalls: 128,
  executions: 3,
  discoveries: 8,
  concurrency: 4,
  perServer: 2,
  queue: 16,
  argumentBytes: 64 * 1024,
  responseBytes: 2 * 1024 * 1024,
  totalResponseBytes: 20 * 1024 * 1024,
  outputBytes: 16 * 1024,
});

export class CodeModeError extends Error {
  override name = 'CodeModeError';
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function jsonBytes(value: unknown): number {
  const text = JSON.stringify(value);
  if (text === undefined) throw new CodeModeError('INVALID_RESULT', 'Return a JSON value.');
  return new TextEncoder().encode(text).byteLength;
}

export interface CodeCallResult {
  data?: unknown;
  text?: string;
  contentTypes: string[];
}

export interface CodeCallTrace {
  id: string;
  tool: string;
  server: string;
  status:
    'queued' | 'awaiting_approval' | 'running' | 'success' | 'error' | 'denied' | 'cancelled' | 'unknown';
  durationMs: number;
  responseBytes?: number;
}

export interface SandboxOptions {
  signal: AbortSignal;
  maxOutputBytes: number;
  call(toolId: string, args: unknown, signal: AbortSignal): Promise<CodeCallResult>;
  /** Pause the active timer only when all work is waiting for a human. Absolute deadline never pauses. */
  waitingForApproval?: () => boolean;
}

export interface CodeSandboxPort {
  execute(code: string, options: SandboxOptions): Promise<unknown>;
}

export interface CodeWorkerJob {
  code: string;
  wasmPath: string;
  cpuMs: number;
  maxOutputBytes: number;
}

export type CodeWorkerMessage =
  | { type: 'call'; id: string; tool: string; argumentsJson: string }
  | { type: 'result'; json: string }
  | { type: 'error'; code: string; message: string };

export type CodeWorkerReply =
  { id: string; ok: true; json: string } | { id: string; ok: false; code: string; message: string };

export const CODE_TOOL_NAMES = ['code_search', 'code_describe', 'execute_code'] as const;
