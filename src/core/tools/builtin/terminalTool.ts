import { z } from 'zod';
import { commandPathRisks, commandRiskHints } from '../../permissions/commands';
import { resolveAndVerify } from '../../security/paths';
import { ToolError, defineTool } from '../types';

interface TerminalState {
  cwd: string;
  cwdRelative: string;
}

export const executeTerminalTool = defineTool({
  name: 'execute_terminal',
  risk: 'execute',
  description:
    'Run a shell command in the workspace and return its output and exit code. The user approves every command. Avoid interactive or never-ending commands (watchers, dev servers).',
  schema: z.object({
    command: z.string().min(1).max(4000),
    cwd: z.string().optional().describe('Workspace-relative working directory (default: workspace root)'),
    timeout_seconds: z.number().int().min(1).max(3600).optional(),
  }),
  label: (a) => a.command,
  async prepare(a, ctx) {
    const resolved = await resolveAndVerify(a.cwd ?? '.', ctx.workspace);
    const stat = await ctx.workspace.stat(resolved.absolute);
    if (!stat || stat.type !== 'directory') throw new ToolError(`Working directory ${resolved.relative} does not exist.`);
    const state: TerminalState = { cwd: resolved.absolute, cwdRelative: resolved.relative };
    // Commands can read files the read tools protect, so the paths they name are checked too.
    const risks = commandPathRisks(a.command, {
      protectedPaths: ctx.settings.protectedPaths,
      roots: ctx.workspace.roots().map((r) => r.path),
    });
    const warnings = [...new Set([...commandRiskHints(a.command), ...risks])];
    return {
      paths: [],
      command: a.command,
      risks,
      state,
      approval: { kind: 'command', command: a.command, cwd: resolved.relative, warnings },
    };
  },
  async execute(a, ctx, prepared) {
    const { cwd, cwdRelative } = prepared.state as TerminalState;
    const timeoutMs = a.timeout_seconds ? a.timeout_seconds * 1000 : ctx.settings.terminalTimeoutMs;
    const r = await ctx.process.run(a.command, {
      cwd,
      timeoutMs,
      signal: ctx.signal,
      maxOutputChars: ctx.settings.maxToolResultChars,
      onOutput: ctx.onOutput,
    });
    const status = r.cancelled
      ? 'cancelled by the user'
      : r.timedOut
        ? `timed out after ${Math.round(timeoutMs / 1000)}s and was terminated`
        : `exit code ${r.exitCode ?? `signal ${r.signal ?? 'unknown'}`}`;
    const output = r.output.trim() || '(no output)';
    return {
      content: `$ ${a.command}\n[${status}${r.truncated ? ', output truncated' : ''}]\n${output}`,
      isError: r.cancelled || r.timedOut || (r.exitCode !== null && r.exitCode !== 0),
      summary: r.timedOut ? 'timed out' : r.cancelled ? 'cancelled' : `exit ${r.exitCode ?? '?'} · ${(r.durationMs / 1000).toFixed(1)}s`,
      display: { kind: 'command', command: a.command, cwd: cwdRelative, output: r.output, exitCode: r.exitCode, timedOut: r.timedOut },
    };
  },
});
