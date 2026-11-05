/**
 * The SDK transports Sovran builds, against real servers: a child process over stdio (the fixture server) and an HTTP
 * server speaking Streamable HTTP. Covers what reaches the server (token, environment, working folder, headers), what
 * comes back (stderr, failures), and that a redirect to another origin is never followed.
 */
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { McpHub } from '../../src/core/mcp/hub';
import { nullLogger, type Logger } from '../../src/core/ports';
import { NodeMcpTransports } from '../../src/extension/adapters/McpTransports';
import { server, until } from '../fixtures/mcp';

const fixture = path.resolve(__dirname, '../fixtures/mcpStdioServer.mjs');
const signal = () => new AbortController().signal;
let hub: McpHub | undefined;
afterEach(async () => hub?.dispose());

function makeHub(token: string | undefined, env: Record<string, string> = {}, logger: Logger = nullLogger) {
  const transports = new NodeMcpTransports({
    variables: () => ({
      workspaceFolder: os.tmpdir(),
      userHome: os.homedir(),
      env: { ...process.env, ...env },
    }),
    token: async () => token,
  });
  return (hub = new McpHub({
    transports,
    logger,
    client: { name: 'sovran', version: '0' },
    secrets: () => [token],
  }));
}

describe('stdio transport', () => {
  it('starts the server with its token, its variables and only the environment it needs', async () => {
    const lines: string[] = [];
    const logger = { ...nullLogger, debug: (m: string) => void lines.push(m) };
    const h = makeHub(
      'tok-123456',
      { HTTPS_PROXY: 'http://proxy:3128', SOVRAN_TEST_UNRELATED: 'leak', ELECTRON_RUN_AS_NODE: '1' },
      logger,
    );
    h.update(
      [
        server({
          id: 'fx',
          command: process.execPath,
          args: [fixture, '--root', '${workspaceFolder}'],
          env: { DEMO_MODE: '${env:HTTPS_PROXY}' },
          auth: { type: 'env', envName: 'DEMO_TOKEN' },
        }),
      ],
      true,
    );
    await until(() => h.states()[0]!.status === 'connected', 15_000);
    const result = await h.callTool('fx', 'whoami', {}, signal());
    const seen = JSON.parse(result.content) as Record<string, unknown>;
    expect(seen).toMatchObject({
      token: 'tok-123456',
      mode: 'http://proxy:3128',
      proxy: 'http://proxy:3128',
      unrelated: null,
      electron: null,
      args: ['--root', os.tmpdir()],
    });
    expect(await import('node:fs').then((fs) => fs.realpathSync(String(seen.cwd)))).toBe(
      (await import('node:fs')).realpathSync(os.tmpdir()),
    );
    expect(lines).toContain('MCP fx › fixture server ready');
  });

  it('explains a command that does not exist, a slow tool and a server that exits', async () => {
    const h = makeHub(undefined);
    // A short request timeout (settings allow 5 s and up) keeps this test quick.
    h.update(
      [
        server({ id: 'missing', command: 'sovran-no-such-mcp-server' }),
        server({ id: 'fx', name: 'Fixture', command: process.execPath, args: [fixture], timeoutSeconds: 2 }),
      ],
      true,
    );
    await until(() => h.states().every((s) => s.status === 'connected' || s.status === 'error'), 15_000);
    expect(h.states()[0]).toMatchObject({
      status: 'error',
      error:
        'Could not start "sovran-no-such-mcp-server": it was not found. Install it, or use its full path.',
    });
    expect(h.states()[1]!.status).toBe('connected');

    await expect(h.callTool('fx', 'slow', { ms: 5000 }, signal())).rejects.toThrow(
      'Fixture did not answer within 2 seconds. If this tool is slow, raise the timeout',
    );
    // Stopping the run cancels the call at once, and the error is the cancellation itself, not a tool failure.
    const stop = new AbortController();
    const pending = h.callTool('fx', 'slow', { ms: 5000 }, stop.signal);
    stop.abort();
    await expect(pending).rejects.not.toThrow(/did not answer/);

    await h.callTool('fx', 'crash', {}, signal());
    await until(() => h.states()[1]!.status === 'error', 10_000);
    expect(h.states()[1]!.error).toBe('The server stopped: fatal: crashing on purpose');
  });
});

describe('Streamable HTTP transport', () => {
  let web: http.Server;
  let base = '';
  const seen: http.IncomingHttpHeaders[] = [];
  const handler = createMcpHandler(() => {
    const s = new McpServer({ name: 'web', version: '2.0.0' });
    s.registerTool(
      'echo',
      { description: 'Echoes.', inputSchema: z.object({ text: z.string() }) },
      async ({ text }) => ({ content: [{ type: 'text', text }] }),
    );
    return s;
  });

  beforeAll(async () => {
    web = http.createServer(async (req, res) => {
      seen.push(req.headers);
      const port = (web.address() as AddressInfo).port;
      // Another origin (localhost instead of 127.0.0.1): headers and tokens must never follow.
      if (req.url === '/moved')
        return void res.writeHead(307, { Location: `http://localhost:${port}/mcp` }).end();
      if (req.url === '/locked') return void res.writeHead(401).end();
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'DELETE';
      const response = await handler.fetch(
        new Request(`http://127.0.0.1:${port}${req.url}`, {
          method: req.method,
          headers,
          body: hasBody ? Buffer.concat(chunks) : undefined,
        }),
      );
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) for await (const chunk of response.body) res.write(chunk);
      res.end();
    });
    await new Promise<void>((r) => web.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(web.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await handler.close();
    web.closeAllConnections();
    await new Promise<void>((r) => web.close(() => r()));
  });

  it('connects with the token as a bearer header next to the configured headers', async () => {
    const h = makeHub('web-token-987654');
    h.update(
      [
        server({
          id: 'web',
          command: undefined,
          url: `${base}/mcp`,
          headers: { 'X-Team': 'core' },
          auth: { type: 'bearer' },
        }),
      ],
      true,
    );
    await until(() => h.states()[0]!.status !== 'starting', 10_000);
    expect(h.states()[0]).toMatchObject({ status: 'connected', server: { name: 'web', version: '2.0.0' } });
    expect(await h.callTool('web', 'echo', { text: 'hi' }, signal())).toMatchObject({
      content: 'hi',
      isError: false,
    });
    expect(seen.at(-1)).toMatchObject({ authorization: 'Bearer web-token-987654', 'x-team': 'core' });
  });

  it('does not follow a redirect to another origin, and explains a refused token', async () => {
    seen.length = 0;
    const h = makeHub('web-token-987654');
    h.update(
      [
        server({ id: 'moved', command: undefined, url: `${base}/moved`, auth: { type: 'bearer' } }),
        server({ id: 'locked', command: undefined, url: `${base}/locked`, auth: { type: 'bearer' } }),
      ],
      true,
    );
    await until(() => h.states().every((s) => s.status === 'error'), 10_000);
    expect(h.states()[0]!.error).toMatch(
      /^The server redirected to http:\/\/localhost:\d+\/mcp\. Sovran does not follow redirects to another address/,
    );
    expect(seen.filter((x) => x.host?.startsWith('localhost'))).toEqual([]);
    expect(h.states()[1]!.error).toBe('The server answered 401. Check the token and where it is sent.');
  });
});
