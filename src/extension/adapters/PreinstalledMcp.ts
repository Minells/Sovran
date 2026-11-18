import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { integration, integrationConnection } from '../../core/mcp/catalog';
import type { McpServerConfig } from '../../core/mcp/config';
import { commandCandidates, outsideWorkspace } from '../../core/mcp/launch';
import { isInside } from '../../core/security/paths';
import { runFileProcess } from './processExecution';
import type { ManagedPackageOptions } from './ManagedMcpPackages';

const sameMap = (a: Record<string, string> = {}, b: Record<string, string> = {}) =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, v]) => b[k] === v);

/** Separate from locked browser packages: never install software or look for Chrome here. */
export async function launchPreinstalledIntegration(
  server: McpServerConfig,
  options: ManagedPackageOptions,
): Promise<McpServerConfig> {
  const managed = server.managed!;
  const item = integration(managed.id);
  const expected = integrationConnection(managed);
  if (
    server.url ||
    server.cwd ||
    server.command !== expected.command ||
    JSON.stringify(server.args ?? []) !== JSON.stringify(expected.args ?? []) ||
    JSON.stringify(server.auth) !== JSON.stringify(expected.auth) ||
    !sameMap(server.env, expected.env) ||
    Object.keys(server.headers ?? {}).length
  ) {
    throw new Error(
      `The managed ${item.name} launch configuration changed. Add the catalog entry again, or explicitly edit it as a custom server.`,
    );
  }
  const roots = await Promise.all(options.roots().map((root) => fs.realpath(root).catch(() => root)));
  const candidates = outsideWorkspace(
    commandCandidates(expected.command!, {
      cwd: options.storage,
      path: process.env.PATH ?? process.env.Path,
      pathext: process.env.PATHEXT,
      platform: process.platform,
    }),
    roots,
    process.platform,
  );
  let executable: string | undefined;
  for (const candidate of candidates) {
    try {
      const actual = await fs.realpath(candidate);
      if (roots.some((root) => isInside(root, actual))) continue;
      await fs.access(actual, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
      if ((await fs.stat(actual)).isFile()) {
        executable = actual;
        break;
      }
    } catch {
      /* Try the next PATH entry. */
    }
  }
  if (!executable)
    throw new Error(
      `${item.name} executable was not found outside the workspace. ${item.requirements} Configure its full path if it is not on PATH.`,
    );
  let prefix: string[] = [];
  // npm's Windows launcher is a .cmd file. Run its known JS bundle through Node,
  // rather than evaluating a shell script during a version check.
  if (process.platform === 'win32' && managed.id === 'sentry' && /\.cmd$/i.test(executable)) {
    const bundle = await fs
      .realpath(path.join(path.dirname(executable), 'node_modules/@sentry/mcp-server/dist/sentry-mcp.cjs'))
      .catch(() => undefined);
    if (!bundle || roots.some((root) => isInside(root, bundle)))
      throw new Error(
        'The sentry-mcp launcher has no installed bundle outside the workspace. Reinstall @sentry/mcp-server 0.49.0.',
      );
    prefix = [bundle];
    executable = undefined;
    for (const candidate of commandCandidates('node', {
      cwd: options.storage,
      path: process.env.PATH ?? process.env.Path,
      pathext: '.EXE',
      platform: 'win32',
    })) {
      const actual = await fs.realpath(candidate).catch(() => undefined);
      if (actual && !roots.some((root) => isInside(root, actual)) && (await fs.stat(actual)).isFile()) {
        executable = actual;
        break;
      }
    }
    if (!executable) throw new Error('Install Node.js 22.15+ outside the workspace to run Sentry MCP.');
  }
  options.authorize();
  await fs.mkdir(options.storage, { recursive: true });
  // No credential is read or supplied to this probe. Do not print arbitrary executable output.
  const version = await (options.run ?? runFileProcess)(executable, [...prefix, '--version'], {
    cwd: options.storage,
    env: expected.env,
    timeoutMs: 10_000,
    maxOutputChars: 1000,
    signal: new AbortController().signal,
    disallowedExecutableRoots: roots,
    beforeSpawn: options.authorize,
  });
  const reported = version.stdout.trim().replace(/\r\n/g, '\n');
  const expectedVersion =
    managed.id === 'terraform' ? `Terraform MCP Server\nVersion: ${item.version}` : item.version;
  if (
    version.exitCode !== 0 ||
    version.timedOut ||
    version.cancelled ||
    version.truncated ||
    reported !== expectedVersion
  )
    throw new Error(
      `${item.name} requires the reviewed version ${item.version}. Install that version separately and configure its executable again.`,
    );
  options.authorize();
  return {
    ...server,
    command: executable,
    args: [...prefix, ...(server.args ?? [])],
    cwd: path.resolve(options.storage),
  };
}
