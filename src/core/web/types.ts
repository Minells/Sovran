export const WEB_LIMITS = {
  timeoutMs: 30_000,
  bodyBytes: 1024 * 1024,
  robotsBytes: 128 * 1024,
  redirects: 3,
  requests: 8,
  links: 20,
} as const;

export interface WebPage {
  url: string;
  title: string;
  text: string;
  links: string[];
  truncated: boolean;
}

export interface WebFetchPort {
  /** One approved URL, robots.txt and bounded same-origin redirects. No ambient authentication or proxy. */
  fetch(
    url: string,
    options: { signal: AbortSignal; beforeRequest: () => void; maxChars: number },
  ): Promise<WebPage>;
}

export interface HtmlExtractorPort {
  extract(html: string, url: string, maxChars: number, signal: AbortSignal): Promise<Omit<WebPage, 'url'>>;
  checkRobots(
    text: string,
    robotsUrl: string,
    pageUrl: string,
    signal: AbortSignal,
  ): Promise<{ allowed: boolean; crawlDelay?: number }>;
}
