/**
 * MCP servers the user connects (`sovran.mcp.servers`). The list is read from user settings only: a repository must
 * never be able to make Sovran start a process or call an endpoint (SECURITY.md, T18).
 *
 * The settings shape follows the `command`/`url` convention every MCP host uses, so a snippet from a server's README
 * maps onto it field by field. Tokens never live here: `auth` only says where the token stored in Secret Storage goes.
 */
import { z } from 'zod';
import {
  ENV_NAME_PATTERN,
  HEADER_NAME_PATTERN,
  isHttpUrl,
  MCP_ID_PATTERN,
  MCP_MESSAGES,
  MCP_TIMEOUT_SECONDS,
  transportProblems,
  type McpAuth,
  type McpToolPolicy,
  type McpTransportKind,
} from './rules';

export {
  MCP_ID_PATTERN,
  MCP_TIMEOUT_SECONDS,
  transportProblems,
  type McpAuth,
  type McpToolPolicy,
  type McpTransportKind,
};

export interface McpServerConfig {
  id: string;
  name: string;
  enabled: boolean;
  /** A local server: the program Sovran starts and talks to over its stdin and stdout. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** A remote server: its Streamable HTTP endpoint. */
  url?: string;
  headers?: Record<string, string>;
  auth: McpAuth;
  /** How long a request may go without an answer or a progress update. */
  timeoutSeconds: number;
  /** Tools that run without asking. */
  allowedTools: string[];
  /** Tools the model is never offered. Wins over `allowedTools`. */
  disabledTools: string[];
}

export const transportOf = (s: Pick<McpServerConfig, 'url'>): McpTransportKind => (s.url ? 'http' : 'stdio');

export function toolPolicy(
  server: Pick<McpServerConfig, 'allowedTools' | 'disabledTools'>,
  tool: string,
): McpToolPolicy {
  if (server.disabledTools.includes(tool)) return 'off';
  return server.allowedTools.includes(tool) ? 'allow' : 'ask';
}

// ------------------------------------------------------------------------------------------------ schema

export const mcpEnvName = z.string().regex(ENV_NAME_PATTERN, MCP_MESSAGES.envName);
export const mcpHeaderName = z.string().regex(HEADER_NAME_PATTERN, MCP_MESSAGES.headerName);
export const mcpHttpUrl = z.string().trim().max(2000).refine(isHttpUrl, MCP_MESSAGES.url);

export const mcpAuthSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('bearer') }),
  z.object({ type: z.literal('header'), headerName: mcpHeaderName }),
  z.object({ type: z.literal('env'), envName: mcpEnvName }),
]);

const toolNames = z.array(z.string().min(1).max(200)).max(500);

/** One entry of `sovran.mcp.servers`, as written in settings.json. */
export const mcpServerEntrySchema = z
  .object({
    id: z
      .string()
      .regex(MCP_ID_PATTERN, 'Use 1 to 32 lowercase letters, digits and -, starting with a letter or digit.'),
    name: z.string().trim().min(1).max(80).optional(),
    enabled: z.boolean().optional(),
    command: z.string().trim().min(1).max(1000).optional(),
    args: z.array(z.string().max(4000)).max(100).optional(),
    env: z.record(mcpEnvName, z.string().max(8000)).optional(),
    cwd: z.string().trim().min(1).max(1000).optional(),
    url: mcpHttpUrl.optional(),
    headers: z.record(mcpHeaderName, z.string().max(8000)).optional(),
    auth: mcpAuthSchema.optional(),
    timeoutSeconds: z.number().int().min(MCP_TIMEOUT_SECONDS.min).max(MCP_TIMEOUT_SECONDS.max).optional(),
    allowedTools: toolNames.optional(),
    disabledTools: toolNames.optional(),
  })
  .superRefine((s, ctx) => {
    for (const problem of transportProblems(s)) ctx.addIssue({ code: 'custom', message: problem });
  });

export type McpServerEntry = z.infer<typeof mcpServerEntrySchema>;

export function fromEntry(e: McpServerEntry): McpServerConfig {
  return {
    id: e.id,
    name: e.name ?? e.id,
    enabled: e.enabled ?? true,
    ...(e.command ? { command: e.command } : {}),
    ...(e.args?.length ? { args: e.args } : {}),
    ...(e.env && Object.keys(e.env).length ? { env: e.env } : {}),
    ...(e.cwd ? { cwd: e.cwd } : {}),
    ...(e.url ? { url: e.url } : {}),
    ...(e.headers && Object.keys(e.headers).length ? { headers: e.headers } : {}),
    auth: e.auth ?? { type: 'none' },
    timeoutSeconds: e.timeoutSeconds ?? MCP_TIMEOUT_SECONDS.default,
    allowedTools: [...new Set(e.allowedTools ?? [])],
    disabledTools: [...new Set(e.disabledTools ?? [])],
  };
}

/** The settings.json form of a server: defaults are left out, so the file stays short and readable. */
export function toEntry(s: McpServerConfig): McpServerEntry {
  return {
    id: s.id,
    ...(s.name !== s.id ? { name: s.name } : {}),
    ...(s.enabled ? {} : { enabled: false }),
    ...(s.command ? { command: s.command } : {}),
    ...(s.args?.length ? { args: s.args } : {}),
    ...(s.env && Object.keys(s.env).length ? { env: s.env } : {}),
    ...(s.cwd ? { cwd: s.cwd } : {}),
    ...(s.url ? { url: s.url } : {}),
    ...(s.headers && Object.keys(s.headers).length ? { headers: s.headers } : {}),
    ...(s.auth.type !== 'none' ? { auth: s.auth } : {}),
    ...(s.timeoutSeconds !== MCP_TIMEOUT_SECONDS.default ? { timeoutSeconds: s.timeoutSeconds } : {}),
    ...(s.allowedTools.length ? { allowedTools: s.allowedTools } : {}),
    ...(s.disabledTools.length ? { disabledTools: s.disabledTools } : {}),
  };
}

/** Reads `sovran.mcp.servers`. Invalid entries are skipped with a problem each; a repeated id keeps the first. */
export function parseMcpServers(raw: unknown): { servers: McpServerConfig[]; problems: string[] } {
  const servers: McpServerConfig[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const [i, entry] of (Array.isArray(raw) ? raw : []).entries()) {
    const parsed = mcpServerEntrySchema.safeParse(entry);
    const label =
      typeof (entry as { id?: unknown })?.id === 'string' ? `"${(entry as { id: string }).id}"` : `#${i + 1}`;
    if (!parsed.success) {
      problems.push(
        `MCP server ${label}: ${parsed.error.issues.map((x) => (x.path.length ? `${x.path.join('.')}: ${x.message}` : x.message)).join('; ')}`,
      );
      continue;
    }
    if (seen.has(parsed.data.id)) {
      problems.push(`MCP server ${label} is listed twice; the first entry is used.`);
      continue;
    }
    seen.add(parsed.data.id);
    servers.push(fromEntry(parsed.data));
  }
  return { servers, problems };
}

/**
 * The new value of `sovran.mcp.servers` after a change made in Settings. Entries Sovran could not read (a typo made by
 * hand, a repeated id) are kept exactly as written, in place: changing one tool must never delete what the user typed.
 */
export function mergeMcpEntries(raw: unknown, servers: readonly McpServerConfig[]): unknown[] {
  const byId = new Map(servers.map((s) => [s.id, s]));
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    const parsed = mcpServerEntrySchema.safeParse(entry);
    if (!parsed.success || seen.has(parsed.data.id)) {
      out.push(entry);
      continue;
    }
    seen.add(parsed.data.id);
    const server = byId.get(parsed.data.id);
    if (server) out.push(toEntry(server));
  }
  for (const s of servers) if (!seen.has(s.id)) out.push(toEntry(s));
  return out;
}

/** A stable id for a new server, from its name, that no other server uses. */
export function newServerId(name: string, taken: ReadonlySet<string>): string {
  const base =
    name
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 28)
      .replace(/-+$/, '') || 'server';
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}
