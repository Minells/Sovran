import { describe, expect, it } from 'vitest';
import { AgentRunner, type AgentSettings, type RunOptions } from '../../src/core/agent/agentRunner';
import type { AgentEvent } from '../../src/core/agent/events';
import { MemoryCapabilityStore } from '../../src/core/providers/capabilities';
import { ProviderError } from '../../src/core/providers/errors';
import type { Session, ToolMessage } from '../../src/core/sessions/model';
import { createBuiltinRegistry } from '../../src/core/tools/builtin';
import { nullLogger } from '../../src/core/ports';
import { FakeProcess, MemoryWorkspace, ScriptedApprovals, ScriptedProvider, call, text } from '../fixtures/fakes';

const settings: AgentSettings = {
  maxIterations: 10,
  policy: { approvalMode: 'ask', allowedCommands: ['npm test'], protectedPaths: ['**/.env'] },
  tools: { terminalTimeoutMs: 1000, maxToolResultChars: 20_000, protectedPaths: ['**/.env'] },
  defaultContextWindow: 32_768,
  defaultMaxOutputTokens: 4096,
};

function setup(turns: ConstructorParameters<typeof ScriptedProvider>[0], opts: { files?: Record<string, string>; approvals?: ScriptedApprovals; waits?: number[] } = {}) {
  const provider = new ScriptedProvider(turns);
  const workspace = new MemoryWorkspace(opts.files ?? { 'src/a.ts': 'const a = 1;\n' });
  const approvals = opts.approvals ?? new ScriptedApprovals();
  const process = new FakeProcess();
  const capabilities = new MemoryCapabilityStore();
  let n = 0;
  const runner = new AgentRunner({
    provider,
    registry: createBuiltinRegistry(),
    workspace,
    process,
    approvals,
    capabilities,
    logger: nullLogger,
    newId: () => `id${++n}`,
    now: () => 1_700_000_000_000,
    sleep: async (ms) => void opts.waits?.push(ms),
  });
  const session: Session = { id: 's', title: 't', createdAt: 0, updatedAt: 0, mode: 'act', messages: [{ role: 'user', id: 'u1', content: 'go', createdAt: 0 }] };
  const events: AgentEvent[] = [];
  const run = (over: Partial<RunOptions> = {}) =>
    runner.run({
      session,
      providerId: 'p',
      model: { id: 'm' },
      mode: 'act',
      settings,
      grants: { edits: false },
      signal: new AbortController().signal,
      emit: (e) => events.push(e),
      ...over,
    });
  return { provider, workspace, approvals, process, capabilities, session, events, run };
}

const toolMsgs = (s: Session) => s.messages.filter((m): m is ToolMessage => m.role === 'tool');

describe('AgentRunner limits', () => {
  const contextEvent = (events: AgentEvent[]) => events.find((e): e is Extract<AgentEvent, { type: 'context' }> => e.type === 'context')!;

  it('uses the window the server reports when the user set none, and never sends it as max_tokens', async () => {
    const t = setup([[text('ok')]]);
    await t.run({ model: { id: 'm', serverLimits: { contextWindow: 131072, maxOutputTokens: 32000 } } });
    expect(contextEvent(t.events)).toMatchObject({ contextWindow: 131072, budgetTokens: 131072 - 4096 });
    expect(t.provider.requests[0]!.maxTokens).toBeUndefined();
  });

  it("lets the user's values win over the server's", async () => {
    const t = setup([[text('ok')]]);
    await t.run({ model: { id: 'm', contextWindow: 65536, maxOutputTokens: 8192, serverLimits: { contextWindow: 131072 } } });
    expect(contextEvent(t.events)).toMatchObject({ contextWindow: 65536, budgetTokens: 65536 - 8192 });
    expect(t.provider.requests[0]!.maxTokens).toBe(8192);
  });

  it('keeps the limits the server reported when it learns that a model needs prompted tools', async () => {
    const t = setup([new ProviderError('tools_unsupported', 'no tools', undefined, 400), [text('ok')]]);
    t.capabilities.set('p/m', { contextWindow: 131072, updatedAt: 1 });
    await t.run();
    expect(t.capabilities.get('p/m')).toMatchObject({ toolMode: 'prompted', contextWindow: 131072 });
  });
});

describe('AgentRunner', () => {
  it('completes a multi-step read → edit flow with approval and a native diff proposal', async () => {
    const t = setup([
      [call(0, 'read_file', { path: 'src/a.ts' })],
      [call(0, 'edit_file', { path: 'src/a.ts', old_string: 'const a = 1;', new_string: 'const a = 2;' })],
      [text('Changed a to 2.')],
    ]);
    const outcome = await t.run();
    expect(outcome.reason).toBe('completed');
    expect(t.workspace.get('src/a.ts')).toBe('const a = 2;\n');
    expect(t.approvals.requests).toHaveLength(1);
    const detail = t.approvals.requests[0]!.detail;
    expect(detail.kind).toBe('edit');
    if (detail.kind === 'edit') expect(detail.diff).toContain('+const a = 2;');
    expect(toolMsgs(t.session).map((m) => m.status)).toEqual(['success', 'success']);
    // The second request carries the tool result back to the model in native format.
    const second = t.provider.requests[1]!;
    expect(second.messages.some((m) => m.role === 'tool' && m.content.includes('const a = 1;'))).toBe(true);
    expect(second.tools?.map((x) => x.function.name)).toContain('edit_file');
  });

  it('plan mode exposes only read tools and refuses writes even if the model calls them', async () => {
    const t = setup([[call(0, 'write_file', { path: 'x.ts', content: 'boom' })], [text('ok')]]);
    await t.run({ mode: 'plan' });
    const offered = t.provider.requests[0]!.tools!.map((x) => x.function.name);
    expect(offered).not.toContain('write_file');
    expect(offered).not.toContain('execute_terminal');
    expect(t.workspace.get('x.ts')).toBeUndefined();
    expect(toolMsgs(t.session)[0]!.status).toBe('denied');
    expect(t.approvals.requests).toHaveLength(0);
  });

  it('returns rejection feedback to the model and does not write', async () => {
    const approvals = new ScriptedApprovals(() => ({ approved: false, feedback: 'use let' }));
    const t = setup([[call(0, 'write_file', { path: 'new.ts', content: 'x' })], [text('understood')]], { approvals });
    await t.run();
    expect(t.workspace.get('new.ts')).toBeUndefined();
    const tm = toolMsgs(t.session)[0]!;
    expect(tm.status).toBe('denied');
    expect(tm.content).toContain('use let');
  });

  it('feeds validation errors back so the model can self-correct', async () => {
    const t = setup([[call(0, 'read_file', { file: 'src/a.ts' })], [call(0, 'read_file', { path: 'src/a.ts' })], [text('done')]]);
    await t.run();
    const [first, second] = toolMsgs(t.session);
    expect(first!.status).toBe('error');
    expect(first!.content).toMatch(/Invalid arguments for read_file: path/);
    expect(second!.status).toBe('success');
  });

  it('auto-downgrades to prompted tools when the server rejects native tools, and remembers it', async () => {
    const t = setup([
      new ProviderError('tools_unsupported', 'HTTP 400: does not support tools'),
      (req) => {
        expect(req.tools).toBeUndefined();
        expect(req.messages[0]!.content).toContain('<tool_call>');
        return [text('Let me look.\n<tool_call>\n{"name":"read_file","arguments":{"path":"src/a.ts"}}\n</tool_call>')];
      },
      (req) => {
        const last = req.messages[req.messages.length - 1]!;
        expect(last.role).toBe('user');
        expect(last.content).toContain('<tool_result name="read_file"');
        return [text('It sets a to 1.')];
      },
    ]);
    const outcome = await t.run();
    expect(outcome.reason).toBe('completed');
    expect(t.capabilities.get('p/m')?.toolMode).toBe('prompted');
    expect(t.events.some((e) => e.type === 'notice' && /prompted tools/.test(e.message))).toBe(true);
    const assistant = t.session.messages.find((m) => m.role === 'assistant')!;
    expect(assistant.content).toBe('Let me look.'); // tool_call block hidden from visible text
  });

  it('splits <think> reasoning from visible text', async () => {
    const t = setup([[text('<thi'), text('nk>pondering</think>Answer')]]);
    await t.run();
    const a = t.session.messages.find((m) => m.role === 'assistant');
    expect(a && a.role === 'assistant' && a.reasoning).toBe('pondering');
    expect(a && a.content).toBe('Answer');
  });

  it('asks a busy server again before reporting the error, and honours Retry-After', async () => {
    const busy = (status: number, retryAfterMs?: number) =>
      Object.assign(new ProviderError(status === 429 ? 'rate_limit' : 'server', `HTTP ${status}: busy`, undefined, status), { retryAfterMs });
    const waits: number[] = [];
    const recovered = setup([busy(503), busy(429, 7000), [text('ok')]], { waits });
    expect((await recovered.run()).reason).toBe('completed');
    expect(waits).toEqual([1000, 7000]);
    expect(recovered.session.messages.filter((m) => m.role === 'assistant')).toMatchObject([{ content: 'ok' }]);
    expect(recovered.events.filter((e) => e.type === 'notice')).toHaveLength(2);

    // Two retries, then the error is the user's to see.
    const down = setup([busy(503), busy(503), busy(503), [text('never')]], { waits: [] });
    expect(await down.run()).toMatchObject({ reason: 'error', error: { kind: 'server' } });
    expect(down.provider.requests).toHaveLength(3);

    // Not retried: other errors, and a server that asks for a long wait.
    for (const error of [new ProviderError('auth', 'HTTP 401', undefined, 401), new ProviderError('server', 'HTTP 500', undefined, 500), busy(429, 120_000)]) {
      const t = setup([error, [text('never')]], { waits: [] });
      expect((await t.run()).reason).toBe('error');
      expect(t.provider.requests).toHaveLength(1);
    }
  });

  it('says when a reply was cut at the output limit', async () => {
    const cut = setup([[text('half an ans'), { type: 'finish', reason: 'length' }]]);
    await cut.run();
    expect(cut.events.filter((e) => e.type === 'notice')).toMatchObject([{ level: 'warning', message: expect.stringMatching(/output limit/) }]);
    const whole = setup([[text('done'), { type: 'finish', reason: 'stop' }]]);
    await whole.run();
    expect(whole.events.some((e) => e.type === 'notice')).toBe(false);
  });

  it('gives the model file content unchanged, masking only the provider key', async () => {
    const source = 'const token = getToken(); // key-123456\n';
    const t = setup([[call(0, 'read_file', { path: 'src/a.ts' })], [text('ok')]], { files: { 'src/a.ts': source } });
    await t.run({ secrets: ['key-123456'] });
    const result = t.session.messages.find((m) => m.role === 'tool');
    expect(result?.content).toContain('const token = getToken(); // ••••');
  });

  it('stops at the iteration limit', async () => {
    const turns = Array.from({ length: 5 }, () => [call(0, 'list_directory', { path: '.' })]);
    const t = setup(turns);
    const outcome = await t.run({ settings: { ...settings, maxIterations: 3 } });
    expect(outcome.reason).toBe('max_iterations');
    expect(t.provider.requests).toHaveLength(3);
  });

  it('loop guard stops repeated identical failures', async () => {
    const bad = () => [call(0, 'read_file', { path: 'missing.ts' })];
    const t = setup([bad(), bad(), bad(), bad()]);
    const outcome = await t.run();
    expect(outcome.reason).toBe('error');
    expect(outcome.error?.kind).toBe('loop_guard');
  });

  it('auto-runs allow-listed commands but asks for anything with shell operators', async () => {
    const t = setup([[call(0, 'execute_terminal', { command: 'npm test' })], [call(0, 'execute_terminal', { command: 'npm test; rm -rf /' })], [text('ok')]]);
    await t.run();
    expect(t.process.commands.map((c) => c.command)).toEqual(['npm test', 'npm test; rm -rf /']);
    expect(t.approvals.requests).toHaveLength(1);
    expect(t.approvals.requests[0]!.detail.kind).toBe('command');
  });

  it('denies writes in an untrusted workspace', async () => {
    const t = setup([[call(0, 'write_file', { path: 'n.ts', content: 'x' })], [text('ok')]]);
    t.workspace.trusted = false;
    await t.run();
    expect(toolMsgs(t.session)[0]!.status).toBe('denied');
  });

  it('records provider errors on the assistant message with a hint', async () => {
    const t = setup([new ProviderError('auth', 'HTTP 401: bad key', 'Check the API key')]);
    const outcome = await t.run();
    expect(outcome).toMatchObject({ reason: 'error', error: { kind: 'auth', hint: 'Check the API key' } });
  });

  it('cancels while waiting for approval and closes out pending calls', async () => {
    const ac = new AbortController();
    const approvals = new ScriptedApprovals(
      () =>
        new Promise((_resolve, reject) => {
          ac.abort();
          reject(new Error('aborted'));
        }),
    );
    const t = setup([[call(0, 'write_file', { path: 'a.txt', content: 'x' }), call(1, 'read_file', { path: 'src/a.ts' }, 'c1')]], { approvals });
    const outcome = await t.run({ signal: ac.signal });
    expect(outcome.reason).toBe('cancelled');
    expect(toolMsgs(t.session).map((m) => m.status)).toEqual(['cancelled', 'cancelled']);
  });

  it('session edit grant skips later approvals', async () => {
    const approvals = new ScriptedApprovals(() => ({ approved: true, grant: 'session-edits' }));
    const t = setup(
      [[call(0, 'write_file', { path: 'a.txt', content: '1' })], [call(0, 'write_file', { path: 'b.txt', content: '2' })], [text('ok')]],
      { approvals },
    );
    const grants = { edits: false };
    await t.run({ grants });
    expect(approvals.requests).toHaveLength(1);
    expect(grants.edits).toBe(true);
    expect(t.workspace.get('b.txt')).toBe('2');
  });
});
