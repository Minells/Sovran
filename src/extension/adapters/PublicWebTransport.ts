import * as dns from 'node:dns/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import * as tls from 'node:tls';
import { isIP, Socket } from 'node:net';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { ToolError } from '../../core/tools/types';
import { publicAddress, webUrl } from '../../core/web/urls';

export interface WebResponse {
  status: number;
  location?: string;
  contentType: string;
  body: Buffer;
}

export interface WebTransportDeps {
  certificateAuthorities?(): string[] | undefined;
  resolve(hostname: string): Promise<readonly { address: string; family: number }[]>;
  request(
    options: https.RequestOptions,
    callback: (response: http.IncomingMessage) => void,
    beforeConnect: () => void,
  ): http.ClientRequest;
}

const defaults: WebTransportDeps = {
  certificateAuthorities: trustedAuthorities,
  resolve: (hostname) => dns.lookup(hostname, { all: true, verbatim: true }),
  request: directWebRequest,
};

/** VS Code wraps http(s).request to apply proxies, even with agent:false. Use public socket/request primitives. */
export function directWebRequest(
  options: https.RequestOptions,
  callback: (response: http.IncomingMessage) => void,
  beforeConnect: () => void,
): http.ClientRequest {
  const secure = options.protocol === 'https:';
  const agent = secure ? new https.Agent({ keepAlive: false }) : new http.Agent({ keepAlive: false });
  agent.createConnection = () => {
    beforeConnect();
    const socket = new Socket();
    // Socket.connect is not VS Code's patched net.connect helper. The destination is already a numeric IP.
    socket.connect({
      host: String(options.hostname),
      port: Number(options.port),
      family: Number(options.family),
    });
    if (!secure) return socket;
    try {
      return tls.connect({
        socket,
        ca: options.ca,
        servername: options.servername,
        rejectUnauthorized: true,
        checkServerIdentity: options.checkServerIdentity as tls.ConnectionOptions['checkServerIdentity'],
        ALPNProtocols: ['http/1.1'],
      });
    } catch (error) {
      socket.destroy();
      throw error;
    }
  };
  try {
    const request = new http.ClientRequest({ ...options, agent }, callback);
    request.once('close', () => agent.destroy());
    return request;
  } catch (error) {
    agent.destroy();
    throw error;
  }
}

let authorities: string[] | undefined;
function trustedAuthorities(): string[] | undefined {
  // Newer extension hosts can honor trusted OS/enterprise CAs without changing TLS defaults for other clients.
  // Node 20 has no system-store API: retain its normal configured trust, including NODE_EXTRA_CA_CERTS.
  if (typeof tls.getCACertificates !== 'function') return undefined;
  return (authorities ??= [
    ...new Set([...tls.getCACertificates('default'), ...tls.getCACertificates('system')]),
  ]);
}

/** Direct sockets only. No proxy, shared agent, cookie jar, authentication or automatic redirect path. */
export class PublicWebTransport {
  constructor(private readonly deps: WebTransportDeps = defaults) {}

  async get(
    input: string,
    signal: AbortSignal,
    beforeRequest: () => void,
    maxBytes: number,
  ): Promise<WebResponse> {
    const url = webUrl(input);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    signal.throwIfAborted();
    const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await this.resolve(host, signal);
    // Reject mixed public/private results. Only a numeric validated address reaches the socket API.
    if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
      throw new ToolError('The Web destination does not resolve exclusively to public Internet addresses.');
    const address = addresses[0]!;
    const ca = url.protocol === 'https:' ? this.deps.certificateAuthorities?.() : undefined;
    signal.throwIfAborted();
    beforeRequest();
    return new Promise<WebResponse>((resolve, reject) => {
      let request: http.ClientRequest | undefined;
      let response: http.IncomingMessage | undefined;
      let settled = false;
      const finish = (error?: Error, value?: WebResponse) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abort);
        response?.destroy();
        request?.destroy();
        if (error) reject(error);
        else resolve(value!);
      };
      const abort = () => finish(new ToolError('The Web read was cancelled or timed out.'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) return abort();
      try {
        // Revalidate immediately before socket creation; no await or unvalidated DNS lookup follows it.
        beforeRequest();
        signal.throwIfAborted();
        request = this.deps.request(
          {
            protocol: url.protocol,
            hostname: address.address,
            family: address.family,
            port: url.protocol === 'https:' ? 443 : 80,
            path: url.pathname + url.search,
            method: 'GET',
            agent: false,
            maxHeaderSize: 16 * 1024,
            ...(url.protocol === 'https:'
              ? {
                  rejectUnauthorized: true,
                  ...(ca ? { ca } : {}),
                  servername: isIP(host) ? undefined : host,
                  checkServerIdentity: (_name: string, cert: tls.PeerCertificate) =>
                    tls.checkServerIdentity(host, cert),
                }
              : {}),
            headers: {
              Host: url.host,
              'User-Agent': 'SovranWeb/1.0',
              Accept: 'text/html, text/plain, text/markdown, application/json;q=0.8',
              'Accept-Encoding': 'gzip, deflate, br',
            },
          },
          (incoming) => {
            if (settled) {
              incoming.destroy();
              return;
            }
            response = incoming;
            const status = incoming.statusCode ?? 0;
            const value: WebResponse = {
              status,
              location: incoming.headers.location,
              contentType: incoming.headers['content-type'] ?? '',
              body: Buffer.alloc(0),
            };
            if (status < 200 || status >= 300) return finish(undefined, value);
            const length = Number(incoming.headers['content-length']);
            if (length > maxBytes)
              return finish(new ToolError('The Web response exceeds the download limit.'));
            const encoding = (incoming.headers['content-encoding'] ?? 'identity').toLowerCase();
            const decoder =
              encoding === 'gzip'
                ? createGunzip()
                : encoding === 'deflate'
                  ? createInflate()
                  : encoding === 'br'
                    ? createBrotliDecompress()
                    : undefined;
            if (encoding !== 'identity' && !decoder)
              return finish(new ToolError('Unsupported Web response compression.'));
            let encoded = 0;
            let decoded = 0;
            const chunks: Buffer[] = [];
            const counter = new Transform({
              transform(chunk: Buffer, _encoding, callback) {
                encoded += chunk.length;
                callback(
                  encoded > maxBytes ? new ToolError('The Web response exceeds the download limit.') : null,
                  chunk,
                );
              },
            });
            const collector = new Writable({
              write(chunk: Buffer, _encoding, callback) {
                decoded += chunk.length;
                if (decoded > maxBytes)
                  return callback(new ToolError('The decoded Web response exceeds the download limit.'));
                chunks.push(chunk);
                callback();
              },
            });
            const streams = decoder
              ? [incoming, counter, decoder, collector]
              : [incoming, counter, collector];
            void pipeline(streams, { signal }).then(
              () => finish(undefined, { ...value, body: Buffer.concat(chunks) }),
              (error: unknown) =>
                finish(
                  error instanceof ToolError
                    ? error
                    : new ToolError('The Web response ended before it could be read.'),
                ),
            );
          },
          () => {
            signal.throwIfAborted();
            beforeRequest();
          },
        );
        request.on('error', (error: NodeJS.ErrnoException) => {
          const code = error.code && /^[A-Z0-9_]{1,64}$/.test(error.code) ? ` (${error.code})` : '';
          finish(new ToolError(`The public Web connection failed${code}.`));
        });
        request.on('upgrade', (_response, socket) => {
          socket.destroy();
          finish(new ToolError('Protocol upgrades are unavailable to web_fetch.'));
        });
        request.end();
      } catch (e) {
        finish(e instanceof ToolError ? e : new ToolError('The public Web connection could not start.'));
      }
    });
  }

  private resolve(
    host: string,
    signal: AbortSignal,
  ): Promise<readonly { address: string; family: number }[]> {
    return new Promise((resolve, reject) => {
      const abort = () =>
        reject(new ToolError('The Web read was cancelled or timed out during name resolution.'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) {
        abort();
        signal.removeEventListener('abort', abort);
        return;
      }
      void this.deps
        .resolve(host)
        .then(resolve, () => reject(new ToolError('The public Web hostname could not be resolved.')))
        .finally(() => signal.removeEventListener('abort', abort));
    });
  }
}
