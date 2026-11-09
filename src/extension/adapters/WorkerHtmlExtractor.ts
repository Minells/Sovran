import { Worker } from 'node:worker_threads';
import { ToolError } from '../../core/tools/types';
import type { HtmlExtractorPort, WebPage } from '../../core/web/types';
import type { WebJob } from './webWorker';

export class WorkerHtmlExtractor implements HtmlExtractorPort {
  constructor(private readonly script: string) {}

  async extract(
    html: string,
    url: string,
    maxChars: number,
    signal: AbortSignal,
  ): Promise<Omit<WebPage, 'url'>> {
    const result = (await this.run({ kind: 'html', html, url, maxChars }, signal)) as Partial<WebPage> | null;
    if (
      typeof result?.text !== 'string' ||
      typeof result.title !== 'string' ||
      typeof result.truncated !== 'boolean' ||
      !Array.isArray(result.links) ||
      !result.links.every((s) => typeof s === 'string')
    )
      throw new ToolError('The Web extraction worker returned an invalid page.');
    return result as Omit<WebPage, 'url'>;
  }

  async checkRobots(
    text: string,
    robotsUrl: string,
    pageUrl: string,
    signal: AbortSignal,
  ): Promise<{ allowed: boolean; crawlDelay?: number }> {
    const result = (await this.run({ kind: 'robots', text, robotsUrl, pageUrl }, signal)) as {
      allowed?: unknown;
      crawlDelay?: unknown;
    } | null;
    if (
      typeof result?.allowed !== 'boolean' ||
      (result.crawlDelay !== undefined && typeof result.crawlDelay !== 'number')
    )
      throw new ToolError('The Web worker could not check robots.txt.');
    return result as { allowed: boolean; crawlDelay?: number };
  }

  private run(job: WebJob, signal: AbortSignal): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new ToolError('The Web read was cancelled.'));
      let worker: Worker;
      try {
        worker = new Worker(this.script, {
          workerData: job,
          resourceLimits: { maxOldGenerationSizeMb: 128 },
          execArgv: [],
          env: {},
          stdout: true,
          stderr: true,
        });
      } catch {
        return reject(new ToolError('The Web extraction worker could not start.'));
      }
      worker.stdout.resume();
      worker.stderr.resume();
      let settled = false;
      const finish = (error?: Error, result?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        void worker.terminate();
        if (error) reject(error);
        else resolve(result);
      };
      const abort = () => finish(new ToolError('The Web extraction was cancelled.'));
      const timer = setTimeout(
        () => finish(new ToolError('Web page extraction exceeded its time limit.')),
        5000,
      );
      signal.addEventListener('abort', abort, { once: true });
      worker.once('message', (message: unknown) => {
        const reply = message as { ok?: unknown; result?: unknown } | null;
        if (reply?.ok !== true)
          return finish(new ToolError('The Web extraction worker returned no readable result.'));
        finish(undefined, reply.result);
      });
      worker.once('error', () =>
        finish(new ToolError('The Web extraction worker failed or exceeded its memory limit.')),
      );
      worker.once('exit', () => finish(new ToolError('The Web extraction worker stopped without a result.')));
    });
  }
}
