/** Stable group ids are persisted per chat; MCP ids retain the configured server id across reconnects. */
export const TOOL_GROUP_PATTERN =
  /^(?:files|context|editing|terminal|git|web|other|mcp:[a-z0-9][a-z0-9-]{0,31})$/;
export const TOOL_GROUP_LABELS: Record<string, string> = {
  files: 'Read files and search',
  context: 'Editor and diagnostics',
  editing: 'Edit files',
  terminal: 'Terminal',
  git: 'Git',
  web: 'Web fetch',
  other: 'Other native tools',
};

export function normalizeExcludedGroups(value: unknown): string[] {
  return Array.isArray(value)
    ? [
        ...new Set(value.filter((id): id is string => typeof id === 'string' && TOOL_GROUP_PATTERN.test(id))),
      ].slice(0, 506)
    : [];
}
