import { z } from 'zod';
import type { AgentMode } from '../permissions/policy';
import type { ToolSchema } from '../providers/types';
import type { AnyTool } from './types';

/** Tools that come and go while Sovran runs (the tools of connected MCP servers). Asked again for every request. */
export interface ToolSource {
  tools(): readonly AnyTool[];
}

export class ToolRegistry {
  private readonly tools = new Map<string, AnyTool>();
  private readonly sources: ToolSource[] = [];
  private readonly schemaCache = new Map<string, ToolSchema>();

  register(tool: AnyTool): this {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name)) throw new Error(`Invalid tool name: ${tool.name}`);
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
  list(mode: AgentMode): AnyTool[] {
    return [...this.tools.values(), ...this.fromSources()].filter((t) => mode === 'act' || t.risk === 'read');
  }

  /** A source can never shadow a built-in tool. */
  private fromSources(): AnyTool[] {
    return this.sources.flatMap((s) => s.tools()).filter((t) => !this.tools.has(t.name));
  }

  schema(tool: AnyTool): ToolSchema {
    // Given as JSON Schema (MCP tools): used as it is, and not cached, because a server may change it.
    if (tool.parameters) return { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } };
    let cached = this.schemaCache.get(tool.name);
    if (!cached) {
      const json = z.toJSONSchema(tool.schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
      delete json.$schema;
      cached = { type: 'function', function: { name: tool.name, description: tool.description, parameters: json } };
      this.schemaCache.set(tool.name, cached);
    }
    return cached;
  }

  schemas(tools: readonly AnyTool[]): ToolSchema[] {
    return tools.map((t) => this.schema(t));
  }
}
