import { randomUUID } from 'node:crypto';
import { planCompaction, renderForSummary, summarize } from '../context/compaction';
import type { DocumentReader } from '../documents/reader';
import { buildContext, estimateTokens } from '../context/contextManager';
import { commandPathRisks } from '../permissions/commands';
import { decide, type AgentMode, type PolicySettings, type SessionGrants } from '../permissions/policy';
import type { ApprovalPort, Logger, ProcessPort, WorkspacePort } from '../ports';
import {
  capabilityKey,
  resolveToolMode,
  resolveVision,
  type CapabilityStore,
} from '../providers/capabilities';
import { effectiveLimits } from '../providers/limits';
import { ProviderError, errorFromException } from '../providers/errors';
import type { ChatProvider, ModelConfig, ResolvedToolMode } from '../providers/types';
import { PathError } from '../security/paths';
import { redact } from '../security/redact';
import {
  messagesForModel,
  type AssistantMessage,
  type ErrorInfo,
  type Session,
  type ToolCall,
  type ToolMessage,
  type ToolStatus,
} from '../sessions/model';
import { truncateMiddle } from '../tools/edits';
import type { ToolRegistry } from '../tools/registry';
import { ToolError, type AnyTool, type ToolContext, type ToolSettings } from '../tools/types';
import type { AgentEvent, RunOutcome } from './events';
import { parseJsonLenient, parseToolCallBlock } from './promptedTools';
import { buildSystemPrompt } from './systemPrompt';
import type { WebFetchPort } from '../web/types';
import { TaggedStreamParser } from './taggedStream';

const defaultsOf = (s: Pick<AgentSettings, 'defaultContextWindow' | 'defaultMaxOutputTokens'>) => ({
  contextWindow: s.defaultContextWindow,
  maxOutputTokens: s.defaultMaxOutputTokens,
});

export interface AgentSettings {
  maxIterations: number;
  policy: PolicySettings;
  tools: ToolSettings;
  defaultContextWindow: number;
  defaultMaxOutputTokens: number;
}

export interface AgentDeps {
  provider: ChatProvider;
  registry: ToolRegistry;
  workspace: WorkspacePort;
  process: ProcessPort;
  approvals: ApprovalPort;
  capabilities: CapabilityStore;
  logger: Logger;
  /** Lets `read_file` read PDF, Office and OpenDocument files (see ToolContext.documents). */
  documents?: DocumentReader;
  web?: WebFetchPort;
  newId?: () => string;
  now?: () => number;
}

export interface RunOptions {
  session: Session;
  providerId: string;
  model: ModelConfig;
  mode: AgentMode;
  settings: AgentSettings;
  grants: SessionGrants;
  signal: AbortSignal;
  emit: (event: AgentEvent) => void;
  projectInstructions?: string;
  /** Secrets to scrub from any error text (e.g. the provider API key). */
  secrets?: readonly (string | undefined)[];
  /** Summarize older turns instead of dropping them when the context window is full. */
  autoCompact?: boolean;
  /**
   * The current permission policy, read before every action so that changes made during a run (switching the
   * approval mode, "always allow" on a command) apply to the next action. Defaults to `settings.policy`.
   */
  policy?: () => PolicySettings;
  /** Data URLs of the images in the chat's messages, by image id (see `UserMessage.images`). */
  images?: ReadonlyMap<string, string>;
}

export type CompactOptions = Pick<
  RunOptions,
  'session' | 'model' | 'settings' | 'signal' | 'emit' | 'secrets'
>;

interface TurnResult {
  text: string;
  reasoning: string;
  calls: ToolCall[];
}

const LOOP_GUARD_LIMIT = 3;

/**
 * The agent loop: context → model → tool calls → validation → policy → approval → execution → repeat.
 * Pure orchestration over ports; owns no I/O of its own.
 */
export class AgentRunner {
  private readonly newId: () => string;
  private readonly now: () => number;

  constructor(private readonly deps: AgentDeps) {
    this.newId = deps.newId ?? (() => randomUUID());
    this.now = deps.now ?? (() => Date.now());
  }

  async run(o: RunOptions): Promise<RunOutcome> {
    const key = capabilityKey(o.providerId, o.model.id);
    const failures = new Map<string, number>();
    let downgraded = false;
    let visionRefused = false;
    let compactedThisRun = false;
    let iteration = 0;

    const latest = [...o.session.messages].reverse().find((m) => m.role === 'user');
    if (
      latest?.role === 'user' &&
      latest.images?.length &&
      !resolveVision(o.model.vision, this.deps.capabilities.get(key))
    ) {
      o.emit({
        type: 'notice',
        level: 'info',
        message: `${o.model.name ?? o.model.id} does not accept images, so it receives only their names. Choose a vision model to show it the images.`,
      });
    }

    while (iteration < o.settings.maxIterations) {
      if (o.signal.aborted) return { reason: 'cancelled' };
      iteration++;
      const toolMode = resolveToolMode(o.model.toolMode, this.deps.capabilities.get(key));
      // A refusal in this run counts at once, whether or not the capability store kept it.
      const vision = !visionRefused && resolveVision(o.model.vision, this.deps.capabilities.get(key));
      o.emit({ type: 'iteration', iteration, maxIterations: o.settings.maxIterations });

      const assistant: AssistantMessage = {
        role: 'assistant',
        id: this.newId(),
        content: '',
        streaming: true,
        model: { providerId: o.providerId, modelId: o.model.id },
        createdAt: this.now(),
      };

      let turn: TurnResult;
      let offered: ReadonlyMap<string, AnyTool>;
      try {
        let built = this.buildRequest(o, toolMode, vision);
        if (built.droppedTurns > 0 && o.autoCompact && !compactedThisRun) {
          compactedThisRun = true;
          if (await this.compact(o)) built = this.buildRequest(o, toolMode, vision);
          if (o.signal.aborted) return { reason: 'cancelled' };
        }
        if (built.droppedTurns > 0) {
          o.emit({
            type: 'notice',
            level: 'info',
            message: `Context window is full: ${built.droppedTurns} earlier exchange(s) are no longer sent to the model.`,
          });
        }
        o.emit({
          type: 'context',
          estimatedTokens: built.estimatedTokens,
          budgetTokens: built.budgetTokens,
          contextWindow: built.contextWindow,
        });
        const request = built.request;
        offered = built.offered;
        o.session.messages.push(assistant);
        o.emit({ type: 'message_started', message: { ...assistant } });
        turn = await this.streamTurn(assistant, request, toolMode, o);
      } catch (e) {
        const err =
          e instanceof ProviderError ? e : errorFromException(e, { url: o.providerId, secrets: o.secrets });
        // Like tools: an unconfigured model that refuses images is remembered as text-only, and the step is retried
        // with each image's name in its place. A model configured with `vision: true` reports the error instead.
        if (err.kind === 'vision_unsupported' && vision && o.model.vision === undefined && !visionRefused) {
          visionRefused = true;
          this.deps.capabilities.set(key, {
            ...this.deps.capabilities.get(key),
            vision: false,
            updatedAt: this.now(),
          });
          this.removeMessage(o, assistant.id);
          o.emit({
            type: 'notice',
            level: 'info',
            message: `${o.model.name ?? o.model.id} does not accept images. Sovran sent their names instead and retried; it will not send images to this model again.`,
          });
          iteration--;
          continue;
        }
        if (
          err.kind === 'tools_unsupported' &&
          toolMode === 'native' &&
          (o.model.toolMode ?? 'auto') === 'auto' &&
          !downgraded
        ) {
          downgraded = true;
          // Merge: the same record also holds the limits the server reported.
          this.deps.capabilities.set(key, {
            ...this.deps.capabilities.get(key),
            toolMode: 'prompted',
            updatedAt: this.now(),
          });
          this.removeMessage(o, assistant.id);
          o.emit({
            type: 'notice',
            level: 'info',
            message: `${o.model.name ?? o.model.id} rejected native tool calling. Sovran switched this model to prompted tools and retried.`,
          });
          iteration--;
          continue;
        }
        assistant.streaming = undefined;
        if (err.kind === 'cancelled' || o.signal.aborted) {
          this.commitOrDrop(o, assistant);
          return { reason: 'cancelled' };
        }
        const info: ErrorInfo = {
          kind: err.kind,
          message: redact(err.message, o.secrets ?? []),
          hint: err.hint,
        };
        assistant.error = info;
        this.deps.logger.warn(`Provider error (${err.kind}): ${info.message}`);
        o.emit({ type: 'message_committed', message: { ...assistant } });
        return { reason: 'error', error: info };
      }

      assistant.streaming = undefined;
      assistant.content = turn.text;
      if (turn.reasoning) assistant.reasoning = turn.reasoning;
      if (turn.calls.length) assistant.toolCalls = turn.calls;
      if (o.signal.aborted) {
        this.commitOrDrop(o, assistant);
        this.cancelRemaining(o, turn.calls);
        return { reason: 'cancelled' };
      }
      o.emit({ type: 'message_committed', message: { ...assistant } });
      if (turn.calls.length === 0) return { reason: 'completed' };

      for (const [i, call] of turn.calls.entries()) {
        if (o.signal.aborted) {
          this.cancelRemaining(o, turn.calls.slice(i));
          return { reason: 'cancelled' };
        }
        const result = await this.executeCall(call, o, offered);
        o.session.messages.push(result);
        o.emit({ type: 'message_committed', message: { ...result } });
        if (result.status === 'cancelled') {
          this.cancelRemaining(o, turn.calls.slice(i + 1));
          return { reason: 'cancelled' };
        }
        const signature = `${call.name}:${canonicalArguments(call.arguments)}`;
        if (result.status === 'error' || result.status === 'denied') {
          const count = (failures.get(signature) ?? 0) + 1;
          failures.set(signature, count);
          if (count >= LOOP_GUARD_LIMIT) {
            const message = `Stopped: the agent repeated the same failing action (${call.name}) ${count} times.`;
            o.emit({ type: 'notice', level: 'warning', message });
            this.cancelRemaining(o, turn.calls.slice(i + 1));
            return { reason: 'error', error: { kind: 'loop_guard', message } };
          }
        } else {
          failures.delete(signature);
        }
      }
    }

    o.emit({
      type: 'notice',
      level: 'warning',
      message: `Reached the limit of ${o.settings.maxIterations} steps. Send "continue" to keep going, or raise sovran.agent.maxIterations.`,
    });
    return { reason: 'max_iterations' };
  }

  private buildRequest(o: RunOptions, toolMode: ResolvedToolMode, vision = false) {
    const tools =
      toolMode === 'none'
        ? []
        : this.deps.registry.list(o.mode, {
            ...(o.policy?.() ?? o.settings.policy),
            excludedToolGroups: o.session.excludedToolGroups,
            workspaceTrusted: this.deps.workspace.isTrusted(),
          });
    const schemas = this.deps.registry.schemas(tools);
    const env = this.deps.workspace.environment();
    const systemPrompt = buildSystemPrompt({
      mode: o.mode,
      toolMode,
      tools: schemas,
      os: env.os,
      shell: env.shell,
      folders: this.deps.workspace.roots().map((r) => r.name),
      date: new Date(this.now()).toISOString().slice(0, 10),
      trusted: this.deps.workspace.isTrusted(),
      projectInstructions: o.projectInstructions,
    });
    const { contextWindow, reserveTokens: maxOutput } = effectiveLimits(
      o.model,
      o.model.serverLimits,
      defaultsOf(o.settings),
    );
    const schemaTokens = toolMode === 'native' ? estimateTokens(JSON.stringify(schemas)) : 0;
    const budgetTokens = Math.max(1024, contextWindow - maxOutput);
    const ctx = buildContext({
      systemPrompt,
      messages: messagesForModel(o.session),
      toolMode,
      budgetTokens,
      toolSchemaTokens: schemaTokens,
      maxToolResultChars: o.settings.tools.maxToolResultChars,
      summary: o.session.compaction?.summary,
      images: o.images,
      vision,
    });
    return {
      offered: new Map(tools.map((tool) => [tool.name, tool])),
      request: {
        model: o.model.id,
        messages: ctx.messages,
        tools: toolMode === 'native' && schemas.length ? schemas : undefined,
        temperature: o.model.temperature,
        maxTokens: o.model.maxOutputTokens,
      },
      droppedTurns: ctx.droppedTurns,
      estimatedTokens: ctx.estimatedTokens,
      budgetTokens,
      contextWindow,
    };
  }

  /**
   * Summarizes everything before the last `keepTurns` user turns into `session.compaction`.
   * The transcript keeps every message for the user; only what the model receives changes.
   * Returns false when there is nothing to compact or summarization failed (the caller then falls back to dropping turns).
   */
  async compact(o: CompactOptions, keepTurns = 2): Promise<boolean> {
    const visible = messagesForModel(o.session);
    const plan = planCompaction(visible, keepTurns);
    const firstKept = plan ? visible[plan.firstKeptIndex] : undefined;
    if (!plan || !firstKept) return false;
    o.emit({ type: 'compaction_started' });
    const { contextWindow } = effectiveLimits(o.model, o.model.serverLimits, defaultsOf(o.settings));
    const maxChars = Math.floor(Math.max(2048, contextWindow - 1500) * 3.5 * 0.85);
    const previous = o.session.compaction;
    try {
      const transcript = renderForSummary(visible.slice(0, plan.firstKeptIndex), previous?.summary, maxChars);
      const summary = await summarize(this.deps.provider, o.model, transcript, o.signal);
      const compaction = {
        summary: redact(summary, o.secrets ?? []),
        firstKeptId: firstKept.id,
        summarizedCount: (previous?.summarizedCount ?? 0) + plan.firstKeptIndex,
        createdAt: this.now(),
      };
      o.session.compaction = compaction;
      o.emit({ type: 'compacted', compaction: { ...compaction } });
      return true;
    } catch (e) {
      if (o.signal.aborted) return false;
      const message = e instanceof Error ? redact(e.message, o.secrets ?? []) : String(e);
      this.deps.logger.warn(`Compaction failed: ${message}`);
      o.emit({
        type: 'notice',
        level: 'warning',
        message: `Could not summarize earlier messages (${message}). Older messages will be dropped instead.`,
      });
      return false;
    }
  }

  private async streamTurn(
    assistant: AssistantMessage,
    request: ReturnType<AgentRunner['buildRequest']>['request'],
    toolMode: ResolvedToolMode,
    o: RunOptions,
  ): Promise<TurnResult> {
    const parser = new TaggedStreamParser({ think: 'stream', tool_call: 'block' });
    const partials = new Map<number, { id?: string; name?: string; args: string }>();
    const blocks: string[] = [];
    let text = '';
    let reasoning = '';

    const onSegments = (segments: { kind: string; text: string }[]) => {
      for (const s of segments) {
        if (s.kind === 'text') {
          text += s.text;
          assistant.content = text;
          o.emit({ type: 'text_delta', messageId: assistant.id, text: s.text });
        } else if (s.kind === 'think') {
          reasoning += s.text;
          assistant.reasoning = reasoning;
          o.emit({ type: 'reasoning_delta', messageId: assistant.id, text: s.text });
        } else if (s.kind === 'tool_call') {
          blocks.push(s.text);
        }
      }
    };

    for await (const ev of this.deps.provider.streamChat(request, o.signal)) {
      switch (ev.type) {
        case 'text':
          onSegments(parser.push(ev.text));
          break;
        case 'reasoning':
          reasoning += ev.text;
          assistant.reasoning = reasoning;
          o.emit({ type: 'reasoning_delta', messageId: assistant.id, text: ev.text });
          break;
        case 'tool_call_delta': {
          let p = partials.get(ev.index);
          if (!p) {
            p = { args: '' };
            partials.set(ev.index, p);
          }
          if (ev.id && !p.id) p.id = ev.id;
          if (ev.name && !p.name) {
            p.name = ev.name;
            o.emit({ type: 'tool_call_streaming', messageId: assistant.id, name: ev.name });
          }
          if (ev.argumentsDelta) p.args += ev.argumentsDelta;
          break;
        }
        case 'usage':
          o.emit({ type: 'usage', promptTokens: ev.promptTokens, completionTokens: ev.completionTokens });
          break;
        default:
          break;
      }
    }
    onSegments(parser.flush());

    const calls: ToolCall[] = [];
    if (partials.size > 0) {
      for (const [, p] of [...partials.entries()].sort(([a], [b]) => a - b)) {
        if (!p.name) continue;
        calls.push({ id: p.id ?? `call_${this.newId()}`, name: p.name, arguments: p.args || '{}' });
      }
    } else if (toolMode !== 'none') {
      // Prompted mode, or a native-mode model that emitted Hermes-style <tool_call> text.
      for (const block of blocks) {
        const parsed = parseToolCallBlock(block);
        calls.push(
          parsed.ok
            ? { id: `call_${this.newId()}`, name: parsed.name, arguments: parsed.argumentsJson }
            : {
                id: `call_${this.newId()}`,
                name: '__invalid__',
                arguments: JSON.stringify({ error: parsed.error }),
              },
        );
      }
    }
    return { text: text.trim(), reasoning: reasoning.trim(), calls };
  }

  private async executeCall(
    call: ToolCall,
    o: RunOptions,
    offered: ReadonlyMap<string, AnyTool>,
  ): Promise<ToolMessage> {
    const started = this.now();
    const result = (status: ToolStatus, content: string, extra: Partial<ToolMessage> = {}): ToolMessage => ({
      role: 'tool',
      id: this.newId(),
      toolCallId: call.id,
      toolName: call.name,
      content: truncateMiddle(redact(content, o.secrets ?? []), o.settings.tools.maxToolResultChars),
      status,
      durationMs: this.now() - started,
      createdAt: this.now(),
      ...extra,
    });

    if (call.name === '__invalid__') {
      const parsed = parseJsonLenient(call.arguments);
      const msg = parsed.ok ? String((parsed.value as { error?: unknown }).error) : 'Invalid tool call.';
      return result('error', msg);
    }
    const tool = this.deps.registry.get(call.name);
    if (!tool) {
      const names = [...offered.keys()].join(', ');
      return result('error', `Unknown tool "${call.name}". Available tools: ${names}.`);
    }
    if (o.mode === 'plan' && tool.risk !== 'read') {
      return result(
        'denied',
        `${tool.name} is not available in Plan mode (read-only). Describe the change in your plan instead.`,
      );
    }

    if (offered.get(call.name) !== tool) {
      return result(
        'denied',
        `${call.name} was not offered in this model request, or its definition changed. Request the current tools before retrying.`,
      );
    }
    const unavailable = () =>
      this.deps.registry.unavailable(tool, o.mode, {
        ...(o.policy?.() ?? o.settings.policy),
        excludedToolGroups: o.session.excludedToolGroups,
        workspaceTrusted: this.deps.workspace.isTrusted(),
      });
    const unavailableReason = unavailable();
    if (unavailableReason) return result('denied', unavailableReason);
    if (o.signal.aborted) return result('cancelled', 'Cancelled by the user.');

    const parsedJson = parseJsonLenient(call.arguments);
    if (!parsedJson.ok)
      return result('error', `Arguments for ${tool.name} are not valid JSON: ${parsedJson.error}`);
    const parsed = tool.schema.safeParse(parsedJson.value);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      return result('error', `Invalid arguments for ${tool.name}: ${issues}`);
    }
    const args = parsed.data;
    const label = safeLabel(() => tool.label(args), call.name);

    const ctx: ToolContext = {
      workspace: this.deps.workspace,
      process: this.deps.process,
      signal: o.signal,
      settings: { ...o.settings.tools, protectedPaths: (o.policy?.() ?? o.settings.policy).protectedPaths },
      onOutput: (chunk) => o.emit({ type: 'tool_output', callId: call.id, chunk }),
      ...(this.deps.documents ? { documents: this.deps.documents } : {}),
      ...(this.deps.web ? { web: this.deps.web } : {}),
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
              roots: this.deps.workspace.roots().map((r) => r.path),
            })
          : [];
      return decide({
        toolName: tool.name,
        risk: tool.risk,
        mode: o.mode,
        workspaceTrusted: this.deps.workspace.isTrusted(),
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
        response = await this.deps.approvals.request(
          {
            id: this.newId(),
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
      return result(
        'denied',
        'Permissions changed before execution. Request this action again for approval.',
        { summary: label },
      );
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
      this.deps.logger.warn(`Tool ${tool.name} failed: ${e instanceof Error ? e.message : String(e)}`);
      return result('error', describeToolFailure(e), { summary: label });
    }
  }

  private removeMessage(o: RunOptions, id: string) {
    const idx = o.session.messages.findIndex((m) => m.id === id);
    if (idx !== -1) o.session.messages.splice(idx, 1);
    o.emit({ type: 'message_removed', messageId: id });
  }

  /** Keeps a partially streamed message if it has content; otherwise removes it. */
  private commitOrDrop(o: RunOptions, assistant: AssistantMessage) {
    assistant.streaming = undefined;
    if (assistant.content.trim() || assistant.reasoning?.trim() || assistant.toolCalls?.length) {
      o.emit({ type: 'message_committed', message: { ...assistant } });
    } else {
      this.removeMessage(o, assistant.id);
    }
  }

  private cancelRemaining(o: RunOptions, calls: readonly ToolCall[]) {
    for (const call of calls) {
      if (o.session.messages.some((m) => m.role === 'tool' && m.toolCallId === call.id)) continue;
      const msg: ToolMessage = {
        role: 'tool',
        id: this.newId(),
        toolCallId: call.id,
        toolName: call.name,
        content: 'Not executed: the run was cancelled.',
        status: 'cancelled',
        createdAt: this.now(),
      };
      o.session.messages.push(msg);
      o.emit({ type: 'message_committed', message: { ...msg } });
    }
  }
}

/** Stable form of tool arguments, so whitespace or key order cannot slip a repeated failure past the loop guard. */
export function canonicalArguments(raw: string): string {
  const parsed = parseJsonLenient(raw);
  if (!parsed.ok) return raw.trim();
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v as Record<string, unknown>)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([k, x]) => [k, sort(x)]),
          )
        : v;
  return JSON.stringify(sort(parsed.value));
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
