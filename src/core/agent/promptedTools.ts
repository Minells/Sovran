import type { ToolSchema } from '../providers/types';

/**
 * Text-based tool protocol for servers/models without native tool calling.
 * Format is deliberately close to the Hermes-style `<tool_call>` convention many open models were trained on.
 */
export function renderToolInstructions(tools: readonly ToolSchema[]): string {
  const specs = tools
    .map((t) => `## ${t.function.name}\n${t.function.description}\nParameters (JSON Schema): ${JSON.stringify(t.function.parameters)}`)
    .join('\n\n');
  return [
    '# Tools',
    'You can call tools. To call a tool, output a block exactly like this and then STOP your reply:',
    '<tool_call>',
    '{"name": "tool_name", "arguments": {"param": "value"}}',
    '</tool_call>',
    'Rules: use valid JSON with double quotes; one or more <tool_call> blocks per reply; never invent tool results.',
    'Results are returned to you in <tool_result> blocks in the next message.',
    'When you no longer need tools, reply normally without any <tool_call> block.',
    '',
    specs,
  ].join('\n');
}

export function serializeToolCall(name: string, argumentsJson: string): string {
  let args: unknown;
  try {
    args = JSON.parse(argumentsJson || '{}');
  } catch {
    args = argumentsJson;
  }
  return `<tool_call>\n${JSON.stringify({ name, arguments: args })}\n</tool_call>`;
}

export function formatToolResult(name: string, id: string, content: string, status: string): string {
  return `<tool_result name="${name}" id="${id}" status="${status}">\n${content}\n</tool_result>`;
}

/** Light repair for common model JSON mistakes: code fences, trailing commas, surrounding prose. */
export function repairJson(raw: string): string {
  let s = raw.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(s);
  if (fence?.[1] !== undefined) s = fence[1].trim();
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first > 0 && last > first) s = s.slice(first, last + 1);
  return s.replace(/,\s*([}\]])/g, '$1');
}

export function parseJsonLenient(raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const text = raw.trim() || '{}';
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    try {
      return { ok: true, value: JSON.parse(repairJson(text)) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}

export type ParsedBlock = { ok: true; name: string; argumentsJson: string } | { ok: false; error: string };

export function parseToolCallBlock(block: string): ParsedBlock {
  const parsed = parseJsonLenient(block);
  if (!parsed.ok) return { ok: false, error: `The <tool_call> block is not valid JSON: ${parsed.error}` };
  const v = parsed.value as { name?: unknown; arguments?: unknown; parameters?: unknown };
  if (!v || typeof v !== 'object' || typeof v.name !== 'string' || !v.name) {
    return { ok: false, error: 'The <tool_call> block must be a JSON object with a "name" string.' };
  }
  const args = v.arguments ?? v.parameters ?? {};
  return { ok: true, name: v.name, argumentsJson: typeof args === 'string' ? args : JSON.stringify(args) };
}
