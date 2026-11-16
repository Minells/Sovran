/** Shared authorization pipeline for direct tool calls and Code Mode child calls. No transcript side effects. */
import { commandPathRisks } from '../permissions/commands';
import { decide, type AgentMode, type PolicySettings, type SessionGrants } from '../permissions/policy';
import type { ApprovalPort, Logger, ProcessPort, WorkspacePort } from '../ports';
import type { DocumentReader } from '../documents/reader';
import type { WebFetchPort } from '../web/types';
import type { ToolRegistry } from './registry';
import type { ToolCall, ToolMessage, ToolStatus } from '../sessions/model';
import type { AgentEvent } from '../agent/events';
import { parseJsonLenient } from '../agent/promptedTools';
import { PathError } from '../security/paths';
import { ToolError, type AnyTool, type ToolContext, type ToolSettings, type ToolResult } from './types';

export type ToolResultFactory = (
  status: ToolStatus,
  content: string,
  extra?: Partial<ToolMessage>,
) => ToolMessage;
export interface ExecutionServices {
  registry: ToolRegistry;
  workspace: WorkspacePort;
  process: ProcessPort;
  approvals: ApprovalPort;
  logger: Logger;
  documents?: DocumentReader;
  web?: WebFetchPort;
  newId(): string;
}
export interface ExecutionOptions {
  captureMcpResult?: boolean;
  /** Additional host-owned capability check, repeated wherever normal availability is checked. */
  authorize?: () => string | undefined;
  mode: AgentMode;
  signal: AbortSignal;
  settings: { policy: PolicySettings };
  session: { excludedToolGroups?: readonly string[] };
  policy?: () => PolicySettings;
  grants: SessionGrants;
  emit(event: AgentEvent): void;
}

export async function executeAuthorizedTool(
  tool: AnyTool,
  call: ToolCall,
  o: ExecutionOptions,
  deps: ExecutionServices,
  settings: ToolSettings,
  result: ToolResultFactory,
  onResult?: (value: ToolResult) => void,
  onApproval?: (waiting: boolean) => void,
): Promise<ToolMessage> {
  const unavailable = () =>
    deps.registry.unavailable(tool, o.mode, {
      ...(o.policy?.() ?? o.settings.policy),
      excludedToolGroups: o.session.excludedToolGroups,
      workspaceTrusted: deps.workspace.isTrusted(),
    }) ?? o.authorize?.();
  const unavailableReason = unavailable();
  if (unavailableReason) return result('denied', unavailableReason);
  if (o.signal.aborted) return result('cancelled', 'Cancelled by the user.');

  const parsedJson = parseJsonLenient(call.arguments);
  if (!parsedJson.ok)
    return result('error', `Arguments for ${tool.name} are not valid JSON: ${parsedJson.error}`);
  const parsed = tool.schema.safeParse(parsedJson.value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    return result('error', `Invalid arguments for ${tool.name}: ${issues}`);
  }
  const args = parsed.data;
  const label = safeLabel(() => tool.label(args), call.name);

  const ctx: ToolContext = {
    workspace: deps.workspace,
    process: deps.process,
    signal: o.signal,
    captureMcpResult: o.captureMcpResult,
    settings: { ...settings, protectedPaths: (o.policy?.() ?? o.settings.policy).protectedPaths },
    onOutput: (chunk) => o.emit({ type: 'tool_output', callId: call.id, chunk }),
    ...(deps.documents ? { documents: deps.documents } : {}),
    ...(deps.web ? { web: deps.web } : {}),
  };

  let prepared;
  try {
    prepared = tool.prepare ? await tool.prepare(args, ctx) : { paths: [] };
  } catch (e) {
    return result('error', describeToolFailure(e), { summary: label });
  }

  if (o.signal.aborted) return result('cancelled', 'Cancelled by the user.', { summary: label });
  const preparedUnavailable = unavailable();
  if (preparedUnavailable) return result('denied', preparedUnavailable, { summary: label });

  const evaluate = (policy = o.policy?.() ?? o.settings.policy) => {
    const mcp = tool.mcpPolicy?.() ?? prepared.mcp;
    const commandRisks =
      !mcp && prepared.command
        ? commandPathRisks(prepared.command, {
            protectedPaths: policy.protectedPaths,
            roots: deps.workspace.roots().map((r) => r.path),
          })
        : [];
    return decide({
      toolName: tool.name,
      risk: tool.risk,
      mode: o.mode,
      workspaceTrusted: deps.workspace.isTrusted(),
      paths: prepared.paths,
      command: prepared.command,
      risks: [...(prepared.risks ?? []), ...commandRisks],
      mcp,
      network: prepared.network,
      settings: policy,
      grants: o.grants,
    });
  };
  const decision = evaluate();
  if (decision.action === 'deny') return result('denied', decision.reason, { summary: label });
  // Changes made without a human decision are labelled, so the transcript shows what ran unattended.
  let approvedReason: string | undefined;

  if (decision.action === 'ask') {
    o.emit({ type: 'tool_phase', callId: call.id, toolName: tool.name, label, phase: 'awaiting_approval' });
    const detail = prepared.approval ?? {
      kind: 'read' as const,
      path: prepared.paths[0] ?? label,
      reason: decision.reason,
    };
    let response;
    try {
      onApproval?.(true);
      response = await deps.approvals.request(
        {
          id: deps.newId(),
          callId: call.id,
          toolName: tool.name,
          title: label,
          detail,
          reason: decision.reason,
        },
        o.signal,
      );
    } catch {
      return result('cancelled', 'The run was cancelled while waiting for approval.', { summary: label });
    } finally {
      onApproval?.(false);
    }
    if (o.signal.aborted)
      return result('cancelled', 'The run was cancelled while waiting for approval.', { summary: label });
    if (!response.approved) {
      const feedback = response.feedback?.trim() ? ` User feedback: ${response.feedback.trim()}` : '';
      return result('denied', `The user rejected this action.${feedback}`, { summary: label });
    }
    approvedReason = decision.reason;
    if (response.grant === 'session-edits') o.grants.edits = true;
  }

  o.emit({ type: 'tool_phase', callId: call.id, toolName: tool.name, label, phase: 'running' });
  // No await between this final check and dispatch. UI event listeners may also change policy or cancel.
  if (o.signal.aborted) return result('cancelled', 'Cancelled by the user.', { summary: label });
  const finalUnavailable = unavailable();
  if (finalUnavailable) return result('denied', finalUnavailable, { summary: label });
  const finalDecision = evaluate();
  if (finalDecision.action === 'deny') return result('denied', finalDecision.reason, { summary: label });
  if (finalDecision.action === 'ask' && approvedReason !== finalDecision.reason) {
    return result('denied', 'Permissions changed before execution. Request this action again for approval.', {
      summary: label,
    });
  }
  ctx.settings = { ...ctx.settings, protectedPaths: (o.policy?.() ?? o.settings.policy).protectedPaths };
  const audit =
    !approvedReason && finalDecision.action === 'allow' && tool.risk !== 'read'
      ? { autoApproved: finalDecision.reason }
      : {};
  ctx.revalidate = () => {
    if (o.signal.aborted) throw new ToolError('Cancelled by the user.');
    const unavailableReason = unavailable();
    if (unavailableReason) throw new ToolError(unavailableReason);
    const policy = o.policy?.() ?? o.settings.policy;
    const current = evaluate(policy);
    if (current.action === 'deny') throw new ToolError(current.reason);
    if (current.action === 'ask' && current.reason !== approvedReason) {
      throw new ToolError('Permissions changed before execution. Request this action again for approval.');
    }
    ctx.settings.protectedPaths = policy.protectedPaths;
  };
  try {
    const r = await tool.execute(args, ctx, prepared);
    onResult?.(r);
    if (o.signal.aborted && tool.risk !== 'write') {
      return result('cancelled', r.content || 'Cancelled.', {
        summary: r.summary ?? label,
        display: r.display,
        ...audit,
      });
    }
    return result(r.isError ? 'error' : 'success', r.content, {
      summary: r.summary ?? label,
      display: r.display,
      ...audit,
    });
  } catch (e) {
    if (o.signal.aborted) return result('cancelled', 'Cancelled by the user.', { summary: label });
    deps.logger.warn(`Tool ${tool.name} failed: ${e instanceof Error ? e.message : String(e)}`);
    return result('error', describeToolFailure(e), { summary: label });
  }
}

function describeToolFailure(e: unknown): string {
  if (e instanceof ToolError || e instanceof PathError) return e.message;
  return `The tool failed unexpectedly: ${e instanceof Error ? e.message : String(e)}`;
}

function safeLabel(fn: () => string, fallback: string): string {
  try {
    return fn() || fallback;
  } catch {
    return fallback;
  }
}
