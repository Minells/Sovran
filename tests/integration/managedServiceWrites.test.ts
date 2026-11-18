/** Opt-in release checks. Only local API fixtures and dummy credentials; no production mutations or downloads. */
import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  integration,
  integrationConnection,
  type IntegrationId,
  type ManagedIntegration,
} from '../../src/core/mcp/catalog';
import { integrationWriteTools } from '../../src/core/mcp/writes';
import { fromEntry } from '../../src/core/mcp/config';
import { McpHub } from '../../src/core/mcp/hub';
import { nullLogger } from '../../src/core/ports';
import { ManagedMcpPackages } from '../../src/extension/adapters/ManagedMcpPackages';
import { NodeMcpTransports } from '../../src/extension/adapters/McpTransports';
import { until } from '../fixtures/mcp';

const candidates = [
  ['sentry', process.env.SOVRAN_TEST_SENTRY_MCP],
  ['grafana', process.env.SOVRAN_TEST_GRAFANA_MCP],
  ['terraform', process.env.SOVRAN_TEST_TERRAFORM_MCP],
] as const;

describe('released service MCP write profiles', { timeout: 30000 }, () => {
  for (const [id, executable] of candidates) {
    it.skipIf(!executable)(`initializes and writes only to the local ${id} API fixture`, async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), `sovran-${id}-writes-`));
      const requests: Array<{ method: string; path: string; body: unknown; authorization?: string }> = [];
      let deny = false;
      const fixture = http.createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk as Buffer);
        const raw = Buffer.concat(chunks).toString();
        const body = raw ? JSON.parse(raw) : undefined;
        requests.push({
          method: request.method!,
          path: request.url!,
          body,
          authorization: request.headers.authorization,
        });
        response.setHeader(
          'Content-Type',
          id === 'terraform' ? 'application/vnd.api+json' : 'application/json',
        );
        if (deny && request.method === 'POST') {
          response.writeHead(403).end(JSON.stringify({ detail: 'fixture denied' }));
          return;
        }
        if (id === 'terraform') {
          response.setHeader('TFP-API-Version', '2.7');
          response.setHeader('TFE-Version', '202611-1');
          if (request.url === '/api/v2/ping') {
            response.end('{}');
            return;
          }
          if (request.method === 'GET' && request.url?.includes('/workspaces/')) {
            response.end(
              JSON.stringify({
                data: {
                  id: 'ws-fixture',
                  type: 'workspaces',
                  attributes: { name: 'test', locked: false, 'auto-apply': true },
                },
              }),
            );
            return;
          }
          if (request.method === 'POST' && request.url === '/api/v2/runs') {
            response.end(
              JSON.stringify({
                data: {
                  id: 'run-fixture',
                  type: 'runs',
                  attributes: { status: 'pending', message: 'fixture' },
                },
              }),
            );
            return;
          }
          if (request.method === 'POST' && request.url?.endsWith('/actions/apply')) {
            response.writeHead(202).end();
            return;
          }
        }
        if (id === 'sentry' && request.method === 'POST' && request.url?.endsWith('/notes/')) {
          response.end(
            JSON.stringify({
              id: 'note-fixture',
              type: 'note',
              dateCreated: '2026-11-18T12:00:00Z',
              data: { text: 'Investigating' },
            }),
          );
          return;
        }
        if (id === 'grafana') {
          if (request.url === '/api/frontend/settings') {
            response.end(JSON.stringify({ buildInfo: { version: '12.0.0' } }));
            return;
          }
          if (request.method === 'POST' && request.url === '/api/annotations') {
            response.end(JSON.stringify({ id: 1, message: 'Annotation added' }));
            return;
          }
        }
        response.writeHead(404).end(JSON.stringify({ detail: 'unknown fixture route' }));
      });
      let hub: McpHub | undefined;
      try {
        await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
        const url = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
        const managed: ManagedIntegration = {
          id: id as IntegrationId,
          profile: id === 'terraform' ? 'hcp-operations' : 'collaboration',
          version: integration(id).version,
          executable: executable!,
          instanceUrl: url,
        };
        const packages = new ManagedMcpPackages({
          resources: path.resolve('resources/mcp'),
          storage: path.join(directory, 'storage'),
          roots: () => [process.cwd()],
          authorize() {},
          changed() {},
        });
        const transports = new NodeMcpTransports({
          managedLaunch: (server) => packages.launch(server),
          variables: () => ({
            userHome: directory,
            env: {
              ...process.env,
              XDG_CONFIG_HOME: path.join(directory, 'config'),
              XDG_CACHE_HOME: path.join(directory, 'cache'),
              XDG_DATA_HOME: path.join(directory, 'data'),
            },
          }),
          token: async () => 'sntryu_fixture-placeholder-not-a-real-token',
        });
        hub = new McpHub({
          transports,
          logger: nullLogger,
          client: { name: 'sovran-release-fixture', version: '0' },
        });
        hub.update([fromEntry({ id, managed, ...integrationConnection(managed), timeoutSeconds: 10 })], true);
        await until(() => ['connected', 'error'].includes(hub!.states()[0]!.status), 20000);
        expect(hub.states()[0]?.error).toBeUndefined();
        const offered = hub.states()[0]!.tools.map((tool) => tool.name);
        for (const name of integrationWriteTools(id, managed.profile)) expect(offered).toContain(name);
        for (const name of ['execute_sentry_tool', 'create_project', 'create_datasource', 'grafana_api_request', 'delete_workspace_safely'])
          expect(offered).not.toContain(name);
        const tool =
          id === 'sentry' ? 'add_issue_note' : id === 'grafana' ? 'create_annotation' : 'create_run';
        const args =
          id === 'sentry'
            ? { organizationSlug: 'acme', issueId: 'APP-1', text: 'Investigating' }
            : id === 'grafana'
              ? { text: 'Release deployed', tags: ['release'] }
              : { terraform_org_name: 'acme', workspace_name: 'test', run_type: 'plan_and_apply' };
        const result = await hub.callTool(id, tool, args, new AbortController().signal);
        expect(result.isError, result.content).toBe(false);
        const mutation = requests.find((request) => request.method === 'POST')!;
        expect(mutation).toBeDefined();
        expect(mutation.authorization).toBe('Bearer sntryu_fixture-placeholder-not-a-real-token');
        if (id === 'terraform') {
          expect(mutation.path).toBe('/api/v2/runs');
          expect(mutation.body).toMatchObject({ data: { attributes: { 'auto-apply': false } } });
          expect(requests.some((request) => request.path.endsWith('/actions/apply'))).toBe(false);
          expect(
            (
              await hub.callTool(
                id,
                'action_run',
                { run_action: 'apply', run_id: 'run-fixture' },
                new AbortController().signal,
              )
            ).isError,
          ).toBe(false);
          expect(requests.at(-1)?.path).toBe('/api/v2/runs/run-fixture/actions/apply');
        } else
          expect(mutation.body).toMatchObject({
            text: id === 'sentry' ? 'Investigating' : 'Release deployed',
          });
        deny = true;
        expect((await hub.callTool(id, tool, args, new AbortController().signal)).isError).toBe(true);
      } finally {
        await hub?.dispose();
        fixture.closeAllConnections();
        await new Promise<void>((resolve) => fixture.close(() => resolve()));
        await fs.rm(directory, { recursive: true, force: true });
      }
    });
  }
});
