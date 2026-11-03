import * as net from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OpenAICompatibleProvider } from '../../src/core/providers/openaiCompatible';
import { ProviderError } from '../../src/core/providers/errors';
import type { ProviderEvent } from '../../src/core/providers/types';
import { MockOpenAIServer, delta, sse } from '../fixtures/mockOpenAIServer';

const server = new MockOpenAIServer();
beforeAll(() => server.start());
afterAll(() => server.stop());
beforeEach(() => {
  server.requests = [];
});

function provider(overrides: Partial<ConstructorParameters<typeof OpenAICompatibleProvider>[0]['config']> = {}, key?: string) {
  return new OpenAICompatibleProvider({
    config: { id: 'p', name: 'P', baseUrl: `${server.baseUrl}/`, timeoutSeconds: 5, ...overrides },
    getApiKey: async () => key,
  });
}

async function collect(it: AsyncIterable<ProviderEvent>) {
  const out: ProviderEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const req = { model: 'm', messages: [{ role: 'user' as const, content: 'hi' }] };
const tools = [{ type: 'function' as const, function: { name: 'read_file', description: 'd', parameters: { type: 'object' } } }];

async function expectError(p: Promise<unknown>): Promise<ProviderError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ProviderError);
    return e as ProviderError;
  }
  throw new Error('expected an error');
}

describe('OpenAICompatibleProvider — compatibility scenarios', () => {
  it('streams text and sends only portable request fields', async () => {
    server.handler = (_r, res) => sse(res, [delta({ role: 'assistant' }), delta({ content: 'Hel' }), delta({ content: 'lo' }, 'stop')]);
    const events = await collect(provider({}, 'sk-secret-123456').streamChat({ ...req, tools, temperature: 0.2 }, new AbortController().signal));
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('')).toBe('Hello');
    expect(events).toContainEqual({ type: 'finish', reason: 'stop' });
    const r = server.requests[0]!;
    expect(r.url).toBe('/v1/chat/completions'); // trailing slash in baseUrl normalized
    expect(r.headers.authorization).toBe('Bearer sk-secret-123456');
    expect(Object.keys(r.body!).sort()).toEqual(['messages', 'model', 'stream', 'temperature', 'tools']);
  });

  it('accumulates native tool-call deltas split across chunks, including parallel calls', async () => {
    server.handler = (_r, res) =>
      sse(res, [
        delta({ tool_calls: [{ index: 0, id: 'a', type: 'function', function: { name: 'read_file', arguments: '' } }] }),
        delta({ tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] }),
        delta({ tool_calls: [{ index: 1, id: 'b', function: { name: 'list_directory', arguments: '{}' } }] }),
        delta({ tool_calls: [{ index: 0, function: { arguments: 'th":"x"}' } }] }, 'tool_calls'),
      ]);
    const events = await collect(provider().streamChat({ ...req, tools }, new AbortController().signal));
    const deltas = events.filter((e) => e.type === 'tool_call_delta');
    const byIndex = new Map<number, string>();
    for (const d of deltas) if (d.type === 'tool_call_delta') byIndex.set(d.index, (byIndex.get(d.index) ?? '') + (d.argumentsDelta ?? ''));
    expect(byIndex.get(0)).toBe('{"path":"x"}');
    expect(byIndex.get(1)).toBe('{}');
  });

  it('handles servers that ignore stream:true and return plain JSON (with object arguments)', async () => {
    server.handler = (_r, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: { content: 'ok', tool_calls: [{ id: 't', function: { name: 'read_file', arguments: { path: 'a' } } }] },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 1 },
        }),
      );
    };
    const events = await collect(provider().streamChat(req, new AbortController().signal));
    expect(events).toContainEqual({ type: 'text', text: 'ok' });
    expect(events).toContainEqual({ type: 'tool_call_delta', index: 0, id: 't', name: 'read_file', argumentsDelta: '{"path":"a"}' });
    expect(events).toContainEqual({ type: 'usage', promptTokens: 3, completionTokens: 1 });
  });

  it('parses reasoning_content deltas, CRLF framing and a missing [DONE]', async () => {
    server.handler = (_r, res) =>
      sse(res, [delta({ reasoning_content: 'think…' }), delta({ content: 'answer' }, 'stop')], { done: false, crlf: true });
    const events = await collect(provider().streamChat(req, new AbortController().signal));
    expect(events[0]).toEqual({ type: 'reasoning', text: 'think…' });
    expect(events).toContainEqual({ type: 'text', text: 'answer' });
  });

  it('classifies a 400 that rejects tools as tools_unsupported', async () => {
    server.handler = (_r, res) => res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: 'model does not support tools' } }));
    const err = await expectError(collect(provider().streamChat({ ...req, tools }, new AbortController().signal)));
    expect(err.kind).toBe('tools_unsupported');
  });

  it('does not misclassify tool-like errors when no tools were sent', async () => {
    server.handler = (_r, res) => res.writeHead(400).end(JSON.stringify({ error: 'invalid tool format' }));
    const err = await expectError(collect(provider().streamChat(req, new AbortController().signal)));
    expect(err.kind).toBe('bad_request');
  });

  it.each([
    [401, 'auth'],
    [404, 'not_found'],
    [429, 'rate_limit'],
    [503, 'server'],
  ])('maps HTTP %i to %s and redacts secrets', async (status, kind) => {
    server.handler = (_r, res) => res.writeHead(status).end(JSON.stringify({ error: { message: 'bad key sk-secret-123456' } }));
    const err = await expectError(collect(provider({}, 'sk-secret-123456').streamChat(req, new AbortController().signal)));
    expect(err.kind).toBe(kind);
    expect(err.message).not.toContain('sk-secret-123456');
  });

  it('detects context-length errors', async () => {
    server.handler = (_r, res) => res.writeHead(400).end(JSON.stringify({ error: { message: "This model's maximum context length is 8192 tokens" } }));
    const err = await expectError(collect(provider().streamChat(req, new AbortController().signal)));
    expect(err.kind).toBe('context_length');
  });

  it('surfaces errors sent inside the stream', async () => {
    server.handler = (_r, res) => sse(res, [delta({ content: 'a' }), { error: { message: 'upstream exploded' } }]);
    const err = await expectError(collect(provider().streamChat(req, new AbortController().signal)));
    expect(err.message).toContain('upstream exploded');
  });

  it('cancels mid-stream via AbortSignal', async () => {
    server.handler = (_r, res) => sse(res, Array.from({ length: 50 }, (_, i) => delta({ content: `${i}` })), { delayMs: 20 });
    const ac = new AbortController();
    const seen: ProviderEvent[] = [];
    const err = await expectError(
      (async () => {
        for await (const e of provider().streamChat(req, ac.signal)) {
          seen.push(e);
          if (seen.length === 3) ac.abort();
        }
      })(),
    );
    expect(err.kind).toBe('cancelled');
    expect(seen.length).toBeLessThan(10);
  });

  it('times out when the server stalls (idle timeout)', async () => {
    server.handler = (_r, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify(delta({ content: 'a' }))}\n\n`);
      // never ends
    };
    const p = new OpenAICompatibleProvider({
      config: { id: 'p', name: 'P', baseUrl: server.baseUrl, timeoutSeconds: 5 },
      getApiKey: async () => undefined,
    });
    // Shrink the timeout for the test without exposing a sub-5s config value.
    (p as unknown as { options: { config: { timeoutSeconds: number } } }).options.config.timeoutSeconds = 0.3;
    const err = await expectError(collect(p.streamChat(req, new AbortController().signal)));
    expect(err.kind).toBe('timeout');
  }, 10_000);

  it('reports connection refused with an actionable hint', async () => {
    // Grab a free ephemeral port, then close it so nothing is listening there.
    const probe = net.createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const port = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const p = new OpenAICompatibleProvider({ config: { id: 'x', name: 'X', baseUrl: `http://127.0.0.1:${port}/v1` }, getApiKey: async () => undefined });
    const err = await expectError(collect(p.streamChat(req, new AbortController().signal)));
    expect(err.kind).toBe('network');
    expect(err.hint).toMatch(/running/);
  });

  it('uses a custom auth header and extra headers', async () => {
    server.handler = (_r, res) => sse(res, [delta({ content: 'x' }, 'stop')]);
    await collect(
      provider({ auth: { type: 'header', headerName: 'api-key' }, headers: { 'X-Team': 'core' } }, 'k-123456').streamChat(req, new AbortController().signal),
    );
    expect(server.requests[0]!.headers['api-key']).toBe('k-123456');
    expect(server.requests[0]!.headers['x-team']).toBe('core');
    expect(server.requests[0]!.headers.authorization).toBeUndefined();
  });

  it('lists models from data[], models[] and plain arrays', async () => {
    server.handler = (_r, res) => res.writeHead(200).end(JSON.stringify({ data: [{ id: 'b' }, { id: 'a' }, { id: 'a' }] }));
    expect(await provider().listModels()).toEqual(['a', 'b']);
    server.handler = (_r, res) => res.writeHead(200).end(JSON.stringify({ models: [{ name: 'llama' }] }));
    expect(await provider().listModels()).toEqual(['llama']);
    server.handler = (_r, res) => res.writeHead(404).end('not found');
    const err = await expectError(provider().listModels());
    expect(err.kind).toBe('not_found');
    expect(err.hint).toMatch(/\/v1|manually/);
  });
});
