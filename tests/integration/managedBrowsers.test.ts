/** Opt-in: uses previously installed locked packages and system Chrome; never installs or attaches to personal data. */
import * as http from 'node:http';
import type { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { McpHub } from '../../src/core/mcp/hub';
import { fromEntry } from '../../src/core/mcp/config';
import { integration } from '../../src/core/mcp/catalog';
import { nullLogger } from '../../src/core/ports';
import { ManagedMcpPackages } from '../../src/extension/adapters/ManagedMcpPackages';
import { NodeMcpTransports } from '../../src/extension/adapters/McpTransports';
import { until } from '../fixtures/mcp';

const storage = process.env.SOVRAN_MCP_SMOKE_STORAGE;
describe.skipIf(!storage)('real managed browser servers', () => {
  const fixture = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(
      '<title>Sovran MCP fixture</title><h1>Browser fixture</h1><button onclick="this.textContent=\'Clicked successfully\'">Click fixture</button><script>console.log("fixture console");fetch("/data")</script>',
    );
  });
  let url: string;
  beforeAll(async () => {
    await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
  });
  it.each(['playwright', 'devtools'] as const)(
    'handshakes, filters, calls and stops %s',
    async (id) => {
      const packages = new ManagedMcpPackages({
        resources: `${process.cwd()}/resources/mcp`,
        storage: storage!,
        roots: () => [],
        authorize() {},
        changed() {},
      });
      const transports = new NodeMcpTransports({
        variables: () => ({ env: process.env, userHome: storage! }),
        token: async () => undefined,
        managedLaunch: async (server) => {
          const launch = await packages.launch(server);
          return { ...launch, args: [...launch.args!, '--headless'] };
        },
      });
      let transport: StdioClientTransport | undefined;
      let pid: number | null | undefined;
      const hub = new McpHub({
        transports: {
          create: async (server, log) => {
            transport = (await transports.create(server, log)) as StdioClientTransport;
            return transport;
          },
        },
        logger: nullLogger,
        client: { name: 'sovran-test', version: '0.1.0' },
      });
      try {
        hub.update(
          [
            fromEntry({
              id,
              command: 'node',
              timeoutSeconds: 30,
              managed: { id, profile: 'isolated', version: integration(id).version },
            }),
          ],
          true,
        );
        await until(() => ['connected', 'error'].includes(hub.states()[0]!.status), 20_000);
        expect(hub.states()[0]!.error).toBeUndefined();
        pid = transport?.pid;
        expect(pid).toBeGreaterThan(0);
        const names = hub.states()[0]!.tools.map((tool) => tool.name);
        expect(names.length).toBeGreaterThan(5);
        expect(names).not.toContain('browser_evaluate');
        expect(names).not.toContain('evaluate_script');
        expect(names).not.toContain('browser_file_upload');
        const call = async (tool: string, args: Record<string, unknown> = {}) => {
          const result = await hub.callTool(id, tool, args, new AbortController().signal);
          expect(result.isError, result.content).toBe(false);
          return result.content;
        };
        if (id === 'playwright') {
          expect(await call('browser_navigate', { url })).toContain('Sovran MCP fixture');
          const snapshot = await call('browser_snapshot');
          expect(snapshot).toContain('Browser fixture');
          const ref = /button "Click fixture" \[ref=([^\]]+)\]/.exec(snapshot)?.[1];
          expect(ref).toBeDefined();
          await call('browser_click', { target: ref });
          expect(await call('browser_snapshot')).toContain('Clicked successfully');
          await call('browser_close');
        } else {
          const pages = await call('new_page', { url });
          const pageId = Number(/(?:^|\n)(\d+):.*127\.0\.0\.1/.exec(pages)?.[1]);
          expect(Number.isFinite(pageId), pages).toBe(true);
          expect(await call('take_snapshot', { pageId })).toContain('Browser fixture');
          expect(await call('list_console_messages', { pageId })).toContain('fixture console');
          expect(await call('list_network_requests', { pageId })).toContain(url);
        }
        await expect(
          hub.callTool(
            id,
            id === 'playwright' ? 'browser_run_code' : 'evaluate_script',
            {},
            new AbortController().signal,
          ),
        ).rejects.toThrow(/no longer offered/);
      } finally {
        await hub.dispose();
        packages.dispose();
      }
      expect(hub.tools()).toEqual([]);
      await until(() => {
        try {
          process.kill(pid!, 0);
          return false;
        } catch {
          return true;
        }
      }, 3000);
    },
    60_000,
  );
});
