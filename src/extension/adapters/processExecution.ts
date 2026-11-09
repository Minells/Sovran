import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { FileProcessOptions, FileProcessResult, ProcessOptions } from '../../core/ports';
import { isInside } from '../../core/security/paths';

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
export const stripAnsi = (s: string) => s.replace(ANSI, '');

/** Keeps complete output until the budget is exceeded, then a head and rolling tail. */
export class OutputBuffer {
  private value = '';
  private tail = '';
  truncated = false;
  constructor(private readonly max: number) {}
  push(text: string) {
    if (!this.truncated && this.value.length + text.length <= this.max) {
      this.value += text;
      return;
    }
    const head = Math.floor(this.max * 0.6);
    const tail = this.max - head;
    if (!this.truncated) {
      const combined = this.value + text;
      this.value = combined.slice(0, head);
      this.tail = tail ? combined.slice(-tail) : '';
      this.truncated = true;
    } else this.tail = tail ? (this.tail + text).slice(-tail) : '';
  }
  toString() {
    return this.truncated ? `${this.value}\n[… output truncated …]\n${this.tail}` : this.value;
  }
}

function emptyResult(cancelled: boolean, message = ''): FileProcessResult {
  return {
    exitCode: null,
    signal: null,
    output: message,
    stdout: '',
    stderr: message,
    truncated: false,
    timedOut: false,
    cancelled,
    durationMs: 0,
  };
}

/** Shared lifecycle for shell commands and argv processes; no VS Code or UI dependency. */
export function runProcess(
  executable: string,
  argv: readonly string[],
  options: ProcessOptions,
  host: { shell?: string; env: NodeJS.ProcessEnv; onRawOutput?: (chunk: string) => void },
): Promise<FileProcessResult> {
  if (options.signal.aborted) return Promise.resolve(emptyResult(true));
  const started = Date.now();
  const isWin = process.platform === 'win32';
  return new Promise((resolve) => {
    const output = new OutputBuffer(options.maxOutputChars);
    const stdout = new OutputBuffer(options.maxOutputChars);
    const stderr = new OutputBuffer(options.maxOutputChars);
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let escalation: NodeJS.Timeout | undefined;
    const child = spawn(executable, [...argv], {
      cwd: options.cwd,
      shell: host.shell ?? false,
      detached: !isWin,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: host.env,
    });
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    const collect = (stream: 'stdout' | 'stderr', text: string) => {
      if (!text) return;
      (stream === 'stdout' ? stdout : stderr).push(text);
      host.onRawOutput?.(text);
      const clean = stripAnsi(text);
      output.push(clean);
      options.onOutput?.(clean);
    };
    const finish = (code: number | null, signal: string | null, error = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(escalation);
      options.signal.removeEventListener('abort', onAbort);
      for (const stream of ['stdout', 'stderr'] as const) collect(stream, decoders[stream].end());
      if (error) collect('stderr', error);
      resolve({
        exitCode: code,
        signal,
        output: output.toString(),
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        truncated: output.truncated || stdout.truncated || stderr.truncated,
        timedOut,
        cancelled,
        durationMs: Date.now() - started,
      });
    };
    const signalTree = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        if (isWin) {
          const root = process.env.SystemRoot ?? process.env.WINDIR;
          if (root)
            spawn(path.join(root, 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/T', '/F'], {
              windowsHide: true,
            }).on('error', () => child.kill());
          else child.kill();
        } else process.kill(-child.pid, signal);
      } catch {
        child.kill(signal);
      }
    };
    const stop = () => {
      signalTree('SIGTERM');
      if (escalation) return;
      escalation = setTimeout(() => {
        signalTree('SIGKILL');
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(child.exitCode, 'SIGKILL');
      }, 2000);
      escalation.unref();
    };
    const onAbort = () => {
      cancelled = true;
      stop();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    child.stdout?.on('data', (data: Buffer) => collect('stdout', decoders.stdout.write(data)));
    child.stderr?.on('data', (data: Buffer) => collect('stderr', decoders.stderr.write(data)));
    child.on('error', (error) => finish(null, null, `Failed to start command: ${error.message}`));
    child.on('close', (code, signal) => finish(code, signal));
    options.signal.addEventListener('abort', onAbort, { once: true });
    if (options.signal.aborted) onAbort();
  });
}

/** Avoid inherited Git redirection, loader/preload variables, secrets and relative executable searches. */
export function fileProcessEnvironment(
  base: NodeJS.ProcessEnv,
  overrides: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  const allowed = new Set([
    'PATH',
    'HOME',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'SYSTEMROOT',
    'WINDIR',
    'TMP',
    'TEMP',
    'TMPDIR',
  ]);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base))
    if (allowed.has(key.toUpperCase()) && value !== undefined) env[key] = value;
  // Windows treats environment keys case-insensitively. Do not retain a second Path alongside PATH.
  for (const [key, value] of Object.entries(overrides)) {
    for (const old of Object.keys(env)) if (old.toUpperCase() === key.toUpperCase()) delete env[old];
    env[key] = value;
  }
  return env;
}

async function resolveExecutable(
  executable: string,
  options: FileProcessOptions,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const roots = await Promise.all(
    [options.cwd, ...(options.disallowedExecutableRoots ?? [])].map(async (root) =>
      realpath(root).catch(() => path.resolve(root)),
    ),
  );
  const hostPath = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
  const candidates = path.isAbsolute(executable)
    ? [executable]
    : path.basename(executable) !== executable
      ? []
      : hostPath
          .split(path.delimiter)
          .filter((entry) => path.isAbsolute(entry))
          .flatMap((entry) => {
            const names =
              process.platform === 'win32' && !path.extname(executable)
                ? [`${executable}.exe`, `${executable}.com`]
                : [executable];
            return names.map((name) => path.join(entry, name));
          });
  for (const candidate of candidates) {
    const actual = await realpath(candidate).catch(() => undefined);
    if (!actual || roots.some((root) => isInside(root, actual))) continue;
    if (!(await stat(actual)).isFile()) continue;
    if (process.platform === 'win32' && !/\.(exe|com)$/i.test(actual)) continue;
    try {
      await access(actual, constants.X_OK);
      return actual;
    } catch {
      /* try the next trusted PATH entry */
    }
  }
  throw new Error(
    `Executable ${path.basename(executable)} was not found outside the workspace on the host PATH.`,
  );
}

export async function runFileProcess(
  executable: string,
  argv: readonly string[],
  options: FileProcessOptions,
): Promise<FileProcessResult> {
  if (options.signal.aborted) return emptyResult(true);
  try {
    const env = fileProcessEnvironment(process.env, options.env);
    const resolved = await resolveExecutable(executable, options, env);
    return runProcess(resolved, argv, options, { env });
  } catch (error) {
    return emptyResult(
      options.signal.aborted,
      `Failed to start command: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
