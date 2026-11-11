// Standalone minimum-runtime proof: no Vitest/Vite or adjacent node_modules, and only an injected local fixture.
import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import { NativeWebFetcher } from '../../src/extension/adapters/NativeWebFetcher';
import { directWebRequest, PublicWebTransport } from '../../src/extension/adapters/PublicWebTransport';
import { WorkerHtmlExtractor } from '../../src/extension/adapters/WorkerHtmlExtractor';

async function main() {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url!);
    if (req.url === '/robots.txt')
      return void res.writeHead(200, { 'Content-Type': 'text/plain' }).end('User-agent: *\nAllow: /');
    res
      .writeHead(200, { 'Content-Type': 'text/html' })
      .end(
        '<title>Runtime docs</title><main><h1>Guide</h1><pre>  const x = 1;</pre><a href="/api">API</a></main>',
      );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const transport = new PublicWebTransport({
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
      request: (bound, callback, beforeConnect) => {
        assert.equal(bound.hostname, '93.184.216.34');
        assert.equal(bound.servername, 'docs.example.com');
        return directWebRequest(
          { ...bound, protocol: 'http:', hostname: '127.0.0.1', family: 4, port },
          callback,
          beforeConnect,
        );
      },
    });
    const extractor = new WorkerHtmlExtractor(process.argv[2]!);
    const page = await new NativeWebFetcher(extractor, transport).fetch('https://docs.example.com/guide', {
      signal: new AbortController().signal,
      beforeRequest: () => {},
      maxChars: 2000,
    });
    assert.equal(page.title, 'Runtime docs');
    assert.ok(page.text.includes('```\n  const x = 1;\n```'));
    assert.deepEqual(page.links, ['https://docs.example.com/api']);
    assert.deepEqual(seen, ['/robots.txt', '/guide']);
    console.log(`Web transport and bundled worker passed on Node ${process.versions.node}.`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
