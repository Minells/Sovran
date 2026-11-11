import { setTimeout as delay } from 'node:timers/promises';
import { ToolError } from '../../core/tools/types';
import { WEB_LIMITS, type HtmlExtractorPort, type WebFetchPort, type WebPage } from '../../core/web/types';
import { webUrl } from '../../core/web/urls';
import { PublicWebTransport, type WebResponse } from './PublicWebTransport';

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function decode(response: WebResponse): string {
  const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(response.contentType)?.[1] ?? 'utf-8';
  try {
    return new TextDecoder(charset, { fatal: true }).decode(response.body);
  } catch {
    throw new ToolError('Unsupported or invalid text encoding in the Web response.');
  }
}

/** One job shared by all chats; no cache, background jobs, retries, sitemap discovery or implicit connections. */
export class NativeWebFetcher implements WebFetchPort {
  private busy = false;
  constructor(
    private readonly extractor: HtmlExtractorPort,
    private readonly transport = new PublicWebTransport(),
  ) {}

  async fetch(input: string, options: Parameters<WebFetchPort['fetch']>[1]): Promise<WebPage> {
    if (this.busy) throw new ToolError('Another Web read is running. Retry after it finishes.');
    this.busy = true;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), WEB_LIMITS.timeoutMs);
    const signal = AbortSignal.any([options.signal, timeout.signal]);
    try {
      const initial = webUrl(input);
      let requests = 0;
      const get = async (url: URL, maxBytes: number) => {
        if (url.origin !== initial.origin)
          throw new ToolError(
            `The page redirects to ${url.href}, outside the approved origin. Request that URL separately for approval.`,
          );
        if (++requests > WEB_LIMITS.requests) throw new ToolError('The Web request budget was exhausted.');
        signal.throwIfAborted();
        options.beforeRequest();
        return this.transport.get(url.href, signal, options.beforeRequest, maxBytes);
      };
      const following = async (start: URL, maxBytes: number) => {
        let url = start;
        for (let redirects = 0; ; redirects++) {
          const response = await get(url, maxBytes);
          if (!REDIRECTS.has(response.status)) return { url, response };
          if (!response.location || redirects >= WEB_LIMITS.redirects)
            throw new ToolError('The page has an invalid redirect or too many redirects.');
          try {
            url = webUrl(new URL(response.location, url).href);
          } catch {
            throw new ToolError('The page redirects to an unsupported or non-public URL.');
          }
        }
      };
      const robotsUrl = new URL('/robots.txt', initial);
      const robots = await following(robotsUrl, WEB_LIMITS.robotsBytes);
      let robotsText: string | undefined;
      if (robots.response.status === 200) {
        if (robots.response.contentType && !/^text\/plain(?:;|$)/i.test(robots.response.contentType))
          throw new ToolError('robots.txt did not return plain text; the page was not requested.');
        robotsText = decode(robots.response);
      } else if (![404, 410].includes(robots.response.status)) {
        throw new ToolError(
          `robots.txt could not be checked (HTTP ${robots.response.status}); the page was not requested.`,
        );
      }
      let url = initial;
      for (let redirects = 0; ; redirects++) {
        if (robotsText !== undefined) {
          const rules = await this.extractor.checkRobots(robotsText, robotsUrl.href, url.href, signal);
          if (!rules.allowed) throw new ToolError('robots.txt disallows this page for SovranWeb.');
          const crawlDelay = rules.crawlDelay;
          if (crawlDelay !== undefined) {
            if (!Number.isFinite(crawlDelay) || crawlDelay < 0 || crawlDelay * 1000 >= WEB_LIMITS.timeoutMs)
              throw new ToolError('The site requests a crawl delay beyond this tool’s time limit.');
            await delay(crawlDelay * 1000, undefined, { signal });
          }
        }
        const response = await get(url, WEB_LIMITS.bodyBytes);
        if (REDIRECTS.has(response.status)) {
          if (!response.location || redirects >= WEB_LIMITS.redirects)
            throw new ToolError('The page has an invalid redirect or too many redirects.');
          try {
            url = webUrl(new URL(response.location, url).href);
          } catch {
            throw new ToolError('The page redirects to an unsupported or non-public URL.');
          }
          continue;
        }
        if (response.status !== 200)
          throw new ToolError(`The page returned HTTP ${response.status}. No error-page body was returned.`);
        const mime = response.contentType.split(';')[0]?.trim().toLowerCase();
        if (
          !['text/html', 'application/xhtml+xml', 'text/plain', 'text/markdown', 'application/json'].includes(
            mime ?? '',
          )
        )
          throw new ToolError('web_fetch supports HTML, plain text, Markdown and JSON responses.');
        const text = decode(response);
        if (text.includes('\0')) throw new ToolError('The response contains binary data.');
        signal.throwIfAborted();
        options.beforeRequest();
        const page =
          mime === 'text/html' || mime === 'application/xhtml+xml'
            ? await this.extractor.extract(text, url.href, options.maxChars, signal)
            : {
                title: '',
                text: text.slice(0, options.maxChars),
                links: [],
                truncated: text.length > options.maxChars,
              };
        if (!page.text.trim())
          throw new ToolError(
            'No readable page content was found. The page may require JavaScript or authentication.',
          );
        signal.throwIfAborted();
        options.beforeRequest();
        return { ...page, url: url.href };
      }
    } finally {
      clearTimeout(timer);
      this.busy = false;
    }
  }
}
