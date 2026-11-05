/**
 * Rules for MCP server settings shared by the host's zod schemas and the webview's Settings form. Free of zod and of
 * Node modules, so the webview bundle stays small.
 */

export const MCP_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const MCP_TIMEOUT_SECONDS = { default: 60, min: 5, max: 3600 } as const;
export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** RFC 9110 token characters. */
export const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

export const MCP_MESSAGES = {
  envName: 'Use letters, digits and _ in environment variable names, not starting with a digit.',
  headerName: 'Header names cannot contain spaces or symbols such as : ( ) , ;',
  url: 'Enter the full http(s) URL of the MCP endpoint, for example https://mcp.example.com/mcp',
} as const;

/** Where the server's token goes: an Authorization header, another header, or an environment variable. */
export type McpAuth =
  | { type: 'none' }
  | { type: 'bearer' }
  | { type: 'header'; headerName: string }
  | { type: 'env'; envName: string };

/** Off: hidden from the model. Ask: offered, and asks before every call. Allow: offered, and runs without asking. */
export type McpToolPolicy = 'off' | 'ask' | 'allow';

export type McpTransportKind = 'stdio' | 'http';

export function isHttpUrl(value: string): boolean {
  try {
    const p = new URL(value.trim()).protocol;
    return p === 'http:' || p === 'https:';
  } catch {
    return false;
  }
}

/** One transport per server, and a token place that fits it. */
export function transportProblems(s: {
  command?: string;
  url?: string;
  headers?: object;
  env?: object;
  args?: unknown[];
  cwd?: string;
  auth?: McpAuth;
}): string[] {
  const problems: string[] = [];
  if (!s.command === !s.url)
    problems.push('Set either a command (a local server) or a URL (a remote server).');
  if (s.url && (s.env || s.args || s.cwd))
    problems.push('Arguments, environment and working folder only apply to local servers.');
  if (s.command && s.headers) problems.push('Headers only apply to remote servers.');
  if (s.url && s.auth?.type === 'env')
    problems.push('A remote server receives its token in a header: use "bearer" or "header".');
  if (s.command && (s.auth?.type === 'bearer' || s.auth?.type === 'header')) {
    problems.push('A local server receives its token in an environment variable: use "env".');
  }
  return problems;
}
