import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { probeConnection } from '../../src/core/providers/connection';
import { OpenAICompatibleProvider } from '../../src/core/providers/openaiCompatible';
import { MockOpenAIServer } from '../fixtures/mockOpenAIServer';

const server = new MockOpenAIServer();
let routes: Record<string, { status: number; body: unknown }> = {};

beforeAll(async () => {
  await server.start();
  server.handler = (req, res) => {
    const route = routes[req.url];
    if (!route)
      return void res
        .writeHead(404, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ error: 'not found' }));
    res.writeHead(route.status, { 'Content-Type': 'application/json' }).end(JSON.stringify(route.body));
  };
});
afterAll(() => server.stop());
beforeEach(() => {
  server.requests = [];
  routes = {};
});

const provider = () =>
  new OpenAICompatibleProvider({
    config: { id: 'p', name: 'P', baseUrl: server.baseUrl, timeoutSeconds: 5, auth: { type: 'none' } },
    getApiKey: async () => undefined,
  });

describe('model limits from the server', () => {
  it('reads vLLM max_model_len from /models, without a second request', async () => {
    routes['/v1/models'] = {
      status: 200,
      body: {
        object: 'list',
        data: [{ id: 'glm-5.3-flash', object: 'model', owned_by: 'vllm', max_model_len: 131072 }],
      },
    };
    expect(await provider().listModelInfo()).toEqual([{ id: 'glm-5.3-flash', contextWindow: 131072 }]);
    expect(server.requests.map((r) => r.url)).toEqual(['/v1/models']);
  });

  it("falls back to LiteLLM's /model/info when /models declares nothing", async () => {
    routes['/v1/models'] = { status: 200, body: { data: [{ id: 'gpt-4o' }, { id: 'local-coder' }] } };
    routes['/v1/model/info'] = {
      status: 200,
      body: {
        data: [{ model_name: 'gpt-4o', model_info: { max_input_tokens: 128000, max_output_tokens: 16384 } }],
      },
    };
    expect(await provider().listModelInfo()).toEqual([
      { id: 'gpt-4o', contextWindow: 128000, maxOutputTokens: 16384 },
      { id: 'local-coder' },
    ]);
  });

  it('keeps the model list when the server has no /model/info (Ollama, LM Studio)', async () => {
    routes['/v1/models'] = {
      status: 200,
      body: { object: 'list', data: [{ id: 'qwen2.5-coder:14b', object: 'model', owned_by: 'library' }] },
    };
    expect(await provider().listModelInfo()).toEqual([{ id: 'qwen2.5-coder:14b' }]);
    expect(server.requests.map((r) => r.url)).toEqual(['/v1/models', '/v1/model/info']);
  });

  it('returns the limits from the connection test, so they can be stored', async () => {
    routes['/v1/models'] = {
      status: 200,
      body: {
        data: [
          { id: 'a', context_length: 200000, top_provider: { max_completion_tokens: 32000 } },
          { id: 'b' },
        ],
      },
    };
    const result = await probeConnection(provider(), 'a', server.baseUrl);
    expect(result).toMatchObject({
      ok: true,
      models: ['a', 'b'],
      info: [{ id: 'a', contextWindow: 200000, maxOutputTokens: 32000 }, { id: 'b' }],
    });

    routes['/v1/models'] = { status: 200, body: { data: [{ id: 'plain' }] } };
    expect((await probeConnection(provider(), 'plain', server.baseUrl)).info).toBeUndefined();
  });
});
