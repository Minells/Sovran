import { parentPort, workerData } from 'node:worker_threads';
import { extractPage } from '../../core/web/extract';
import robotsParser from 'robots-parser';

export type WebJob =
  | { kind: 'html'; html: string; url: string; maxChars: number }
  | { kind: 'robots'; text: string; robotsUrl: string; pageUrl: string };

if (parentPort) {
  try {
    const job = workerData as WebJob;
    if (job.kind === 'html') {
      parentPort.postMessage({ ok: true, result: extractPage(job.html, job.url, job.maxChars) });
    } else {
      const rules = robotsParser(job.robotsUrl, job.text);
      parentPort.postMessage({
        ok: true,
        result: {
          allowed: rules.isAllowed(job.pageUrl, 'SovranWeb') === true,
          crawlDelay: rules.getCrawlDelay('SovranWeb'),
        },
      });
    }
  } catch {
    parentPort.postMessage({ ok: false });
  }
}
