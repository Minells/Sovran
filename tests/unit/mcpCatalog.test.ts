import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { INTEGRATIONS, integration, integrationArguments, supportedNode } from '../../src/core/mcp/catalog';
import { fromEntry, parseMcpServers, toEntry, mergeMcpEntries } from '../../src/core/mcp/config';
import { webviewMessageSchema } from '../../src/shared/protocol';
import { ManagedMcpPackages } from '../../src/extension/adapters/ManagedMcpPackages';
import type { FileProcessResult } from '../../src/core/ports';
import type { runFileProcess } from '../../src/extension/adapters/processExecution';

const temporary: string[] = [];
afterEach(async () => {
  for (const dir of temporary.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});
const result = (stdout = ''): FileProcessResult => ({
  stdout,
  stderr: '',
  output: stdout,
  exitCode: 0,
  signal: null,
  durationMs: 1,
  timedOut: false,
  cancelled: false,
  truncated: false,
});

describe('optional integration catalog contracts', () => {
  it('contains only three optional integrations and exact package candidates', () => {
    expect(INTEGRATIONS.map((i) => i.id)).toEqual(['playwright', 'devtools', 'github']);
    expect(integration('playwright').version).toBe('0.0.84');
    expect(integration('devtools').version).toBe('1.12.0');
    expect(INTEGRATIONS.some((item) => /latest/.test(item.version))).toBe(false);
  });
  it.each([
    ['playwright', '18.20.0', false],
    ['playwright', '20.18.0', true],
    ['devtools', '20.18.0', false],
    ['devtools', '20.19.0', true],
    ['devtools', '21.0.0', false],
    ['devtools', '22.11.0', false],
    ['devtools', '22.12.0', true],
    ['devtools', '24.0.0', true],
  ] as const)('checks %s against Node %s', (id, version, expected) => {
    expect(supportedNode(id, version)).toBe(expected);
  });
  it('rejects unknown messages/profiles and round-trips managed provenance without changing custom entries', () => {
    expect(
      webviewMessageSchema.safeParse({ type: 'installMcpIntegration', integration: 'arbitrary-package' })
        .success,
    ).toBe(false);
    expect(() => integrationArguments({ id: 'playwright', profile: 'readonly', version: '0.0.84' })).toThrow(
      /profile/,
    );
    const raw = [
      { id: 'custom', command: 'my-command', allowedTools: ['read'], disabledTools: ['write'] },
      { broken: true },
    ];
    const managed = fromEntry({
      id: 'browser',
      command: 'node',
      enabled: false,
      managed: { id: 'playwright', profile: 'isolated', version: '0.0.84' },
    });
    const merged = mergeMcpEntries(raw, [...parseMcpServers(raw).servers, managed]);
    expect(merged.slice(0, 2)).toEqual(raw);
    expect(toEntry(parseMcpServers(merged).servers[1]!)).toMatchObject({
      enabled: false,
      managed: managed.managed,
    });
  });
});

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sovran-catalog-'));
  temporary.push(dir);
  const storage = path.join(dir, 'storage');
  let allowed = true;
  let failed = false;
  const run = vi.fn<typeof runFileProcess>(async (_exe, args, options) => {
    options.beforeSpawn?.();
    if (args[0] === '--version') return result('v22.23.4\n');
    if (failed) return { ...result(), exitCode: 1 };
    const item = options.cwd.includes('playwright-') ? integration('playwright') : integration('devtools');
    const packageDir = path.join(options.cwd, 'node_modules', item.package!);
    await fs.mkdir(path.dirname(path.join(options.cwd, item.entry!)), { recursive: true });
    await fs.writeFile(path.join(options.cwd, item.entry!), '// fixture');
    await fs.writeFile(path.join(packageDir, 'package.json'), JSON.stringify({ version: item.version }));
    return result();
  });
  const manager = new ManagedMcpPackages({
    resources: path.resolve('resources/mcp'),
    storage,
    roots: () => [],
    authorize: () => {
      if (!allowed) throw new Error('Trust revoked');
    },
    changed: () => {},
    run,
  });
  return {
    dir,
    storage,
    run,
    manager,
    allow: (value: boolean) => {
      allowed = value;
    },
    fail: (value: boolean) => {
      failed = value;
    },
  };
}

describe('managed package installation lifecycle', () => {
  it('inspects without spawning or creating storage', async () => {
    const f = await fixture();
    await f.manager.inspect();
    expect(f.manager.states()).toContainEqual({ id: 'playwright', status: 'missing' });
    expect(f.run).not.toHaveBeenCalled();
    await expect(fs.stat(f.storage)).rejects.toThrow();
  });
  it('installs with locked dependencies and scripts disabled, then launches the installed entry directly', async () => {
    const f = await fixture();
    await f.manager.install('playwright', new AbortController().signal);
    const install = f.run.mock.calls.find((call) => call[1].includes('ci'))!;
    expect(install[1]).toContain('--ignore-scripts');
    expect(install[2].cwd).toContain('.installing-');
    const config = fromEntry({
      id: 'browser',
      command: 'node',
      managed: { id: 'playwright', version: '0.0.84', profile: 'isolated' },
    });
    const launch = await f.manager.launch(config);
    expect(path.isAbsolute(launch.command!)).toBe(true);
    expect(launch.args?.[0]).toContain('node_modules');
    expect(launch.args).toContain('--isolated');
    expect(launch.args?.join(' ')).not.toMatch(/npx|latest/);
    expect(f.manager.states()).toContainEqual({ id: 'playwright', status: 'ready' });
    expect((await fs.readdir(f.storage)).some((name) => name.includes('.installing-'))).toBe(false);
  });
  it('keeps failed installs retryable without a ready marker or an abandoned staging folder', async () => {
    const f = await fixture();
    f.fail(true);
    await expect(f.manager.install('devtools', new AbortController().signal)).rejects.toThrow(/npm/);
    expect(await fs.readdir(f.storage)).toEqual([]);
    expect(f.manager.states().find((s) => s.id === 'devtools')?.status).toBe('error');
    f.fail(false);
    await f.manager.install('devtools', new AbortController().signal);
    expect(f.manager.states().find((s) => s.id === 'devtools')?.status).toBe('ready');
  });
  it('rejects restricted or cancelled installations before npm can run', async () => {
    const f = await fixture();
    f.allow(false);
    await expect(f.manager.install('playwright', new AbortController().signal)).rejects.toThrow(/Trust/);
    expect(f.run).not.toHaveBeenCalled();
    f.allow(true);
    const abort = new AbortController();
    abort.abort();
    await expect(f.manager.install('playwright', abort.signal)).rejects.toThrow();
    expect(f.run.mock.calls.some((call) => call[1].includes('ci'))).toBe(false);
  });
  it('refuses a missing install or a modified lockfile, while preserving custom configurations', async () => {
    const f = await fixture();
    const config = fromEntry({
      id: 'browser',
      command: 'node',
      managed: { id: 'playwright', version: '0.0.84', profile: 'isolated' },
    });
    await expect(f.manager.launch(config)).rejects.toThrow(/Install/);
    await f.manager.install('playwright', new AbortController().signal);
    const folder = (await fs.readdir(f.storage))[0]!;
    await fs.writeFile(path.join(f.storage, folder, 'package-lock.json'), '{}');
    await expect(f.manager.launch(config)).rejects.toThrow(/Install/);
    const custom = fromEntry({ id: 'custom', command: 'user-command', args: ['arbitrary'] });
    expect(await f.manager.launch(custom)).toBe(custom);
  });
});
