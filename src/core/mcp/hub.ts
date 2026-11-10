/**
 * The MCP client: one connection per configured server, the tools they offer, and the calls the agent makes to them.
 *
 * The hub turns each tool of a connected server into a `ToolDefinition` (it is a `ToolSource` of the registry), with
 * `risk: 'execute'`: MCP tools exist only in Act mode, never in Plan mode or an untrusted workspace, and ask before they
 * run unless the user allowed them (see `PolicyInput.mcp`). Transports come from a factory the host provides, so the
 * core never spawns a process or opens a socket itself, and tests connect servers in memory.
 */
import {
  Client,
  ProtocolError,
  SdkError,
  SdkErrorCode,
  type Tool,
  type Transport,
} from '@modelcontextprotocol/client';
import { z } from 'zod';
import { integrationCallProblem, integrationToolAllowed } from './catalog';
import { estimateTokens } from '../context/contextManager';
import type { Logger, McpToolHint } from '../ports';
import { redact } from '../security/redact';
import type { ToolSource } from '../tools/registry';
import { ToolError, type AnyTool, type ToolResult } from '../tools/types';
import { toolPolicy, transportOf, type McpServerConfig, type McpToolPolicy } from './config';
import { commandNotFound, McpConfigError } from './launch';
import { mcpToolName } from './naming';
import { formatToolResult } from './results';
import type { McpStatus } from './status';

/** Starting a server can include `npx` downloading it on first use. */
const CONNECT_TIMEOUT_MS = 120_000;
/** A request that keeps reporting progress may run this long in total. */
const MAX_TOTAL_MS = 3_600_000;
const MAX_DESCRIPTION = 1024;
const MAX_ARGUMENTS_SHOWN = 8000;
/** Lines of the server's stderr kept to explain a failure. */
const STDERR_LINES = 20;
/** A schema larger than this is replaced by a permissive one, so one tool cannot fill the context window. */
const MAX_SCHEMA_CHARS = 16_000;

export type { McpStatus };

export interface McpTransportFactory {
  /**
   * Creates (does not start) the transport for a server. `log` receives the server's diagnostic output (stderr) line by
   * line. Throws `McpConfigError` when the server cannot start as configured (a missing token, an unknown variable).
   */
  create(server: McpServerConfig, log: (line: string) => void): Promise<Transport>;
}

export interface McpToolInfo {
  name: string;
  title?: string;
  description?: string;
  /** The name the model calls it by. */
  modelName: string;
  policy: McpToolPolicy;
  hints: McpToolHint[];
  /** Estimated tokens its definition adds to every request while it is offered. */
  definitionTokens: number;
}

export interface McpServerState {
  config: McpServerConfig;
  status: McpStatus;
  /** Why the server is not connected, for the user. */
  error?: string;
  /** The server's own name and version, once connected. */
  server?: { name: string; version: string };
  tools: McpToolInfo[];
}

export interface McpHubDeps {
  transports: McpTransportFactory;
  logger: Logger;
  /** How Sovran introduces itself to servers. */
  client: { name: string; version: string };
  /** Called whenever a status or a tool list changes. */
  onChange?: () => void;
  /** Values to mask in anything shown or logged (the servers' tokens). */
  secrets?: () => readonly (string | undefined)[];
}

interface Connection {
  config: McpServerConfig;
  /** Bumped on every start and stop: callbacks of an older connection see a different number and do nothing. */
  generation: number;
  status: McpStatus;
  error?: string;
  client?: Client;
  transport?: Transport;
  tools: Tool[];
  /** Definitions remain stable across policy-only updates, but not discovery or reconnects. */
  definitions: WeakMap<Tool, AnyTool>;
  server?: { name: string; version: string };
  stderr: string[];
}

/** Arguments are an object; a model that sends nothing at all means "no arguments". */
const argumentsSchema = z.preprocess((v) => (v == null ? {} : v), z.record(z.string(), z.unknown()));

/** Settings that need a new connection when they change. Names, timeouts and tool policies apply in place. */
const connectionKey = (s: McpServerConfig) =>
  JSON.stringify([s.command, s.args, s.env, s.cwd, s.url, s.headers, s.auth, s.managed]);

function hintsOf(tool: Tool): McpToolHint[] {
  const a = tool.annotations;
  if (!a) return [];
  const hints: McpToolHint[] = [];
  if (a.readOnlyHint === true) hints.push('read-only');
  else if (a.destructiveHint === true) hints.push('destructive');
  if (a.openWorldHint === true) hints.push('open-world');
  return hints;
}

/** The input schema as an OpenAI-style function `parameters` object. */
function parametersOf(tool: Tool): Record<string, unknown> {
  const { $schema: _ignored, ...schema } = (tool.inputSchema ?? {}) as Record<string, unknown>;
  const object = { ...schema, type: 'object', properties: (schema.properties as object | undefined) ?? {} };
  return JSON.stringify(object).length > MAX_SCHEMA_CHARS
    ? { type: 'object', properties: {}, additionalProperties: true }
    : object;
}

function descriptionOf(tool: Tool, server: string): string {
  const text = (tool.description ?? '').trim();
  const cut = text.length > MAX_DESCRIPTION ? `${text.slice(0, MAX_DESCRIPTION - 1).trimEnd()}…` : text;
  return `${tool.title ? `${tool.title}. ` : ''}${cut || `Tool "${tool.name}".`} (MCP server "${server}")`;
}

/** Words of a line that explains a failure, in the server's own output. */
const ERROR_LINE =
  /\b(error|exception|fatal|panic|failed|failure|cannot|can't|unable|denied|refused|not found|no such|invalid|missing|unauthori[sz]ed|forbidden)\b/i;

/**
 * The line of a server's stderr that best explains a failure: the last that reads like an error, else the last one.
 * A crash rarely ends on its reason (Node ends with its version, Python with the exception after the traceback).
 */
export function tellingLine(lines: readonly string[]): string | undefined {
  for (let i = lines.length - 1; i >= 0; i--) if (ERROR_LINE.test(lines[i]!)) return lines[i];
  return lines.at(-1);
}

export class McpHub implements ToolSource {
  private connections = new Map<string, Connection>();
  private active = false;
  private generation = 0;
  private cache: AnyTool[] | undefined;
  private disposed = false;

  constructor(private readonly deps: McpHubDeps) {}

  // ------------------------------------------------------------------------------------------ lifecycle

  /**
   * Applies the configured servers: starts new and enabled ones, stops removed and disabled ones, and reconnects those
   * whose connection settings changed. While inactive (an untrusted workspace) no server runs.
   */
  update(servers: readonly McpServerConfig[], active: boolean): void {
    if (this.disposed) return;
    this.active = active;
    const next = new Map<string, Connection>();
    for (const config of servers) {
      const old = this.connections.get(config.id);
      const keep =
        old && connectionKey(old.config) === connectionKey(config) && old.config.enabled === config.enabled;
      if (old && keep) {
        old.config = config;
        if (active && config.enabled && old.status === 'stopped') void this.start(old);
        if (!active && old.status !== 'disabled') void this.stop(old);
        next.set(config.id, old);
        continue;
      }
      if (old) void this.stop(old);
      const conn: Connection = {
        config,
        generation: 0,
        status: config.enabled ? 'stopped' : 'disabled',
        tools: [],
        definitions: new WeakMap(),
        stderr: [],
      };
      next.set(config.id, conn);
      if (active && config.enabled) void this.start(conn);
    }
    for (const [id, old] of this.connections) if (!next.has(id)) void this.stop(old);
    this.connections = next;
    this.changed();
  }

  /** Connects again (after a crash, a new token or a change on the server's side). */
  async restart(id: string): Promise<void> {
    const conn = this.connections.get(id);
    if (!conn || !conn.config.enabled || !this.active) return;
    await this.stop(conn);
    await this.start(conn);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.all([...this.connections.values()].map((c) => this.stop(c)));
    this.connections.clear();
  }

  private stale(conn: Connection, generation: number) {
    return this.disposed || conn.generation !== generation || this.connections.get(conn.config.id) !== conn;
  }

  private async start(conn: Connection): Promise<void> {
    const generation = (conn.generation = ++this.generation);
    const { config } = conn;
    conn.status = 'starting';
    conn.error = undefined;
    conn.stderr = [];
    conn.tools = [];
    this.changed();
    let client: Client | undefined;
    try {
      const transport = await this.deps.transports.create(config, (line) =>
        this.onLog(conn, generation, line),
      );
      if (this.stale(conn, generation)) return void transport.close().catch(() => undefined);
      client = new Client(this.deps.client, {
        listChanged: {
          tools: { onChanged: (error, tools) => this.onToolsChanged(conn, generation, error, tools) },
        },
      });
      client.onclose = () => this.onClosed(conn, generation);
      client.onerror = (e) => this.deps.logger.debug(`MCP ${config.id}: ${this.clean(e.message)}`);
      conn.client = client;
      conn.transport = transport;
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
      if (this.stale(conn, generation)) return void client.close().catch(() => undefined);
      const tools = client.getServerCapabilities()?.tools
        ? (await client.listTools(undefined, { timeout: config.timeoutSeconds * 1000 })).tools
        : [];
      if (this.stale(conn, generation)) return void client.close().catch(() => undefined);
      const info = client.getServerVersion();
      conn.server = info ? { name: info.name, version: info.version } : undefined;
      conn.tools = tools.filter((tool) => integrationToolAllowed(config.managed, tool.name));
      conn.status = 'connected';
      this.deps.logger.info(
        `MCP ${config.id}: connected${info ? ` to ${info.name} ${info.version}` : ''} · ${tools.length} tool${tools.length === 1 ? '' : 's'}`,
      );
    } catch (e) {
      if (this.stale(conn, generation)) return;
      conn.status = 'error';
      conn.error = this.describeStartFailure(e, conn);
      conn.client = undefined;
      conn.transport = undefined;
      this.deps.logger.warn(`MCP ${config.id}: ${conn.error}`);
      void client?.close().catch(() => undefined);
    }
    this.changed();
  }

  private async stop(conn: Connection): Promise<void> {
    conn.generation = ++this.generation;
    const { client, transport } = conn;
    conn.client = undefined;
    conn.transport = undefined;
    conn.tools = [];
    conn.error = undefined;
    conn.status = conn.config.enabled ? 'stopped' : 'disabled';
    if (!client) return;
    // A Streamable HTTP server keeps a session until it is told to end it; never wait long for that.
    const terminate = (transport as { terminateSession?: () => Promise<void> } | undefined)?.terminateSession;
    if (terminate)
      await Promise.race([
        terminate.call(transport).catch(() => undefined),
        new Promise((r) => setTimeout(r, 2000)),
      ]);
    await client.close().catch(() => undefined);
  }

  private onClosed(conn: Connection, generation: number) {
    if (this.stale(conn, generation) || conn.status !== 'connected') return;
    const last = tellingLine(conn.stderr);
    conn.status = 'error';
    conn.error = `The server stopped${last ? `: ${last}` : '.'}`;
    conn.client = undefined;
    conn.transport = undefined;
    conn.tools = [];
    this.deps.logger.warn(`MCP ${conn.config.id}: ${conn.error}`);
    this.changed();
  }

  private onToolsChanged(conn: Connection, generation: number, error: Error | null, tools: Tool[] | null) {
    if (this.stale(conn, generation)) return;
    if (error)
      return this.deps.logger.warn(
        `MCP ${conn.config.id}: could not refresh the tool list: ${this.clean(error.message)}`,
      );
    conn.tools = (tools ?? []).filter((tool) => integrationToolAllowed(conn.config.managed, tool.name));
    this.deps.logger.info(`MCP ${conn.config.id}: tool list changed · ${conn.tools.length} tools`);
    this.changed();
  }

  private onLog(conn: Connection, generation: number, line: string) {
    if (this.stale(conn, generation) || !line.trim()) return;
    const clean = this.clean(line.trim()).slice(0, 500);
    conn.stderr.push(clean);
    if (conn.stderr.length > STDERR_LINES) conn.stderr.shift();
    this.deps.logger.debug(`MCP ${conn.config.id} › ${clean}`);
  }

  private changed() {
    this.cache = undefined;
    this.deps.onChange?.();
  }

  private clean(text: string) {
    return redact(text, this.deps.secrets?.() ?? []);
  }

  // ------------------------------------------------------------------------------------------ state

  states(): McpServerState[] {
    return [...this.connections.values()].map((c) => ({
      config: c.config,
      status: c.status,
      ...(c.error ? { error: c.error } : {}),
      ...(c.server ? { server: c.server } : {}),
      tools: c.tools.map((t) => {
        const modelName = mcpToolName(c.config.id, t.name);
        return {
          name: t.name,
          ...(t.title ? { title: t.title } : {}),
          ...(t.description ? { description: t.description } : {}),
          modelName,
          policy: toolPolicy(c.config, t.name),
          hints: hintsOf(t),
          definitionTokens: estimateTokens(
            modelName + descriptionOf(t, c.config.name) + JSON.stringify(parametersOf(t)),
          ),
        };
      }),
    }));
  }

  /** The server and tool behind a model-facing name, for labels. */
  describe(modelName: string): { server: string; tool: string } | undefined {
    for (const c of this.connections.values()) {
      const t = c.tools.find((x) => mcpToolName(c.config.id, x.name) === modelName);
      if (t) return { server: c.config.name, tool: t.title ?? t.name };
    }
    return undefined;
  }

  // ------------------------------------------------------------------------------------------ tools

  /** Tools of connected servers, except those turned off. Rebuilt only when something changed. */
  tools(): readonly AnyTool[] {
    if (this.cache) return this.cache;
    const out: AnyTool[] = [];
    const names = new Set<string>();
    for (const c of this.connections.values()) {
      if (c.status !== 'connected') continue;
      for (const t of c.tools) {
        if (toolPolicy(c.config, t.name) === 'off') continue;
        const name = mcpToolName(c.config.id, t.name);
        if (names.has(name)) {
          this.deps.logger.warn(`MCP ${c.config.id}: skipped a second tool named "${t.name}".`);
          continue;
        }
        names.add(name);
        let definition = c.definitions.get(t);
        if (!definition) {
          definition = this.toolDefinition(c.config.id, t, name);
          c.definitions.set(t, definition);
        }
        out.push(definition);
      }
    }
    return (this.cache = out);
  }

  private toolDefinition(serverId: string, tool: Tool, name: string): AnyTool {
    const server = () => this.connections.get(serverId)?.config;
    const label = () => `${tool.title ?? tool.name} · ${server()?.name ?? serverId}`;
    const connection = this.connections.get(serverId)!;
    const generation = connection.generation;
    const definition: AnyTool = {
      name,
      description: descriptionOf(tool, server()?.name ?? serverId),
      schema: argumentsSchema,
      parameters: parametersOf(tool),
      risk: 'execute',
      source: { kind: 'mcp', serverId },
      group: `mcp:${serverId}`,
      requiresTrust: true,
      unavailable: () => {
        const current = this.connections.get(serverId);
        if (
          current !== connection ||
          current.generation !== generation ||
          current.status !== 'connected' ||
          !current.tools.includes(tool)
        ) {
          return `${tool.name} is no longer available from this MCP connection.`;
        }
        const config = server();
        return !this.active || !config?.enabled || toolPolicy(config, tool.name) === 'off'
          ? `${tool.name} is turned off in Sovran's MCP settings.`
          : undefined;
      },
      mcpPolicy: () => {
        const config = server();
        return {
          server: config?.name ?? serverId,
          allowed: !!config && toolPolicy(config, tool.name) === 'allow',
        };
      },
      label,
      prepare: async (args: Record<string, unknown>) => {
        // Read at call time: the user may have changed the tool's policy while the run was going.
        const config = server();
        const policy = config ? toolPolicy(config, tool.name) : 'off';
        if (!config || policy === 'off')
          throw new ToolError(`${tool.name} is turned off in Sovran's MCP settings.`);
        const problem = integrationCallProblem(config.managed, tool.name, args);
        if (problem) throw new ToolError(problem);
        const shown = JSON.stringify(args, null, 2);
        return {
          paths: [],
          mcp: { server: config.name, allowed: policy === 'allow' },
          approval: {
            kind: 'mcp',
            serverId,
            server: config.name,
            tool: tool.name,
            ...(tool.title ? { title: tool.title } : {}),
            arguments:
              shown.length > MAX_ARGUMENTS_SHOWN ? `${shown.slice(0, MAX_ARGUMENTS_SHOWN)}\n…` : shown,
            hints: hintsOf(tool),
          },
        };
      },
      execute: async (args: Record<string, unknown>, ctx) => {
        const reason = definition.unavailable?.();
        if (reason) throw new ToolError(reason);
        return this.callTool(serverId, tool.name, args, ctx.signal, label());
      },
    };
    return definition;
  }

  /** Calls a tool. Protocol failures become a `ToolError` the model can read; a failed tool is an error result. */
  async callTool(
    serverId: string,
    tool: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    summary?: string,
  ): Promise<ToolResult> {
    const conn = this.connections.get(serverId);
    const name = conn?.config.name ?? serverId;
    if (!conn?.client || conn.status !== 'connected') {
      throw new ToolError(
        `The MCP server ${name} is not connected${conn?.error ? ` (${conn.error})` : ''}. Restart it in Sovran Settings → MCP.`,
      );
    }
    if (signal.aborted) throw new ToolError('Cancelled by the user.');
    if (!this.active || !conn.config.enabled || toolPolicy(conn.config, tool) === 'off') {
      throw new ToolError(`${tool} is turned off in Sovran's MCP settings.`);
    }
    if (!conn.tools.some((t) => t.name === tool))
      throw new ToolError(`${tool} is no longer offered by ${name}.`);
    const problem = integrationCallProblem(conn.config.managed, tool, args);
    if (problem) throw new ToolError(problem);
    const timeout = conn.config.timeoutSeconds * 1000;
    try {
      const result = await conn.client.callTool(
        { name: tool, arguments: args },
        { signal, timeout, resetTimeoutOnProgress: true, maxTotalTimeout: MAX_TOTAL_MS },
      );
      const formatted = formatToolResult(result);
      return { content: formatted.text, isError: formatted.isError, ...(summary ? { summary } : {}) };
    } catch (e) {
      if (signal.aborted) throw e;
      throw new ToolError(this.describeCallFailure(e, conn));
    }
  }

  // ------------------------------------------------------------------------------------------ messages

  private describeStartFailure(e: unknown, conn: Connection): string {
    const last = tellingLine(conn.stderr);
    const tail = last ? ` The server said: ${last}` : '';
    if (e instanceof McpConfigError) return e.message;
    const err = e as NodeJS.ErrnoException;
    if (err?.code === 'ENOENT' && transportOf(conn.config) === 'stdio') {
      return commandNotFound(conn.config.command ?? '');
    }
    if (SdkError.isInstance(e) && e.code === SdkErrorCode.RequestTimeout) {
      return `The server did not answer within ${CONNECT_TIMEOUT_MS / 1000} seconds.${tail}`;
    }
    if (SdkError.isInstance(e) && e.code === SdkErrorCode.ConnectionClosed) {
      return `The server closed the connection while starting.${tail || ' Check the command and its arguments, then Show logs.'}`;
    }
    const status = (e as { status?: unknown }).status;
    if (typeof status === 'number' && status >= 300 && status < 400) {
      const target = /Redirect to (\S+) not followed/.exec(e instanceof Error ? e.message : '')?.[1];
      return `The server redirected to ${target ?? 'another address'}. Sovran does not follow redirects to another address, so tokens and headers reach only the server you entered. If that is the right server, use its URL.`;
    }
    if (typeof status === 'number') {
      const hint =
        status === 401 || status === 403
          ? ' Check the token and where it is sent.'
          : status === 404
            ? ' Check the URL: it is usually the server address followed by /mcp.'
            : '';
      return `The server answered ${status}.${hint}`;
    }
    const message = this.clean(e instanceof Error ? e.message : String(e));
    return `${message || 'The server could not be started.'}${tail && !message.includes(last ?? '') ? tail : ''}`;
  }

  private describeCallFailure(e: unknown, conn: Connection): string {
    const name = conn.config.name;
    if (SdkError.isInstance(e) && e.code === SdkErrorCode.RequestTimeout) {
      return `${name} did not answer within ${conn.config.timeoutSeconds} seconds. If this tool is slow, raise the timeout in Sovran Settings → MCP.`;
    }
    if (
      SdkError.isInstance(e) &&
      (e.code === SdkErrorCode.ConnectionClosed || e.code === SdkErrorCode.NotConnected)
    ) {
      return `${name} stopped during the call. Restart it in Sovran Settings → MCP.`;
    }
    if (ProtocolError.isInstance(e)) return `${name} refused the call: ${this.clean(e.message)}`;
    return `The call to ${name} failed: ${this.clean(e instanceof Error ? e.message : String(e))}`;
  }
}
