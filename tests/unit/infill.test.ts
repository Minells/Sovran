import { describe, expect, it, vi } from 'vitest';
import { cleanInfill, InfillRequests, infillEndpoint, requestInfill } from '../../src/core/providers/infill';

const fresh = () => new AbortController().signal;
const current = () => true;
function deferred() {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('inline infill', () => {
  it('uses the same-origin native route, bounded raw FIM and configured authentication', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ content: '<|fim_middle|>value);<|endoftext|>' }));
    const config = {
      id: 'x',
      name: 'Test',
      baseUrl: 'https://gateway.example/proxy/v1/',
      auth: { type: 'header' as const, headerName: 'x-api-key' },
    };
    const output = await requestInfill(
      { config, fetch, getApiKey: async () => 'known-secret' },
      { model: 'coder', prefix: 'x'.repeat(5000), suffix: ');' },
      fresh(),
      current,
    );
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe('https://gateway.example/proxy/infill');
    expect(init).toMatchObject({ redirect: 'manual', headers: { 'x-api-key': 'known-secret' } });
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'coder',
      input_prefix: 'x'.repeat(3000),
      input_suffix: ');',
      prompt: '',
      stream: false,
      n_predict: 64,
      temperature: 0,
    });
    expect(output).toBe('value');
    expect(cleanInfill(');', ');')).toBeUndefined();
    expect(infillEndpoint('https://gateway.example/v1?other=true')).toBeUndefined();
  });

  it('never fetches after cancellation during credential lookup', async () => {
    const abort = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>();
    const getApiKey = async () => {
      abort.abort();
      return 'key';
    };
    const result = await requestInfill(
      {
        config: { id: 'x', name: 'Test', baseUrl: 'https://gateway.example/v1' },
        getApiKey,
        fetch,
      },
      { model: 'coder', prefix: 'a', suffix: 'b' },
      abort.signal,
      current,
    );
    expect(result).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('cancels during debounce before any request starts', async () => {
    const abort = new AbortController();
    const request = vi.fn(async () => 'surprise');
    const pending = new InfillRequests().complete(false, abort.signal, current, request);
    abort.abort();
    await expect(pending).resolves.toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });

  it('drops a late response after either an editor change or replacement by a newer request', async () => {
    const requests = new InfillRequests();
    const late = deferred();
    let freshEditor = true;
    const first = requests.complete(
      true,
      fresh(),
      () => freshEditor,
      () => late.promise,
    );
    freshEditor = false;
    late.resolve('old content');
    await expect(first).resolves.toBeUndefined();

    const lateAgain = deferred();
    const second = requests.complete(true, fresh(), current, () => lateAgain.promise);
    const third = requests.complete(true, fresh(), current, async () => 'current content');
    lateAgain.resolve('obsolete');
    await expect(second).resolves.toBeUndefined();
    await expect(third).resolves.toBe('current content');
  });

  it('returns promptly when the endpoint times out or is unavailable', async () => {
    const timer = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(timer.signal);
    try {
      const requests = new InfillRequests();
      const pending = requests.complete(true, fresh(), current, () => new Promise(() => {}));
      timer.abort();
      await expect(pending).resolves.toBeUndefined();
      await expect(
        requests.complete(true, fresh(), current, async () => {
          throw new Error('ECONNREFUSED');
        }),
      ).resolves.toBeUndefined();
    } finally {
      timeout.mockRestore();
    }
  });
});
