/**
 * Reads the JSON snippet an MCP server's README gives for other hosts and turns it into Settings form values.
 * Accepted: `{ "mcpServers": { … } }` (Claude Desktop, Cursor, Cline), `{ "servers": { … } }` (VS Code mcp.json),
 * `{ "mcp": { "servers": … } }` (VS Code settings), a bare map of servers, one server object, or a fragment such as
 * `"github": { … }` without the outer braces. Comments and trailing commas (JSONC) are fine.
 *
 * A secret in the snippet (a token in `env`, an `Authorization` header) becomes the server's token, which Sovran keeps
 * in Secret Storage instead of settings.json. Every change is listed in `notes` so the user sees what happened.
 * Shared by the webview (no Node or DOM dependencies).
 */
import type { McpAuth } from '../core/mcp/rules';

export interface McpDraft {
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  auth: McpAuth;
  /** A token found in the snippet, for Secret Storage. */
  token?: string;
  notes: string[];
}

export type McpImport = { drafts: McpDraft[] } | { error: string };

/** A whole word of the name, so GITHUB_TOKEN and x-api-key match and TOKENIZER_PATH does not. */
const SECRET_NAME =
  /(^|[_-])(TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIALS?|PAT)($|[_-])/i;
/** Values that stand for "put your secret here" rather than being one. */
const PLACEHOLDER = /^\s*$|^<.*>$|^\$\{.*\}$|your[_-]|^x{3,}$|^\*+$|replace|changeme|^\.\.\.$/i;

/** Removes // and /* *\/ comments and trailing commas, leaving strings (URLs with //) untouched. */
export function stripJsonc(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i === -1) break;
      i++;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function parseLoose(text: string): unknown {
  const clean = stripJsonc(text).trim();
  for (const candidate of [clean, `{${clean}}`]) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next shape
    }
  }
  return undefined;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const isServer = (v: unknown): v is Record<string, unknown> =>
  isObject(v) &&
  (typeof v.command === 'string' || typeof v.url === 'string' || typeof v.serverUrl === 'string');

/** Splits a command line on spaces, honouring quotes, for snippets that put everything in `command`. */
function splitCommandLine(line: string): string[] {
  const parts: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(line); m; m = re.exec(line)) parts.push(m[1] ?? m[2] ?? m[3]!);
  return parts;
}

const strings = (v: unknown): Record<string, string> | undefined =>
  isObject(v)
    ? Object.fromEntries(
        Object.entries(v)
          .filter(([, x]) => x != null)
          .map(([k, x]) => [k, String(x)]),
      )
    : undefined;

function toDraft(name: string, s: Record<string, unknown>): McpDraft {
  const notes: string[] = [];
  const type = typeof s.type === 'string' ? s.type.toLowerCase() : '';
  const url = typeof s.url === 'string' ? s.url : typeof s.serverUrl === 'string' ? s.serverUrl : undefined;
  let auth: McpAuth = { type: 'none' };
  let token: string | undefined;

  if (url) {
    if (type === 'sse')
      notes.push(
        'The snippet uses the older SSE transport. Sovran connects with Streamable HTTP, which most servers also offer at the same address or at /mcp.',
      );
    const headers = strings(s.headers) ?? {};
    for (const [key, value] of Object.entries(headers)) {
      if (auth.type !== 'none') break;
      const bearer = /^bearer\s+(.*)$/i.exec(value);
      if (key.toLowerCase() === 'authorization' && bearer) {
        auth = { type: 'bearer' };
        delete headers[key];
        if (!PLACEHOLDER.test(bearer[1]!)) token = bearer[1]!.trim();
        notes.push(
          token
            ? 'The Authorization token moves to Secret Storage.'
            : 'Enter the token below: it is sent as "Authorization: Bearer <token>".',
        );
      } else if (SECRET_NAME.test(key)) {
        auth = { type: 'header', headerName: key };
        delete headers[key];
        if (!PLACEHOLDER.test(value)) token = value.trim();
        notes.push(
          token
            ? `The ${key} header moves to Secret Storage.`
            : `Enter the token below: it is sent in the ${key} header.`,
        );
      }
    }
    return {
      name,
      transport: 'http',
      url,
      ...(Object.keys(headers).length ? { headers } : {}),
      auth,
      ...(token ? { token } : {}),
      notes: [...notes, ...ignored(s)],
    };
  }

  let command = String(s.command);
  let args = Array.isArray(s.args) ? s.args.map(String) : [];
  if (!args.length && /\s/.test(command.trim())) {
    const [first = command, ...rest] = splitCommandLine(command);
    command = first;
    args = rest;
    notes.push('The command line was split into the command and its arguments.');
  }
  const env = strings(s.env) ?? {};
  for (const [key, value] of Object.entries(env)) {
    if (!SECRET_NAME.test(key)) continue;
    if (auth.type === 'none') {
      auth = { type: 'env', envName: key };
      delete env[key];
      if (!PLACEHOLDER.test(value)) token = value;
      notes.push(
        token
          ? `${key} moves to Secret Storage.`
          : `Enter the token below: it is given to the server as ${key}.`,
      );
    } else {
      notes.push(
        `${key} also looks like a secret. Sovran keeps one token per server, so ${key} stays in settings.json as plain text.`,
      );
    }
  }
  const cwd = typeof s.cwd === 'string' && s.cwd.trim() ? s.cwd : undefined;
  return {
    name,
    transport: 'stdio',
    command,
    ...(args.length ? { args } : {}),
    ...(Object.keys(env).length ? { env } : {}),
    ...(cwd ? { cwd } : {}),
    auth,
    ...(token ? { token } : {}),
    notes: [...notes, ...ignored(s)],
  };
}

/** Settings of other hosts that Sovran handles its own way. */
function ignored(s: Record<string, unknown>): string[] {
  const notes: string[] = [];
  if (s.autoApprove || s.alwaysAllow)
    notes.push(
      "Auto-approved tools are not imported: each tool asks first until you allow it in the server's tool list.",
    );
  if (s.disabled === true) notes.push('The snippet turns the server off; it is added turned on.');
  return notes;
}

export function parseMcpSnippet(text: string): McpImport {
  if (!text.trim()) return { error: "Paste the JSON from the server's README first." };
  const root = parseLoose(text);
  if (root === undefined)
    return { error: 'This is not valid JSON. Copy the whole snippet, including its braces.' };
  if (!isObject(root)) return { error: 'Expected a JSON object with the server\'s "command" or "url".' };
  const container = isObject(root.mcpServers)
    ? root.mcpServers
    : isObject(root.servers)
      ? root.servers
      : isObject(root.mcp) && isObject(root.mcp.servers)
        ? root.mcp.servers
        : root;
  if (isServer(container))
    return {
      drafts: [toDraft(typeof container.name === 'string' ? container.name : 'MCP server', container)],
    };
  const drafts = Object.entries(container)
    .filter(([, v]) => isServer(v))
    .map(([name, v]) => toDraft(name, v as Record<string, unknown>));
  return drafts.length
    ? { drafts }
    : { error: 'No server found: each one needs a "command" (local) or a "url" (remote).' };
}
