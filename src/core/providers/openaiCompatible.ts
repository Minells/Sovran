import { parseSSE } from './sse';
import { ProviderError, errorFromException, errorFromResponse, isRedirect, redirectError } from './errors';
import type { ChatProvider, ChatRequest, ProviderConfig, ProviderEvent } from './types';

export interface OpenAICompatibleOptions {
  config: ProviderConfig;
  /** Lazily resolves the API key from secure storage. Never cached by the provider. */
  getApiKey: () => Promise<string | undefined>;
  fetch?: typeof fetch;
}

/** Aborts when the external signal aborts or when no progress happens within `ms`. */
class Watchdog {
  readonly controller = new AbortController();
  timedOut = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly onAbort = () => this.controller.abort();

  constructor(
    private readonly ms: number,
    private readonly external?: AbortSignal,
  ) {
    if (external?.aborted) this.controller.abort();
    external?.addEventListener('abort', this.onAbort, { once: true });
    this.reset();
  }
  get signal() {
    return this.controller.signal;
  }
  reset() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timedOut = true;
      this.controller.abort();
    }, this.ms);
  }
  dispose() {
    clearTimeout(this.timer);
    this.external?.removeEventListener('abort', this.onAbort);
    this.controller.abort();
  }
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null;

/**
 * Adapter for OpenAI-compatible Chat Completions servers (Ollama, LM Studio, vLLM, LiteLLM,
 * llama.cpp, LocalAI, enterprise gateways…). Assumes nothing beyond the core request shape and
 * tolerates the common deviations; see docs/ARCHITECTURE.md §4.
 */
export class OpenAICompatibleProvider implements ChatProvider {
  readonly id: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenAICompatibleOptions) {
    this.id = options.config.id;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private url(path: string): string {
    return this.options.config.baseUrl.trim().replace(/\/+$/, '') + path;
  }

  private get timeoutMs(): number {
    return Math.max(5, this.options.config.timeoutSeconds ?? 120) * 1000;
  }

  private async headers(json: boolean): Promise<{ headers: Record<string, string>; secret?: string }> {
    const headers: Record<string, string> = {
      Accept: 'application/json, text/event-stream',
      ...(this.options.config.headers ?? {}),
    };
    if (json) headers['Content-Type'] = 'application/json';
    const auth = this.options.config.auth ?? { type: 'bearer' };
    if (auth.type === 'none') return { headers };
    const secret = await this.options.getApiKey();
    if (secret) {
      if (auth.type === 'header') headers[auth.headerName?.trim() || 'api-key'] = secret;
      else headers.Authorization = `Bearer ${secret}`;
    }
    return { headers, secret };
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const url = this.url('/models');
    const watchdog = new Watchdog(Math.min(this.timeoutMs, 30_000), signal);
    let secret: string | undefined;
    try {
      const h = await this.headers(false);
      secret = h.secret;
      const res = await this.fetchImpl(url, { headers: h.headers, signal: watchdog.signal, redirect: 'manual' });
      if (isRedirect(res.status)) throw redirectError(res.status, res.headers.get('location'), url);
      const text = await res.text();
      if (!res.ok) throw errorFromResponse(res.status, text, { url, secrets: [secret] });
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new ProviderError('invalid_response', 'The /models response is not valid JSON.');
      }
      const list = isObj(json) && Array.isArray(json.data) ? json.data : isObj(json) && Array.isArray(json.models) ? json.models : Array.isArray(json) ? json : null;
      if (!list) throw new ProviderError('invalid_response', 'The /models response has no model list.');
      const ids = list
        .map((m: unknown) => (typeof m === 'string' ? m : isObj(m) ? (m.id ?? m.name ?? m.model) : undefined))
        .filter((id: unknown): id is string => typeof id === 'string' && id.length > 0);
      return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
    } catch (e) {
      throw errorFromException(e, { url, timedOut: watchdog.timedOut, secrets: [secret] });
    } finally {
      watchdog.dispose();
    }
  }

  async *streamChat(request: ChatRequest, signal: AbortSignal): AsyncGenerator<ProviderEvent> {
    const url = this.url('/chat/completions');
    const toolsSent = !!request.tools?.length;
    const watchdog = new Watchdog(this.timeoutMs, signal);
    let secret: string | undefined;
    try {
      const h = await this.headers(true);
      secret = h.secret;
      // Only fields that virtually every compatible server accepts. tool_choice, parallel_tool_calls
      // and stream_options are omitted on purpose: several servers reject unknown parameters.
      const body: Json = { model: request.model, messages: request.messages, stream: true };
      if (toolsSent) body.tools = request.tools;
      if (request.temperature !== undefined) body.temperature = request.temperature;
      if (request.maxTokens) body.max_tokens = request.maxTokens;

      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: h.headers,
        body: JSON.stringify(body),
        signal: watchdog.signal,
        // Never forward credentials or code to an address the user did not configure (see redirectError).
        redirect: 'manual',
      });
      if (isRedirect(res.status)) throw redirectError(res.status, res.headers.get('location'), url);
      if (!res.ok) throw errorFromResponse(res.status, await res.text(), { url, toolsSent, secrets: [secret] });
      watchdog.reset();

      const contentType = res.headers.get('content-type') ?? '';
      const ctx = { url, toolsSent, secrets: [secret] };
      if (contentType.includes('text/event-stream') && res.body) {
        let sawData = false;
        for await (const data of parseSSE(res.body)) {
          watchdog.reset();
          const payload = data.trim();
          if (!payload) continue;
          if (payload === '[DONE]') break;
          let chunk: unknown;
          try {
            chunk = JSON.parse(payload);
          } catch {
            continue; // tolerate keep-alive or junk lines
          }
          sawData = true;
          yield* mapChunk(chunk, ctx);
        }
        if (!sawData) throw new ProviderError('invalid_response', 'The server returned an empty stream.');
        return;
      }

      // Non-streaming fallback: the server ignored stream:true (or mislabelled an SSE body).
      const text = await res.text();
      if (text.trimStart().startsWith('data:')) {
        for (const line of text.split(/\r?\n/)) {
          const payload = line.startsWith('data:') ? line.slice(5).trim() : '';
          if (!payload || payload === '[DONE]') continue;
          try {
            yield* mapChunk(JSON.parse(payload), ctx);
          } catch (e) {
            if (e instanceof ProviderError) throw e;
          }
        }
        return;
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new ProviderError('invalid_response', 'The server response is neither an event stream nor JSON.');
      }
      yield* mapChunk(json, ctx);
    } catch (e) {
      throw errorFromException(e, { url, toolsSent, timedOut: watchdog.timedOut, secrets: [secret] });
    } finally {
      watchdog.dispose();
    }
  }
}

function* mapChunk(chunk: unknown, ctx: { url: string; toolsSent: boolean; secrets: (string | undefined)[] }): Generator<ProviderEvent> {
  if (!isObj(chunk)) return;
  if (chunk.error) {
    const status = isObj(chunk.error) && typeof chunk.error.code === 'number' ? chunk.error.code : 500;
    throw errorFromResponse(status, JSON.stringify(chunk), ctx);
  }
  const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
  const choice = choices[0];
  if (isObj(choice)) {
    const delta = isObj(choice.delta) ? choice.delta : isObj(choice.message) ? choice.message : {};
    const reasoning = delta.reasoning_content ?? delta.reasoning;
    if (typeof reasoning === 'string' && reasoning) yield { type: 'reasoning', text: reasoning };
    if (typeof delta.content === 'string' && delta.content) yield { type: 'text', text: delta.content };
    if (Array.isArray(delta.tool_calls)) {
      for (const [i, tc] of delta.tool_calls.entries()) {
        if (!isObj(tc)) continue;
        const fn = isObj(tc.function) ? tc.function : {};
        const args = fn.arguments;
        yield {
          type: 'tool_call_delta',
          index: typeof tc.index === 'number' ? tc.index : i,
          id: typeof tc.id === 'string' && tc.id ? tc.id : undefined,
          name: typeof fn.name === 'string' && fn.name ? fn.name : undefined,
          argumentsDelta: typeof args === 'string' ? args : args != null ? JSON.stringify(args) : undefined,
        };
      }
    } else if (isObj(delta.function_call)) {
      const fc = delta.function_call;
      yield {
        type: 'tool_call_delta',
        index: 0,
        name: typeof fc.name === 'string' ? fc.name : undefined,
        argumentsDelta: typeof fc.arguments === 'string' ? fc.arguments : undefined,
      };
    }
    if (typeof choice.finish_reason === 'string') yield { type: 'finish', reason: choice.finish_reason };
  }
  if (isObj(chunk.usage)) {
    const u = chunk.usage;
    yield {
      type: 'usage',
      promptTokens: typeof u.prompt_tokens === 'number' ? u.prompt_tokens : undefined,
      completionTokens: typeof u.completion_tokens === 'number' ? u.completion_tokens : undefined,
    };
  }
}

