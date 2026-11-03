const MASK = '••••';

const PATTERNS: Array<[RegExp, string]> = [
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${MASK}`],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, `sk-${MASK}`],
  [
    /((?:"|')?(?:api[_-]?key|x-api-key|authorization|access[_-]?token|token|password|secret)(?:"|')?\s*[:=]\s*(?:"|')?)([^"'\s,}]{6,})/gi,
    `$1${MASK}`,
  ],
];

/**
 * Removes credentials from text destined for logs, error messages, the webview or exports.
 * Known secrets (e.g. configured API keys) are masked verbatim; common credential shapes are masked by pattern.
 */
export function redact(text: string, knownSecrets: readonly (string | undefined)[] = []): string {
  let out = text;
  for (const secret of knownSecrets) {
    if (secret && secret.length >= 6) out = out.split(secret).join(MASK);
  }
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return out;
}
