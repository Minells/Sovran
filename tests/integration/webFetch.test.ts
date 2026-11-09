import * as http from 'node:http';
import httpModule from 'node:http';
import httpsModule from 'node:https';
import netModule from 'node:net';
import * as https from 'node:https';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DetailedPeerCertificate } from 'node:tls';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import * as esbuild from 'esbuild';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeWebFetcher } from '../../src/extension/adapters/NativeWebFetcher';
import {
  directWebRequest,
  PublicWebTransport,
  type WebTransportDeps,
} from '../../src/extension/adapters/PublicWebTransport';
import { WorkerHtmlExtractor } from '../../src/extension/adapters/WorkerHtmlExtractor';
import { WEB_LIMITS } from '../../src/core/web/types';

let server: http.Server;
let port: number;
let dir: string;
let script: string;
let extractor: WorkerHtmlExtractor;
let seen: string[];
let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;
const target = 'https://docs.example.com/guide';
const signal = () => new AbortController().signal;
const options = () => ({ signal: signal(), beforeRequest: () => {}, maxChars: 10_000 });

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sovran-web-test-'));
  script = path.join(dir, 'webWorker.js');
  await esbuild.build({
    entryPoints: ['src/extension/adapters/webWorker.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    minify: true,
    outfile: script,
    logLevel: 'silent',
  });
  extractor = new WorkerHtmlExtractor(script);
  server = http.createServer((req, res) => {
    seen.push(req.url!);
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
}, 60_000);
afterAll(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await fs.rm(dir, { recursive: true, force: true });
});
beforeEach(() => {
  seen = [];
  handler = (req, res) => {
    if (req.url === '/robots.txt') {
      res.writeHead(404).end();
      return;
    }
    res
      .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      .end('<title>Docs</title><main><h1>Guide</h1><p>Read this.</p><a href="/api">API</a></main>');
  };
});
afterEach(() => {
  vi.useRealTimers();
  server.closeAllConnections();
});

/** The only loopback authorization lives in this injected test requester; production policy is always exercised first. */
function fixture(
  resolve: WebTransportDeps['resolve'] = async () => [{ address: '93.184.216.34', family: 4 }],
) {
  const dial = vi.fn<WebTransportDeps['request']>((bound, callback, beforeConnect) =>
    directWebRequest(
      {
        ...bound,
        protocol: 'http:',
        hostname: '127.0.0.1',
        family: 4,
        port,
      },
      callback,
      beforeConnect,
    ),
  );
  const dns = vi.fn(resolve);
  const transport = new PublicWebTransport({ resolve: dns, request: dial });
  return { fetcher: new NativeWebFetcher(extractor, transport), transport, dial, dns };
}

describe('native fetch through controlled sockets and the production bundled worker', () => {
  it('reads robots and one HTML page through the same pinned-address transport', async () => {
    const f = fixture();
    const page = await f.fetcher.fetch(target, options());
    expect(seen).toEqual(['/robots.txt', '/guide']);
    expect(page).toMatchObject({ title: 'Docs', url: target, links: ['https://docs.example.com/api'] });
    expect(page.text).toContain('# Guide');
    for (const [bound] of f.dial.mock.calls) {
      expect(bound.hostname).toBe('93.184.216.34');
      expect(bound.agent).toBe(false);
      expect(bound.servername).toBe('docs.example.com');
      expect(bound.rejectUnauthorized).toBe(true);
      expect(bound.lookup).toBeUndefined();
      expect(bound.headers).toMatchObject({ Host: 'docs.example.com', 'User-Agent': 'SovranWeb/1.0' });
      expect(bound.headers).not.toHaveProperty('Authorization');
      expect(bound.headers).not.toHaveProperty('Cookie');
      expect(
        bound.checkServerIdentity?.('93.184.216.34', {
          subjectaltname: 'DNS:docs.example.com',
        } as DetailedPeerCertificate),
      ).toBeUndefined();
      expect(
        bound.checkServerIdentity?.('docs.example.com', {
          subjectaltname: 'DNS:wrong.example.com',
        } as DetailedPeerCertificate),
      ).toBeInstanceOf(Error);
    }
    expect(f.dns).toHaveBeenCalledTimes(2); // Independent validation on every connection.
  });

  it.each(['text/plain', 'text/markdown', 'application/json'])(
    'supports %s without invoking HTML parsing',
    async (mime) => {
      handler = (req, res) => {
        if (req.url === '/robots.txt') return void res.writeHead(404).end();
        res.writeHead(200, { 'Content-Type': mime }).end('Simple content');
      };
      expect((await fixture().fetcher.fetch(target, options())).text).toBe('Simple content');
    },
  );

  it('checks robots allow/disallow rules again for each same-origin page redirect', async () => {
    handler = (req, res) => {
      if (req.url === '/robots.txt')
        return void res
          .writeHead(200, { 'Content-Type': 'text/plain' })
          .end('User-agent: *\nDisallow: /private\nAllow: /private/public\n');
      if (req.url === '/guide') return void res.writeHead(302, { Location: '/private/secret' }).end();
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('SECRET');
    };
    await expect(fixture().fetcher.fetch(target, options())).rejects.toThrow(/disallows/);
    expect(seen).toEqual(['/robots.txt', '/guide']);
    expect((await fixture().fetcher.fetch('https://docs.example.com/private/public', options())).text).toBe(
      'SECRET',
    );
  });

  it.each([403, 429, 500])('fails closed on robots HTTP %s before requesting the page', async (status) => {
    handler = (_req, res) => {
      res.writeHead(status).end('Error');
    };
    await expect(fixture().fetcher.fetch(target, options())).rejects.toThrow(
      /robots.txt could not be checked/,
    );
    expect(seen).toEqual(['/robots.txt']);
  });

  it('fails closed on an HTML robots response and excessive crawl-delay', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' }).end('<p>Not robots</p>');
    };
    await expect(fixture().fetcher.fetch(target, options())).rejects.toThrow(/plain text/);
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('User-agent: *\nCrawl-delay: 60');
    };
    await expect(fixture().fetcher.fetch(target, options())).rejects.toThrow(/crawl delay/);
    expect(seen).toEqual(['/robots.txt', '/robots.txt']);
  });

  it.each(['https://other.example.com/page', 'http://docs.example.com/page', 'http://127.0.0.1/secret'])(
    'does not connect to redirect destination %s',
    async (destination) => {
      handler = (req, res) => {
        if (req.url === '/robots.txt') return void res.writeHead(404).end();
        res.writeHead(302, { Location: destination }).end();
      };
      const f = fixture();
      await expect(f.fetcher.fetch(target, options())).rejects.toThrow(/origin|non-public/);
      expect(f.dial).toHaveBeenCalledTimes(2);
    },
  );

  it('bounds redirects including robots requests, and checks redirected robots through the same transport', async () => {
    handler = (req, res) => {
      if (req.url === '/robots.txt') return void res.writeHead(302, { Location: '/robots-real' }).end();
      if (req.url === '/robots-real')
        return void res.writeHead(200, { 'Content-Type': 'text/plain' }).end('User-agent: *\nAllow: /');
      res.writeHead(302, { Location: '/again' }).end();
    };
    const f = fixture();
    await expect(f.fetcher.fetch(target, options())).rejects.toThrow(/too many redirects/);
    expect(seen).toEqual(['/robots.txt', '/robots-real', '/guide', '/again', '/again', '/again']);
    expect(f.dns).toHaveBeenCalledTimes(6);
    expect(seen.length).toBeLessThanOrEqual(WEB_LIMITS.requests);
  });

  it.each(['application/octet-stream', 'image/png', 'application/pdf'])(
    'refuses unsupported MIME %s',
    async (mime) => {
      handler = (req, res) => {
        if (req.url === '/robots.txt') return void res.writeHead(404).end();
        res.writeHead(200, { 'Content-Type': mime }).end('binary');
      };
      await expect(fixture().fetcher.fetch(target, options())).rejects.toThrow(/supports HTML/);
    },
  );

  it('handles encoding, HTTP errors and script-only pages explicitly', async () => {
    handler = (req, res) => {
      if (req.url === '/robots.txt') return void res.writeHead(410).end();
      res
        .writeHead(200, { 'Content-Type': 'text/plain; charset=windows-1252' })
        .end(Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    };
    expect((await fixture().fetcher.fetch(target, options())).text).toBe('café');
    handler = (req, res) => {
      if (req.url === '/robots.txt') return void res.writeHead(404).end();
      res.writeHead(200, { 'Content-Type': 'text/html' }).end('<script>document.write("Hidden")</script>');
    };
    await expect(fixture().fetcher.fetch(target, options())).rejects.toThrow(/No readable page/);
  });

  it.each(['identity', 'gzip', 'br'])(
    'enforces the decoded-byte cap with %s compression',
    async (encoding) => {
      const bytes = Buffer.alloc(WEB_LIMITS.bodyBytes + 1, 'x');
      handler = (req, res) => {
        if (req.url === '/robots.txt') return void res.writeHead(404).end();
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Encoding': encoding });
        res.end(
          encoding === 'gzip' ? gzipSync(bytes) : encoding === 'br' ? brotliCompressSync(bytes) : bytes,
        );
      };
      await expect(fixture().fetcher.fetch(target, options())).rejects.toThrow(/download limit/);
    },
  );

  it('handles a broken encoded stream and oversized robots without fetching the page', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Encoding': 'gzip' }).end('Not gzip');
    };
    await expect(fixture().fetcher.fetch(target, options())).rejects.toThrow(/ended before/);
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('a'.repeat(WEB_LIMITS.robotsBytes + 1));
    };
    await expect(fixture().fetcher.fetch(target, options())).rejects.toThrow(/download limit/);
    expect(seen).toEqual(['/robots.txt', '/robots.txt']);
  });
});

describe('DNS, cancellation and authorization boundaries', () => {
  it('bypasses global HTTP/proxy and net.connect wrappers using direct socket/request primitives', async () => {
    const unavailable = () => {
      throw new Error('An ambient proxy wrapper was used');
    };
    const spies = [
      vi.spyOn(httpModule, 'request').mockImplementation(unavailable),
      vi.spyOn(httpsModule, 'request').mockImplementation(unavailable),
      vi.spyOn(netModule, 'connect').mockImplementation(unavailable),
    ];
    try {
      expect((await fixture().fetcher.fetch(target, options())).text).toContain('Read this.');
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
  it('checks authorization again at the raw Socket.connect boundary', async () => {
    let revoked = false;
    const transport = new PublicWebTransport({
      resolve: async () => [{ address: '8.8.8.8', family: 4 }],
      request: (bound, callback, beforeConnect) => {
        revoked = true;
        return directWebRequest(
          { ...bound, protocol: 'http:', hostname: '127.0.0.1', family: 4, port },
          callback,
          beforeConnect,
        );
      },
    });
    await expect(
      transport.get(
        target,
        signal(),
        () => {
          if (revoked) throw new Error('revoked');
        },
        1000,
      ),
    ).rejects.toThrow(/could not start/);
    expect(seen).toEqual([]);
  });
  it('refuses mixed DNS answers before opening any socket', async () => {
    const f = fixture(async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]);
    await expect(f.fetcher.fetch(target, options())).rejects.toThrow(/exclusively/);
    expect(f.dial).not.toHaveBeenCalled();
  });
  it('rechecks DNS after robots so rebinding cannot reach a private destination', async () => {
    let calls = 0;
    const f = fixture(async () => [{ address: ++calls === 1 ? '8.8.8.8' : '169.254.169.254', family: 4 }]);
    await expect(f.fetcher.fetch(target, options())).rejects.toThrow(/exclusively/);
    expect(seen).toEqual(['/robots.txt']);
  });
  it('refuses late permission revocation after DNS but before socket creation', async () => {
    let allowed = true;
    const f = fixture(async () => {
      allowed = false;
      return [{ address: '8.8.8.8', family: 4 }];
    });
    await expect(
      f.fetcher.fetch(target, {
        ...options(),
        beforeRequest: () => {
          if (!allowed) throw new Error('revoked');
        },
      }),
    ).rejects.toThrow(/revoked/);
    expect(f.dial).not.toHaveBeenCalled();
  });
  it('aborts a stalled response and rejects concurrent jobs across chats', async () => {
    let arrived!: () => void;
    const started = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.write('waiting');
      arrived();
    };
    const f = fixture();
    const abort = new AbortController();
    const pending = f.fetcher.fetch(target, { ...options(), signal: abort.signal });
    const rejected = expect(pending).rejects.toThrow(/cancelled|timed out/);
    await started;
    await expect(f.fetcher.fetch(target, options())).rejects.toThrow(/Another Web read/);
    abort.abort();
    await rejected;
    expect(seen).toEqual(['/robots.txt']);
  });
  it('times out stalled DNS without creating a socket or leaving the service busy', async () => {
    vi.useFakeTimers();
    const f = fixture(async () => new Promise(() => {}));
    const pending = expect(f.fetcher.fetch(target, options())).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(WEB_LIMITS.timeoutMs + 1);
    await pending;
    expect(f.dial).not.toHaveBeenCalled();
  });
});

describe('real HTTPS validation through a test-only trusted local CA', () => {
  it('preserves SNI/hostname validation and refuses an untrusted or differently named certificate', async () => {
    const [key, cert] = await Promise.all([
      fs.readFile('tests/fixtures/web-tls/test-only.key'),
      fs.readFile('tests/fixtures/web-tls/test-only.crt'),
    ]);
    const names: string[] = [];
    const secure = https.createServer({ key, cert }, (req, res) => {
      names.push((req.socket as { servername?: string }).servername ?? '');
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('Verified TLS');
    });
    await new Promise<void>((resolve) => secure.listen(0, '127.0.0.1', resolve));
    const securePort = (secure.address() as { port: number }).port;
    const transport = (trustFixture: boolean) =>
      new PublicWebTransport({
        certificateAuthorities: () => (trustFixture ? [cert.toString()] : undefined),
        resolve: async () => [{ address: '93.184.216.34', family: 4 }],
        request: (bound, callback, beforeConnect) =>
          directWebRequest({ ...bound, hostname: '127.0.0.1', port: securePort }, callback, beforeConnect),
      });
    try {
      const result = await transport(true).get(target, signal(), () => {}, 1000);
      expect(result.body.toString()).toBe('Verified TLS');
      expect(names).toEqual(['docs.example.com']);
      await expect(transport(false).get(target, signal(), () => {}, 1000)).rejects.toThrow(
        /connection failed/,
      );
      await expect(
        transport(true).get('https://wrong.example.com/guide', signal(), () => {}, 1000),
      ).rejects.toThrow(/connection failed/);
      expect(names).toEqual(['docs.example.com']);
    } finally {
      secure.closeAllConnections();
      await new Promise<void>((resolve) => secure.close(() => resolve()));
    }
  });
});

describe('worker lifecycle', () => {
  it('reports a missing worker and an already cancelled job', async () => {
    await expect(
      new WorkerHtmlExtractor(path.join(dir, 'missing.js')).extract('<p>Hello</p>', target, 1000, signal()),
    ).rejects.toThrow(/worker/);
    const abort = new AbortController();
    abort.abort();
    await expect(extractor.extract('<p>Hello</p>', target, 1000, abort.signal)).rejects.toThrow(/cancelled/);
  });
  it('terminates a pathological worker on cancellation', async () => {
    const hang = path.join(dir, 'hang.cjs');
    await fs.writeFile(hang, 'setInterval(() => {}, 1000)');
    const abort = new AbortController();
    const pending = new WorkerHtmlExtractor(hang).extract('<p>Hello</p>', target, 1000, abort.signal);
    const rejected = expect(pending).rejects.toThrow(/cancelled/);
    setTimeout(() => abort.abort(), 30);
    await rejected;
  });
});
