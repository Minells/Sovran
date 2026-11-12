import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import {
  integration,
  integrationArguments,
  integrationEndpoint,
  supportedNode,
  INTEGRATIONS,
  type IntegrationId,
  type InstallationState,
} from '../../core/mcp/catalog';
import type { McpServerConfig } from '../../core/mcp/config';
import { isInside } from '../../core/security/paths';
import { MCP_INHERITED_ENV } from '../../core/mcp/launch';
import { runFileProcess } from './processExecution';

interface Installed {
  digest: string;
  node: string;
  nodeVersion: string;
}
export interface ManagedPackageOptions {
  resources: string;
  storage: string;
  roots(): readonly string[];
  authorize(): void;
  changed(): void;
  remote?: boolean;
  browser?: () => Promise<string | undefined>;
  run?: typeof runFileProcess;
}

/** External packages live only in extension storage; lockfiles ship with Sovran, never come from the workspace. */
export class ManagedMcpPackages {
  private readonly state = new Map<IntegrationId, InstallationState>();
  private installing?: AbortController;
  constructor(private readonly options: ManagedPackageOptions) {}
  states(): InstallationState[] {
    return INTEGRATIONS.map(
      (item) => this.state.get(item.id) ?? { id: item.id, status: item.package ? 'missing' : 'remote' },
    );
  }
  async inspect(): Promise<void> {
    for (const item of INTEGRATIONS.filter((i) => i.package)) {
      try {
        await this.installed(item.id);
        this.state.set(item.id, { id: item.id, status: 'ready' });
      } catch {
        this.state.set(item.id, { id: item.id, status: 'missing' });
      }
    }
    this.options.changed();
  }
  private async manifest(id: IntegrationId) {
    const item = integration(id);
    if (!item.package)
      throw new Error('This integration is hosted and does not need a package installation.');
    const folder = path.join(this.options.resources, id);
    const [manifest, lock] = await Promise.all(
      ['package.json', 'package-lock.json'].map((name) => fs.readFile(path.join(folder, name), 'utf8')),
    );
    if (
      JSON.parse(manifest!).dependencies?.[item.package] !== item.version ||
      JSON.parse(lock!).packages?.['']?.dependencies?.[item.package] !== item.version
    )
      throw new Error(
        'The bundled integration manifest does not match the reviewed version. Reinstall Sovran.',
      );
    const digest = createHash('sha256').update(manifest!).update(lock!).digest('hex');
    const directory = path.join(this.options.storage, `${id}-${item.version}-${digest.slice(0, 12)}`);
    return { item, manifest: manifest!, lock: lock!, digest, directory };
  }
  private async installed(id: IntegrationId) {
    const manifest = await this.manifest(id);
    const record = JSON.parse(
      await fs.readFile(path.join(manifest.directory, 'ready.json'), 'utf8'),
    ) as Installed;
    if (record.digest !== manifest.digest || !path.isAbsolute(record.node))
      throw new Error('The managed installation is incomplete. Install dependencies again.');
    if ((await fs.readFile(path.join(manifest.directory, 'package-lock.json'), 'utf8')) !== manifest.lock)
      throw new Error('The installed lockfile changed. Install dependencies again.');
    const entry = await fs.realpath(path.join(manifest.directory, manifest.item.entry!));
    const root = await fs.realpath(manifest.directory);
    const pkg = JSON.parse(
      await fs.readFile(
        path.join(manifest.directory, 'node_modules', manifest.item.package!, 'package.json'),
        'utf8',
      ),
    );
    if (!isInside(root, entry) || !(await fs.stat(entry)).isFile() || pkg.version !== manifest.item.version)
      throw new Error('The managed entrypoint does not match the reviewed installation.');
    return { ...manifest, record, entry };
  }
  private async nodePath(): Promise<string> {
    const roots = await Promise.all(this.options.roots().map((root) => fs.realpath(root).catch(() => root)));
    const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
    for (const folder of (process.env.PATH ?? process.env.Path ?? '')
      .split(path.delimiter)
      .filter(path.isAbsolute)) {
      const node = await fs.realpath(path.join(folder, nodeName)).catch(() => undefined);
      if (!node || roots.some((root) => isInside(root, node))) continue;
      if ((await fs.stat(node)).isFile()) return node;
    }
    throw new Error('Install Node.js with npm on the extension host, outside the workspace, then retry.');
  }
  private async nodeVersion(
    node: string,
    cwd: string,
    signal: AbortSignal,
    id: IntegrationId,
  ): Promise<string> {
    const result = await (this.options.run ?? runFileProcess)(node, ['--version'], {
      cwd,
      timeoutMs: 10_000,
      maxOutputChars: 1000,
      signal,
      disallowedExecutableRoots: this.options.roots(),
      beforeSpawn: this.options.authorize,
    });
    const version = result.stdout.trim().replace(/^v/, '');
    if (result.exitCode !== 0 || !supportedNode(id, version))
      throw new Error(
        `${integration(id).name} needs a compatible Node.js on the extension host. ${integration(id).requirements}`,
      );
    return version;
  }
  async install(id: IntegrationId, signal: AbortSignal): Promise<void> {
    if (this.installing) throw new Error('Another integration installation is running.');
    this.options.authorize();
    const abort = new AbortController();
    this.installing = abort;
    const combined = AbortSignal.any([signal, abort.signal]);
    let staging: string | undefined;
    this.state.set(id, { id, status: 'installing' });
    this.options.changed();
    try {
      const manifest = await this.manifest(id);
      await fs.mkdir(this.options.storage, { recursive: true });
      const node = await this.nodePath();
      const nodeVersion = await this.nodeVersion(node, this.options.storage, combined, id);
      const npmCandidates = [
        path.join(path.dirname(node), 'node_modules/npm/bin/npm-cli.js'),
        path.join(path.dirname(node), '../lib/node_modules/npm/bin/npm-cli.js'),
        path.join(path.dirname(node), 'npm'),
      ];
      let npm: string | undefined;
      for (const candidate of npmCandidates) {
        const actual = await fs.realpath(candidate).catch(() => undefined);
        if (
          actual?.endsWith('npm-cli.js') &&
          !this.options.roots().some((root) => isInside(root, actual)) &&
          (await fs.stat(actual)).isFile()
        ) {
          npm = actual;
          break;
        }
      }
      if (!npm)
        throw new Error('npm was not found next to Node.js. Install Node.js with npm on the extension host.');
      this.options.authorize();
      combined.throwIfAborted();
      staging = `${manifest.directory}.installing-${randomUUID()}`;
      await fs.mkdir(staging);
      await Promise.all([
        fs.writeFile(path.join(staging, 'package.json'), manifest.manifest),
        fs.writeFile(path.join(staging, 'package-lock.json'), manifest.lock),
      ]);
      const result = await (this.options.run ?? runFileProcess)(
        node,
        [
          npm,
          'ci',
          '--ignore-scripts',
          '--omit=dev',
          '--no-audit',
          '--no-fund',
          '--loglevel=error',
          '--cache',
          path.join(this.options.storage, 'cache'),
        ],
        {
          cwd: staging,
          timeoutMs: 180_000,
          maxOutputChars: 4000,
          signal: combined,
          disallowedExecutableRoots: this.options.roots(),
          inheritEnv: MCP_INHERITED_ENV,
          beforeSpawn: this.options.authorize,
        },
      );
      if (result.cancelled || combined.aborted)
        throw new Error('Installation cancelled. Nothing was connected.');
      if (result.exitCode !== 0 || result.timedOut)
        throw new Error(
          'npm could not complete the locked installation. Check the host’s network, certificate trust and npm configuration, then retry.',
        );
      this.options.authorize();
      combined.throwIfAborted();
      await fs.writeFile(
        path.join(staging, 'ready.json'),
        JSON.stringify({ digest: manifest.digest, node, nodeVersion } satisfies Installed),
      );
      // Replacing an incomplete installation is explicit and cannot touch a workspace or a different version.
      await fs.rm(manifest.directory, { recursive: true, force: true });
      await fs.rename(staging, manifest.directory);
      staging = undefined;
      await this.installed(id);
      this.state.set(id, { id, status: 'ready' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Installation failed.';
      this.state.set(id, { id, status: 'error', error: message });
      throw error;
    } finally {
      if (staging) await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
      this.installing = undefined;
      this.options.changed();
    }
  }
  async launch(server: McpServerConfig): Promise<McpServerConfig> {
    const managed = server.managed;
    if (!managed) return server;
    const args = integrationArguments(managed);
    this.options.authorize();
    const item = integration(managed.id);
    if (item.remote) {
      const headers = item.remote.headers?.(managed.profile) ?? {};
      if (
        server.command ||
        server.url !== integrationEndpoint(managed) ||
        server.auth.type !== 'bearer' ||
        Object.keys(server.headers ?? {}).length !== Object.keys(headers).length ||
        Object.entries(headers).some(([key, value]) => server.headers?.[key] !== value)
      ) {
        throw new Error(
          `The managed ${item.name} endpoint, authentication or filters changed. Add the catalog entry again, or explicitly edit it as a custom server.`,
        );
      }
      return server;
    }
    if (managed.profile === 'extension' && this.options.remote)
      throw new Error(
        'Existing desktop Chrome profiles are unavailable on Remote hosts. Use a separate browser on the extension host.',
      );
    if (
      server.url ||
      server.command !== 'node' ||
      server.auth.type !== 'none' ||
      server.args?.length ||
      Object.keys(server.env ?? {}).length ||
      server.cwd ||
      Object.keys(server.headers ?? {}).length
    ) {
      throw new Error(
        'The managed browser launch configuration changed. Add the catalog entry again, or explicitly edit it as a custom server.',
      );
    }
    let installed: Awaited<ReturnType<ManagedMcpPackages['installed']>>;
    try {
      installed = await this.installed(managed.id);
    } catch {
      throw new Error(
        `Install ${integration(managed.id).name} dependencies in Sovran Settings → Tools before connecting.`,
      );
    }
    await this.nodeVersion(
      installed.record.node,
      this.options.storage,
      new AbortController().signal,
      managed.id,
    );
    const browser = await (this.options.browser ?? (() => findChrome(this.options.roots())))();
    if (!browser)
      throw new Error(
        'Google Chrome was not found on the extension host. Install Chrome there, or configure an explicit browser executable as a custom MCP server. Sovran does not download a browser.',
      );
    if (managed.id === 'playwright') {
      const output = path.join(this.options.storage, 'artifacts', server.id);
      await fs.mkdir(output, { recursive: true });
      args.push('--output-dir', output, '--output-max-size', String(20 * 1024 * 1024));
      if (managed.profile === 'isolated') args.push('--executable-path', browser);
    } else args.push('--executable-path', browser);
    this.options.authorize();
    return {
      ...server,
      command: installed.record.node,
      args: [installed.entry, ...args],
      cwd: installed.directory,
      env:
        managed.id === 'devtools'
          ? { CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1', CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1' }
          : {},
    };
  }
  dispose(): void {
    this.installing?.abort();
  }
}

/** Known system installations only: never resolve a browser from the workspace or an arbitrary PATH entry. */
async function findChrome(roots: readonly string[]): Promise<string | undefined> {
  const candidates =
    process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
        ]
      : process.platform === 'win32'
        ? [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
            .filter((root): root is string => !!root && path.isAbsolute(root))
            .map((root) => path.join(root, 'Google/Chrome/Application/chrome.exe'))
        : ['/opt/google/chrome/chrome', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'];
  const canonicalRoots = await Promise.all(roots.map((root) => fs.realpath(root).catch(() => root)));
  for (const candidate of candidates) {
    const actual = await fs.realpath(candidate).catch(() => undefined);
    if (!actual || canonicalRoots.some((root) => isInside(root, actual))) continue;
    try {
      await fs.access(actual, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
      if ((await fs.stat(actual)).isFile()) return actual;
    } catch {
      /* Try another system installation. */
    }
  }
  return undefined;
}
