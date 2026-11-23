/** Endpoint helpers shared by the host and the webview (no VS Code or DOM dependencies). */

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0.0.0.0' || /^127\./.test(host);
}

/** Where requests go, as shown in the status bar: "local" for loopback endpoints, otherwise the host name. */
export function endpointLocation(baseUrl: string | undefined): string | null {
  if (!baseUrl) return null;
  try {
    const host = new URL(baseUrl).hostname;
    return isLoopbackHost(host) ? 'local' : host.replace(/^\[|\]$/g, '');
  } catch {
    return null;
  }
}

/** True when an API key would travel unencrypted: plain http to a host other than this machine. */
export function sendsKeyInsecurely(baseUrl: string, authType: 'none' | 'bearer' | 'header'): boolean {
  if (authType === 'none') return false;
  try {
    const url = new URL(baseUrl);
    return url.protocol === 'http:' && !isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

/** llama.cpp's native infill is a sibling of its OpenAI-compatible /v1 base. */
export function infillEndpoint(baseUrl: string): URL | undefined {
  try {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      return;
    const base = url.pathname.replace(/\/+$/, '');
    if (!base.endsWith('/v1')) return;
    url.pathname = `${base.slice(0, -3)}/infill`;
    return url;
  } catch {
    return undefined;
  }
}

export function supportsInfill(baseUrl: string, model: { fim?: string } | undefined): boolean {
  return model?.fim === 'llama.cpp-infill' && !!infillEndpoint(baseUrl);
}
