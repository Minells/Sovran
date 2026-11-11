import picomatch from 'picomatch';
import { commandGuardrails, matchesAllowList } from './commands';

export type AgentMode = 'plan' | 'act';
export type ToolRisk = 'read' | 'write' | 'execute';

/**
 * How much Act mode may do without asking.
 * - `ask`: every file change and command waits for approval (the default).
 * - `edits`: file changes are applied without asking; commands still ask.
 * - `auto`: file changes and commands run without asking, except what the guardrails catch.
 *
 * In every mode, protected paths and high-risk commands still ask, Plan mode stays read-only and
 * untrusted workspaces cannot change anything.
 */
export type ApprovalMode = 'ask' | 'edits' | 'auto';

export const APPROVAL_MODES: readonly ApprovalMode[] = ['ask', 'edits', 'auto'];

export interface PolicySettings {
  approvalMode: ApprovalMode;
  /** Native tool overrides, read only from user settings. MCP keeps its own Off / Ask / Allow policy. */
  disabledTools?: readonly string[];
  forceAskTools?: readonly string[];
  allowedCommands: readonly string[];
  protectedPaths: readonly string[];
}

export interface SessionGrants {
  edits: boolean;
}

export interface PolicyInput {
  toolName?: string;
  risk: ToolRisk;
  mode: AgentMode;
  workspaceTrusted: boolean;
  /** Workspace-relative paths touched by the action. */
  paths: readonly string[];
  command?: string;
  /** Context-dependent reasons that require confirmation (e.g. a command that names a protected file). */
  risks?: readonly string[];
  /**
   * A tool of an MCP server. It acts outside the workspace (another program or service), where no guardrail can see
   * what it does and no checkpoint can undo it, so it asks in every approval mode unless the user allowed that tool.
   */
  mcp?: { server: string; allowed: boolean };
  /** An explicit public Web read; always asks, also in Plan/Auto. */
  network?: { url: string };
  settings: PolicySettings;
  grants: SessionGrants;
}

export type PolicyDecision = { action: 'allow' | 'ask' | 'deny'; reason: string };

export function isProtectedPath(relativePath: string, patterns: readonly string[]): boolean {
  if (patterns.length === 0) return false;
  return picomatch.isMatch(relativePath, patterns as string[], { dot: true, nocase: true });
}

const MODE_LABEL: Record<Exclude<ApprovalMode, 'ask'>, string> = { edits: 'Auto-edit mode', auto: 'Auto mode' };

/**
 * The single authority on whether a tool action may run. Enforced by the tool runtime,
 * independent of anything the model was told in the prompt.
 */
export function decide(input: PolicyInput): PolicyDecision {
  const { risk, mode, settings } = input;
  const protectedHit = input.paths.find((p) => isProtectedPath(p, settings.protectedPaths));

  if (risk !== 'read' && mode === 'plan') {
    return { action: 'deny', reason: 'Plan mode is read-only. Switch to Act mode to make changes.' };
  }
  if (risk !== 'read' && !input.workspaceTrusted) {
    return { action: 'deny', reason: 'This workspace is in Restricted Mode. Trust the workspace to allow changes.' };
  }
  if (input.network && !input.workspaceTrusted)
    return { action: 'deny', reason: 'Trust the workspace before accessing the public Web.' };

  if (!input.mcp && input.toolName && settings.disabledTools?.includes(input.toolName)) {
    return { action: 'deny', reason: `${input.toolName} is disabled in Sovran's tool settings.` };
  }
  if (!input.mcp && input.toolName && settings.forceAskTools?.includes(input.toolName)) {
    return { action: 'ask', reason: `You chose to always review ${input.toolName}.` };
  }
  if (input.network) return { action: 'ask', reason: 'Public Web access requires approval for each URL.' };

  switch (risk) {
    case 'read':
      return protectedHit
        ? { action: 'ask', reason: `${protectedHit} is a protected path.` }
        : { action: 'allow', reason: 'Read-only access inside the workspace.' };
    case 'write':
      if (protectedHit) return { action: 'ask', reason: `${protectedHit} is a protected path, so Sovran always asks before changing it.` };
      if (settings.approvalMode !== 'ask') return { action: 'allow', reason: `Applied without asking (${MODE_LABEL[settings.approvalMode]}).` };
      if (input.grants.edits) return { action: 'allow', reason: 'Applied without asking (allowed for this chat).' };
      return { action: 'ask', reason: 'File edits require approval.' };
    case 'execute': {
      if (input.mcp) {
        return input.mcp.allowed
          ? { action: 'allow', reason: `Ran without asking (you allowed this tool of ${input.mcp.server}).` }
          : { action: 'ask', reason: 'Tools of MCP servers ask before they run, in every approval mode, until you allow them.' };
      }
      // Guardrails win over the allow-list and over Auto mode: these commands always need a human.
      const guardrails = [...commandGuardrails(input.command ?? ''), ...(input.risks ?? [])];
      if (guardrails.length) return { action: 'ask', reason: guardrails[0]! };
      if (input.command && matchesAllowList(input.command, settings.allowedCommands)) {
        return { action: 'allow', reason: 'Ran without asking (in your allowed commands).' };
      }
      if (settings.approvalMode === 'auto') return { action: 'allow', reason: `Ran without asking (${MODE_LABEL.auto}).` };
      return { action: 'ask', reason: 'Terminal commands require approval.' };
    }
  }
}
