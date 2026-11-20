/** Opt-in release checks. Only local API fixtures and dummy credentials; no production mutations or downloads. */
import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
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
      let child: ChildProcess | undefined;
      let gateway: http.Server | undefined;
      try {
        await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
        const url = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
        // The test harness is the operator: start the released server remotely, not through Sovran's launcher.
        const reservation = http.createServer();
        await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
        const port = (reservation.address() as { port: number }).port;
        await new Promise<void>((resolve) => reservation.close(() => resolve()));
        const runtimeUrl = `http://127.0.0.1:${port}`;
        let diagnostics = '';
        child = spawn(
          executable!,
          id === 'grafana'
            ? ['-t', 'streamable-http', '--address', `127.0.0.1:${port}`, '--usage-stats=disabled']
            : ['streamable-http', '--transport-port', String(port)],
          {
            cwd: directory,
            env: {
              ...process.env,
              GRAFANA_URL: url,
              GRAFANA_SERVICE_ACCOUNT_TOKEN: 'product-fixture-token',
              MCP_GRAFANA_SERVER_TOKEN: 'gateway-fixture-token',
              TFE_ADDRESS: url,
              TFE_TOKEN: '',
              ENABLE_TF_OPERATIONS: 'true',
              DO_NOT_TRACK: '1',
              OTEL_METRICS_ENABLED: 'false',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        child.on('error', (error) => {
          diagnostics += error.message;
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          diagnostics = (diagnostics + chunk.toString()).slice(-6000);
        });
        child.stdout?.on('data', () => {});
        const deadline = Date.now() + 10000;
        while (true) {
          if (child.exitCode !== null || Date.now() > deadline)
            throw new Error(`MCP did not start: ${diagnostics}`);
          try {
            await fetch(`${runtimeUrl}/${id === 'grafana' ? 'healthz' : 'health'}`);
            break;
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 30));
          }
        }
        gateway = http.createServer((request, response) => {
          if (request.headers.authorization !== 'Bearer gateway-fixture-token') {
            response.writeHead(401).end();
            return;
          }
          // Terraform HTTP interprets Authorization as the TFE token. Authenticate the caller first, then
          // replace it with the operator's backend credential. Never forward the gateway credential to TFE.
          const headers = {
            ...request.headers,
            host: `127.0.0.1:${port}`,
            authorization: `Bearer ${id === 'terraform' ? 'product-fixture-token' : 'gateway-fixture-token'}`,
          };
          const upstream = http.request(
            `${runtimeUrl}${request.url}`,
            { method: request.method, headers },
            (reply) => {
              response.writeHead(reply.statusCode!, reply.headers);
              reply.pipe(response);
            },
          );
          upstream.on('error', () => response.destroy());
          request.pipe(upstream);
        });
        await new Promise<void>((resolve) => gateway!.listen(0, '127.0.0.1', resolve));
        const endpoint = `http://127.0.0.1:${(gateway.address() as { port: number }).port}/mcp`;
        const managed: ManagedIntegration = {
          id: id as IntegrationId,
          profile: id === 'terraform' ? 'hcp-operations' : 'collaboration',
          version: integration(id).version,
          endpoint,
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
          token: async () => 'gateway-fixture-token',
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
        for (const name of [
          'create_project',
          'create_datasource',
          'grafana_api_request',
          'delete_workspace_safely',
        ])
          expect(offered).not.toContain(name);
        const tool = id === 'grafana' ? 'create_annotation' : 'create_run';
        const args =
          id === 'grafana'
            ? { text: 'Release deployed', tags: ['release'] }
            : { terraform_org_name: 'acme', workspace_name: 'test', run_type: 'plan_and_apply' };
        const result = await hub.callTool(id, tool, args, new AbortController().signal);
        expect(result.isError, result.content).toBe(false);
        const mutation = requests.find((request) => request.method === 'POST')!;
        expect(mutation).toBeDefined();
        expect(mutation.authorization).toBe('Bearer product-fixture-token');
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
            text: 'Release deployed',
          });
        deny = true;
        expect((await hub.callTool(id, tool, args, new AbortController().signal)).isError).toBe(true);
      } finally {
        await hub?.dispose();
        if (gateway) {
          gateway.closeAllConnections();
          await new Promise<void>((resolve) => gateway!.close(() => resolve()));
        }
        if (child && child.exitCode === null) {
          const stopped = once(child, 'exit');
          child.kill('SIGKILL');
          await stopped;
        }
        fixture.closeAllConnections();
        await new Promise<void>((resolve) => fixture.close(() => resolve()));
        await fs.rm(directory, { recursive: true, force: true });
      }
    });
  }
});
