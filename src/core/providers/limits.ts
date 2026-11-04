import type { ModelConfig } from './types';

/** Used when neither the user nor the server says how large the context window is. */
export const DEFAULT_CONTEXT_WINDOW = 32_768;
/** Tokens reserved for the reply when the user has not set `maxOutputTokens`. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

/** Limits a server reports for a model. */
export interface ServerLimits {
  /** Total tokens the model accepts (prompt and reply). */
  contextWindow?: number;
  /** Most tokens the model may generate in one reply. */
  maxOutputTokens?: number;
}

export interface ModelInfo extends ServerLimits {
  id: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

function intIn(v: unknown, min: number, max: number): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : undefined;
}
const asContext = (v: unknown) => intIn(v, 1024, 10_000_000);
const asOutput = (v: unknown) => intIn(v, 64, 1_000_000);

function pick<T>(...values: Array<T | undefined>): T | undefined {
  return values.find((v) => v !== undefined);
}

function consistent(limits: ServerLimits): ServerLimits {
  // A reply cap at or above the window is not a usable limit (some servers repeat the window there).
  const { contextWindow, maxOutputTokens } = limits;
  const output =
    maxOutputTokens !== undefined && contextWindow !== undefined && maxOutputTokens >= contextWindow
      ? undefined
      : maxOutputTokens;
  return {
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(output !== undefined ? { maxOutputTokens: output } : {}),
  };
}

/**
 * Reads the limits a `/models` entry declares, under the names OpenAI-compatible servers use:
 * vLLM and SGLang `max_model_len`, OpenRouter `context_length` and `top_provider.max_completion_tokens`, Groq and others
 * `context_window`, LM Studio's REST API `max_context_length`.
 *
 * Deliberately not read: Ollama (its model card states the trained context, not the `num_ctx` it runs with, and it
 * truncates silently) and llama.cpp's `meta.n_ctx_train` (also the training context). Trusting those would be worse
 * than the default.
 */
export function limitsFromModelEntry(entry: unknown): ServerLimits {
  if (!isObj(entry)) return {};
  const top = isObj(entry.top_provider) ? entry.top_provider : {};
  return consistent({
    contextWindow: pick(
      asContext(entry.max_model_len),
      asContext(entry.context_length),
      asContext(entry.context_window),
      asContext(entry.max_context_length),
      asContext(top.context_length),
    ),
    maxOutputTokens: pick(
      asOutput(entry.max_output_tokens),
      asOutput(entry.max_completion_tokens),
      asOutput(top.max_completion_tokens),
    ),
  });
}

/**
 * Reads LiteLLM's `/model/info` (`data[].model_name` with `model_info.max_input_tokens`, `max_output_tokens` or the older
 * `max_tokens`). `max_input_tokens` becomes the window: slightly conservative, never too large.
 */
export function limitsFromLiteLlmInfo(json: unknown): Map<string, ServerLimits> {
  const out = new Map<string, ServerLimits>();
  const list = isObj(json) && Array.isArray(json.data) ? json.data : [];
  for (const item of list) {
    if (!isObj(item) || typeof item.model_name !== 'string' || !isObj(item.model_info)) continue;
    const info = item.model_info;
    const limits = consistent({
      contextWindow: asContext(info.max_input_tokens),
      maxOutputTokens: pick(asOutput(info.max_output_tokens), asOutput(info.max_tokens)),
    });
    if ((limits.contextWindow || limits.maxOutputTokens) && !out.has(item.model_name))
      out.set(item.model_name, limits);
  }
  return out;
}

export type LimitSource = 'model' | 'server' | 'default';

export interface EffectiveLimits {
  contextWindow: number;
  /** Tokens kept free for the reply when the prompt is built. */
  reserveTokens: number;
  contextSource: LimitSource;
  reserveSource: LimitSource;
}

/**
 * The limits a request uses. What the user configured wins; then what the server reports; then the defaults.
 *
 * The window is taken as reported. The reply reserve is different: a server's maximum output (often 16–32K) is a cap,
 * not a good reserve, because every token reserved for the reply is a token the conversation cannot use. So without a
 * user value the reserve is the default, lowered to the server's cap and to a quarter of the window when those are
 * smaller, which keeps room for the prompt on small windows.
 */
export function effectiveLimits(
  model: Pick<ModelConfig, 'contextWindow' | 'maxOutputTokens'>,
  server?: ServerLimits,
  defaults: { contextWindow: number; maxOutputTokens: number } = {
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  },
): EffectiveLimits {
  const contextWindow = model.contextWindow ?? server?.contextWindow ?? defaults.contextWindow;
  const contextSource: LimitSource = model.contextWindow
    ? 'model'
    : server?.contextWindow
      ? 'server'
      : 'default';
  if (model.maxOutputTokens)
    return { contextWindow, reserveTokens: model.maxOutputTokens, contextSource, reserveSource: 'model' };
  const capped = Math.min(defaults.maxOutputTokens, server?.maxOutputTokens ?? Infinity);
  return {
    contextWindow,
    reserveTokens: Math.max(64, Math.min(capped, Math.floor(contextWindow / 4))),
    contextSource,
    reserveSource:
      server?.maxOutputTokens !== undefined && server.maxOutputTokens < defaults.maxOutputTokens
        ? 'server'
        : 'default',
  };
}
