import { z } from 'zod';
import type { AgentMode } from '../permissions/policy';
import type { ToolSchema } from '../providers/types';
import { LOAD_TOOLS } from './loading';
import type { AnyTool } from './types';

/** Tools that come and go while Sovran runs (the tools of connected MCP servers). Asked again for every request. */
export interface ToolSource {
  tools(): readonly AnyTool[];
}

export interface ToolSelection {
  disabledTools?: readonly string[];
  workspaceTrusted?: boolean;
  excludedToolGroups?: readonly string[];
}

/** Below this, a `maxLength` is guidance the model can use (a subject line); above it, a guard against abuse. */
const GUARD_LENGTH = 1000;

/**
 * Drops from a derived JSON Schema the constraints that tell the model nothing: non-empty strings, guard lengths on
 * paths and texts, and the safe-integer bounds zod puts on every integer. They cost tokens in every request. The zod
 * schema still validates them; limits a model should respect (a page size of 50) stay.
 */
export function leanSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(leanSchema);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'minLength' && child === 1) continue;
    if (key === 'maxLength' && typeof child === 'number' && child >= GUARD_LENGTH) continue;
    if (key === 'maximum' && child === Number.MAX_SAFE_INTEGER) continue;
    if (key === 'minimum' && child === Number.MIN_SAFE_INTEGER) continue;
    out[key] = leanSchema(child);
  }
  return out;
}

export class ToolRegistry {
  private readonly tools = new Map<string, AnyTool>();
  private readonly sources: ToolSource[] = [];
  private readonly schemaCache = new WeakMap<AnyTool, ToolSchema>();

  register(tool: AnyTool): this {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name)) throw new Error(`Invalid tool name: ${tool.name}`);
    if (tool.name === LOAD_TOOLS) throw new Error(`Reserved tool name: ${tool.name}`);
    if (this.tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
    this.tools.set(tool.name, tool);
    return this;
  }

  addSource(source: ToolSource): this {
    this.sources.push(source);
    return this;
  }

  get(name: string): AnyTool | undefined {
    return this.tools.get(name) ?? this.fromSources().find((t) => t.name === name);
  }

  /** Tools offered to the model in a mode. Plan mode only ever sees read-only tools. */
  list(mode: AgentMode, selection: ToolSelection = {}): AnyTool[] {
    return this.all().filter((t) => !this.unavailable(t, mode, selection));
  }

  /** Current definitions for settings; permission checks still apply when listing for a model or dispatching. */
  all(): AnyTool[] {
    return [...this.tools.values(), ...this.fromSources()];
  }

  /** Visibility and dispatch share the same checks. A replaced definition needs a fresh model request. */
  unavailable(tool: AnyTool, mode: AgentMode, selection: ToolSelection = {}): string | undefined {
    if (this.get(tool.name) !== tool)
      return `${tool.name} is no longer available. Request its current definition before retrying.`;
    if (selection.excludedToolGroups?.includes(tool.group ?? 'other'))
      return `${tool.name} belongs to a tool group excluded from this chat.`;
    if (mode === 'plan' && tool.risk !== 'read')
      return `${tool.name} is not available in Plan mode (read-only).`;
    if ((tool.risk !== 'read' || tool.requiresTrust) && selection.workspaceTrusted === false) {
      return `${tool.name} is not available in Restricted Mode. Trust the workspace first.`;
    }
    if (tool.source?.kind !== 'mcp' && selection.disabledTools?.includes(tool.name)) {
      return `${tool.name} is disabled in Sovran's tool settings.`;
    }
    return tool.unavailable?.();
  }

  /** Native names win; ambiguous dynamic names fail closed instead of choosing an arbitrary source. */
  private fromSources(): AnyTool[] {
    const candidates = this.sources.flatMap((s) => s.tools());
    const counts = new Map<string, number>();
    for (const t of candidates) counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
    return candidates.filter(
      (t) => /^[a-zA-Z0-9_-]{1,64}$/.test(t.name) && !this.tools.has(t.name) && counts.get(t.name) === 1,
    );
  }

  schema(tool: AnyTool): ToolSchema {
    // Given as JSON Schema (MCP tools): used as it is, and not cached, because a server may change it.
    if (tool.parameters)
      return {
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      };
    let cached = this.schemaCache.get(tool);
    if (!cached) {
      const json = leanSchema(
        z.toJSONSchema(tool.schema, { io: 'input', unrepresentable: 'any' }),
      ) as Record<string, unknown>;
      delete json.$schema;
      cached = {
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: json },
      };
      this.schemaCache.set(tool, cached);
    }
    return cached;
  }

  schemas(tools: readonly AnyTool[]): ToolSchema[] {
    return tools.map((t) => this.schema(t));
  }
}
