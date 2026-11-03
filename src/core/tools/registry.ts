import { z } from 'zod';
import type { AgentMode } from '../permissions/policy';
import type { ToolSchema } from '../providers/types';
import type { AnyTool } from './types';

export class ToolRegistry {
  private readonly tools = new Map<string, AnyTool>();
  private readonly schemaCache = new Map<string, ToolSchema>();

  register(tool: AnyTool): this {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name)) throw new Error(`Invalid tool name: ${tool.name}`);
    if (this.tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): AnyTool | undefined {
    return this.tools.get(name);
  }

  /** Tools offered to the model in a mode. Plan mode only ever sees read-only tools. */
  list(mode: AgentMode): AnyTool[] {
    return [...this.tools.values()].filter((t) => mode === 'act' || t.risk === 'read');
  }

  schema(tool: AnyTool): ToolSchema {
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
