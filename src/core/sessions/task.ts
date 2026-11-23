import { redact } from '../security/redact';
import type { ContextSource, ToolDisplay, ToolStatus } from './model';

export interface TaskChange {
  path: string;
  diff: string;
  added: number;
  removed: number;
}

export interface TaskAction {
  id: string;
  tool: string;
  kind: 'edit' | 'terminal' | 'git' | 'mcp' | 'external';
  label: string;
  paths: string[];
  status: ToolStatus | 'running' | 'unknown';
  command?: string;
  cwd?: string;
  verification?: boolean;
  exitCode?: number | null;
  processIssue?: 'start-error' | 'timeout' | 'cancelled' | 'signal';
  error?: string;
}

export interface TaskState {
  status: 'running' | 'completed' | 'cancelled' | 'max_iterations' | 'error' | 'interrupted';
  actions: TaskAction[];
  changes: TaskChange[];
  context?: ContextSource[];
}

export function canResume(task: TaskState | undefined): task is TaskState {
  return !!task && task.status !== 'running' && task.status !== 'completed';
}

/** Recognize direct test runners conservatively. Shell composition can hide their actual exit status. */
export function isTestCommand(command: string): boolean {
  if (/[;&|\x60$<>(){}\r\n]/.test(command)) return false;
  return /^(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?=[:\s]|$)|(?:npx\s+)?(?:vitest|jest|pytest)(?=\s|$)|(?:python3?\s+-m\s+)(?:pytest|unittest)(?=\s|$)|(?:go|cargo|dotnet)\s+test(?=\s|$)|node\s+--test(?=\s|$))/i.test(
    command.trim(),
  );
}

export function testOutcome(action: TaskAction): 'passed' | 'failed' | 'inconclusive' | undefined {
  if (action.kind !== 'terminal' || !action.command || !isTestCommand(action.command)) return undefined;
  if (action.status === 'denied' || action.processIssue === 'start-error') return undefined;
  if (action.processIssue) return 'inconclusive';
  if (action.status === 'success' && action.exitCode === 0) return 'passed';
  if (action.status === 'error' && typeof action.exitCode === 'number' && action.exitCode !== 0)
    return 'failed';
  return 'inconclusive';
}

export function finishTaskAction(
  action: TaskAction,
  status: ToolStatus,
  content: string,
  display: ToolDisplay | undefined,
  secrets: readonly (string | undefined)[],
): TaskAction {
  const command = display?.kind === 'command' ? display : undefined;
  const processIssue = command?.startError
    ? 'start-error'
    : command?.timedOut
      ? 'timeout'
      : command?.cancelled
        ? 'cancelled'
        : command?.signal
          ? 'signal'
          : undefined;
  // A failed or cancelled external operation may already have changed state.
  const uncertain = status === 'cancelled' || (status === 'error' && action.kind !== 'edit' && !command);
  return {
    ...action,
    status: uncertain ? 'unknown' : status,
    ...(command ? { exitCode: command.exitCode, verification: command.verification, processIssue } : {}),
    ...(status !== 'success' ? { error: redact(content, secrets).slice(-1400) } : {}),
  };
}

export function taskFacts(task: TaskState): string {
  const files = [...new Set([...task.changes.map((f) => f.path), ...task.actions.flatMap((a) => a.paths)])];
  const actions = task.actions.slice(-24).map((a) => {
    const exit = typeof a.exitCode === 'number' ? `, exit ${a.exitCode}` : '';
    return `${a.tool} ${a.label} [${a.status}${exit}]${a.error ? ` — ${JSON.stringify(a.error.slice(0, 300))}` : ''}`;
  });
  return [
    `Status: ${task.status}`,
    files.length ? `Files: ${files.slice(0, 30).join(', ')}` : '',
    ...actions,
    'Next: inspect the current state of affected files and any uncertain effects before continuing with the original goal.',
  ]
    .filter(Boolean)
    .join('\n');
}
