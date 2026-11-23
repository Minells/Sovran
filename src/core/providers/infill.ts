import { setTimeout as delay } from 'node:timers/promises';
import { infillEndpoint } from '../../shared/endpoints';
import { providerHeaders, type OpenAICompatibleOptions } from './openaiCompatible';

export const INFILL_LIMITS = {
  prefix: 3000,
  suffix: 1000,
  tokens: 64,
  debounceMs: 200,
  timeoutMs: 2000,
} as const;
const MAX_RESPONSE_BYTES = 64 * 1024;
const FIM_MARKER = /<\|(?:fim_(?:prefix|suffix|middle|pad)|endoftext|im_end|repo_name|file_sep)\|>/g;

async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return JSON.parse(text + decoder.decode()) as unknown;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) return undefined;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

export function cleanInfill(text: string, suffix: string): string | undefined {
  const stripped = text.replace(/^(?:<\|fim_(?:prefix|suffix|middle|pad)\|>)+/, '');
  const end = stripped.search(FIM_MARKER);
  const stop = end >= 0 ? stripped.slice(0, end) : stripped;
  const unfenced = stop.replace(/^```[\w+-]*\r?\n/, '').replace(/\r?\n```\s*$/, '');
  const candidate = unfenced.slice(0, 1600).split(/\r?\n/).slice(0, 12).join('\n');
  for (let n = Math.min(candidate.length, suffix.length); n > 0; n--) {
    if (candidate.endsWith(suffix.slice(0, n)))
      return candidate.slice(0, -n).trim() ? candidate.slice(0, -n) : undefined;
  }
  return candidate.trim() ? candidate : undefined;
}

export async function requestInfill(
  options: OpenAICompatibleOptions,
  request: { model: string; prefix: string; suffix: string },
  signal: AbortSignal,
  current: () => boolean,
): Promise<string | undefined> {
  const url = infillEndpoint(options.config.baseUrl);
  if (!url || signal.aborted || !current()) return;
  const { headers } = await providerHeaders(options, true, 'application/json');
  if (signal.aborted || !current()) return;
  const response = await (options.fetch ?? globalThis.fetch.bind(globalThis))(url.href, {
    method: 'POST',
    headers,
    redirect: 'manual',
    signal,
    body: JSON.stringify({
      model: request.model,
      input_prefix: request.prefix.slice(-INFILL_LIMITS.prefix),
      input_suffix: request.suffix.slice(0, INFILL_LIMITS.suffix),
      prompt: '',
      stream: false,
      n_predict: INFILL_LIMITS.tokens,
      temperature: 0,
    }),
  });
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    return;
  }
  const data = await boundedJson(response);
  if (
    signal.aborted ||
    !current() ||
    !data ||
    typeof data !== 'object' ||
    !('content' in data) ||
    typeof data.content !== 'string'
  )
    return;
  return cleanInfill(data.content, request.suffix);
}

/** A single latest request per editor window. The caller checks document and configuration identity. */
export class InfillRequests {
  private pending: { abort: AbortController; current: () => boolean } | undefined;

  cancel(): void {
    this.pending?.abort.abort();
    this.pending = undefined;
  }

  invalidate(): void {
    if (this.pending && !this.pending.current()) this.cancel();
  }

  async complete(
    manual: boolean,
    external: AbortSignal,
    current: () => boolean,
    request: (signal: AbortSignal) => Promise<string | undefined>,
  ): Promise<string | undefined> {
    this.cancel();
    if (external.aborted || !current()) return;
    const pending = new AbortController();
    this.pending = { abort: pending, current };
    const cancelled = AbortSignal.any([external, pending.signal]);
    try {
      if (!manual) await delay(INFILL_LIMITS.debounceMs, undefined, { signal: cancelled });
      if (cancelled.aborted || !current()) return;
      const signal = AbortSignal.any([cancelled, AbortSignal.timeout(INFILL_LIMITS.timeoutMs)]);
      const stop = new Promise<undefined>((resolve) => {
        signal.addEventListener('abort', () => resolve(undefined), { once: true });
      });
      const completion = await Promise.race([request(signal), stop]);
      return !signal.aborted && current() ? completion : undefined;
    } catch {
      return undefined;
    } finally {
      pending.abort();
      if (this.pending?.abort === pending) this.pending = undefined;
    }
  }
}
