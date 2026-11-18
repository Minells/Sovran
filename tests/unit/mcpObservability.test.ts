import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  integration,
  integrationArguments,
  integrationConnection,
  integrationCallProblem,
  integrationToolAllowed,
  normalizeIntegrationUrl,
  type ManagedIntegration,
} from '../../src/core/mcp/catalog';
import {
  fromEntry,
  parseMcpServers,
  requiresToken,
  toEntry,
  type McpServerConfig,
} from '../../src/core/mcp/config';
import { McpHub } from '../../src/core/mcp/hub';
import { resolveLaunch } from '../../src/core/mcp/launch';
import { nullLogger, type FileProcessResult } from '../../src/core/ports';
import { ManagedMcpPackages } from '../../src/extension/adapters/ManagedMcpPackages';
import { NodeMcpTransports } from '../../src/extension/adapters/McpTransports';
import { MemoryTransports, until } from '../fixtures/mcp';
import type { runFileProcess } from '../../src/extension/adapters/processExecution';

const dirs: string[] = [];
const hubs: McpHub[] = [];
afterEach(async () => {
  await Promise.all(hubs.splice(0).map((hub) => hub.dispose()));
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});
const configs: ManagedIntegration[] = [
  {
    id: 'sentry',
    profile: 'readonly',
    version: '0.49.0',
    executable: 'sentry-mcp',
    instanceUrl: 'https://sentry.io',
  },
  {
    id: 'grafana',
    profile: 'readonly',
    version: '2.3.0',
    executable: 'mcp-grafana',
    instanceUrl: 'http://localhost:3000',
  },
  { id: 'terraform', profile: 'registry', version: '1.4.1', executable: 'terraform-mcp-server' },
  {
    id: 'terraform',
    profile: 'hcp-readonly',
    version: '1.4.1',
    executable: 'terraform-mcp-server',
    instanceUrl: 'https://tfe.example.test',
  },
  {
    id: 'opensearch',
    profile: 'readonly',
    version: 'external-v1',
    endpoint: 'https://mcp.example.test/prefix/mcp',
  },
];
const configured = (managed: ManagedIntegration) =>
  fromEntry({ id: managed.id, managed, ...integrationConnection(managed) });

describe('observability and Terraform catalog connections', () => {
  it.each(configs)('round trips $id/$profile and puts credentials only in the launch', (managed) => {
    const config = configured(managed);
    expect(parseMcpServers([toEntry(config)]).servers).toEqual([config]);
    expect(requiresToken(config)).toBe(managed.id !== 'opensearch' && managed.profile !== 'registry');
    const launch = resolveLaunch(config, { userHome: '/user', env: {} }, 'secret-fixture');
    expect(JSON.stringify(config)).not.toContain('secret-fixture');
    if (launch.kind === 'stdio') {
      expect(launch.args.join(' ')).not.toContain('secret-fixture');
      if (config.auth.type === 'env') expect(launch.env[config.auth.envName]).toBe('secret-fixture');
    } else expect(launch.headers.Authorization).toBe('Bearer secret-fixture');
    expect(() => integrationArguments({ ...managed, version: 'old-version' })).toThrow(/version/);
    expect(integrationToolAllowed({ ...managed, profile: 'developer' }, 'read_anything')).toBe(false);
  });

  it('rejects unsafe URLs and distinguishes service origins from external endpoint paths', () => {
    for (const invalid of [
      'http://private.example/mcp',
      'https://u:p@example.com',
      'https://example.com?token=x',
      'https://example.com/#',
      'https://example.com/${env:HOST}',
      'https://example.com/../mcp',
      'https://example.com\\@evil.test',
      'file:///mcp',
    ])
      expect(() => normalizeIntegrationUrl(invalid)).toThrow();
    expect(normalizeIntegrationUrl('https://MCP.example.test:8443/prefix/mcp/')).toBe(
      'https://mcp.example.test:8443/prefix/mcp',
    );
    expect(normalizeIntegrationUrl('http://[::1]:8000/mcp')).toBe('http://[::1]:8000/mcp');
    expect(() => normalizeIntegrationUrl('https://sentry.example.test/path', true)).toThrow(/origin/);
    expect(() => integrationArguments({ ...configs[2]!, instanceUrl: 'https://tfe.test' })).toThrow(
      /Registry/,
    );
  });

  it('rejects every OpenSearch connection override even when null or hidden from the upstream schema', () => {
    const managed = configs[4]!;
    for (const key of [
      'opensearch_url',
      'opensearch_username',
      'opensearch_password',
      'opensearch_no_auth',
      'opensearch_ssl_verify',
      'opensearch_timeout',
      'aws_region',
      'aws_iam_arn',
      'aws_profile',
      'aws_opensearch_serverless',
      'aws_access_key_id',
      'aws_secret_access_key',
      'opensearch_client_key_path',
    ])
      expect(integrationCallProblem(managed, 'SearchIndexTool', { [key]: null })).toMatch(/overrides/);
    expect(
      integrationCallProblem(managed, 'SearchIndexTool', {
        opensearch_cluster_name: 'preconfigured',
        index: 'logs',
        query_dsl: { size: 0 },
      }),
    ).toBeUndefined();
  });
});

async function fixture(managed: ManagedIntegration) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sovran-preinstalled-'));
  dirs.push(dir);
  const executable = path.join(dir, process.platform === 'win32' ? 'server.exe' : 'server');
  await fs.writeFile(executable, 'fixture', { mode: 0o755 });
  let stdout =
    managed.id === 'terraform'
      ? `Terraform MCP Server\nVersion: ${managed.version}\n`
      : `${managed.version}\n`;
  let roots: string[] = [];
  const run = vi.fn<typeof runFileProcess>(async (_exe, _args, options): Promise<FileProcessResult> => {
    options.beforeSpawn?.();
    return {
      stdout,
      stderr: '',
      output: stdout,
      exitCode: 0,
      signal: null,
      durationMs: 1,
      timedOut: false,
      cancelled: false,
      truncated: false,
    };
  });
  const browser = vi.fn(async () => undefined);
  const manager = new ManagedMcpPackages({
    resources: path.resolve('resources/mcp'),
    storage: path.join(dir, 'storage'),
    roots: () => roots,
    authorize() {},
    changed() {},
    browser,
    run,
  });
  return {
    dir,
    manager,
    run,
    browser,
    config: configured({ ...managed, executable }),
    setVersion: (value: string) => {
      stdout = value;
    },
    setRoots: (value: string[]) => {
      roots = value;
    },
  };
}

describe('preinstalled launch validation', () => {
  it.each(configs.slice(0, 4))(
    'launches $id/$profile without npm, Chrome or credentials in version checks',
    async (managed) => {
      const f = await fixture(managed);
      const launch = await f.manager.launch(f.config);
      expect(launch.cwd).toBe(path.join(f.dir, 'storage'));
      expect(launch.args).toEqual(f.config.args);
      expect(f.run).toHaveBeenCalledTimes(1);
      expect(f.run.mock.calls[0]![1]).toEqual(['--version']);
      expect(f.run.mock.calls[0]![2].env).toEqual(f.config.env);
      expect(f.browser).not.toHaveBeenCalled();
      expect(f.manager.states()).toContainEqual({ id: managed.id, status: 'external' });
    },
  );

  it('rejects wrong versions, missing executables and executables inside workspace roots', async () => {
    const f = await fixture(configs[1]!);
    f.setVersion('2.3.1');
    await expect(f.manager.launch(f.config)).rejects.toThrow(/reviewed version 2.3.0/);
    f.run.mockClear();
    f.setRoots([f.dir]);
    await expect(f.manager.launch(f.config)).rejects.toThrow(/outside the workspace/);
    expect(f.run).not.toHaveBeenCalled();
    f.setRoots([]);
    await fs.unlink(f.config.command!);
    await expect(f.manager.launch(f.config)).rejects.toThrow(/not found/);
  });

  it('rejects changed arguments, environment, auth and destination before reading any token', async () => {
    const f = await fixture(configs[0]!);
    const token = vi.fn(async () => 'should-not-be-read');
    const transport = new NodeMcpTransports({
      managedLaunch: (s) => f.manager.launch(s),
      variables: () => ({ userHome: f.dir, env: {} }),
      token,
    });
    for (const edit of [
      { args: ['--all-skills'] },
      { env: { SENTRY_HOST: 'https://evil.test' } },
      { auth: { type: 'env', envName: 'EVIL' } as const },
      { command: '/evil' },
      { cwd: '/workspace' },
    ])
      await expect(transport.create({ ...f.config, ...edit }, () => {})).rejects.toThrow(
        /configuration changed/,
      );
    expect(token).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
  });

  it('looks up the credential against persisted settings after resolving the runtime launch', async () => {
    const f = await fixture(configs[0]!);
    const token = vi.fn(async (_server: McpServerConfig) => 'bound-secret-fixture');
    const transports = new NodeMcpTransports({
      managedLaunch: (s) => f.manager.launch(s),
      variables: () => ({ userHome: f.dir, env: {} }),
      token,
    });
    const transport = await transports.create(f.config, () => {});
    expect(token).toHaveBeenCalledExactlyOnceWith(f.config);
    expect(token.mock.calls[0]?.[0].cwd).toBeUndefined();
    await transport.close();
  });

  it('validates external OpenSearch endpoint and headers without any local runtime', async () => {
    const f = await fixture(configs[0]!);
    const config = configured(configs[4]!);
    expect(await f.manager.launch(config)).toBe(config);
    await expect(f.manager.launch({ ...config, url: 'https://evil.test/mcp' })).rejects.toThrow(/endpoint/);
    await expect(f.manager.launch({ ...config, headers: { Authorization: 'secret' } })).rejects.toThrow(
      /filters/,
    );
    expect(f.run).not.toHaveBeenCalled();
    expect(f.browser).not.toHaveBeenCalled();
  });
});

describe('reviewed tools across discovery and dispatch', () => {
  it('reports a failed HCP profile when upstream falls back to Registry tools', async () => {
    const transports = new MemoryTransports({
      terraform: () => {
        const srv = new McpServer({ name: 'terraform-mcp-server', version: '1.4.1' });
        srv.registerTool('search_modules', { inputSchema: z.object({}) }, async () => ({ content: [] }));
        return srv;
      },
    });
    const hub = new McpHub({ transports, logger: nullLogger, client: { name: 'sovran', version: '0' } });
    hubs.push(hub);
    hub.update([configured(configs[3]!)], true);
    await until(() => hub.states()[0]?.status === 'error');
    expect(hub.states()[0]?.error).toMatch(/HCP\/TFE read tools are unavailable/);
    expect(hub.tools()).toEqual([]);
  });
  it.each([
    [configs[0]!, 'get_issue_details', 'execute_sentry_tool'],
    [configs[1]!, 'query_loki_logs', 'grafana_api_request'],
    [configs[2]!, 'search_modules', 'get_workspace_details'],
    [configs[3]!, 'get_workspace_details', 'create_run'],
    [configs[4]!, 'SearchIndexTool', 'GenericOpenSearchApiTool'],
  ] as const)(
    'filters $0.id tools through changes, reconnect and direct calls',
    async (managed, allowed, forbidden) => {
      const calls = vi.fn();
      const info = vi.fn();
      const transports = new MemoryTransports({
        [managed.id]: () => {
          const srv = new McpServer({ name: managed.id, version: integration(managed.id).version });
          for (const name of [allowed, forbidden])
            srv.registerTool(
              name,
              { inputSchema: z.object({}).passthrough(), annotations: { readOnlyHint: true } },
              async () => {
                calls();
                return { content: [{ type: 'text', text: 'upstream failure' }], isError: true };
              },
            );
          return srv;
        },
      });
      const hub = new McpHub({
        transports,
        logger: { ...nullLogger, info },
        client: { name: 'sovran', version: '0' },
      });
      hubs.push(hub);
      const config = configured(managed);
      hub.update([config], true);
      await until(() => hub.states()[0]?.status === 'connected');
      expect(hub.tools().map((t) => t.name)).toEqual([`mcp__${managed.id}__${allowed}`]);
      await expect(hub.callTool(config.id, forbidden, {}, new AbortController().signal)).rejects.toThrow(
        /no longer offered/,
      );
      if (managed.id === 'opensearch') {
        await expect(
          hub.callTool(
            config.id,
            allowed,
            { opensearch_url: 'https://evil.test' },
            new AbortController().signal,
          ),
        ).rejects.toThrow(/overrides/);
        expect(calls).not.toHaveBeenCalled();
      }
      expect(await hub.callTool(config.id, allowed, {}, new AbortController().signal)).toMatchObject({
        isError: true,
        content: 'upstream failure',
      });
      const srv = transports.servers.get(config.id)!;
      srv.registerTool('unreviewed_new_tool', { inputSchema: z.object({}) }, async () => ({ content: [] }));
      srv.sendToolListChanged();
      await until(() => info.mock.calls.some(([line]) => line.includes('tool list changed')));
      await expect(
        hub.callTool(config.id, 'unreviewed_new_tool', {}, new AbortController().signal),
      ).rejects.toThrow(/no longer offered/);
      await hub.restart(config.id);
      await until(() => hub.states()[0]?.status === 'connected');
      await expect(hub.callTool(config.id, forbidden, {}, new AbortController().signal)).rejects.toThrow(
        /no longer offered/,
      );
    },
  );
});
