import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  INTEGRATIONS,
  integration,
  integrationArguments,
  integrationCallProblem,
  integrationHeaders,
  integrationEndpoint,
  integrationToolAllowed,
  normalizeGitLabInstance,
  supportedNode,
} from '../../src/core/mcp/catalog';
import { fromEntry, parseMcpServers, toEntry, mergeMcpEntries, toolPolicy } from '../../src/core/mcp/config';
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
  it('contains the reviewed integrations and exact package candidates', () => {
    expect(INTEGRATIONS.map((i) => i.id)).toEqual(['playwright', 'devtools', 'github', 'context7', 'gitlab']);
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

  it('validates a GitLab instance URL and preserves its port and prefix', () => {
    const instanceUrl = normalizeGitLabInstance('https://GITLAB.example.test:8443/team/gitlab/');
    const managed = { id: 'gitlab', profile: 'collaboration', version: 'hosted-v1', instanceUrl } as const;
    expect(integrationEndpoint(managed)).toBe('https://gitlab.example.test:8443/team/gitlab/api/v4/mcp');
    for (const invalid of [
      'http://gitlab.example.test',
      'https://user:password@gitlab.example.test',
      'https://gitlab.example.test/?token=abc',
      'https://gitlab.example.test/#',
      'https://gitlab.example.test/api/v4/mcp',
      'https://gitlab.example.test/workspace/../gitlab',
      'https://gitlab.example.test/${env:HOST}',
    ])
      expect(() => normalizeGitLabInstance(invalid)).toThrow(/HTTPS GitLab instance/);
    expect(integrationToolAllowed(managed, 'save_merge_request')).toBe(true);
    expect(integrationToolAllowed({ ...managed, profile: 'readonly' }, 'save_merge_request')).toBe(false);
    expect(integrationToolAllowed(managed, 'execute_graphql')).toBe(false);
    expect(
      toolPolicy(
        { managed, allowedTools: ['accept_merge_request'], disabledTools: [] },
        'accept_merge_request',
      ),
    ).toBe('ask');
    expect(
      toolPolicy(
        { managed, allowedTools: [], disabledTools: ['accept_merge_request'] },
        'accept_merge_request',
      ),
    ).toBe('off');
  });

  it('keeps GitHub collaboration headers compatible and constrains the new developer profile', () => {
    const managed = { id: 'github', profile: 'developer', version: 'hosted-v1' } as const;
    expect(integrationHeaders('collaboration')['X-MCP-Tools']).toBe(
      'get_me,issue_read,pull_request_read,search_issues,search_pull_requests,issue_write,add_issue_comment,create_pull_request',
    );
    expect(integrationToolAllowed(managed, 'actions_get')).toBe(true);
    expect(integrationToolAllowed(managed, 'push_files')).toBe(false);
    expect(integrationCallProblem(managed, 'merge_pull_request', {})).toContain('expectedHeadSha');
    expect(
      integrationCallProblem(managed, 'merge_pull_request', { expectedHeadSha: 'f'.repeat(40) }),
    ).toBeUndefined();
  });
});

async function fixture(
  browser: () => Promise<string | undefined> = async () => '/system/chrome',
  remote = false,
) {
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
    browser,
    remote,
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
  it('rejects output paths and executable URL schemes only for managed browser profiles', () => {
    const managed = { id: 'playwright', version: '0.0.84', profile: 'isolated' } as const;
    expect(integrationCallProblem(managed, 'browser_snapshot', { filename: '/tmp/output' })).toMatch(
      /inline/,
    );
    expect(integrationCallProblem(managed, 'browser_navigate', { url: 'javascript:alert(1)' })).toMatch(
      /HTTP/,
    );
    expect(
      integrationCallProblem(managed, 'browser_navigate', { url: 'https://example.com' }),
    ).toBeUndefined();
    expect(
      integrationCallProblem(undefined, 'browser_snapshot', { filename: '/tmp/output' }),
    ).toBeUndefined();
  });
  it('keeps browser code, uploads, installation, screenshots and page-defined tools outside managed profiles', () => {
    for (const tool of [
      'browser_evaluate',
      'browser_run_code',
      'browser_file_upload',
      'browser_install',
      'browser_take_screenshot',
      'page_defined_tool',
    ]) {
      expect(integrationToolAllowed({ id: 'playwright', version: '0.0.84', profile: 'isolated' }, tool)).toBe(
        false,
      );
    }
    expect(
      integrationToolAllowed({ id: 'devtools', version: '1.12.0', profile: 'isolated' }, 'evaluate_script'),
    ).toBe(false);
    expect(
      integrationToolAllowed({ id: 'github', version: 'hosted-v1', profile: 'readonly' }, 'issue_write'),
    ).toBe(false);
    expect(
      integrationToolAllowed({ id: 'github', version: 'hosted-v1', profile: 'collaboration' }, 'issue_write'),
    ).toBe(true);
    expect(integrationHeaders()['X-MCP-Readonly']).toBe('true');
    expect(integrationHeaders('collaboration')).not.toHaveProperty('X-MCP-Readonly');
  });
  it('requires explicit browser profiles and rejects Remote desktop attachment', async () => {
    const managed = { id: 'playwright', version: '0.0.84', profile: 'extension' } as const;
    expect(() => integrationArguments(managed)).toThrow(/explicit/);
    expect(() => integrationArguments({ ...managed, browserProfile: '../Default' })).toThrow(/explicit/);
    expect(integrationArguments({ ...managed, browserProfile: 'Profile 2' })).toEqual(
      expect.arrayContaining(['--extension', '--profile-dir-name', 'Profile 2']),
    );
    const f = await fixture(undefined, true);
    await expect(
      f.manager.launch(
        fromEntry({ id: 'browser', command: 'node', managed: { ...managed, browserProfile: 'Profile 2' } }),
      ),
    ).rejects.toThrow(/Remote/);
    expect(f.run).not.toHaveBeenCalled();
  });
  it('fails with instructions when Chrome is missing and disables DevTools external reporting', async () => {
    const f = await fixture(async () => undefined);
    await f.manager.install('devtools', new AbortController().signal);
    const config = fromEntry({
      id: 'debug',
      command: 'node',
      managed: { id: 'devtools', version: '1.12.0', profile: 'isolated' },
    });
    await expect(f.manager.launch(config)).rejects.toThrow(/Chrome was not found/);
    const g = await fixture();
    await g.manager.install('devtools', new AbortController().signal);
    const launch = await g.manager.launch(config);
    expect(launch.args).toEqual(
      expect.arrayContaining([
        '--isolated',
        '--no-usage-statistics',
        '--no-performance-crux',
        '--no-javascript-evaluation',
      ]),
    );
    expect(launch.env).toEqual({
      CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1',
      CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1',
    });
  });
  it('rejects edited managed GitHub filters and endpoint without contacting it', async () => {
    const f = await fixture();
    const config = fromEntry({
      id: 'github',
      url: 'https://api.githubcopilot.com/mcp/',
      auth: { type: 'bearer' },
      headers: integrationHeaders(),
      managed: { id: 'github', profile: 'readonly', version: 'hosted-v1' },
    });
    expect(await f.manager.launch(config)).toBe(config);
    await expect(f.manager.launch({ ...config, headers: {} })).rejects.toThrow(/filters changed/);
    await expect(f.manager.launch({ ...config, url: 'https://other.example/mcp' })).rejects.toThrow(
      /filters changed/,
    );
    expect(f.run).not.toHaveBeenCalled();
  });
  it('validates the hosted Context7 destination without inspecting or running a package', async () => {
    const f = await fixture();
    const config = fromEntry({
      id: 'context7',
      url: 'https://mcp.context7.com/mcp',
      auth: { type: 'bearer' },
      managed: { id: 'context7', profile: 'readonly', version: 'hosted-v1' },
    });
    expect(await f.manager.launch(config)).toBe(config);
    await expect(f.manager.launch({ ...config, url: 'https://other.example/mcp' })).rejects.toThrow(
      /endpoint/,
    );
    await expect(f.manager.launch({ ...config, auth: { type: 'none' } })).rejects.toThrow(/authentication/);
    expect(f.manager.states()).toContainEqual({ id: 'context7', status: 'remote' });
    expect(f.run).not.toHaveBeenCalled();
  });
  it('validates a managed GitLab launch before it can request a token or contact a server', async () => {
    const f = await fixture();
    const managed = {
      id: 'gitlab',
      profile: 'readonly',
      version: 'hosted-v1',
      instanceUrl: 'https://gitlab.example.test:8443/team',
    } as const;
    const config = fromEntry({
      id: 'gitlab',
      url: integrationEndpoint(managed),
      auth: { type: 'bearer' },
      headers: integration('gitlab').remote!.headers!(managed.profile),
      managed,
    });
    expect(await f.manager.launch(config)).toBe(config);
    await expect(
      f.manager.launch({ ...config, url: 'https://elsewhere.example.test/api/v4/mcp' }),
    ).rejects.toThrow(/endpoint/);
    await expect(f.manager.launch({ ...config, headers: { Authorization: 'other' } })).rejects.toThrow(
      /filters/,
    );
    expect(f.run).not.toHaveBeenCalled();
  });
  it('rejects a managed local preset redirected to a URL or custom environment before spawning', async () => {
    const f = await fixture();
    const managed = { id: 'playwright', version: '0.0.84', profile: 'isolated' } as const;
    await expect(
      f.manager.launch(fromEntry({ id: 'x', url: 'https://other.example/mcp', managed })),
    ).rejects.toThrow(/configuration changed/);
    await expect(
      f.manager.launch(fromEntry({ id: 'x', command: 'node', env: { CUSTOM: 'value' }, managed })),
    ).rejects.toThrow(/configuration changed/);
    expect(f.run).not.toHaveBeenCalled();
  });
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
