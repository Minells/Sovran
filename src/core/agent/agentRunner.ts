import { randomUUID } from 'node:crypto';
import { buildContext, estimateTokens } from '../context/contextManager';
import { decide, type AgentMode, type PolicySettings, type SessionGrants } from '../permissions/policy';
import type { ApprovalPort, Logger, ProcessPort, WorkspacePort } from '../ports';
import { capabilityKey, resolveToolMode, type CapabilityStore } from '../providers/capabilities';
import { ProviderError, errorFromException } from '../providers/errors';
import type { ChatProvider, ModelConfig, ResolvedToolMode } from '../providers/types';
import { PathError } from '../security/paths';
import { redact } from '../security/redact';
import type { AssistantMessage, ErrorInfo, Session, ToolCall, ToolMessage, ToolStatus } from '../sessions/model';
import { truncateMiddle } from '../tools/edits';
import type { ToolRegistry } from '../tools/registry';
import { ToolError, type ToolContext, type ToolSettings } from '../tools/types';
import type { AgentEvent, RunOutcome } from './events';
import { parseJsonLenient, parseToolCallBlock } from './promptedTools';
import { buildSystemPrompt } from './systemPrompt';
import { TaggedStreamParser } from './taggedStream';

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
}

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
    let iteration = 0;

    while (iteration < o.settings.maxIterations) {
      if (o.signal.aborted) return { reason: 'cancelled' };
      iteration++;
      const toolMode = resolveToolMode(o.model.toolMode, this.deps.capabilities.get(key));
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
      try {
        const request = this.buildRequest(o, toolMode);
        o.session.messages.push(assistant);
        o.emit({ type: 'message_started', message: { ...assistant } });
        turn = await this.streamTurn(assistant, request, toolMode, o);
      } catch (e) {
        const err = e instanceof ProviderError ? e : errorFromException(e, { url: o.providerId, secrets: o.secrets });
        if (err.kind === 'tools_unsupported' && toolMode === 'native' && (o.model.toolMode ?? 'auto') === 'auto' && !downgraded) {
          downgraded = true;
          this.deps.capabilities.set(key, { toolMode: 'prompted', updatedAt: this.now() });
          this.removeMessage(o, assistant.id);
          o.emit({
            type: 'notice',
            level: 'info',
            message: `${o.model.name ?? o.model.id} rejected native tool calling. SOVRAN switched this model to prompted tools and retried.`,
          });
          iteration--;
          continue;
        }
        assistant.streaming = undefined;
        if (err.kind === 'cancelled' || o.signal.aborted) {
          this.commitOrDrop(o, assistant);
          return { reason: 'cancelled' };
        }
        const info: ErrorInfo = { kind: err.kind, message: redact(err.message, o.secrets ?? []), hint: err.hint };
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
        const result = await this.executeCall(call, o);
        o.session.messages.push(result);
        o.emit({ type: 'message_committed', message: { ...result } });
        if (result.status === 'cancelled') {
          this.cancelRemaining(o, turn.calls.slice(i + 1));
          return { reason: 'cancelled' };
        }
        const signature = `${call.name}:${call.arguments}`;
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

  private buildRequest(o: RunOptions, toolMode: ResolvedToolMode) {
    const tools = toolMode === 'none' ? [] : this.deps.registry.list(o.mode);
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
    const contextWindow = o.model.contextWindow ?? o.settings.defaultContextWindow;
    const maxOutput = o.model.maxOutputTokens ?? o.settings.defaultMaxOutputTokens;
    const schemaTokens = toolMode === 'native' ? estimateTokens(JSON.stringify(schemas)) : 0;
    const ctx = buildContext({
      systemPrompt,
      messages: o.session.messages,
      toolMode,
      budgetTokens: Math.max(1024, contextWindow - maxOutput),
      toolSchemaTokens: schemaTokens,
      maxToolResultChars: o.settings.tools.maxToolResultChars,
    });
    if (ctx.droppedTurns > 0) {
      o.emit({ type: 'notice', level: 'info', message: `Context window is full: ${ctx.droppedTurns} earlier exchange(s) are no longer sent to the model.` });
    }
    return {
      model: o.model.id,
      messages: ctx.messages,
      tools: toolMode === 'native' && schemas.length ? schemas : undefined,
      temperature: o.model.temperature,
      maxTokens: o.model.maxOutputTokens,
    };
  }

  private async streamTurn(
    assistant: AssistantMessage,
    request: ReturnType<AgentRunner['buildRequest']>,
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
            : { id: `call_${this.newId()}`, name: '__invalid__', arguments: JSON.stringify({ error: parsed.error }) },
        );
      }
    }
    return { text: text.trim(), reasoning: reasoning.trim(), calls };
  }

  private async executeCall(call: ToolCall, o: RunOptions): Promise<ToolMessage> {
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
      const names = this.deps.registry.list(o.mode).map((t) => t.name).join(', ');
      return result('error', `Unknown tool "${call.name}". Available tools: ${names}.`);
    }
    if (o.mode === 'plan' && tool.risk !== 'read') {
      return result('denied', `${tool.name} is not available in Plan mode (read-only). Describe the change in your plan instead.`);
    }

    const parsedJson = parseJsonLenient(call.arguments);
    if (!parsedJson.ok) return result('error', `Arguments for ${tool.name} are not valid JSON: ${parsedJson.error}`);
    const parsed = tool.schema.safeParse(parsedJson.value);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
      return result('error', `Invalid arguments for ${tool.name}: ${issues}`);
    }
    const args = parsed.data;
    const label = safeLabel(() => tool.label(args), call.name);

    const ctx: ToolContext = {
      workspace: this.deps.workspace,
      process: this.deps.process,
      signal: o.signal,
      settings: o.settings.tools,
      onOutput: (chunk) => o.emit({ type: 'tool_output', callId: call.id, chunk }),
    };

    let prepared;
    try {
      prepared = tool.prepare ? await tool.prepare(args, ctx) : { paths: [] };
    } catch (e) {
      return result('error', describeToolFailure(e), { summary: label });
    }

    const decision = decide({
      risk: tool.risk,
      mode: o.mode,
      workspaceTrusted: this.deps.workspace.isTrusted(),
      paths: prepared.paths,
      command: prepared.command,
      settings: o.settings.policy,
      grants: o.grants,
    });
    if (decision.action === 'deny') return result('denied', decision.reason, { summary: label });

    if (decision.action === 'ask') {
      o.emit({ type: 'tool_phase', callId: call.id, toolName: tool.name, label, phase: 'awaiting_approval' });
      const detail = prepared.approval ?? { kind: 'read' as const, path: prepared.paths[0] ?? label, reason: decision.reason };
      let response;
      try {
        response = await this.deps.approvals.request({ id: this.newId(), callId: call.id, toolName: tool.name, title: label, detail }, o.signal);
      } catch {
        return result('cancelled', 'The run was cancelled while waiting for approval.', { summary: label });
      }
      if (o.signal.aborted) return result('cancelled', 'The run was cancelled while waiting for approval.', { summary: label });
      if (!response.approved) {
        const feedback = response.feedback?.trim() ? ` User feedback: ${response.feedback.trim()}` : '';
        return result('denied', `The user rejected this action.${feedback}`, { summary: label });
      }
      if (response.grant === 'session-edits') o.grants.edits = true;
    }

    o.emit({ type: 'tool_phase', callId: call.id, toolName: tool.name, label, phase: 'running' });
    try {
      const r = await tool.execute(args, ctx, prepared);
      if (o.signal.aborted && tool.risk !== 'write') {
        return result('cancelled', r.content || 'Cancelled.', { summary: r.summary ?? label, display: r.display });
      }
      return result(r.isError ? 'error' : 'success', r.content, { summary: r.summary ?? label, display: r.display });
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
