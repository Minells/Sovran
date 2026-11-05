import { createHash } from 'node:crypto';

/** OpenAI-compatible servers reject function names longer than 64 characters or with other characters than these. */
const MAX_NAME = 64;
const INVALID = /[^A-Za-z0-9_-]/g;
export const MCP_TOOL_PREFIX = 'mcp__';

/**
 * The name the model sees for a tool of an MCP server: `mcp__<server>__<tool>`. A tool name that does not fit (too
 * long, or with characters such as `.` or `/`) is shortened or cleaned and gets a short hash of the original, so two
 * tools never end up with the same name. The name is only ever looked up, never parsed back.
 */
export function mcpToolName(serverId: string, tool: string): string {
  const raw = `${MCP_TOOL_PREFIX}${serverId}__${tool}`;
  const clean = raw.replace(INVALID, '_');
  if (clean === raw && raw.length <= MAX_NAME) return raw;
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 8);
  return `${clean.slice(0, MAX_NAME - hash.length - 1)}_${hash}`;
}

export const isMcpToolName = (name: string) => name.startsWith(MCP_TOOL_PREFIX);
