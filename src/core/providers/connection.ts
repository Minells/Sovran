import { ProviderError, errorFromException } from './errors';
import type { ModelInfo } from './limits';
import type { ChatProvider } from './types';

/**
 * Cleans an API key as pasted by a person. Sovran adds the `Bearer ` prefix itself, so a key copied together with it
 * (or with quotes, or from a line such as `Authorization: Bearer sk-…`) would otherwise be sent as
 * `Authorization: Bearer Bearer sk-…`, which a gateway rejects as an unknown key.
 */
export function normalizeApiKey(raw: string): { key: string; notes: string[] } {
  const notes: string[] = [];
  let key = raw.trim();
  const header = /^authorization\s*:\s*/i;
  if (header.test(key)) {
    key = key.replace(header, '');
    notes.push('the "Authorization:" header name');
  }
  if (/^bearer\s+/i.test(key)) {
    key = key.replace(/^bearer\s+/i, '');
    notes.push('the "Bearer " prefix (Sovran adds it)');
  }
  const quoted = key.match(/^(["'`])(.*)\1$/s);
  if (quoted) {
    key = quoted[2]!;
    notes.push('the quotes around the key');
  }
  key = key.trim();
  if (/\s/.test(key)) {
    key = key.replace(/\s+/g, '');
    notes.push('spaces or line breaks inside the key');
  }
  return { key, notes };
}

export interface ConnectionResult {
  ok: boolean;
  latencyMs?: number;
  models?: string[];
  /** The models with the limits the server declared, when it declares any. */
  info?: ModelInfo[];
  message: string;
  hint?: string;
}

/**
 * Checks that a provider answers: lists its models, or, when the server has no `/models` (404) or refuses it with the
 * key (401/403, common on gateways that only expose chat to a key), sends a one-token completion to the first
 * configured model. A key that works for chat is a working connection even if it cannot list models.
 */
export async function probeConnection(
  provider: ChatProvider,
  firstModel: string | undefined,
  url: string,
): Promise<ConnectionResult> {
  const started = Date.now();
  const asError = (e: unknown) => (e instanceof ProviderError ? e : errorFromException(e, { url }));
  try {
    const info = provider.listModelInfo ? await provider.listModelInfo() : undefined;
    const models = info ? info.map((m) => m.id) : await provider.listModels();
    return {
      ok: true,
      latencyMs: Date.now() - started,
      models,
      ...(info?.some((m) => m.contextWindow || m.maxOutputTokens) ? { info } : {}),
      message: `Connected · ${models.length} model${models.length === 1 ? '' : 's'} available`,
    };
  } catch (e) {
    const err = asError(e);
    const fallback = err.kind === 'not_found' || err.kind === 'auth';
    if (!fallback) return { ok: false, message: err.message, hint: err.hint };
    if (!firstModel) {
      const hint =
        err.kind === 'auth'
          ? `${err.hint ?? ''} Some gateways allow chat but not /models for a key: add a model ID and test again to check chat directly.`.trim()
          : err.hint;
      return { ok: false, message: err.message, hint };
    }
    try {
      const ac = new AbortController();
      for await (const ev of provider.streamChat(
        { model: firstModel, messages: [{ role: 'user', content: 'ping' }], maxTokens: 1 },
        ac.signal,
      )) {
        if (ev.type === 'text' || ev.type === 'reasoning') break;
      }
      ac.abort();
      return {
        ok: true,
        latencyMs: Date.now() - started,
        message:
          err.kind === 'auth'
            ? `Connected · chat works, but the server refused to list models (HTTP ${err.status ?? 401})`
            : 'Connected · this server does not list models',
        ...(err.kind === 'auth'
          ? { hint: 'This key is not allowed to call /models. Add the model IDs you use by hand.' }
          : {}),
      };
    } catch (e2) {
      const err2 = asError(e2);
      return { ok: false, message: err2.message, hint: err2.hint };
    }
  }
}
