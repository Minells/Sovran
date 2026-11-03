import picomatch from 'picomatch';
import { matchesAllowList } from './commands';

export type AgentMode = 'plan' | 'act';
export type ToolRisk = 'read' | 'write' | 'execute';

export interface PolicySettings {
  fileEdits: 'ask' | 'auto';
  allowedCommands: readonly string[];
  protectedPaths: readonly string[];
}

export interface SessionGrants {
  edits: boolean;
}

export interface PolicyInput {
  risk: ToolRisk;
  mode: AgentMode;
  workspaceTrusted: boolean;
  /** Workspace-relative paths touched by the action. */
  paths: readonly string[];
  command?: string;
  settings: PolicySettings;
  grants: SessionGrants;
}

export type PolicyDecision = { action: 'allow' | 'ask' | 'deny'; reason: string };

export function isProtectedPath(relativePath: string, patterns: readonly string[]): boolean {
  if (patterns.length === 0) return false;
  return picomatch.isMatch(relativePath, patterns as string[], { dot: true, nocase: true });
}

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

  switch (risk) {
    case 'read':
      return protectedHit
        ? { action: 'ask', reason: `${protectedHit} is a protected path.` }
        : { action: 'allow', reason: 'Read-only access inside the workspace.' };
    case 'write':
      if (protectedHit) return { action: 'ask', reason: `${protectedHit} is a protected path.` };
      if (settings.fileEdits === 'auto') return { action: 'allow', reason: 'File edits are auto-approved in settings.' };
      if (input.grants.edits) return { action: 'allow', reason: 'File edits were allowed for this session.' };
      return { action: 'ask', reason: 'File edits require approval.' };
    case 'execute':
      if (input.command && matchesAllowList(input.command, settings.allowedCommands)) {
        return { action: 'allow', reason: 'The command is in the allow-list.' };
      }
      return { action: 'ask', reason: 'Terminal commands require approval.' };
  }
}
