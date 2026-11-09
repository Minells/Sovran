// Test-only bridge into the same adapters shipped by the extension. It is never included in the VSIX.
import { webFetchTool } from '../../src/core/tools/builtin/webFetchTool';
import type { ToolContext } from '../../src/core/tools/types';
import { NativeWebFetcher } from '../../src/extension/adapters/NativeWebFetcher';
import { directWebRequest, PublicWebTransport } from '../../src/extension/adapters/PublicWebTransport';
import { WorkerHtmlExtractor } from '../../src/extension/adapters/WorkerHtmlExtractor';
import { VscodeWorkspace } from '../../src/extension/adapters/VscodeWorkspace';

export async function readWeb(script: string, port: number) {
  const transport = new PublicWebTransport({
    resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    request: (bound, callback, beforeConnect) =>
      directWebRequest(
        { ...bound, protocol: 'http:', hostname: '127.0.0.1', family: 4, port },
        callback,
        beforeConnect,
      ),
  });
  const unexpectedProcess = async (): Promise<never> => {
    throw new Error('Web reads cannot execute a process.');
  };
  const ctx: ToolContext = {
    workspace: new VscodeWorkspace(),
    process: { run: unexpectedProcess, runFile: unexpectedProcess },
    signal: new AbortController().signal,
    settings: { protectedPaths: [], maxToolResultChars: 2000, terminalTimeoutMs: 1000 },
    web: new NativeWebFetcher(new WorkerHtmlExtractor(script), transport),
  };
  const args = webFetchTool.schema.parse({ url: 'https://docs.example.com/guide' });
  const prepared = await webFetchTool.prepare!(args, ctx);
  return { prepared, result: await webFetchTool.execute(args, ctx, prepared) };
}
