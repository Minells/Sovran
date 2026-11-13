import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AgentRunner, type AgentSettings, type RunOptions } from '../../src/core/agent/agentRunner';
import type { AgentEvent } from '../../src/core/agent/events';
import { nullLogger } from '../../src/core/ports';
import { MemoryCapabilityStore } from '../../src/core/providers/capabilities';
import type { ChatRequest, ModelConfig } from '../../src/core/providers/types';
import type { Session, ToolMessage } from '../../src/core/sessions/model';
import { createBuiltinRegistry } from '../../src/core/tools/builtin';
import {
  addUnits,
  CORE_UNIT,
  LOAD_TOOLS,
  loadableUnits,
  loadToolsSchema,
  normalizeToolUnits,
  offerTools,
  resolveLoadRequest,
  TOOL_UNIT_PATTERN,
  unitOf,
  unitsWithinBudget,
  withImplied,
} from '../../src/core/tools/loading';
import { ToolRegistry } from '../../src/core/tools/registry';
import { defineTool, type AnyTool } from '../../src/core/tools/types';
import { FakeProcess, MemoryWorkspace, ScriptedApprovals, ScriptedProvider, call, text } from '../fixtures/fakes';

const settings: AgentSettings = {
  maxIterations: 6,
  policy: { approvalMode: 'auto', allowedCommands: [], protectedPaths: [] },
  tools: { terminalTimeoutMs: 1000, maxToolResultChars: 4000, protectedPaths: [] },
  defaultContextWindow: 32768,
  defaultMaxOutputTokens: 4096,
};
const auto: AgentSettings = { ...settings, toolLoading: 'auto' };
/** A window whose budget share leaves room for the core only. */
const small: ModelConfig = { id: 'm', contextWindow: 8192 };
/** A window where every definition fits the budget share. */
const large: ModelConfig = { id: 'm', contextWindow: 1_000_000 };

function fake(name: string, extra: Partial<AnyTool> = {}) {
  return defineTool({
    name,
    // Long enough that the core alone exceeds the budget share of the small window, as real definitions do.
    description: `The ${name} tool. ${'It is described at length. '.repeat(40)}`,
    risk: 'read',
    schema: z.object({ path: z.string().optional() }),
    label: () => name,
    execute: vi.fn(async () => ({ content: `${name} ran` })),
    source: { kind: 'native' },
    ...extra,
  });
}

function newSession(extra: Partial<Session> = {}): Session {
  return { id: 's', title: 'Test', createdAt: 0, updatedAt: 0, mode: 'act', messages: [], ...extra };
}

function setup(registry: ToolRegistry, turns: ConstructorParameters<typeof ScriptedProvider>[0], session = newSession()) {
  const provider = new ScriptedProvider(turns);
  const process = new FakeProcess();
  const events: AgentEvent[] = [];
  const runner = new AgentRunner({
    registry,
    provider,
    workspace: new MemoryWorkspace(),
    process,
    approvals: new ScriptedApprovals(),
    capabilities: new MemoryCapabilityStore(),
    logger: nullLogger,
  });
  const run = (options: Partial<RunOptions> = {}) =>
    runner.run({
      session,
      providerId: 'p',
      model: small,
      mode: 'act',
      settings: auto,
      grants: { edits: false },
      signal: new AbortController().signal,
      emit: (e) => events.push(e),
      ...options,
    });
  return { provider, process, session, events, run };
}

const names = (req: ChatRequest | undefined) => (req?.tools ?? []).map((t) => t.function.name);
const system = (req: ChatRequest | undefined) => String(req?.messages[0]?.content ?? '');
const tools = (session: Session) => session.messages.filter((m): m is ToolMessage => m.role === 'tool');

/** core: probe, write_probe · git: git_read · git.changes: git_write · mcp:docs: mcp__docs__search */
function fakeRegistry() {
  const registry = new ToolRegistry()
    .register(fake('probe', { group: 'files', unit: CORE_UNIT }))
    .register(fake('write_probe', { group: 'editing', unit: CORE_UNIT, risk: 'write' }))
    .register(fake('git_read', { group: 'git', unit: 'git' }))
    .register(fake('git_write', { group: 'git', unit: 'git.changes', risk: 'write' }));
  const mcp = fake('mcp__docs__search', { group: 'mcp:docs', risk: 'execute', source: { kind: 'mcp', serverId: 'docs' } });
  registry.addSource({ tools: () => [mcp] });
  return { registry, mcp };
}

describe('tool units', () => {
  it('gives every native tool an explicit unit that a chat can load or the core', () => {
    const units = new Set<string>();
    for (const tool of createBuiltinRegistry().all()) {
      expect(tool.unit, tool.name).toBeDefined();
      expect(tool.unit === CORE_UNIT || TOOL_UNIT_PATTERN.test(tool.unit!), tool.name).toBe(true);
      units.add(tool.unit!);
    }
    expect([...units].sort()).toEqual(
      ['core', 'diagnostics', 'git', 'git.changes', 'git.remote', 'symbols', 'web'].sort(),
    );
  });

  it('keeps file, editing, terminal and editor-context tools in the core', () => {
    const core = createBuiltinRegistry()
      .all()
      .filter((tool) => unitOf(tool) === CORE_UNIT)
      .map((tool) => tool.name);
    expect(core).toEqual([
      'read_file',
      'list_directory',
      'find_files',
      'search_files',
      'get_workspace_info',
      'get_active_editor_context',
      'write_file',
      'edit_file',
      'apply_diff',
      'execute_terminal',
    ]);
  });

  it('puts an MCP tool in its server unit and reserves the load_tools name', () => {
    const { mcp } = fakeRegistry();
    expect(unitOf(mcp)).toBe('mcp:docs');
    expect(() => new ToolRegistry().register(fake(LOAD_TOOLS))).toThrow(/Reserved/);
  });

  it('normalizes persisted units', () => {
    expect(normalizeToolUnits(['git', 'git', 'core', 'mcp:Docs', 'mcp:docs', 3, 'web'])).toEqual(['git', 'mcp:docs', 'web']);
    expect(normalizeToolUnits('git')).toEqual([]);
  });

  it('loads the units a unit builds on first and never twice', () => {
    const loaded = ['web'];
    expect(addUnits(loaded, ['git.remote', 'git.changes', 'web'])).toEqual(['git', 'git.remote', 'git.changes']);
    expect(loaded).toEqual(['web', 'git', 'git.remote', 'git.changes']);
    expect(withImplied(['git.changes'])).toEqual(['git', 'git.changes']);
  });
});

describe('tool offer', () => {
  const { registry } = fakeRegistry();
  const available = registry.list('act', { workspaceTrusted: true });
  const units = loadableUnits(available, () => 100);

  it('groups available tools into units in registry order, without the core', () => {
    expect(units.map((u) => [u.id, u.tools.map((t) => t.name), u.tokens])).toEqual([
      ['git', ['git_read'], 100],
      ['git.changes', ['git_write'], 100],
      ['mcp:docs', ['mcp__docs__search'], 100],
    ]);
  });

  it('offers the core, then loaded units in load order, and indexes every unit while one is deferred', () => {
    const offer = offerTools(available, ['git.changes', 'git'], units);
    expect(offer.core.map((t) => t.name)).toEqual(['probe', 'write_probe']);
    expect(offer.loaded.map((t) => t.name)).toEqual(['git_write', 'git_read']);
    expect(offer.index.map((u) => u.id)).toEqual(['git', 'git.changes', 'mcp:docs']);
  });

  it('keeps registry order and drops the index once every unit is loaded', () => {
    const offer = offerTools(available, ['mcp:docs', 'git.changes', 'git'], units);
    expect(offer.core).toEqual(available);
    expect(offer.loaded).toEqual([]);
    expect(offer.index).toEqual([]);
  });

  it('loads everything, the native units or nothing, depending on what fits the budget share', () => {
    expect(unitsWithinBudget(200, units, 10_000)).toEqual(['git', 'git.changes', 'mcp:docs']);
    expect(unitsWithinBudget(200, units, 4_000)).toEqual(['git', 'git.changes']);
    expect(unitsWithinBudget(200, units, 3_000)).toEqual([]);
  });

  it('describes the units and constrains load_tools to their ids', () => {
    const many = loadableUnits(
      Array.from({ length: 14 }, (_, i) =>
        fake(`mcp__big__t${i}`, { source: { kind: 'mcp', serverId: 'big' }, group: 'mcp:big' }),
      ),
      () => 1,
    );
    const schema = loadToolsSchema([...units, ...many]);
    expect(schema.function.name).toBe(LOAD_TOOLS);
    expect(schema.function.description).toContain('- git (repository status, diffs, history and branches): git_read');
    expect(schema.function.description).toContain('mcp__big__t11 and 2 more');
    expect(schema.function.parameters).toEqual({
      type: 'object',
      properties: {
        units: { type: 'array', items: { type: 'string', enum: ['git', 'git.changes', 'mcp:docs', 'mcp:big'] } },
      },
      required: ['units'],
    });
  });

  it('accepts unit ids, a single id or a tool name, adds implied units and rejects anything else', () => {
    expect(resolveLoadRequest({ units: ['git.changes'] }, units)).toEqual({ ok: true, units: ['git', 'git.changes'] });
    expect(resolveLoadRequest({ units: 'mcp:docs' }, units)).toEqual({ ok: true, units: ['mcp:docs'] });
    expect(resolveLoadRequest({ units: ['git_read', 'git'] }, units)).toEqual({ ok: true, units: ['git'] });
    expect(resolveLoadRequest({ units: ['shell'] }, units)).toEqual({
      ok: false,
      error: 'Unknown unit "shell". Units you can load: git, git.changes, mcp:docs.',
    });
    expect(resolveLoadRequest({ groups: ['git'] }, units)).toMatchObject({ ok: false });
    // An implied unit that this chat cannot load (all its tools excluded) is left out.
    expect(resolveLoadRequest({ units: ['git.changes'] }, units.slice(1))).toEqual({ ok: true, units: ['git.changes'] });
  });
});

describe('on-demand loading in the agent loop', () => {
  it('sends every tool in registry order without load_tools when loading is not on demand', async () => {
    const t = setup(createBuiltinRegistry(), [[text('done')]]);
    await t.run({ settings });
    expect(names(t.provider.requests[0])).toEqual(createBuiltinRegistry().all().map((tool) => tool.name));
    expect(system(t.provider.requests[0])).not.toContain('load_tools');
    expect(t.session.toolUnits).toBeUndefined();
  });

  it('sends the same request as before when every definition fits the budget share', async () => {
    const before = setup(createBuiltinRegistry(), [[text('done')]]);
    await before.run({ settings, model: large });
    const after = setup(createBuiltinRegistry(), [[text('done')]]);
    await after.run({ model: large });
    expect(after.provider.requests[0]).toEqual(before.provider.requests[0]);
    expect(after.session.toolUnits).toEqual(['diagnostics', 'symbols', 'web', 'git', 'git.changes', 'git.remote']);
    expect(after.events).toContainEqual({ type: 'tools_loaded', units: after.session.toolUnits, reason: 'budget' });
  });

  it('offers the core and load_tools to a small window, with the on-demand rule in the system prompt', async () => {
    const t = setup(createBuiltinRegistry(), [[text('done')]]);
    await t.run();
    const request = t.provider.requests[0];
    expect(names(request)).toEqual([
      'read_file',
      'list_directory',
      'find_files',
      'search_files',
      'get_workspace_info',
      'get_active_editor_context',
      'write_file',
      'edit_file',
      'apply_diff',
      'execute_terminal',
      LOAD_TOOLS,
    ]);
    const load = request?.tools?.at(-1)?.function.parameters as { properties: { units: { items: { enum: string[] } } } };
    expect(load.properties.units.items.enum).toEqual(['diagnostics', 'symbols', 'web', 'git', 'git.changes', 'git.remote']);
    expect(system(request)).toContain('call load_tools with the units you need');
    expect(t.session.toolUnits).toEqual([]);
  });

  it('loads units for the next request and appends their tools, keeping the earlier prefix', async () => {
    const t = setup(createBuiltinRegistry(), [[call(0, LOAD_TOOLS, { units: ['git.changes'] })], [text('done')]]);
    await t.run();
    const [first, second] = t.provider.requests;
    expect(names(second).slice(0, names(first).length)).toEqual(names(first));
    expect(second?.tools?.slice(0, first?.tools?.length)).toEqual(first?.tools);
    expect(system(second)).toBe(system(first));
    expect(names(second).slice(names(first).length)).toEqual([
      'git_status',
      'git_diff',
      'git_log',
      'git_show',
      'git_branches',
      'git_stage',
      'git_unstage',
      'git_commit',
    ]);
    expect(t.session.toolUnits).toEqual(['git', 'git.changes']);
    expect(tools(t.session)[0]).toMatchObject({
      status: 'success',
      loaded: ['git', 'git.changes'],
      content: expect.stringMatching(/^Loaded git, git\.changes: git_status, .*git_commit\. Use them from your next step\.$/),
    });
    expect(t.events).toContainEqual({ type: 'tools_loaded', units: ['git', 'git.changes'], reason: 'model' });
  });

  it('keeps the system prompt and tools identical between steps that load nothing', async () => {
    const t = setup(createBuiltinRegistry(), [[call(0, 'list_directory', { path: '.' })], [text('done')]]);
    await t.run();
    const [first, second] = t.provider.requests;
    expect(second?.tools).toEqual(first?.tools);
    expect(system(second)).toBe(system(first));
  });

  it('loads the unit of a tool called before it was loaded, without running it, then runs it next time', async () => {
    const { registry } = fakeRegistry();
    const gitRead = registry.get('git_read')!;
    const t = setup(registry, [
      [call(0, 'git_read', { path: 'a' }), call(1, 'git_read', { path: 'b' })],
      [call(0, 'git_read', { path: 'a' }, 'c2')],
      [text('done')],
    ]);
    await t.run();
    const results = tools(t.session);
    expect(results.slice(0, 2).map((r) => [r.status, r.loaded])).toEqual([
      ['success', ['git']],
      ['success', ['git']],
    ]);
    expect(results[0]?.content).toBe(
      'git_read was not loaded yet, so it did not run. Sovran loaded git: call git_read again with the same arguments.',
    );
    expect(gitRead.execute).toHaveBeenCalledTimes(1);
    expect(results[2]).toMatchObject({ status: 'success', content: 'git_read ran' });
    expect(names(t.provider.requests[1])).toContain('git_read');
    expect(t.events.filter((e) => e.type === 'tools_loaded')).toEqual([
      { type: 'tools_loaded', units: ['git'], reason: 'call' },
    ]);
  });

  it('loads Git reads with Git writes when a write tool is called first', async () => {
    const { registry } = fakeRegistry();
    const t = setup(registry, [[call(0, 'git_write', {})], [text('done')]]);
    await t.run();
    expect(tools(t.session)[0]?.loaded).toEqual(['git', 'git.changes']);
    expect(names(t.provider.requests[1])).toEqual(['probe', 'write_probe', LOAD_TOOLS, 'git_read', 'git_write']);
  });

  it('never loads a tool the chat excludes, the user disabled or Plan mode forbids', async () => {
    const excluded = fakeRegistry();
    const a = setup(excluded.registry, [[call(0, 'git_read', {})], [text('done')]], newSession({ excludedToolGroups: ['git'] }));
    await a.run();
    expect(tools(a.session)[0]).toMatchObject({ status: 'denied' });
    expect(a.session.toolUnits).toEqual([]);

    const disabled = fakeRegistry();
    const b = setup(disabled.registry, [[call(0, 'git_read', {})], [text('done')]]);
    await b.run({ settings: { ...auto, policy: { ...auto.policy, disabledTools: ['git_read'] } } });
    expect(tools(b.session)[0]).toMatchObject({ status: 'denied' });
    expect(b.session.toolUnits).toEqual([]);
    expect(disabled.registry.get('git_read')!.execute).not.toHaveBeenCalled();

    const plan = fakeRegistry();
    const c = setup(plan.registry, [[call(0, 'git_write', {})], [text('done')]]);
    await c.run({ mode: 'plan' });
    expect(tools(c.session)[0]).toMatchObject({ status: 'denied', content: expect.stringContaining('Plan mode') });
    expect(c.session.toolUnits).toEqual([]);
    const load = c.provider.requests[0]?.tools?.find((tool) => tool.function.name === LOAD_TOOLS);
    expect((load?.function.parameters as { properties: { units: { items: { enum: string[] } } } }).properties.units.items.enum).toEqual(['git']);
  });

  it('leaves the MCP policy in charge once an MCP server is loaded', async () => {
    const { registry, mcp } = fakeRegistry();
    const t = setup(registry, [[call(0, LOAD_TOOLS, { units: ['mcp:docs'] })], [call(0, mcp.name, {}, 'c2')], [text('done')]]);
    await t.run();
    // Loading needs no approval; the MCP call itself still asks, even in Auto mode.
    expect(tools(t.session)[0]).toMatchObject({ status: 'success', loaded: ['mcp:docs'] });
    expect(names(t.provider.requests[1])).toContain(mcp.name);
    expect(tools(t.session)[1]?.status).toBe('success');
    expect(mcp.execute).toHaveBeenCalledTimes(1);
  });

  it('points an unknown tool to load_tools and rejects bad load requests', async () => {
    const { registry } = fakeRegistry();
    const t = setup(registry, [
      [call(0, 'shell', {}), call(1, LOAD_TOOLS, { units: ['shell'] }), call(2, LOAD_TOOLS, '{units')],
      [text('done')],
    ]);
    await t.run();
    const [unknown, bad, invalid] = tools(t.session);
    expect(unknown).toMatchObject({ status: 'error' });
    expect(unknown?.content).toBe(
      'Unknown tool "shell". Available tools: probe, write_probe, load_tools. More tools load with load_tools: git, git.changes, mcp:docs.',
    );
    expect(bad).toMatchObject({ status: 'error', content: 'Unknown unit "shell". Units you can load: git, git.changes, mcp:docs.' });
    expect(invalid).toMatchObject({ status: 'error', content: expect.stringContaining('not valid JSON') });
    expect(t.session.toolUnits).toEqual([]);
  });

  it('reports a unit that is already loaded', async () => {
    const { registry } = fakeRegistry();
    const t = setup(registry, [[call(0, LOAD_TOOLS, { units: 'git' })], [text('done')]], newSession({ toolUnits: ['git'] }));
    await t.run();
    expect(tools(t.session)[0]).toMatchObject({ status: 'success', content: 'Already loaded: git (git_read).' });
    expect(t.events.some((e) => e.type === 'tools_loaded')).toBe(false);
  });

  it('treats load_tools as an unknown tool when nothing is deferred', async () => {
    const t = setup(fakeRegistry().registry, [[call(0, LOAD_TOOLS, { units: ['git'] })], [text('done')]]);
    await t.run({ settings });
    expect(tools(t.session)[0]).toMatchObject({ status: 'error', content: expect.stringContaining('Unknown tool "load_tools"') });
  });

  it('starts an older chat with the units of the tools it already called', async () => {
    const session = newSession({
      messages: [
        { role: 'user', id: 'u', content: 'status?', createdAt: 0 },
        {
          role: 'assistant',
          id: 'a',
          content: '',
          toolCalls: [
            { id: 'x', name: 'git_write', arguments: '{}' },
            { id: 'y', name: 'probe', arguments: '{}' },
          ],
          createdAt: 0,
        },
        { role: 'tool', id: 't1', toolCallId: 'x', toolName: 'git_write', content: 'ok', status: 'success', createdAt: 0 },
        { role: 'tool', id: 't2', toolCallId: 'y', toolName: 'probe', content: 'ok', status: 'success', createdAt: 0 },
        { role: 'assistant', id: 'b', content: 'Done.', createdAt: 0 },
        { role: 'user', id: 'u2', content: 'thanks', createdAt: 0 },
      ],
    });
    const t = setup(fakeRegistry().registry, [[text('done')]], session);
    await t.run();
    expect(session.toolUnits).toEqual(['git', 'git.changes']);
    expect(names(t.provider.requests[0])).toEqual(['probe', 'write_probe', LOAD_TOOLS, 'git_read', 'git_write']);
    expect(t.events).toContainEqual({ type: 'tools_loaded', units: ['git', 'git.changes'], reason: 'history' });
  });

  it('lists load_tools in prompted instructions and loads from a tool_call block', async () => {
    const { registry } = fakeRegistry();
    const t = setup(registry, [
      [text('<tool_call>\n{"name": "load_tools", "arguments": {"units": ["git"]}}\n</tool_call>')],
      [text('done')],
    ]);
    await t.run({ model: { ...small, toolMode: 'prompted' } });
    const [first, second] = t.provider.requests;
    expect(first?.tools).toBeUndefined();
    expect(system(first)).toContain('## load_tools');
    expect(system(first)).not.toContain('## git_read');
    expect(system(second)).toContain('## git_read');
    expect(t.session.toolUnits).toEqual(['git']);
  });

  it('prepares nothing for a model without tools', async () => {
    const t = setup(fakeRegistry().registry, [[text('done')]]);
    await t.run({ model: { ...small, toolMode: 'none' } });
    expect(t.session.toolUnits).toBeUndefined();
    expect(t.provider.requests[0]?.tools).toBeUndefined();
  });
});
