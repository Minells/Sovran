/**
 * How Sovran reaches a configured MCP server: variables expanded, the token put where `auth` says, the working folder
 * resolved. Separate from config.ts, which the webview also uses and which must stay free of Node modules.
 */
import * as path from 'node:path';
import { requiresToken, type McpServerConfig } from './config';

/** Values `${…}` variables expand to. `env` is the extension host's environment. */
export interface McpVariables {
  workspaceFolder?: string;
  userHome: string;
  env: Readonly<Record<string, string | undefined>>;
}

/** A server that cannot start as configured. The message says what to fix and is shown as the server's status. */
export class McpConfigError extends Error {
  override name = 'McpConfigError';
}

const VARIABLE = /\$\{([^}]*)\}/g;

/**
 * Expands `${workspaceFolder}`, `${userHome}` and `${env:NAME}`. Anything else, and a variable without a value, is a
 * problem rather than an empty string: a token that silently became "" fails much later with a far vaguer error.
 */
export function expandVariables(text: string, vars: McpVariables, problems: string[]): string {
  return text.replace(VARIABLE, (whole, name: string) => {
    if (name === 'workspaceFolder') {
      if (vars.workspaceFolder) return vars.workspaceFolder;
      problems.push('${workspaceFolder} needs an open folder.');
      return whole;
    }
    if (name === 'userHome') return vars.userHome;
    if (name.startsWith('env:')) {
      const key = name.slice(4);
      const value = vars.env[key];
      if (value !== undefined) return value;
      problems.push(`\${env:${key}} is not set in VS Code's environment.`);
      return whole;
    }
    problems.push(
      `${whole} is not a variable Sovran knows. Use \${workspaceFolder}, \${userHome} or \${env:NAME}; for a token, use the token option.`,
    );
    return whole;
  });
}

/**
 * Variables of the extension host a local server also receives, on top of the minimal set the SDK passes (PATH, HOME,
 * USER… or their Windows equivalents): proxies and certificate bundles, so `npx` and HTTP clients work behind a
 * corporate proxy, plus locale and temp folders. Other variables reach a server only when its `env` names them.
 */
export const MCP_INHERITED_ENV = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
] as const;

export function inheritedEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of MCP_INHERITED_ENV) {
    const value = env[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export type McpLaunch =
  | { kind: 'stdio'; command: string; args: string[]; env: Record<string, string>; cwd: string }
  | { kind: 'http'; url: string; headers: Record<string, string> };

/**
 * What it takes to reach a server: variables expanded, the token put where `auth` says, the working folder resolved.
 * Throws `McpConfigError` listing every problem at once.
 */
export function resolveLaunch(s: McpServerConfig, vars: McpVariables, token: string | undefined): McpLaunch {
  const problems: string[] = [];
  const x = (v: string) => expandVariables(v, vars, problems);
  const map = (m: Record<string, string> | undefined) =>
    Object.fromEntries(Object.entries(m ?? {}).map(([k, v]) => [k, x(v)]));
  if (requiresToken(s) && !token) problems.push(`No token is stored for ${s.name}. Add it with Set token.`);

  let launch: McpLaunch;
  if (s.url) {
    const headers = map(s.headers);
    if (token && s.auth.type === 'bearer') headers.Authorization = `Bearer ${token}`;
    if (token && s.auth.type === 'header') headers[s.auth.headerName] = token;
    launch = { kind: 'http', url: x(s.url), headers };
  } else {
    const env = { ...inheritedEnvironment(vars.env), ...map(s.env) };
    if (token && s.auth.type === 'env') env[s.auth.envName] = token;
    const base = vars.workspaceFolder ?? vars.userHome;
    launch = {
      kind: 'stdio',
      command: x(s.command ?? ''),
      args: (s.args ?? []).map(x),
      env,
      cwd: s.cwd ? path.resolve(base, x(s.cwd)) : base,
    };
  }
  if (problems.length) throw new McpConfigError([...new Set(problems)].join(' '));
  return launch;
}

/** What the user reads when the command of a local server cannot be found. */
export const commandNotFound = (command: string) =>
  `Could not start "${command}": it was not found. Install it, or use its full path.`;

export interface CommandLookup {
  /** The server's working folder: relative paths, and on Windows bare names too, are looked up there first. */
  cwd: string;
  /** PATH of the environment the server starts with. */
  path: string | undefined;
  /** PATHEXT on Windows. */
  pathext: string | undefined;
  platform: NodeJS.Platform;
}

/**
 * The files that could run `command`, in the order the system looks for them: the path itself when it names a
 * folder, else each folder of PATH. On Windows each extension of PATHEXT is tried, as `cmd.exe` does (`npx` runs
 * `npx.cmd`). Checking them before starting the server gives the same "not found" on every system: on Windows a
 * missing command otherwise only shows up as a message from `cmd.exe`, in the language of the system.
 */
export function commandCandidates(command: string, o: CommandLookup): string[] {
  const windows = o.platform === 'win32';
  const p = windows ? path.win32 : path.posix;
  const exts = (o.pathext || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((e) => e.trim())
    .filter(Boolean);
  const variants = (file: string) =>
    !windows
      ? [file]
      : exts.some((e) => file.toLowerCase().endsWith(e.toLowerCase()))
        ? [file]
        : exts.map((e) => file + e);
  if (p.isAbsolute(command) || command.includes('/') || (windows && command.includes('\\'))) {
    return variants(p.resolve(o.cwd, command));
  }
  const folders = (o.path ?? '')
    .split(windows ? ';' : ':')
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
  return (windows ? [o.cwd, ...folders] : folders).flatMap((d) => variants(p.join(d, command)));
}

/** A command given as a name only (`npx`), which the system looks up, rather than as a path. */
export function isBareCommand(command: string, platform: NodeJS.Platform): boolean {
  const p = platform === 'win32' ? path.win32 : path.posix;
  return !p.isAbsolute(command) && !command.includes('/') && !(platform === 'win32' && command.includes('\\'));
}

/**
 * The candidates that are not inside an open workspace folder. On Windows a bare name is looked up in the working
 * folder first, and a server's working folder is the workspace by default: a repository that ships `npx.cmd` would
 * run in place of the real one every time the server starts. A file there runs only when the command names its path.
 */
export function outsideWorkspace(
  candidates: readonly string[],
  roots: readonly string[],
  platform: NodeJS.Platform,
): string[] {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const inside = (root: string, file: string) => {
    const rel = p.relative(root, file);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${p.sep}`) && !p.isAbsolute(rel));
  };
  return candidates.filter((file) => !roots.some((root) => inside(root, file)));
}

/** What the user reads when a bare command exists only inside the workspace. */
export const commandInWorkspace = (command: string) =>
  `"${command}" was found only inside the workspace, where a repository could replace it. Install it on this computer, or give its full path if you mean the one in the workspace.`;
