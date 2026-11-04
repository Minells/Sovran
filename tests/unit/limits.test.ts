import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_OUTPUT_TOKENS,
  effectiveLimits,
  limitsFromLiteLlmInfo,
  limitsFromModelEntry,
} from '../../src/core/providers/limits';

describe('limits a server declares', () => {
  it('reads the names used by vLLM/SGLang, OpenRouter, Groq and LM Studio', () => {
    expect(
      limitsFromModelEntry({ id: 'glm-5.3-flash', object: 'model', owned_by: 'vllm', max_model_len: 131072 }),
    ).toEqual({ contextWindow: 131072 });
    expect(
      limitsFromModelEntry({
        id: 'x/y',
        context_length: 200000,
        top_provider: { context_length: 200000, max_completion_tokens: 32000 },
      }),
    ).toEqual({ contextWindow: 200000, maxOutputTokens: 32000 });
    expect(
      limitsFromModelEntry({ id: 'llama-3.3-70b', context_window: 131072, max_completion_tokens: 32768 }),
    ).toEqual({
      contextWindow: 131072,
      maxOutputTokens: 32768,
    });
    expect(limitsFromModelEntry({ id: 'm', max_context_length: 32768 })).toEqual({ contextWindow: 32768 });
  });

  it('ignores what does not describe the running window', () => {
    // Ollama's OpenAI endpoint and llama.cpp's training context are not read.
    expect(limitsFromModelEntry({ id: 'qwen2.5-coder:14b', object: 'model', owned_by: 'library' })).toEqual(
      {},
    );
    expect(limitsFromModelEntry({ id: 'm', meta: { n_ctx_train: 131072 } })).toEqual({});
    // Nonsense and strings are not limits.
    expect(
      limitsFromModelEntry({ id: 'm', max_model_len: 12, context_length: '131072', max_output_tokens: 3.5 }),
    ).toEqual({});
    expect(limitsFromModelEntry('plain-id')).toEqual({});
    // A reply cap equal to the window says nothing useful about the reply.
    expect(limitsFromModelEntry({ id: 'm', context_length: 8192, max_completion_tokens: 8192 })).toEqual({
      contextWindow: 8192,
    });
  });

  it("reads LiteLLM's /model/info", () => {
    const info = limitsFromLiteLlmInfo({
      data: [
        {
          model_name: 'gpt-4o',
          model_info: { max_input_tokens: 128000, max_output_tokens: 16384, max_tokens: 16384 },
        },
        { model_name: 'legacy', model_info: { max_tokens: 4096 } },
        { model_name: 'unknown', model_info: {} },
        { model_name: 'gpt-4o', model_info: { max_input_tokens: 1 } },
      ],
    });
    expect(info.get('gpt-4o')).toEqual({ contextWindow: 128000, maxOutputTokens: 16384 });
    expect(info.get('legacy')).toEqual({ maxOutputTokens: 4096 });
    expect(info.has('unknown')).toBe(false);
    expect(limitsFromLiteLlmInfo({ nope: true }).size).toBe(0);
  });
});

describe('effective limits', () => {
  it('prefers the user, then the server, then the default', () => {
    expect(effectiveLimits({}, undefined)).toEqual({
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      reserveTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      contextSource: 'default',
      reserveSource: 'default',
    });
    expect(effectiveLimits({}, { contextWindow: 131072 })).toMatchObject({
      contextWindow: 131072,
      contextSource: 'server',
    });
    expect(
      effectiveLimits(
        { contextWindow: 65536, maxOutputTokens: 8192 },
        { contextWindow: 131072, maxOutputTokens: 2048 },
      ),
    ).toEqual({
      contextWindow: 65536,
      reserveTokens: 8192,
      contextSource: 'model',
      reserveSource: 'model',
    });
  });

  it("uses the server's reply cap as a ceiling, never as the reserve", () => {
    // 32K of possible output on a 200K window still reserves the default 4096.
    expect(effectiveLimits({}, { contextWindow: 200000, maxOutputTokens: 32000 })).toMatchObject({
      reserveTokens: 4096,
      reserveSource: 'default',
    });
    // A smaller cap lowers it.
    expect(effectiveLimits({}, { contextWindow: 200000, maxOutputTokens: 2048 })).toMatchObject({
      reserveTokens: 2048,
      reserveSource: 'server',
    });
  });

  it('keeps room for the prompt on small windows unless the user decides otherwise', () => {
    expect(effectiveLimits({}, { contextWindow: 8192 }).reserveTokens).toBe(2048);
    expect(effectiveLimits({ maxOutputTokens: 6000 }, { contextWindow: 8192 }).reserveTokens).toBe(6000);
  });

  it('takes the defaults from the agent settings', () => {
    expect(effectiveLimits({}, undefined, { contextWindow: 16384, maxOutputTokens: 1024 })).toMatchObject({
      contextWindow: 16384,
      reserveTokens: 1024,
    });
  });
});
