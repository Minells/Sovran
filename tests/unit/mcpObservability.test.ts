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
import { fromEntry, parseMcpServers, requiresToken, toEntry } from '../../src/core/mcp/config';
import { McpHub } from '../../src/core/mcp/hub';
import { resolveLaunch } from '../../src/core/mcp/launch';
import { nullLogger } from '../../src/core/ports';
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
    id: 'grafana',
    profile: 'readonly',
    version: 'remote-v1',
    endpoint: 'https://grafana-mcp.example.test/mcp',
  },
  {
    id: 'terraform',
    profile: 'registry',
    version: 'remote-v1',
    endpoint: 'https://terraform-mcp.example.test/mcp',
  },
  {
    id: 'terraform',
    profile: 'hcp-readonly',
    version: 'remote-v1',
    endpoint: 'https://terraform-mcp.example.test/mcp',
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
    expect(requiresToken(config)).toBe(managed.id !== 'opensearch');
    const launch = resolveLaunch(config, { userHome: '/user', env: {} }, 'secret-fixture');
    expect(JSON.stringify(config)).not.toContain('secret-fixture');
    if (launch.kind === 'stdio') {
      expect(launch.args.join(' ')).not.toContain('secret-fixture');
      if (config.auth.type === 'env') expect(launch.env[config.auth.envName]).toBe('secret-fixture');
    } else expect(launch.headers.Authorization).toBe('Bearer secret-fixture');
    expect(() => integrationArguments({ ...managed, version: 'old-version' })).toThrow(/version|remote/);
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
    expect(() => normalizeIntegrationUrl('https://service.example.test/path', true)).toThrow(/origin/);
    expect(() => integrationArguments({ ...configs[1]!, instanceUrl: 'https://tfe.test' })).toThrow(/remote/);
  });

  it('rejects every OpenSearch connection override even when null or hidden from the upstream schema', () => {
    const managed = configs[3]!;
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

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sovran-remote-'));
  dirs.push(dir);
  const run = vi.fn<typeof runFileProcess>();
  const browser = vi.fn(async () => undefined);
  const manager = new ManagedMcpPackages({
    resources: path.join(dir, 'no-resources'),
    storage: path.join(dir, 'storage'),
    roots: () => [],
    authorize() {},
    changed() {},
    browser,
    run,
  });
  return { dir, manager, run, browser };
}

describe('remote managed launch validation', () => {
  it.each(configs)(
    'validates $id/$profile without resources, npm, browser or executable checks',
    async (managed) => {
      const f = await fixture();
      const config = configured(managed);
      expect(await f.manager.launch(config)).toBe(config);
      expect(f.manager.states()).toContainEqual({ id: managed.id, status: 'remote' });
      expect(f.run).not.toHaveBeenCalled();
      expect(f.browser).not.toHaveBeenCalled();
    },
  );

  it.each(configs)('rejects modified $id settings before retrieving a credential', async (managed) => {
    const f = await fixture();
    const config = configured(managed);
    const token = vi.fn(async () => 'must-not-be-read');
    const transport = new NodeMcpTransports({
      managedLaunch: (s) => f.manager.launch(s),
      variables: () => ({ userHome: f.dir, env: {} }),
      token,
    });
    for (const edit of [
      { args: ['--all-tools'] },
      { env: { TFE_TOKEN: 'secret' } },
      { auth: { type: 'env', envName: 'EVIL' } as const },
      { auth: { type: 'none' } as const },
      { command: '/evil' },
      { cwd: '/workspace' },
      { url: 'https://evil.test/mcp' },
      { headers: { Authorization: 'secret' } },
    ])
      await expect(transport.create({ ...config, ...edit }, () => {})).rejects.toThrow(/endpoint|filters/);
    expect(token).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
  });

  it('preserves legacy settings, disables them, and refuses their launch before reading a token', async () => {
    const f = await fixture();
    const token = vi.fn(async () => 'old-service-token');
    const transport = new NodeMcpTransports({
      managedLaunch: (s) => f.manager.launch(s),
      variables: () => ({ userHome: f.dir, env: {} }),
      token,
    });
    for (const [id, version] of [
      ['sentry', '0.49.0'],
      ['grafana', '2.3.0'],
      ['terraform', '1.4.1'],
    ] as const) {
      const entry = {
        id,
        enabled: true,
        command: `${id}-old`,
        managed: {
          id,
          version,
          profile: 'readonly' as const,
          executable: `${id}-old`,
          instanceUrl: 'https://old.test',
        },
        auth: { type: 'env' as const, envName: 'OLD_TOKEN' },
      };
      const { servers, problems } = parseMcpServers([entry]);
      expect(problems).toEqual([]);
      const config = servers[0]!;
      expect(config.enabled).toBe(false);
      expect(toEntry(config)).toMatchObject({ ...entry, enabled: false });
      await expect(transport.create({ ...config, enabled: true }, () => {})).rejects.toThrow(
        /removed|remote/,
      );
      expect(integrationToolAllowed(config.managed, 'anything')).toBe(false);
    }
    expect(token).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
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
    hub.update([configured(configs[2]!)], true);
    await until(() => hub.states()[0]?.status === 'error');
    expect(hub.states()[0]?.error).toMatch(/HCP\/TFE read tools are unavailable/);
    expect(hub.tools()).toEqual([]);
  });
  it.each([
    [configs[0]!, 'query_loki_logs', 'grafana_api_request'],
    [configs[1]!, 'search_modules', 'get_workspace_details'],
    [configs[2]!, 'get_workspace_details', 'create_run'],
    [configs[3]!, 'SearchIndexTool', 'GenericOpenSearchApiTool'],
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
