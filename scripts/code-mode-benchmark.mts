import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AgentRunner, type AgentSettings } from '../src/core/agent/agentRunner';
import { MemoryCapabilityStore } from '../src/core/providers/capabilities';
import { OpenAICompatibleProvider } from '../src/core/providers/openaiCompatible';
import type { ChatProvider, ChatRequest, ProviderEvent, ResolvedToolMode } from '../src/core/providers/types';
import { serializeToolCall } from '../src/core/agent/promptedTools';
import type { Session } from '../src/core/sessions/model';
import { nullLogger } from '../src/core/ports';
import { QuickJSExecutor } from '../src/extension/adapters/QuickJSExecutor';
import { aggregationCode, codeFixture, expectedFailed, projectCount } from '../tests/fixtures/codeMode';
import {
  FakeProcess,
  MemoryWorkspace,
  ScriptedApprovals,
  ScriptedProvider,
  call,
  text,
} from '../tests/fixtures/fakes';

async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string, fallback = '') => {
    const index = args.indexOf(name);
    return index < 0 ? fallback : (args[index + 1] ?? fallback);
  };
  const reference = args.includes('--reference');
  const endpoint = flag('--endpoint');
  const model = flag('--model');
  const toolMode = flag('--tool-mode', 'native') as ResolvedToolMode;
  const repetitions = Number(flag('--runs', '3'));
  if (
    (!reference && (!endpoint || !model)) ||
    !['native', 'prompted'].includes(toolMode) ||
    !Number.isInteger(repetitions) ||
    repetitions < 1 ||
    repetitions > 10
  )
    throw new Error(
      'Usage: npm run benchmark:code-mode -- --reference | --endpoint URL --model ID [--tool-mode native|prompted] [--runs 1..10] [--out PATH]',
    );

  const sandbox = new QuickJSExecutor(resolve('dist/codeModeWorker.js'), resolve('dist/quickjs.wasm'));
  const settings: AgentSettings = {
    maxIterations: 20,
    codeModeEnabled: true,
    toolLoading: 'auto',
    policy: { approvalMode: 'ask', allowedCommands: [], protectedPaths: [] },
    tools: { terminalTimeoutMs: 1000, maxToolResultChars: 20_000, protectedPaths: [] },
    defaultContextWindow: Number(flag('--context', '32768')),
    defaultMaxOutputTokens: Number(flag('--max-output', '4096')),
  };
  const expected = { totalProjects: projectCount, failedPipelines: expectedFailed };
  const prompt = `Count all projects from server gitlab-0 and all their failed pipelines on server gitlab-1, matching the explicit project IDs. List projects once, then query pipelines for every project_id, counting status === "failed". These fixture tools return complete pages with nextPage:null. Return only valid JSON {"totalProjects":number,"failedPipelines":number}. Do not use other servers or assume a count from the instructions. If a query fails, report incomplete results instead of guessing. In Code Mode search/describe tools first, then use JavaScript to aggregate and return only counts. In normal tool mode you may batch independent tool calls in one response.`;
  const rows: Record<string, unknown>[] = [];
  const warmup: number[] = [];
  for (let n = 0; n < 10; n++) {
    const started = performance.now();
    await sandbox.execute('return 42;', {
      signal: new AbortController().signal,
      maxOutputBytes: 100,
      call: async () => {
        throw new Error('unexpected RPC');
      },
    });
    warmup.push(performance.now() - started);
  }

  for (let n = 0; n < repetitions; n++)
    for (const variant of n % 2 ? ['code', 'standard'] : ['standard', 'code']) {
      let mcpCalls = 0;
      const fixture = await codeFixture({ onCall: () => mcpCalls++ });
      try {
        const projects = fixture.hub
          .tools()
          .find((t) => t.name.includes('gitlab-0') && t.name.endsWith('list_projects'))!.name;
        const pipelines = fixture.hub
          .tools()
          .find((t) => t.name.includes('gitlab-1') && t.name.endsWith('list_pipelines'))!.name;
        const eventsFor = (name: string, value: unknown): ProviderEvent[] =>
          toolMode === 'prompted'
            ? [text(serializeToolCall(name, JSON.stringify(value)))]
            : [call(0, name, value, `${name}-${Math.random()}`)];
        const readLast = (request: ChatRequest) => {
          const message = [...request.messages]
            .reverse()
            .find(
              (m) => m.role === 'tool' || (m.role === 'user' && String(m.content).startsWith('<tool_result')),
            )!;
          const content = String(message.content);
          return JSON.parse(
            content.startsWith('<tool_result')
              ? content.slice(content.indexOf('\n') + 1, content.lastIndexOf('\n'))
              : content,
          );
        };
        const delegate: ChatProvider = reference
          ? new ScriptedProvider(
              variant === 'code'
                ? [
                    eventsFor('code_describe', { toolIds: [projects, pipelines] }),
                    (request) =>
                      eventsFor('execute_code', {
                        manifestId: readLast(request).manifestId,
                        code: aggregationCode(projects, pipelines),
                      }),
                    [text(JSON.stringify(expected))],
                  ]
                : [
                    eventsFor(projects, {}),
                    () =>
                      Array.from({ length: projectCount }, (_, i) =>
                        call(i, pipelines, { project_id: String(i + 1) }, `pipeline-${i}`),
                      ),
                    [text(JSON.stringify(expected))],
                  ],
            )
          : new OpenAICompatibleProvider({
              config: {
                id: 'benchmark',
                name: 'Benchmark',
                baseUrl: endpoint,
                auth: { type: process.env.SOVRAN_BENCHMARK_API_KEY ? 'bearer' : 'none' },
                timeoutSeconds: 180,
              },
              getApiKey: async () => process.env.SOVRAN_BENCHMARK_API_KEY,
            });
        let inputBytes = 0;
        let outputBytes = 0;
        let intermediateBytes = 0;
        let inferenceCalls = 0;
        let promptTokens = 0;
        let completionTokens = 0;
        let usageSeen = false;
        const provider: ChatProvider = {
          id: delegate.id,
          listModels: (signal) => delegate.listModels(signal),
          async *streamChat(request, signal) {
            inferenceCalls++;
            inputBytes += Buffer.byteLength(JSON.stringify(request));
            intermediateBytes += request.messages
              .filter(
                (m) =>
                  m.role === 'tool' || (m.role === 'user' && String(m.content).startsWith('<tool_result')),
              )
              .reduce((sum, m) => sum + Buffer.byteLength(String(m.content)), 0);
            for await (const event of delegate.streamChat(request, signal)) {
            if (event.type === 'text' || event.type === 'reasoning') outputBytes += Buffer.byteLength(event.text);
              if (event.type === 'tool_call_delta')
                outputBytes += Buffer.byteLength(event.argumentsDelta ?? '');
              if (event.type === 'usage') {
                usageSeen = true;
                promptTokens += event.promptTokens ?? 0;
                completionTokens += event.completionTokens ?? 0;
              }
              yield event;
            }
          },
        };
        const session: Session = {
          id: `bench-${n}-${variant}`,
          title: 'Benchmark',
          createdAt: 0,
          updatedAt: 0,
          mode: 'act',
          messages: [
            {
              role: 'user',
              id: 'u',
              content: prompt,
              ...(variant === 'code' ? { display: `/code ${prompt}` } : {}),
              createdAt: 0,
            },
          ],
        };
        const approvals = new ScriptedApprovals();
        const runner = new AgentRunner({
          provider,
          registry: fixture.registry,
          workspace: new MemoryWorkspace(),
          process: new FakeProcess(),
          approvals,
          capabilities: new MemoryCapabilityStore(),
          logger: nullLogger,
          codeSandbox: sandbox,
        });
        const started = performance.now();
        const outcome = await runner.run({
          session,
          providerId: 'benchmark',
          model: { id: model || 'scripted-reference', toolMode, temperature: 0 },
          mode: 'act',
          settings,
          grants: { edits: false },
          signal: AbortSignal.timeout(10 * 60_000),
          emit: () => {},
        });
        const final = [...session.messages].reverse().find((m) => m.role === 'assistant')?.content ?? '';
        let actual: unknown;
        try {
          actual = JSON.parse(final.replace(/^```(?:json)?\s*|\s*```$/g, '').trim());
        } catch {
          /* Invalid final answer is a failure. */
        }
        const correct =
          !!actual &&
          typeof actual === 'object' &&
          'totalProjects' in actual &&
          'failedPipelines' in actual &&
          actual.totalProjects === expected.totalProjects &&
          actual.failedPipelines === expected.failedPipelines;
        const codeResult = session.messages.find((m) => m.role === 'tool' && m.toolName === 'execute_code');
        const row = {
          repetition: n + 1,
          variant,
          reason: outcome.reason,
          correct,
          durationMs: Math.round(performance.now() - started),
          inferenceCalls,
          mcpCalls,
          approvals: approvals.requests.length,
          inputBytes,
          outputBytes,
          intermediateBytes,
          estimatedTotalTokens: Math.ceil((inputBytes + outputBytes) / 3.5),
          ...(usageSeen ? { promptTokens, completionTokens } : {}),
          codeStatus: codeResult?.role === 'tool' ? codeResult.status : undefined,
        };
        rows.push(row);
        console.log(JSON.stringify(row));
      } finally {
        await fixture.hub.dispose();
      }
    }
  warmup.sort((a, b) => a - b);
  const result = {
    kind: reference ? 'scripted-reference-not-model-performance' : 'real-model',
    model: model || 'scripted-reference',
    toolMode,
    createdAt: new Date().toISOString(),
    task: 'complete-pages-cross-server-counts',
    expected,
    runtime: { medianMs: Math.round(warmup[5]!), p95Ms: Math.round(warmup[9]!) },
    rows,
    limitations: [
      'Single task; does not establish the complete 12-task matrix.',
      'Fixture tools allowed explicitly; real-user approval latency not measured.',
      'Estimates use bytes/3.5; provider usage, if present, is reported separately.',
      'Scripted reference final answers are prescribed and validate plumbing, not model reasoning.',
    ],
  };
  await writeFile(
    flag('--out', resolve('code-mode-benchmark.json')),
    JSON.stringify(result, null, 2) + '\n',
  );
  if (
    rows.some(
      (row) =>
        row.reason !== 'completed' ||
        !row.correct ||
        Number(row.mcpCalls) !== 11 ||
        (row.variant === 'code' && row.codeStatus !== 'success'),
    )
  )
    process.exitCode = 1;
}
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Benchmark failed.');
  process.exitCode = 1;
});
