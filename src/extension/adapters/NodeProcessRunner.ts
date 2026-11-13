import * as vscode from 'vscode';
import type { FileProcessOptions, ProcessOptions, ProcessPort, ProcessResult } from '../../core/ports';
import { agentCommandEnv } from './commandEnv';
import { shellPath } from './VscodeWorkspace';

export { OutputBuffer, stripAnsi } from './processExecution';
import { runFileProcess, runProcess } from './processExecution';

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
  constructor(
    private readonly mirror?: () => TerminalMirror | undefined,
    /** Read for every command: whether credential-like variables are removed from its environment. */
    private readonly hideSecretVariables: () => boolean = () => false,
  ) {}

  run(command: string, options: ProcessOptions): Promise<ProcessResult> {
    const mirror = this.mirror?.();
    if (!options.signal.aborted) mirror?.begin(command, options.cwd);
    return runProcess(command, [], options, {
      shell: shellPath(),
      env: agentCommandEnv(process.env, this.hideSecretVariables()),
      onRawOutput: (chunk) => mirror?.write(chunk),
    }).then((result) => {
      mirror?.end(result);
      return result;
    });
  }

  runFile(executable: string, argv: readonly string[], options: FileProcessOptions) {
    // Reads such as Git diff must be filtered by the core before reaching any UI or streaming output.
    return runFileProcess(executable, argv, options);
  }
}
