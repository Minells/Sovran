import { redact } from '../security/redact';

export type ProviderErrorKind =
  | 'auth'
  | 'not_found'
  | 'rate_limit'
  | 'context_length'
  | 'tools_unsupported'
  | 'vision_unsupported'
  | 'bad_request'
  | 'server'
  | 'network'
  | 'tls'
  | 'timeout'
  | 'cancelled'
  | 'invalid_response'
  | 'redirect';

export class ProviderError extends Error {
  override name = 'ProviderError';
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly hint?: string,
    readonly status?: number,
  ) {
    super(message);
  }
  /** How long the server asked to wait before another request (`Retry-After`), when it said so. */
  retryAfterMs?: number;
}

/** Records a `Retry-After` header given in seconds; dates and anything else are ignored. */
export function withRetryAfter(error: ProviderError, header: string | null): ProviderError {
  const seconds = header && /^\d{1,6}$/.test(header.trim()) ? Number(header.trim()) : undefined;
  if (seconds !== undefined) error.retryAfterMs = seconds * 1000;
  return error;
}

/** How a request carried the API key, so an authentication error can say what the server actually received. */
export interface AuthSent {
  type: 'none' | 'bearer' | 'header';
  /** Header that carried the key (`Authorization` for bearer). */
  header?: string;
  /** False when a key is expected but none is stored: the request went out without credentials. */
  keySent: boolean;
}

interface ErrorContext {
  url: string;
  toolsSent?: boolean;
  /** The request carried images, so a refusal that mentions them means the model does not accept images. */
  imagesSent?: boolean;
  secrets?: readonly (string | undefined)[];
  auth?: AuthSent;
}

const GENERIC_AUTH_HINT = 'Check the API key (Sovran: Set Provider API Key…) and the auth type.';

/**
 * Explains a 401/403 from what the request carried. A gateway's own message ("invalid key") rarely says whether the
 * key was missing, sent in a header it does not read, or simply wrong, and those need different fixes.
 */
export function authHint(auth: AuthSent | undefined): string {
  if (!auth) return GENERIC_AUTH_HINT;
  if (auth.type === 'none') {
    return 'The request carried no credentials because Authentication is set to None. If the server needs a key, choose API key and set the key.';
  }
  if (!auth.keySent) {
    return 'No API key is stored for this provider, so the request carried no credentials. Set it with "Set key" (Sovran: Set Provider API Key…).';
  }
  if (auth.type === 'bearer') {
    return 'Sovran sent the stored key as "Authorization: Bearer <key>", the OpenAI standard. Check that the key is right. If the gateway reads the key from another header (for example api-key or x-api-key), set Authentication to Custom header.';
  }
  return `Sovran sent the stored key in the "${auth.header ?? 'api-key'}" header. Most OpenAI-compatible gateways expect "Authorization: Bearer <key>": set Authentication to API key, unless the gateway documents this header.`;
}


const CONTEXT_RE =
  /context[ _]length|maximum context|context window|too many tokens|prompt is too long|exceeds? the (?:model'?s? )?(?:maximum )?context|max_tokens.*exceed/i;
const TOOLS_RE = /\btools?\b|function[ _]?call|tool_choice|does not support tools|--jinja/i;
/**
 * How servers refuse images: vLLM ("not a multimodal model"), llama.cpp ("image input is not supported"), LM Studio
 * and pydantic-based servers that expect `content` to be a string ("Input should be a valid string").
 */
const IMAGES_RE = /\bimages?\b|image_url|vision|multi-?modal|mm_processor|valid string|content.{0,40}(?:must|should) be.{0,20}(?:string|text)|unsupported content/i;
/** Refusals of these images, not of images as such (too large, too many): the model does take images. */
const IMAGE_LIMIT_RE = /too (?:large|big|many)|exceed|at most|maximum|limit|\bsize\b|resolution|dimension/i;

export function extractErrorMessage(body: string): string {
  try {
    const json = JSON.parse(body) as Record<string, unknown>;
    const err = json.error;
    if (typeof err === 'string') return err;
    if (err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') {
      return (err as { message: string }).message;
    }
    if (typeof json.message === 'string') return json.message;
    if (typeof json.detail === 'string') return json.detail;
  } catch {
    /* not JSON */
  }
  return body.trim().slice(0, 500) || 'No error details were returned.';
}

function origin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

export function errorFromResponse(status: number, body: string, ctx: ErrorContext): ProviderError {
  const message = redact(extractErrorMessage(body), ctx.secrets);
  const detail = `HTTP ${status}: ${message}`;
  if (status === 401 || status === 403) {
    return new ProviderError('auth', detail, authHint(ctx.auth), status);
  }
  if (status === 404) {
    const hint = /\/models$/.test(ctx.url)
      ? 'This server does not list models at /models. Add model IDs manually, or check whether the base URL needs a /v1 suffix.'
      : 'The endpoint or model was not found. Check the base URL (often ends in /v1) and the model ID.';
    return new ProviderError('not_found', detail, hint, status);
  }
  if (status === 429) return new ProviderError('rate_limit', detail, 'The server is rate-limiting requests. Wait and retry.', status);
  if (CONTEXT_RE.test(message)) {
    return new ProviderError(
      'context_length',
      detail,
      "The conversation exceeds the model's context window. Start a new chat or set a smaller contextWindow for this model.",
      status,
    );
  }
  const imageStatus = status === 400 || status === 415 || status === 422 || status === 500 || status === 501;
  if (ctx.imagesSent && imageStatus && IMAGES_RE.test(message) && !IMAGE_LIMIT_RE.test(message)) {
    return new ProviderError(
      'vision_unsupported',
      detail,
      'The server refused the images. Use a vision model, or set "vision": false for this model so Sovran sends their names only.',
      status,
    );
  }
  if (ctx.toolsSent && (status === 400 || status === 422 || status === 500 || status === 501) && TOOLS_RE.test(message)) {
    return new ProviderError('tools_unsupported', detail, 'The server rejected tool definitions.', status);
  }
  if (status === 408 || status === 504) return new ProviderError('timeout', detail, 'The server timed out.', status);
  if (status >= 500) return new ProviderError('server', detail, 'The model server reported an internal error.', status);
  return new ProviderError('bad_request', detail, undefined, status);
}

/**
 * Redirects are never followed: fetch keeps custom auth headers (e.g. `api-key`) and the request body (prompts and
 * code) when it follows a redirect to another origin, so a misconfigured or compromised gateway could forward both.
 */
export function redirectError(status: number, location: string | null, url: string): ProviderError {
  let target = '';
  try {
    const t = new URL(location ?? '', url);
    target = `${t.origin}${t.pathname}`;
  } catch {
    /* no usable Location header */
  }
  return new ProviderError(
    'redirect',
    `HTTP ${status}: ${origin(url)} redirected the request${target ? ` to ${target}` : ''}.`,
    'Sovran does not follow redirects, so your API key and code are never sent to an address you did not configure. If the new address is correct, use it as the base URL.',
    status,
  );
}

export const isRedirect = (status: number) => status >= 300 && status < 400;

const TLS_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

function causeCode(e: unknown): string | undefined {
  let cur: unknown = e;
  for (let i = 0; i < 4 && cur && typeof cur === 'object'; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

export function errorFromException(e: unknown, ctx: ErrorContext & { timedOut?: boolean }): ProviderError {
  if (e instanceof ProviderError) return e;
  if (ctx.timedOut) {
    return new ProviderError(
      'timeout',
      `No response from ${origin(ctx.url)} within the timeout.`,
      'Large local models can take a while to load. Increase timeoutSeconds for this provider.',
    );
  }
  if (e instanceof Error && e.name === 'AbortError') return new ProviderError('cancelled', 'Request cancelled.');
  const code = causeCode(e);
  const raw = redact(e instanceof Error ? e.message : String(e), ctx.secrets);
  if (code && TLS_CODES.has(code)) {
    return new ProviderError(
      'tls',
      `TLS certificate error (${code}) connecting to ${origin(ctx.url)}.`,
      'If your organization uses an internal CA, add it to the operating system trust store. Sovran never disables certificate checks.',
    );
  }
  switch (code) {
    case 'ECONNREFUSED':
      return new ProviderError('network', `Connection refused by ${origin(ctx.url)}.`, 'Is the model server running and listening on this address?');
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return new ProviderError('network', `Host not found: ${origin(ctx.url)}.`, 'Check the base URL, VPN and DNS settings.');
    case 'ETIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
      return new ProviderError('timeout', `Connection to ${origin(ctx.url)} timed out.`, 'Check network access, proxy settings (http.proxy) and firewalls.');
    case 'ECONNRESET':
    case 'UND_ERR_SOCKET':
      return new ProviderError('network', `The connection to ${origin(ctx.url)} was interrupted.`, 'The server closed the connection. Check its logs.');
  }
  return new ProviderError('network', `Request to ${origin(ctx.url)} failed: ${raw}`, 'Check the base URL and network/proxy settings.');
}
