import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown> | undefined;
}

export type Handler = (req: RecordedRequest, res: http.ServerResponse) => unknown;

/** A real HTTP server so the provider is exercised through Node's fetch, sockets and streams. */
export class MockOpenAIServer {
  private server!: http.Server;
  handler: Handler = (_req, res) => {
    res.writeHead(500).end('no handler');
  };
  requests: RecordedRequest[] = [];
  baseUrl = '';

  async start() {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const recorded: RecordedRequest = {
          method: req.method ?? 'GET',
          url: req.url ?? '/',
          headers: req.headers,
          body: raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined,
        };
        this.requests.push(recorded);
        void this.handler(recorded, res);
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1`;
  }

  async stop() {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

export function sse(res: http.ServerResponse, events: unknown[], opts: { done?: boolean; delayMs?: number; crlf?: boolean } = {}) {
  const nl = opts.crlf ? '\r\n' : '\n';
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const frames = events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}${nl}${nl}`);
  if (opts.done !== false) frames.push(`data: [DONE]${nl}${nl}`);
  if (!opts.delayMs) {
    res.end(frames.join(''));
    return;
  }
  let i = 0;
  const tick = () => {
    if (res.destroyed) return;
    if (i >= frames.length) return void res.end();
    res.write(frames[i++]);
    setTimeout(tick, opts.delayMs);
  };
  tick();
}

export const delta = (d: Record<string, unknown>, finish: string | null = null) => ({
  id: 'x',
  object: 'chat.completion.chunk',
  choices: [{ index: 0, delta: d, finish_reason: finish }],
});
