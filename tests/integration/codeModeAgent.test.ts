import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import * as esbuild from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentRunner, type AgentSettings } from '../../src/core/agent/agentRunner';
import type { AgentEvent } from '../../src/core/agent/events';
import { MemoryCapabilityStore } from '../../src/core/providers/capabilities';
import type { ChatRequest } from '../../src/core/providers/types';
import type { Session } from '../../src/core/sessions/model';
import { nullLogger } from '../../src/core/ports';
import { serializeToolCall } from '../../src/core/agent/promptedTools';
import { QuickJSExecutor } from '../../src/extension/adapters/QuickJSExecutor';
import {
  FakeProcess,
  MemoryWorkspace,
  ScriptedApprovals,
  ScriptedProvider,
  call,
  text,
} from '../fixtures/fakes';
import { aggregationCode, codeFixture, expectedFailed } from '../fixtures/codeMode';

const require = createRequire(import.meta.url);
let dir: string;
let sandbox: QuickJSExecutor;
beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sovran-code-agent-'));
  const script = path.join(dir, 'codeModeWorker.js');
  const wasm = path.join(dir, 'quickjs.wasm');
  await fs.copyFile(require.resolve('@jitl/quickjs-wasmfile-release-sync/wasm'), wasm);
  await esbuild.build({
    entryPoints: ['src/extension/adapters/codeModeWorker.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    minify: true,
    outfile: script,
    logLevel: 'silent',
    alias: {
      '@jitl/quickjs-wasmfile-release-sync/emscripten-module':
        require.resolve('@jitl/quickjs-wasmfile-release-sync/emscripten-module'),
    },
  });
  sandbox = new QuickJSExecutor(script, wasm);
}, 30_000);
afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const settings: AgentSettings = {
  maxIterations: 12,
  codeModeEnabled: true,
  toolLoading: 'auto',
  policy: { approvalMode: 'auto', allowedCommands: [], protectedPaths: [] },
  tools: { terminalTimeoutMs: 1000, maxToolResultChars: 20_000, protectedPaths: [] },
  defaultContextWindow: 32_768,
  defaultMaxOutputTokens: 4096,
};
const lastResult = (request: ChatRequest) => {
  const result = [...request.messages]
    .reverse()
    .find(
      (m) =>
        m.role === 'tool' ||
        (m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('<tool_result')),
    )!;
  const content = String(result.content);
  return JSON.parse(
    content.startsWith('<tool_result')
      ? content.slice(content.indexOf('\n') + 1, content.lastIndexOf('\n'))
      : content,
  );
};

async function runProgram(
  fixture: Awaited<ReturnType<typeof codeFixture>>,
  program: (projects: string, pipelines: string) => string,
) {
  const projects = fixture.hub
    .tools()
    .find((t) => t.name.includes('gitlab-0') && t.name.endsWith('list_projects'))!.name;
  const pipelines = fixture.hub
    .tools()
    .find((t) => t.name.includes('gitlab-1') && t.name.endsWith('list_pipelines'))!.name;
  const provider = new ScriptedProvider([
    [call(0, 'code_describe', { toolIds: [projects, pipelines] })],
    (request) => [
      call(0, 'execute_code', {
        manifestId: lastResult(request).manifestId,
        code: program(projects, pipelines),
      }),
    ],
    [text('Finished.')],
  ]);
  const runner = new AgentRunner({
    provider,
    registry: fixture.registry,
    workspace: new MemoryWorkspace(),
    process: new FakeProcess(),
    approvals: new ScriptedApprovals(),
    capabilities: new MemoryCapabilityStore(),
    logger: nullLogger,
    codeSandbox: sandbox,
  });
  const session: Session = {
    id: 's',
    title: '',
    createdAt: 0,
    updatedAt: 0,
    mode: 'act',
    messages: [{ role: 'user', id: 'u', content: '/code test', createdAt: 0 }],
  };
  await runner.run({
    session,
    providerId: 'test',
    model: { id: 'test' },
    mode: 'act',
    settings,
    grants: { edits: false },
    signal: new AbortController().signal,
    emit: () => {},
  });
  const result = session.messages.find((m) => m.role === 'tool' && m.toolName === 'execute_code')!;
  return { result, data: JSON.parse(result.content) };
}

describe('Code Mode in the real agent / MCP SDK / QuickJS path', () => {
  it('follows project and pipeline pagination without dropping or counting pages twice', async () => {
    const fixture = await codeFixture({ pageSize: 3 });
    try {
      const { result, data } = await runProgram(
        fixture,
        (projects, pipelines) => `
        const projects = []; let page = 1;
        while (page) {
          const r = await tools.call(${JSON.stringify(projects)}, {page});
          projects.push(...r.data.projects); page = r.data.nextPage;
        }
        let failedPipelines = 0;
        for (const project of projects) {
          page = 1;
          while (page) {
            const r = await tools.call(${JSON.stringify(pipelines)}, {project_id: project.id, page});
            failedPipelines += r.data.pipelines.filter(p => p.status === 'failed').length;
            page = r.data.nextPage;
          }
        }
        return {totalProjects: projects.length, failedPipelines};
      `,
      );
      expect(result).toMatchObject({ status: 'success' });
      expect(data).toMatchObject({
        status: 'success',
        value: { totalProjects: 10, failedPipelines: 20 },
        stats: { calls: 24 },
      });
    } finally {
      await fixture.hub.dispose();
    }
  });

  it('keeps a failed project explicit instead of treating its missing pipelines as zero', async () => {
    const fixture = await codeFixture({ failureProject: '5' });
    try {
      const { data } = await runProgram(
        fixture,
        (projects, pipelines) => `
        const projects = (await tools.call(${JSON.stringify(projects)}, {})).data.projects;
        let failedPipelines = 0; const unavailableProjects = [];
        for (let i = 0; i < projects.length; i += 4) {
          const batch = projects.slice(i, i+4);
          const results = await Promise.allSettled(batch.map(p => tools.call(${JSON.stringify(pipelines)}, {project_id: p.id})));
          results.forEach((r,n) => {
            if (r.status === 'rejected') unavailableProjects.push(batch[n].id);
            else failedPipelines += r.value.data.pipelines.filter(p => p.status === 'failed').length;
          });
        }
        return {failedPipelines, unavailableProjects, complete: unavailableProjects.length === 0};
      `,
      );
      expect(data).toMatchObject({
        status: 'partial',
        value: { failedPipelines: 18, unavailableProjects: ['5'], complete: false },
      });
    } finally {
      await fixture.hub.dispose();
    }
  });
  it.each(['native', 'prompted'] as const)(
    'aggregates across two servers using %s tool calling, without intermediate data in context',
    async (toolMode) => {
      const fixture = await codeFixture();
      try {
        const offered = fixture.hub.tools();
        const projects = offered.find(
          (t) => t.name.includes('gitlab-0') && t.name.endsWith('list_projects'),
        )!.name;
        const pipelines = offered.find(
          (t) => t.name.includes('gitlab-1') && t.name.endsWith('list_pipelines'),
        )!.name;
        const toolCall = (name: string, args: unknown) =>
          toolMode === 'native'
            ? [call(0, name, args, name)]
            : [text(serializeToolCall(name, JSON.stringify(args)))];
        const provider = new ScriptedProvider([
          toolCall('code_search', { query: 'projects pipelines' }),
          () => toolCall('code_describe', { toolIds: [projects, pipelines] }),
          (request) =>
            toolCall('execute_code', {
              manifestId: lastResult(request).manifestId,
              code: aggregationCode(projects, pipelines),
            }),
          [text('Finished.')],
        ]);
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
        const session: Session = {
          id: 's',
          title: 'test',
          mode: 'act',
          createdAt: 0,
          updatedAt: 0,
          toolUnits: ['mcp:gitlab-0'],
          messages: [
            {
              role: 'user',
              id: 'u',
              content: 'Count failed pipelines',
              display: '/code Count failed pipelines',
              createdAt: 0,
            },
          ],
        };
        const events: AgentEvent[] = [];
        const outcome = await runner.run({
          session,
          providerId: 'test',
          model: { id: 'test', toolMode },
          mode: 'act',
          settings,
          grants: { edits: false },
          signal: new AbortController().signal,
          emit: (e) => events.push(e),
        });
        expect(outcome.reason).toBe('completed');
        const execution = session.messages.find((m) => m.role === 'tool' && m.toolName === 'execute_code')!;
        expect(execution).toMatchObject({ status: 'success' });
        expect(JSON.parse(execution.content)).toMatchObject({
          status: 'success',
          value: { totalProjects: 10, failedPipelines: expectedFailed },
          stats: { calls: 11 },
        });
        expect(execution.role === 'tool' && execution.codeMode?.calls).toHaveLength(11);
        expect(events.some((e) => e.type === 'code_trace')).toBe(true);
        expect(approvals.requests).toHaveLength(0);
        expect(session.toolUnits).toEqual(['mcp:gitlab-0']);
        for (const request of provider.requests) {
          expect(request.tools?.some((t) => t.function.name.startsWith('mcp__')) ?? false).toBe(false);
          expect(JSON.stringify(request)).not.toContain('Fixture pipeline metadata.');
        }
      } finally {
        await fixture.hub.dispose();
      }
    },
  );

  it('asks even in Auto mode and dispatches nothing after rejection', async () => {
    let actualCalls = 0;
    const fixture = await codeFixture({ allowed: false, onCall: () => actualCalls++ });
    try {
      const tool = fixture.hub.tools()[0]!.name;
      const provider = new ScriptedProvider([
        [call(0, 'code_describe', { toolIds: [tool] })],
        (request) => [
          call(0, 'execute_code', {
            manifestId: lastResult(request).manifestId,
            code: `return await tools.call(${JSON.stringify(tool)}, {});`,
          }),
        ],
        [text('Rejected.')],
      ]);
      const approvals = new ScriptedApprovals(() => ({ approved: false }));
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
      const session: Session = {
        id: 's',
        title: '',
        createdAt: 0,
        updatedAt: 0,
        mode: 'act',
        messages: [{ role: 'user', id: 'u', content: '/code test', createdAt: 0 }],
      };
      await runner.run({
        session,
        providerId: 'test',
        model: { id: 'test' },
        mode: 'act',
        settings,
        grants: { edits: false },
        signal: new AbortController().signal,
        emit: () => {},
      });
      expect(approvals.requests).toHaveLength(1);
      expect(actualCalls).toBe(0);
      expect(session.messages.find((m) => m.role === 'tool' && m.toolName === 'execute_code')).toMatchObject({
        status: 'denied',
      });
    } finally {
      await fixture.hub.dispose();
    }
  });

  it('refuses /code when disabled, untrusted, in Plan, or tools are disabled', async () => {
    for (const condition of ['setting', 'trust', 'plan', 'tools']) {
      const provider = new ScriptedProvider([[text('must not be called')]]);
      const fixture = await codeFixture();
      try {
        const workspace = new MemoryWorkspace();
        workspace.trusted = condition !== 'trust';
        const runner = new AgentRunner({
          provider,
          registry: fixture.registry,
          workspace,
          process: new FakeProcess(),
          approvals: new ScriptedApprovals(),
          capabilities: new MemoryCapabilityStore(),
          logger: nullLogger,
          codeSandbox: sandbox,
        });
        const session: Session = {
          id: 's',
          title: '',
          createdAt: 0,
          updatedAt: 0,
          mode: 'act',
          messages: [{ role: 'user', id: 'u', content: '/code test', createdAt: 0 }],
        };
        const outcome = await runner.run({
          session,
          providerId: 'test',
          model: { id: 'test', toolMode: condition === 'tools' ? 'none' : 'native' },
          mode: condition === 'plan' ? 'plan' : 'act',
          settings: { ...settings, codeModeEnabled: condition !== 'setting' },
          grants: { edits: false },
          signal: new AbortController().signal,
          emit: () => {},
        });
        expect(outcome.reason).toBe('error');
        expect(provider.requests).toHaveLength(0);
      } finally {
        await fixture.hub.dispose();
      }
    }
  });

  it('handles ten MCP servers advertising ten tools each while exposing only reviewed capabilities', async () => {
    const fixture = await codeFixture({ servers: 10, extraTools: 8 });
    try {
      expect(fixture.transports.servers.size).toBe(10);
      // Every mock advertises 10, but the managed catalog excludes the eight unreviewed tools per server.
      expect(fixture.hub.tools()).toHaveLength(20);
      expect(fixture.hub.tools().every((tool) => !!tool.codeMode)).toBe(true);
      expect(fixture.hub.tools().some((tool) => tool.name.includes('unreviewed'))).toBe(false);
    } finally {
      await fixture.hub.dispose();
    }
  });

  it('rechecks a live experiment revocation after approval, before the MCP call', async () => {
    let allowed = true;
    let actualCalls = 0;
    const fixture = await codeFixture({ allowed: false, onCall: () => actualCalls++ });
    try {
      const tool = fixture.hub.tools()[0]!.name;
      const provider = new ScriptedProvider([
        [call(0, 'code_describe', { toolIds: [tool] })],
        (request) => [
          call(0, 'execute_code', {
            manifestId: lastResult(request).manifestId,
            code: `return await tools.call(${JSON.stringify(tool)}, {});`,
          }),
        ],
        [text('Stopped.')],
      ]);
      const approvals = new ScriptedApprovals(() => {
        allowed = false;
        return { approved: true };
      });
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
      const session: Session = {
        id: 's',
        title: '',
        createdAt: 0,
        updatedAt: 0,
        mode: 'act',
        messages: [{ role: 'user', id: 'u', content: '/code test', createdAt: 0 }],
      };
      await runner.run({
        session,
        providerId: 'test',
        model: { id: 'test' },
        mode: 'act',
        settings,
        codeModeAllowed: () => allowed,
        grants: { edits: false },
        signal: new AbortController().signal,
        emit: () => {},
      });
      expect(approvals.requests).toHaveLength(1);
      expect(actualCalls).toBe(0);
      expect(session.messages.find((m) => m.role === 'tool' && m.toolName === 'execute_code')).toMatchObject({
        status: 'denied',
      });
    } finally {
      await fixture.hub.dispose();
    }
  });
});
