import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ValidateFunction } from 'ajv';
import type { ToolSchema } from '../providers/types';
import type { AnyTool, ToolResult } from '../tools/types';
import type { ToolMessage } from '../sessions/model';
import { redactKnown } from '../security/redact';
import { compileCodeSchema } from './schema';
import {
  CODE_LIMITS,
  CodeModeError,
  jsonBytes,
  type CodeCallResult,
  type CodeCallTrace,
  type CodeSandboxPort,
} from './contracts';

const searchSchema = z.object({
  query: z.string().min(1).max(200),
  limit: z.number().int().min(1).max(8).optional(),
});
const describeSchema = z.object({ toolIds: z.array(z.string().min(1).max(64)).min(1).max(8) });
const executeSchema = z.object({
  manifestId: z.string().max(80),
  code: z.string().min(1).max(CODE_LIMITS.codeBytes),
});

const definitions = [
  [
    'code_search',
    'Find reviewed read-only MCP tools by name, server or purpose. Does not call a server.',
    searchSchema,
  ],
  [
    'code_describe',
    'Read exact input/output schemas for selected toolIds. Returns a manifestId for a later execute_code call. Read this result before writing code.',
    describeSchema,
  ],
  [
    'execute_code',
    'Run a JavaScript async function body in an isolated local sandbox. Use await tools.call(toolId, args), returning {data?,text?,contentTypes}; data is unknown without an output schema. End with return of a small JSON summary. No imports, files, network, Node or native tools. Use only tools in a previously described manifest. Batch at most 4 calls, await every call, paginate explicitly, report missing data and errors. MCP approvals still apply. No TypeScript.',
    executeSchema,
  ],
] as const;

export const codeModeSchemas = (): ToolSchema[] =>
  definitions.map(([name, description, schema]) => {
    const parameters = z.toJSONSchema(schema) as Record<string, unknown>;
    delete parameters.$schema;
    return { type: 'function', function: { name, description, parameters } };
  });

interface Capability {
  tool: AnyTool;
  schema: string;
  validate: ValidateFunction;
}
interface DispatchResult {
  message: ToolMessage;
  raw?: ToolResult;
}
export interface CodeExecutionDeps {
  sandbox: CodeSandboxPort;
  available(): AnyTool[];
  dispatch(
    tool: AnyTool,
    args: unknown,
    signal: AbortSignal,
    phase: (status: CodeCallTrace['status']) => void,
    approval: (waiting: boolean) => void,
    parentId: string,
    authorize: () => string | undefined,
  ): Promise<DispatchResult>;
  emit(calls: readonly CodeCallTrace[], parentId: string): void;
  maxResultChars(): number;
  secrets: readonly (string | undefined)[];
}

/** Ephemeral to one agent run. Capabilities are not permissions and are never restored from chat text. */
export class CodeModeExecution {
  private readonly manifests = new Map<string, Map<string, Capability>>();
  private offeredManifests = new Set<string>();
  private readonly validators = new WeakMap<AnyTool, { schema: string; validate: ValidateFunction | null }>();
  private discoveries = 0;
  private executions = 0;
  private calls = 0;
  private approvalTail: Promise<unknown> = Promise.resolve();
  constructor(private readonly deps: CodeExecutionDeps) {}

  schemas() {
    return codeModeSchemas();
  }

  /** Snapshot before inference: a describe in the same response cannot authorize an already-generated program. */
  beginRequest() {
    this.offeredManifests = new Set(this.manifests.keys());
  }
  invalidate() {
    this.manifests.clear();
    this.offeredManifests.clear();
  }

  async serializeApproval<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
    const previous = this.approvalTail;
    let release!: () => void;
    this.approvalTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (signal.aborted) throw new CodeModeError('CANCELLED', 'Cancelled while waiting for approval.');
      return await work();
    } finally {
      release();
    }
  }

  private eligible(): Capability[] {
    return this.deps.available().flatMap((tool) => {
      if (tool.source?.kind !== 'mcp' || !tool.codeMode) return [];
      const schema = JSON.stringify(tool.codeMode);
      let cached = this.validators.get(tool);
      if (!cached || cached.schema !== schema) {
        cached = { schema, validate: compileCodeSchema(tool.codeMode.inputSchema) ?? null };
        this.validators.set(tool, cached);
      }
      return cached.validate ? [{ tool, validate: cached.validate, schema }] : [];
    });
  }

  async handle(
    name: string,
    args: unknown,
    signal: AbortSignal,
    parentId = '',
  ): Promise<{
    content: string;
    status: 'success' | 'error' | 'denied' | 'cancelled';
    calls?: CodeCallTrace[];
  }> {
    try {
      if (signal.aborted) throw new CodeModeError('CANCELLED', 'Cancelled by the user.');
      if (name !== 'execute_code' && ++this.discoveries > CODE_LIMITS.discoveries)
        throw new CodeModeError('LIMIT_EXCEEDED', 'Discovery budget exceeded.');
      if (name === 'code_search') {
        const input = searchSchema.parse(args);
        const words = input.query.toLowerCase().split(/\s+/).filter(Boolean);
        const found = this.eligible()
          .map(({ tool }) => ({
            tool,
            score: words.reduce(
              (n, word) => n + Number(`${tool.name} ${tool.description}`.toLowerCase().includes(word)),
              0,
            ),
          }))
          .filter((entry) => entry.score > 0)
          .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));
        return this.reply({
          tools: found
            .slice(0, input.limit ?? 8)
            .map(({ tool }) => ({
              toolId: tool.name,
              server: tool.source?.kind === 'mcp' ? tool.source.serverId : '',
              description: tool.description.slice(0, 200),
            })),
          total: found.length,
        });
      }
      if (name === 'code_describe') {
        const input = describeSchema.parse(args);
        const available = this.eligible();
        const selected = [...new Set(input.toolIds)].map((id) => {
          const capability = available.find((c) => c.tool.name === id);
          if (!capability)
            throw new CodeModeError(
              'UNAVAILABLE_TOOL',
              `${id} is unavailable or its schema is unsupported by this prototype.`,
            );
          return capability;
        });
        const manifestId = randomUUID();
        const reply = this.reply({
          manifestId,
          tools: selected.map(({ tool }) => ({
            toolId: tool.name,
            description: tool.description,
            ...tool.codeMode,
          })),
        });
        this.manifests.set(manifestId, new Map(selected.map((c) => [c.tool.name, c])));
        return reply;
      }
      const input = executeSchema.parse(args);
      if (++this.executions > CODE_LIMITS.executions)
        throw new CodeModeError('LIMIT_EXCEEDED', 'Execution budget exceeded.');
      const manifest = this.manifests.get(input.manifestId);
      if (!manifest || !this.offeredManifests.has(input.manifestId))
        throw new CodeModeError(
          'STALE_MANIFEST',
          'Describe tools and read that result before generating this program.',
        );
      return await this.execute(input.code, manifest, signal, parentId);
    } catch (e) {
      return this.failure(e);
    }
  }

  private reply(value: unknown) {
    const content = JSON.stringify(value);
    if (jsonBytes(value) > CODE_LIMITS.outputBytes || content.length > this.deps.maxResultChars())
      throw new CodeModeError(
        'LIMIT_EXCEEDED',
        'Result exceeds the current context budget. Describe fewer tools or return a smaller summary.',
      );
    return { content, status: 'success' as const };
  }

  private failure(e: unknown) {
    const code =
      e instanceof CodeModeError ? e.code : e instanceof z.ZodError ? 'INVALID_ARGUMENTS' : 'EXECUTION_ERROR';
    const message = redactKnown(
      e instanceof Error ? e.message : 'Code execution failed.',
      this.deps.secrets,
    ).slice(0, 800);
    return {
      content: JSON.stringify({ status: 'error', error: { code, message } }),
      status:
        code === 'CANCELLED'
          ? ('cancelled' as const)
          : code === 'DENIED'
            ? ('denied' as const)
            : ('error' as const),
    };
  }

  private async execute(
    code: string,
    manifest: Map<string, Capability>,
    signal: AbortSignal,
    parentId: string,
  ) {
    const abort = new AbortController();
    const cancel = () => abort.abort();
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    const traces: CodeCallTrace[] = [];
    const queue: Array<{ server: string; start(): void; reject(error: Error): void }> = [];
    const servers = new Map<string, number>();
    let running = 0;
    let awaiting = 0;
    let dispatched = 0;
    let bytes = 0;
    let fatal: CodeModeError | undefined;
    const emit = () =>
      this.deps.emit(
        traces.map((t) => ({ ...t })),
        parentId,
      );
    const halt = (error: CodeModeError): never => {
      fatal = error;
      abort.abort();
      throw error;
    };
    const drain = () => {
      if (abort.signal.aborted) {
        for (const entry of queue.splice(0))
          entry.reject(fatal ?? new CodeModeError('CANCELLED', 'Execution stopped.'));
        return;
      }
      while (running < CODE_LIMITS.concurrency) {
        const index = queue.findIndex((job) => (servers.get(job.server) ?? 0) < CODE_LIMITS.perServer);
        if (index < 0) return;
        const [job] = queue.splice(index, 1);
        job!.start();
      }
    };
    abort.signal.addEventListener('abort', drain);
    try {
      const value = await this.deps.sandbox.execute(code, {
        signal: abort.signal,
        maxOutputBytes: Math.max(
          128,
          Math.min(CODE_LIMITS.outputBytes - 512, this.deps.maxResultChars() - 512),
        ),
        waitingForApproval: () => awaiting > 0 && dispatched === 0,
        call: async (id, args, rpcSignal) => {
          if (abort.signal.aborted || rpcSignal.aborted)
            throw fatal ?? new CodeModeError('CANCELLED', 'Execution stopped.');
          const capability = manifest.get(id);
          if (!capability)
            return halt(new CodeModeError('DENIED', 'Tool is not in this execution manifest.'));
          const authorize = () => {
            const current = this.deps.available().find((t) => t.name === id);
            return current !== capability.tool || JSON.stringify(current.codeMode) !== capability.schema
              ? 'Tool definition or permissions changed. Describe the current tool again.'
              : undefined;
          };
          if (authorize()) return halt(new CodeModeError('DENIED', authorize()!));
          const current = capability.tool;
          if (++this.calls > CODE_LIMITS.runCalls || traces.length >= CODE_LIMITS.calls)
            return halt(new CodeModeError('LIMIT_EXCEEDED', 'MCP call budget exceeded.'));
          if (jsonBytes(args) > CODE_LIMITS.argumentBytes || !capability.validate(args))
            throw new CodeModeError(
              'INVALID_ARGUMENTS',
              'Arguments do not match the described MCP input schema.',
            );
          if (queue.length >= CODE_LIMITS.queue)
            return halt(
              new CodeModeError('LIMIT_EXCEEDED', 'Too many queued calls. Use batches of at most four.'),
            );
          const server = current.source!.kind === 'mcp' ? current.source!.serverId : '';
          const trace: CodeCallTrace = {
            id: randomUUID(),
            tool: id,
            server,
            status: 'queued',
            durationMs: 0,
          };
          traces.push(trace);
          emit();
          return new Promise<CodeCallResult>((resolve, reject) => {
            queue.push({
              server,
              reject,
              start: () => {
                running++;
                servers.set(server, (servers.get(server) ?? 0) + 1);
                const start = performance.now();
                let inFlight = false;
                void this.deps
                  .dispatch(
                    current,
                    args,
                    rpcSignal,
                    (status) => {
                      trace.status = status;
                      if (status === 'running' && !inFlight) {
                        inFlight = true;
                        dispatched++;
                      }
                      emit();
                    },
                    (waiting) => {
                      awaiting += waiting ? 1 : -1;
                    },
                    parentId,
                    authorize,
                  )
                  .then(({ message, raw }) => {
                    if (abort.signal.aborted || rpcSignal.aborted)
                      throw new CodeModeError('CANCELLED', 'Execution stopped.');
                    if (message.status === 'denied')
                      return halt(new CodeModeError('DENIED', message.content));
                    if (message.status !== 'success' || !raw)
                      throw new CodeModeError('MCP_ERROR', message.content.slice(0, 1000));
                    const response = normalizeCodeResult(raw);
                    const size = jsonBytes(response);
                    bytes += size;
                    if (size > CODE_LIMITS.responseBytes || bytes > CODE_LIMITS.totalResponseBytes)
                      return halt(
                        new CodeModeError(
                          'LIMIT_EXCEEDED',
                          'MCP response budget exceeded. Paginate the query.',
                        ),
                      );
                    trace.responseBytes = size;
                    trace.status = 'success';
                    resolve(maskResult(response, this.deps.secrets));
                  })
                  .catch((e: unknown) => {
                    trace.status =
                      e instanceof CodeModeError && e.code === 'DENIED'
                        ? 'denied'
                        : rpcSignal.aborted
                          ? 'unknown'
                          : 'error';
                    reject(e);
                  })
                  .finally(() => {
                    if (inFlight) dispatched--;
                    trace.durationMs = performance.now() - start;
                    running--;
                    servers.set(server, (servers.get(server) ?? 1) - 1);
                    emit();
                    drain();
                  });
              },
            });
            drain();
          });
        },
      });
      if (fatal) throw fatal;
      return {
        ...this.reply({
          status: traces.some((t) => t.status !== 'success') ? 'partial' : 'success',
          value,
          stats: { calls: traces.length, responseBytes: bytes },
        }),
        calls: traces,
      };
    } catch (e) {
      return { ...this.failure(fatal ?? e), calls: traces };
    } finally {
      abort.abort();
      for (const trace of traces)
        if (trace.status === 'queued' || trace.status === 'awaiting_approval') trace.status = 'cancelled';
        else if (trace.status === 'running') trace.status = 'unknown';
      emit();
      signal.removeEventListener('abort', cancel);
      abort.signal.removeEventListener('abort', drain);
    }
  }
}

export function normalizeCodeResult(result: ToolResult): CodeCallResult {
  const raw = result.mcpResult;
  const blocks = Array.isArray(raw?.content) ? raw.content : [];
  const textBlocks = blocks.filter(
    (b): b is { type: string; text: string } =>
      !!b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string',
  );
  const contentTypes = [
    ...new Set(
      blocks.map((b: unknown) =>
        b && typeof b === 'object' && 'type' in b ? String(b.type).slice(0, 40) : 'unknown',
      ),
    ),
  ];
  const response: CodeCallResult = { contentTypes };
  if (raw?.structuredContent !== undefined) response.data = raw.structuredContent;
  else if (textBlocks.length === 1) {
    try {
      response.data = JSON.parse(textBlocks[0]!.text);
    } catch {
      /* Text remains text. */
    }
  }
  if (response.data === undefined)
    response.text = textBlocks.map((b) => b.text).join('\n\n') || result.content;
  return response;
}

function maskResult(result: CodeCallResult, secrets: readonly (string | undefined)[]): CodeCallResult {
  // JSON replacer masks values before escaping, including credentials containing quotes or newlines.
  return JSON.parse(
    JSON.stringify(result, (_key, value: unknown) =>
      typeof value === 'string' ? redactKnown(value, secrets) : value,
    ),
  ) as CodeCallResult;
}
