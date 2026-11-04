import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { normalizeApiKey, probeConnection } from '../../src/core/providers/connection';
import { ProviderError } from '../../src/core/providers/errors';
import { OpenAICompatibleProvider } from '../../src/core/providers/openaiCompatible';
import type { ProviderAuth, ProviderEvent } from '../../src/core/providers/types';
import { MockOpenAIServer, delta, sse } from '../fixtures/mockOpenAIServer';

/**
 * An API gateway in the style of APISIX in front of an OpenAI-compatible model: it reads the key from
 * `Authorization: Bearer <key>` (what the OpenAI SDK, and so Continue, sends), answers 401 with its own message when
 * the key is missing or unknown, and in the second variant refuses /models to keys that may only chat.
 */
const KEY = 'lhy-test-0123456789';
const gateway = new MockOpenAIServer();
let modelsAllowed = true;

beforeAll(async () => {
  await gateway.start();
  gateway.handler = (req, res) => {
    const auth = req.headers.authorization;
    const key = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length) : undefined;
    if (key !== KEY) {
      res
        .writeHead(401, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ message: 'chiave non riconosciuta' }));
      return;
    }
    if (req.url === '/v1/models') {
      if (!modelsAllowed)
        return void res
          .writeHead(401, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ message: 'chiave non riconosciuta' }));
      return void res
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ data: [{ id: 'glm-5.3-flash' }] }));
    }
    // An always-reasoning model: reasoning first, then the answer.
    sse(res, [
      delta({ role: 'assistant', reasoning_content: 'The user says ping.' }),
      delta({ content: 'pong' }, 'stop'),
    ]);
  };
});
afterAll(() => gateway.stop());
beforeEach(() => {
  gateway.requests = [];
  modelsAllowed = true;
});

const provider = (auth: ProviderAuth | undefined, key: string | undefined) =>
  new OpenAICompatibleProvider({
    config: {
      id: 'lhy',
      name: 'LHY',
      baseUrl: gateway.baseUrl,
      timeoutSeconds: 5,
      ...(auth ? { auth } : {}),
    },
    getApiKey: async () => key,
  });

async function chatError(p: OpenAICompatibleProvider): Promise<ProviderError> {
  try {
    for await (const _ of p.streamChat(
      { model: 'glm-5.3-flash', messages: [{ role: 'user', content: 'hi' }] },
      new AbortController().signal,
    ))
      void _;
  } catch (e) {
    expect(e).toBeInstanceOf(ProviderError);
    return e as ProviderError;
  }
  throw new Error('expected a 401');
}

describe('API gateway authentication', () => {
  it('works with the default (API key as Authorization: Bearer), like the OpenAI SDK', async () => {
    const events: ProviderEvent[] = [];
    for await (const e of provider(undefined, KEY).streamChat(
      { model: 'glm-5.3-flash', messages: [{ role: 'user', content: 'hi' }] },
      new AbortController().signal,
    ))
      events.push(e);
    expect(events).toContainEqual({ type: 'text', text: 'pong' });
    expect(gateway.requests[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it('explains a 401 when the key went in a custom header the gateway does not read', async () => {
    const err = await chatError(provider({ type: 'header', headerName: 'api-key' }, KEY));
    expect(gateway.requests[0]!.headers['api-key']).toBe(KEY);
    expect(gateway.requests[0]!.headers.authorization).toBeUndefined();
    expect(err.kind).toBe('auth');
    expect(err.message).toBe('HTTP 401: chiave non riconosciuta');
    expect(err.hint).toMatch(
      /sent the stored key in the "api-key" header.*Authorization: Bearer <key>.*API key/,
    );
  });

  it('explains a 401 when no key is stored', async () => {
    const err = await chatError(provider({ type: 'bearer' }, undefined));
    expect(gateway.requests[0]!.headers.authorization).toBeUndefined();
    expect(err.hint).toMatch(/No API key is stored/);
  });

  it('explains a 401 when the bearer key itself is wrong, without revealing it', async () => {
    const err = await chatError(provider({ type: 'bearer' }, 'wrong-key-123456'));
    expect(err.hint).toMatch(
      /sent the stored key as "Authorization: Bearer <key>".*Check that the key is right/,
    );
    expect(`${err.message} ${err.hint}`).not.toContain('wrong-key-123456');
  });

  it('turns a key pasted with "Bearer " into a key that works', async () => {
    const { key, notes } = normalizeApiKey(`  Bearer ${KEY}\n`);
    expect(key).toBe(KEY);
    expect(notes).toEqual(['the "Bearer " prefix (Sovran adds it)']);
    const ok = await probeConnection(provider({ type: 'bearer' }, key), 'glm-5.3-flash', gateway.baseUrl);
    expect(ok).toMatchObject({ ok: true, models: ['glm-5.3-flash'] });
  });

  it('connects through chat when the gateway refuses /models to the key', async () => {
    modelsAllowed = false;
    const result = await probeConnection(provider({ type: 'bearer' }, KEY), 'glm-5.3-flash', gateway.baseUrl);
    expect(result.ok).toBe(true);
    expect(result.message).toBe('Connected · chat works, but the server refused to list models (HTTP 401)');
    expect(gateway.requests.map((r) => r.url)).toEqual(['/v1/models', '/v1/chat/completions']);
    expect(gateway.requests[1]!.body).toMatchObject({ model: 'glm-5.3-flash', max_tokens: 1 });
  });

  it('reports the real auth problem when chat is refused too, or when there is no model to try', async () => {
    const wrong = await probeConnection(
      provider({ type: 'header', headerName: 'api-key' }, KEY),
      'glm-5.3-flash',
      gateway.baseUrl,
    );
    expect(wrong).toMatchObject({ ok: false, message: 'HTTP 401: chiave non riconosciuta' });
    expect(wrong.hint).toMatch(/"api-key" header/);

    modelsAllowed = false;
    const noModel = await probeConnection(provider({ type: 'bearer' }, KEY), undefined, gateway.baseUrl);
    expect(noModel.ok).toBe(false);
    expect(noModel.hint).toMatch(/add a model ID and test again/);
  });
});

describe('normalizeApiKey', () => {
  it('keeps a clean key as it is', () => {
    expect(normalizeApiKey('sk-abc123')).toEqual({ key: 'sk-abc123', notes: [] });
  });

  it('removes what is commonly copied around a key', () => {
    expect(normalizeApiKey('Authorization: Bearer sk-abc').key).toBe('sk-abc');
    expect(normalizeApiKey('"sk-abc"')).toEqual({ key: 'sk-abc', notes: ['the quotes around the key'] });
    expect(normalizeApiKey("bearer 'sk-abc'").notes).toEqual([
      'the "Bearer " prefix (Sovran adds it)',
      'the quotes around the key',
    ]);
    expect(normalizeApiKey('sk-ab\nc').key).toBe('sk-abc');
    expect(normalizeApiKey('   ').key).toBe('');
  });
});
