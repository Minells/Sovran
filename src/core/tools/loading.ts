/**
 * On-demand tool loading: which tool definitions a model request carries.
 *
 * Every tool belongs to a unit. The core unit is always offered. The other units are offered once loaded: by the
 * budget rule when everything fits, from the tool calls already in a chat, by the model through `load_tools`, or when
 * the model calls a tool it has not loaded. Loading only makes a tool visible to the model. Availability and
 * permissions stay with the registry and the policy, which see loaded and always-offered tools alike.
 *
 * Loaded units stay loaded for the chat, and their tools follow the ones already offered: the start of the prompt,
 * where chat templates put tool definitions, then stays the same for the server's prefix cache.
 */
import { z } from 'zod';
import type { ToolSchema } from '../providers/types';
import type { AnyTool } from './types';

export const LOAD_TOOLS = 'load_tools';
export const CORE_UNIT = 'core';

/** `auto` loads tools on demand; `all` offers every available tool with every request. */
export type ToolLoadingMode = 'auto' | 'all';

/** Units a chat can load. Native ids are fixed; an MCP server's unit is `mcp:<server id>`. */
export const TOOL_UNIT_PATTERN =
  /^(?:diagnostics|symbols|git|git\.changes|git\.remote|web|mcp:[a-z0-9][a-z0-9-]{0,31})$/;

/** What each native unit offers, for the index in `load_tools`. */
const NATIVE_UNIT_HINTS: Readonly<Record<string, string>> = {
  diagnostics: 'errors and warnings reported in the editor',
  symbols: 'definitions, references and outlines from language servers',
  git: 'repository status, diffs, history and branches',
  'git.changes': 'stage, unstage and commit',
  'git.remote': 'fetch, pull, push and rebase',
  web: 'read a public URL',
};

/** Loading a unit also loads the units it builds on: Git writes and remote operations start from Git reads. */
const IMPLIED: Readonly<Record<string, readonly string[]>> = {
  'git.changes': ['git'],
  'git.remote': ['git'],
};

/** Share of the input budget that tool definitions may take before Sovran defers some of them. */
export const TOOL_BUDGET_SHARE = 0.1;

/** Tool names listed per unit in the index; a large MCP server is summarized after these. */
const INDEX_TOOL_NAMES = 12;

export interface LoadableUnit {
  id: string;
  /** Available tools of the unit, in registry order. */
  tools: AnyTool[];
  /** Estimated tokens of their definitions. */
  tokens: number;
}

export interface ToolOffer {
  /** Always-offered tools, in registry order. */
  core: AnyTool[];
  /** Tools of loaded units, unit by unit in load order. */
  loaded: AnyTool[];
  /**
   * Every loadable unit while at least one is not loaded, loaded ones included so that the index does not change as
   * units load. Empty when nothing is deferred: the request then carries no `load_tools`.
   */
  index: LoadableUnit[];
}

export function unitOf(tool: AnyTool): string {
  return tool.source?.kind === 'mcp' ? `mcp:${tool.source.serverId}` : (tool.unit ?? CORE_UNIT);
}

export function normalizeToolUnits(value: unknown): string[] {
  return Array.isArray(value)
    ? [
        ...new Set(value.filter((unit): unit is string => typeof unit === 'string' && TOOL_UNIT_PATTERN.test(unit))),
      ].slice(0, 64)
    : [];
}

/** The units of the available tools other than the core, in order of their first tool in the registry. */
export function loadableUnits(available: readonly AnyTool[], tokensOf: (tool: AnyTool) => number): LoadableUnit[] {
  const units = new Map<string, LoadableUnit>();
  for (const tool of available) {
    const id = unitOf(tool);
    if (id === CORE_UNIT) continue;
    const unit = units.get(id) ?? { id, tools: [], tokens: 0 };
    unit.tools.push(tool);
    unit.tokens += tokensOf(tool);
    units.set(id, unit);
  }
  return [...units.values()];
}

/**
 * Splits the available tools for one request. With every unit loaded the tools keep registry order, so the request
 * is the same as with on-demand loading turned off.
 */
export function offerTools(
  available: readonly AnyTool[],
  loaded: readonly string[],
  units: readonly LoadableUnit[],
): ToolOffer {
  if (units.every((unit) => loaded.includes(unit.id))) return { core: [...available], loaded: [], index: [] };
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  return {
    core: available.filter((tool) => unitOf(tool) === CORE_UNIT),
    loaded: loaded.flatMap((id) => byId.get(id)?.tools ?? []),
    index: [...units],
  };
}

/**
 * Units loaded up front because the definitions fit in `TOOL_BUDGET_SHARE` of the input budget: everything, else
 * every native unit, else none. A model with a large window then works as if nothing were deferred.
 */
export function unitsWithinBudget(coreTokens: number, units: readonly LoadableUnit[], budgetTokens: number): string[] {
  const limit = budgetTokens * TOOL_BUDGET_SHARE;
  const fits = (list: readonly LoadableUnit[]) => coreTokens + list.reduce((n, u) => n + u.tokens, 0) <= limit;
  if (fits(units)) return units.map((unit) => unit.id);
  const native = units.filter((unit) => !unit.id.startsWith('mcp:'));
  return fits(native) ? native.map((unit) => unit.id) : [];
}

/** Appends units, and the units they build on first, to `loaded`. Returns the ones that were not loaded yet. */
export function addUnits(loaded: string[], units: readonly string[]): string[] {
  const added: string[] = [];
  const add = (unit: string) => {
    if (loaded.includes(unit)) return;
    loaded.push(unit);
    added.push(unit);
  };
  for (const unit of units) {
    for (const implied of IMPLIED[unit] ?? []) add(implied);
    add(unit);
  }
  return added;
}

/** Units with everything they imply, in the order `addUnits` would load them. */
export function withImplied(units: readonly string[]): string[] {
  const out: string[] = [];
  addUnits(out, units);
  return out;
}

export function loadToolsSchema(index: readonly LoadableUnit[]): ToolSchema {
  const lines = index.map((unit) => {
    const names = unit.tools.map((tool) => tool.name);
    const listed =
      names.length > INDEX_TOOL_NAMES
        ? `${names.slice(0, INDEX_TOOL_NAMES).join(', ')} and ${names.length - INDEX_TOOL_NAMES} more`
        : names.join(', ');
    const hint = NATIVE_UNIT_HINTS[unit.id];
    return `- ${unit.id}${hint ? ` (${hint})` : ''}: ${listed}`;
  });
  return {
    type: 'function',
    function: {
      name: LOAD_TOOLS,
      description: [
        'Load more tools before you use them. They are available from your next step. Units:',
        ...lines,
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          units: { type: 'array', items: { type: 'string', enum: index.map((unit) => unit.id) } },
        },
        required: ['units'],
      },
    },
  };
}

const loadRequestSchema = z.object({
  units: z.union([z.string(), z.array(z.string()).min(1).max(32)]),
});

/**
 * Validates `load_tools` arguments against the index. A tool name stands for its unit, since small models often
 * name the tool they want.
 */
export function resolveLoadRequest(
  value: unknown,
  index: readonly LoadableUnit[],
): { ok: true; units: string[] } | { ok: false; error: string } {
  const parsed = loadRequestSchema.safeParse(value);
  const ids = index.map((unit) => unit.id);
  if (!parsed.success) return { ok: false, error: `Name the units to load in "units", for example ["${ids[0]}"].` };
  const requested = typeof parsed.data.units === 'string' ? [parsed.data.units] : parsed.data.units;
  const units: string[] = [];
  for (const name of requested) {
    const unit =
      index.find((u) => u.id === name.trim()) ?? index.find((u) => u.tools.some((tool) => tool.name === name.trim()));
    if (!unit) return { ok: false, error: `Unknown unit "${name}". Units you can load: ${ids.join(', ')}.` };
    if (!units.includes(unit.id)) units.push(unit.id);
  }
  return { ok: true, units: withImplied(units).filter((id) => ids.includes(id)) };
}
