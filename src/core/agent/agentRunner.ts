import { randomUUID } from 'node:crypto';
import type { CodeModeExecution } from '../codeMode/execution';
import { CODE_TOOL_NAMES, type CodeSandboxPort } from '../codeMode/contracts';
import { planCompaction, renderForSummary, summarize } from '../context/compaction';
import type { DocumentReader } from '../documents/reader';
import { buildContext, CHARS_PER_TOKEN, estimateTokens } from '../context/contextManager';
import { type AgentMode, type PolicySettings, type SessionGrants } from '../permissions/policy';
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
import { redact, redactKnown } from '../security/redact';
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
import {
  addUnits,
  CORE_UNIT,
  LOAD_TOOLS,
  loadableUnits,
  loadToolsSchema,
  offerTools,
  resolveLoadRequest,
  unitOf,
  unitsWithinBudget,
  withImplied,
  type LoadableUnit,
  type ToolLoadingMode,
} from '../tools/loading';
import type { ToolRegistry } from '../tools/registry';
import { routeToolUnits, type RoutingHints } from '../tools/routing';
import { type AnyTool, type ToolSettings, type ToolResult } from '../tools/types';
import type { AgentEvent, RunOutcome, ToolLoadReason } from './events';
import { parseJsonLenient, parseToolCallBlock, renderToolInstructions } from './promptedTools';
import { buildSystemPrompt } from './systemPrompt';
import type { WebFetchPort } from '../web/types';
import { TaggedStreamParser } from './taggedStream';
import { executeAuthorizedTool, type ToolResultFactory } from '../tools/executor';

/** Share of the input budget a single tool result may take: small windows get shorter results and smaller pages. */
const RESULT_BUDGET_SHARE = 0.15;
const MIN_RESULT_CHARS = 2000;

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
  /** `auto` offers the core tools and loads the others on demand; missing means `all`, every tool each request. */
  toolLoading?: ToolLoadingMode;
  codeModeEnabled?: boolean;
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
  codeSandbox?: CodeSandboxPort;
  newId?: () => string;
  now?: () => number;
  /** Waits between retries of a busy server; tests replace it. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
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
  /** Live host switch; disabling the experiment prevents subsequent child dispatches. */
  codeModeAllowed?: () => boolean;
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
  /** What on-demand loading can know about the request beyond its text: its slash command and the MCP servers. */
  routing?: RoutingHints;
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

/** A busy or restarting server (rate limit, gateway errors) is asked again after these waits, then reported. */
const RETRY_DELAYS_MS = [1000, 3000];
const RETRY_STATUS = new Set([429, 502, 503, 504]);
/** A server that asks to wait longer than this is reported instead: the user decides whether to wait. */
const MAX_RETRY_AFTER_MS = 30_000;

/** Resolves after `ms`, or at once when the run is cancelled. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

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

  private codeMode?: CodeModeExecution;

  async run(o: RunOptions): Promise<RunOutcome> {
    const latest = [...o.session.messages].reverse().find((m) => m.role === 'user');
    const requested = latest?.role === 'user' && /^\/code(?:\s|$)/i.test(latest.display ?? latest.content);
    if (requested) {
      const toolMode = resolveToolMode(
        o.model.toolMode,
        this.deps.capabilities.get(capabilityKey(o.providerId, o.model.id)),
      );
      if (
        !o.settings.codeModeEnabled ||
        !this.deps.codeSandbox ||
        o.mode !== 'act' ||
        !this.deps.workspace.isTrusted() ||
        toolMode === 'none'
      ) {
        const message =
          'Code Mode requires the experimental user setting, Act mode, a trusted workspace and a model with tools enabled.';
        o.emit({ type: 'notice', level: 'warning', message });
        return { reason: 'error', error: { kind: 'code_mode', message } };
      }
      const { CodeModeExecution } = await import('../codeMode/execution');
      this.codeMode = new CodeModeExecution({
        sandbox: this.deps.codeSandbox,
        available: () => (o.codeModeAllowed?.() === false ? [] : this.availableTools(o)),
        secrets: o.secrets ?? [],
        maxResultChars: () => this.toolSettings(o).maxToolResultChars,
        emit: (calls, parentId) =>
          o.emit({ type: 'code_trace', callId: parentId, calls: calls.map((call) => ({ ...call })) }),
        dispatch: async (tool, args, signal, phase, approval, parentId, authorize) => {
          let raw: ToolResult | undefined;
          const factory: ToolResultFactory = (status, content, extra = {}) => ({
            role: 'tool',
            id: this.newId(),
            toolCallId: parentId,
            toolName: tool.name,
            content,
            status,
            createdAt: this.now(),
            ...extra,
          });
          const options = {
            ...o,
            signal,
            captureMcpResult: true,
            authorize,
            emit: (event: AgentEvent) => {
              if (event.type === 'tool_phase') phase(event.phase);
              o.emit(event);
            },
          };
          const services = {
            ...this.deps,
            newId: () => this.newId(),
            approvals: {
              request: (request: Parameters<ApprovalPort['request']>[0], approvalSignal: AbortSignal) =>
                this.codeMode!.serializeApproval(
                  () => this.deps.approvals.request(request, approvalSignal),
                  approvalSignal,
                ),
            },
          };
          const message = await executeAuthorizedTool(
            tool,
            { id: parentId, name: tool.name, arguments: JSON.stringify(args) },
            options,
            services,
            this.toolSettings(o),
            factory,
            (result) => {
              raw = result;
            },
            approval,
          );
          return { message, raw };
        },
      });
      o.emit({
        type: 'notice',
        level: 'info',
        message: 'Experimental Code Mode: reviewed read-only MCP tools, with existing approvals.',
      });
    }
    try {
      return await this.runLoop(o);
    } finally {
      this.codeMode?.invalidate();
      this.codeMode = undefined;
    }
  }

  private async runLoop(o: RunOptions): Promise<RunOutcome> {
    const key = capabilityKey(o.providerId, o.model.id);
    const failures = new Map<string, number>();
    let downgraded = false;
    let visionRefused = false;
    let compactedThisRun = false;
    let iteration = 0;
    let retries = 0;

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

    if (!this.codeMode) this.prepareToolUnits(o);

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
      let loadable: readonly LoadableUnit[];
      try {
        let built = this.buildRequest(o, toolMode, vision);
        if (built.droppedTurns > 0 && o.autoCompact && !compactedThisRun) {
          compactedThisRun = true;
          if (await this.compact(o)) {
            this.codeMode?.invalidate();
            // The prompt changed from the start: a good moment to drop tools the conversation no longer uses.
            if (!this.codeMode) this.prepareToolUnits(o);
            built = this.buildRequest(o, toolMode, vision);
          }
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
          breakdown: built.breakdown,
        });
        const request = built.request;
        offered = built.offered;
        loadable = built.loadable;
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
        // Only when nothing of the reply arrived: a retry must not repeat text the user already saw.
        const wait = err.retryAfterMs ?? RETRY_DELAYS_MS[retries];
        if (
          err.status !== undefined &&
          RETRY_STATUS.has(err.status) &&
          wait !== undefined &&
          retries < RETRY_DELAYS_MS.length &&
          wait <= MAX_RETRY_AFTER_MS &&
          !assistant.content &&
          !assistant.reasoning &&
          !o.signal.aborted
        ) {
          retries++;
          this.removeMessage(o, assistant.id);
          o.emit({
            type: 'notice',
            level: 'info',
            message: `${o.model.name ?? o.model.id} is busy (HTTP ${err.status}). Retrying in ${Math.ceil(wait / 1000)} s (attempt ${retries} of ${RETRY_DELAYS_MS.length}).`,
          });
          await (this.deps.sleep ?? sleep)(wait, o.signal);
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

      retries = 0;
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
        const result = await this.executeCall(call, o, offered, loadable);
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
    const available =
      toolMode === 'none'
        ? []
        : this.availableTools(o).filter((t) => !this.codeMode || t.source?.kind !== 'mcp');
    const offer =
      o.settings.toolLoading === 'auto'
        ? offerTools(
            available,
            o.session.toolUnits ?? [],
            loadableUnits(available, (tool) => this.tokensOf(tool)),
          )
        : { core: available, loaded: [], index: [] };
    const tools = [...offer.core, ...offer.loaded];
    // load_tools sits between the core and the loaded units: neither it nor anything before it changes as units load.
    const schemas = [
      ...this.deps.registry.schemas(offer.core),
      ...(offer.index.length ? [loadToolsSchema(offer.index)] : []),
      ...this.deps.registry.schemas(offer.loaded),
      ...(this.codeMode && toolMode !== 'none' ? this.codeMode.schemas() : []),
    ];
    this.codeMode?.beginRequest();
    const env = this.deps.workspace.environment();
    const systemPrompt = buildSystemPrompt({
      mode: o.mode,
      toolMode,
      tools: schemas,
      onDemandTools: offer.index.length > 0,
      os: env.os,
      shell: env.shell,
      folders: this.deps.workspace.roots().map((r) => r.name),
      date: new Date(this.now()).toISOString().slice(0, 10),
      trusted: this.deps.workspace.isTrusted(),
      projectInstructions: o.projectInstructions,
    });
    const { contextWindow, budgetTokens } = this.inputBudget(o);
    const schemaTokens = toolMode === 'native' ? estimateTokens(JSON.stringify(schemas)) : 0;
    // Prompted tools are described inside the system prompt; the breakdown still counts them as tools.
    const promptedToolTokens =
      toolMode === 'prompted' && schemas.length ? estimateTokens(renderToolInstructions(schemas)) : 0;
    const ctx = buildContext({
      systemPrompt,
      messages: messagesForModel(o.session),
      toolMode,
      budgetTokens,
      toolSchemaTokens: schemaTokens,
      maxToolResultChars: this.toolSettings(o).maxToolResultChars,
      summary: o.session.compaction?.summary,
      images: o.images,
      vision,
    });
    return {
      offered: new Map(tools.map((tool) => [tool.name, tool])),
      loadable: offer.index,
      request: {
        model: o.model.id,
        messages: ctx.messages,
        tools: toolMode === 'native' && schemas.length ? schemas : undefined,
        temperature: o.model.temperature,
        maxTokens: o.model.maxOutputTokens,
      },
      droppedTurns: ctx.droppedTurns,
      estimatedTokens: ctx.estimatedTokens,
      breakdown: {
        system: Math.max(0, ctx.breakdown.system - promptedToolTokens),
        tools: ctx.breakdown.tools + promptedToolTokens,
        messages: ctx.breakdown.messages,
      },
      budgetTokens,
      contextWindow,
    };
  }

  /** Tools the model may use in this chat and mode, whether or not their unit is loaded. */
  private availableTools(o: RunOptions): AnyTool[] {
    return this.deps.registry.list(o.mode, {
      ...(o.policy?.() ?? o.settings.policy),
      excludedToolGroups: o.session.excludedToolGroups,
      workspaceTrusted: this.deps.workspace.isTrusted(),
    });
  }

  private tokensOf(tool: AnyTool): number {
    return estimateTokens(JSON.stringify(this.deps.registry.schema(tool)));
  }

  /**
   * Tool settings for this model. The result limit is the user's, lowered for small windows so that one result
   * cannot take more than `RESULT_BUDGET_SHARE` of the input budget; tools then page at that size.
   */
  private toolSettings(o: Pick<RunOptions, 'model' | 'settings'>): ToolSettings {
    const cap = Math.floor(this.inputBudget(o).budgetTokens * RESULT_BUDGET_SHARE * CHARS_PER_TOKEN);
    const maxToolResultChars = Math.min(o.settings.tools.maxToolResultChars, Math.max(MIN_RESULT_CHARS, cap));
    return { ...o.settings.tools, maxToolResultChars };
  }

  /** The model's context window and the part of it left for the request once the reply is reserved. */
  private inputBudget(o: Pick<RunOptions, 'model' | 'settings'>) {
    const { contextWindow, reserveTokens } = effectiveLimits(
      o.model,
      o.model.serverLimits,
      defaultsOf(o.settings),
    );
    return { contextWindow, budgetTokens: Math.max(1024, contextWindow - reserveTokens) };
  }

  /**
   * With on-demand loading, the units a run starts with: those the chat has used, whatever fits the budget for this
   * model, and what the user's message asks for. Within a chat units only accumulate, so the prompt prefix stays
   * stable. They are chosen afresh only when the server's prompt cache is gone anyway: for another model, or after a
   * compaction. Units the visible conversation used or loaded stay; the others go.
   */
  private prepareToolUnits(o: RunOptions) {
    if (o.settings.toolLoading !== 'auto') return;
    const toolMode = resolveToolMode(
      o.model.toolMode,
      this.deps.capabilities.get(capabilityKey(o.providerId, o.model.id)),
    );
    if (toolMode === 'none') return;
    const basis = `${o.providerId}/${o.model.id}#${o.session.compaction?.firstKeptId ?? ''}`;
    const previous = o.session.toolUnits;
    // Units the chat already had are not reported again when they are chosen afresh.
    const known = new Set(previous ?? []);
    if (previous === undefined || o.session.toolUnitsBasis !== basis) {
      o.session.toolUnits = [];
      o.session.toolUnitsBasis = basis;
      this.loadUnits(o, this.unitsInHistory(o), 'history', undefined, known);
    }
    const available = this.availableTools(o);
    const coreTokens = available
      .filter((tool) => unitOf(tool) === CORE_UNIT)
      .reduce((sum, tool) => sum + this.tokensOf(tool), 0);
    const units = loadableUnits(available, (tool) => this.tokensOf(tool));
    this.loadUnits(
      o,
      unitsWithinBudget(coreTokens, units, this.inputBudget(o).budgetTokens),
      'budget',
      undefined,
      known,
    );
    const latest = o.session.messages.findLast((m) => m.role === 'user');
    if (latest?.role === 'user') {
      const routed = routeToolUnits(
        latest.content,
        units.map((unit) => unit.id),
        o.routing,
      );
      const why = new Map(routed.map((r) => [r.unit, r.reason]));
      this.loadUnits(
        o,
        routed.map((r) => r.unit),
        'router',
        why,
        known,
      );
    }
    const dropped = (previous ?? []).filter((unit) => !o.session.toolUnits?.includes(unit));
    if (dropped.length) o.emit({ type: 'tools_unloaded', units: dropped });
  }

  /** Units of the tools the visible conversation called or loaded, in order of first appearance. */
  private unitsInHistory(o: RunOptions): string[] {
    const used: string[] = [];
    const use = (unit: string | undefined) => {
      if (unit && unit !== CORE_UNIT && !used.includes(unit)) used.push(unit);
    };
    for (const message of messagesForModel(o.session)) {
      if (message.role === 'tool') for (const unit of message.loaded ?? []) use(unit);
      if (message.role !== 'assistant') continue;
      for (const c of message.toolCalls ?? []) {
        const tool = this.deps.registry.get(c.name);
        use(tool && unitOf(tool));
      }
    }
    return used;
  }

  /**
   * Adds units to the chat. Their tools are offered from the next model request. Units in `known` were loaded before
   * and are not reported as news.
   */
  private loadUnits(
    o: RunOptions,
    units: readonly string[],
    reason: ToolLoadReason,
    why?: ReadonlyMap<string, string>,
    known?: ReadonlySet<string>,
  ): string[] {
    const added = addUnits((o.session.toolUnits ??= []), units);
    const news = known ? added.filter((unit) => !known.has(unit)) : added;
    if (!news.length) return added;
    const detail = why && news.map((unit) => `${unit}: ${why.get(unit) ?? 'needed by another unit'}`);
    o.emit({ type: 'tools_loaded', units: news, reason, ...(detail ? { detail } : {}) });
    return added;
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
    let finishReason: string | null = null;

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
        case 'finish':
          finishReason = ev.reason ?? finishReason;
          break;
        default:
          break;
      }
    }
    onSegments(parser.flush());
    // A reply cut at the output limit looks complete, and a tool call cut there fails as invalid JSON: say why.
    if (finishReason === 'length') {
      o.emit({
        type: 'notice',
        level: 'warning',
        message: `${o.model.name ?? o.model.id} reached its output limit, so this reply may be cut off. Ask it to continue, or raise the model's maximum output tokens.`,
      });
    }

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
    loadable: readonly LoadableUnit[] = [],
  ): Promise<ToolMessage> {
    const started = this.now();
    const result = (status: ToolStatus, content: string, extra: Partial<ToolMessage> = {}): ToolMessage => ({
      role: 'tool',
      id: this.newId(),
      toolCallId: call.id,
      toolName: call.name,
      // Only the secrets Sovran holds are masked: the model must read files and output exactly as they are.
      content: truncateMiddle(redactKnown(content, o.secrets ?? []), this.toolSettings(o).maxToolResultChars),
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
    // Offered only while something is deferred; otherwise the name is unknown like any other.
    if (call.name === LOAD_TOOLS && loadable.length) return this.loadTools(call, o, loadable, result);
    if (this.codeMode && CODE_TOOL_NAMES.some((name) => name === call.name)) {
      let args: unknown;
      try {
        args = JSON.parse(call.arguments);
      } catch {
        return result(
          'error',
          'Code Mode arguments must be valid JSON; regenerate the call without repairing the JavaScript source.',
        );
      }
      o.emit({
        type: 'tool_phase',
        callId: call.id,
        toolName: call.name,
        label: call.name === 'execute_code' ? 'Running Code Mode' : 'Discovering MCP tools',
        phase: 'running',
      });
      const reply = await this.codeMode.handle(call.name, args, o.signal, call.id);
      return result(reply.status, reply.content, {
        ...(call.name === 'execute_code' ? { codeMode: { calls: reply.calls ?? [] } } : {}),
      });
    }
    const tool = this.deps.registry.get(call.name);
    if (!tool) {
      const names = [...offered.keys(), ...(loadable.length ? [LOAD_TOOLS] : [])].join(', ');
      const more = loadable.length
        ? ` More tools load with ${LOAD_TOOLS}: ${loadable.map((unit) => unit.id).join(', ')}.`
        : '';
      return result('error', `Unknown tool "${call.name}". Available tools: ${names}.${more}`);
    }
    if (o.mode === 'plan' && tool.risk !== 'read') {
      return result(
        'denied',
        `${tool.name} is not available in Plan mode (read-only). Describe the change in your plan instead.`,
      );
    }

    // A tool that was available but not loaded: load its unit for the next request instead of running it here, since
    // the model did not see its definition. Unavailable tools are never in `loadable` and fall through to the denial.
    const unit = offered.has(call.name) ? undefined : loadable.find((u) => u.tools.includes(tool));
    if (unit) {
      const units = withImplied([unit.id]).filter((id) => loadable.some((u) => u.id === id));
      this.loadUnits(o, units, 'call');
      return result(
        'success',
        `${call.name} was not loaded yet, so it did not run. Sovran loaded ${units.join(', ')}: call ${call.name} again with the same arguments.`,
        { loaded: units, summary: units.join(', ') },
      );
    }

    if (offered.get(call.name) !== tool) {
      return result(
        'denied',
        `${call.name} was not offered in this model request, or its definition changed. Request the current tools before retrying.`,
      );
    }
    return executeAuthorizedTool(
      tool,
      call,
      o,
      { ...this.deps, newId: () => this.newId() },
      this.toolSettings(o),
      result,
    );
  }

  /** `load_tools`: adds units to the chat and runs nothing else, so it needs no approval in any mode. */
  private loadTools(
    call: ToolCall,
    o: RunOptions,
    loadable: readonly LoadableUnit[],
    result: ToolResultFactory,
  ): ToolMessage {
    const parsed = parseJsonLenient(call.arguments);
    if (!parsed.ok) return result('error', `Arguments for ${LOAD_TOOLS} are not valid JSON: ${parsed.error}`);
    const request = resolveLoadRequest(parsed.value, loadable);
    if (!request.ok) return result('error', request.error);
    const added = this.loadUnits(o, request.units, 'model');
    const names = loadable
      .filter((unit) => request.units.includes(unit.id))
      .flatMap((unit) => unit.tools.map((tool) => tool.name));
    const units = request.units.join(', ');
    return result(
      'success',
      added.length
        ? `Loaded ${units}: ${names.join(', ')}. Use them from your next step.`
        : `Already loaded: ${units} (${names.join(', ')}).`,
      { loaded: request.units, summary: units },
    );
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
