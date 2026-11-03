import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import type { ProcessPort, ProcessResult } from '../../core/ports';
import { agentCommandEnv } from './commandEnv';
import { shellPath } from './VscodeWorkspace';

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
export const stripAnsi = (s: string) => s.replace(ANSI, '');

/** Keeps the head and a rolling tail of command output within a character budget. */
export class OutputBuffer {
  private head = '';
  private tail = '';
  truncated = false;
  constructor(private readonly max: number) {}
  push(text: string) {
    const headMax = Math.floor(this.max * 0.6);
    if (!this.truncated && this.head.length + text.length <= headMax) {
      this.head += text;
      return;
    }
    if (!this.truncated) {
      const room = headMax - this.head.length;
      this.head += text.slice(0, Math.max(0, room));
      text = text.slice(Math.max(0, room));
      this.truncated = true;
    }
    this.tail = (this.tail + text).slice(-(this.max - headMax));
  }
  toString() {
    return this.truncated ? `${this.head}\n[… output truncated …]\n${this.tail}` : this.head;
  }
}

/** Mirrors agent command output into a read-only "Sovran" terminal so users see it natively. */
export class TerminalMirror implements vscode.Disposable {
  private terminal: vscode.Terminal | undefined;
  private readonly writer = new vscode.EventEmitter<string>();
  private opened = false;
  private pending: string[] = [];

  private ensure(): vscode.Terminal {
    if (this.terminal && this.terminal.exitStatus === undefined) return this.terminal;
    this.opened = false;
    const pty: vscode.Pseudoterminal = {
      onDidWrite: this.writer.event,
      open: () => {
        this.opened = true;
        for (const p of this.pending.splice(0)) this.writer.fire(p);
      },
      close: () => {
        this.terminal = undefined;
      },
    };
    this.terminal = vscode.window.createTerminal({ name: 'Sovran', pty, iconPath: new vscode.ThemeIcon('terminal'), isTransient: true });
    return this.terminal;
  }

  write(text: string) {
    const data = text.replace(/\r?\n/g, '\r\n');
    if (this.opened) this.writer.fire(data);
    else this.pending.push(data);
  }

  begin(command: string, cwd: string) {
    this.ensure().show(true);
    // Never let a model-supplied command inject terminal escape sequences into the header line.
    // eslint-disable-next-line no-control-regex
    const safe = command.replace(/[\u0000-\u001F\u007F]/g, ' ');
    this.write(`\r\n\x1b[2m${cwd}\x1b[0m\r\n\x1b[1m$ ${safe}\x1b[0m\r\n`);
  }

  end(result: ProcessResult) {
    const status = result.cancelled ? 'cancelled' : result.timedOut ? 'timed out' : `exit ${result.exitCode ?? result.signal}`;
    this.write(`\x1b[2m[${status} · ${(result.durationMs / 1000).toFixed(1)}s]\x1b[0m\r\n`);
  }

  dispose() {
    this.terminal?.dispose();
    this.writer.dispose();
  }
}

/**
 * Runs commands with child_process (reliable exit codes and output on every platform), never
 * attached to stdin, with timeout, cancellation and process-tree termination.
 */
export class NodeProcessRunner implements ProcessPort {
  constructor(private readonly mirror?: () => TerminalMirror | undefined) {}

  run(
    command: string,
    o: { cwd: string; timeoutMs: number; signal: AbortSignal; maxOutputChars: number; onOutput?: (chunk: string) => void },
  ): Promise<ProcessResult> {
    const started = Date.now();
    const mirror = this.mirror?.();
    mirror?.begin(command, o.cwd);
    const isWin = process.platform === 'win32';

    return new Promise<ProcessResult>((resolve) => {
      const out = new OutputBuffer(o.maxOutputChars);
      let timedOut = false;
      let cancelled = false;
      let settled = false;

      const child = spawn(command, {
        cwd: o.cwd,
        shell: shellPath(),
        detached: !isWin,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: agentCommandEnv(process.env),
      });

      const killTree = () => {
        if (child.pid === undefined || child.exitCode !== null) return;
        try {
          if (isWin) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
          else process.kill(-child.pid, 'SIGTERM');
        } catch {
          child.kill('SIGTERM');
        }
        setTimeout(() => {
          try {
            if (!isWin && child.pid !== undefined && child.exitCode === null) process.kill(-child.pid, 'SIGKILL');
          } catch {
            /* already gone */
          }
        }, 2000).unref();
      };

      const onData = (buf: Buffer) => {
        const raw = buf.toString('utf8');
        mirror?.write(raw);
        const clean = stripAnsi(raw);
        out.push(clean);
        o.onOutput?.(clean);
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);

      const timer = setTimeout(() => {
        timedOut = true;
        killTree();
      }, o.timeoutMs);
      const onAbort = () => {
        cancelled = true;
        killTree();
      };
      if (o.signal.aborted) onAbort();
      o.signal.addEventListener('abort', onAbort, { once: true });

      const finish = (exitCode: number | null, signal: string | null, extra = '') => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        o.signal.removeEventListener('abort', onAbort);
        if (extra) out.push(extra);
        const result: ProcessResult = {
          exitCode,
          signal,
          output: out.toString(),
          truncated: out.truncated,
          timedOut,
          cancelled,
          durationMs: Date.now() - started,
        };
        mirror?.end(result);
        resolve(result);
      };
      child.on('error', (e) => finish(null, null, `Failed to start command: ${e.message}`));
      child.on('close', (code, sig) => finish(code, sig));
    });
  }
}
