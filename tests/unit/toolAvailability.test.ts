import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AgentRunner, type AgentSettings, type RunOptions } from '../../src/core/agent/agentRunner';
import type { PolicySettings } from '../../src/core/permissions/policy';
import { nullLogger } from '../../src/core/ports';
import { MemoryCapabilityStore } from '../../src/core/providers/capabilities';
import type { Session, ToolMessage } from '../../src/core/sessions/model';
import { ToolRegistry } from '../../src/core/tools/registry';
import { defineTool, type AnyTool } from '../../src/core/tools/types';
import { settingUpdateSchema } from '../../src/shared/protocol';
import {
  FakeProcess,
  MemoryWorkspace,
  ScriptedApprovals,
  ScriptedProvider,
  call,
  text,
} from '../fixtures/fakes';

const settings: AgentSettings = {
  maxIterations: 3,
  policy: { approvalMode: 'auto', allowedCommands: [], protectedPaths: [] },
  tools: { terminalTimeoutMs: 1000, maxToolResultChars: 2000, protectedPaths: [] },
  defaultContextWindow: 32768,
  defaultMaxOutputTokens: 4096,
};

function fixture(overrides: Partial<AnyTool> = {}) {
  const prepare = vi.fn(async () => ({ paths: [] }));
  const execute = vi.fn(async () => ({ content: 'executed' }));
  const tool = defineTool({
    name: 'probe',
    description: 'Test tool',
    risk: 'read',
    schema: z.object({}),
    label: () => 'Probe',
    prepare,
    execute,
    ...overrides,
  });
  const registry = new ToolRegistry().register(tool);
  const workspace = new MemoryWorkspace();
  const session: Session = { id: 's', title: 'Test', createdAt: 0, updatedAt: 0, mode: 'act', messages: [] };
  let policy: PolicySettings = { ...settings.policy };
  let onRequest = () => {};
  let onApproval = () => {};
  const provider = new ScriptedProvider([
    () => {
      onRequest();
      return [call(0, 'probe', {})];
    },
    [text('done')],
  ]);
  const approvals = new ScriptedApprovals(() => {
    onApproval();
    return { approved: true };
  });
  const runner = new AgentRunner({
    registry,
    provider,
    workspace,
    process: new FakeProcess(),
    approvals,
    capabilities: new MemoryCapabilityStore(),
    logger: nullLogger,
  });
  return {
    registry,
    workspace,
    provider,
    approvals,
    prepare,
    execute,
    tool,
    session,
    policy: (next: Partial<PolicySettings>) => {
      policy = { ...policy, ...next };
    },
    onRequest: (fn: () => void) => {
      onRequest = fn;
    },
    onApproval: (fn: () => void) => {
      onApproval = fn;
    },
    run: (options: Partial<RunOptions> = {}) =>
      runner.run({
        session,
        providerId: 'p',
        model: { id: 'm' },
        mode: 'act',
        settings,
        grants: { edits: false },
        signal: new AbortController().signal,
        emit: () => {},
        policy: () => policy,
        ...options,
      }),
    result: () => session.messages.find((m): m is ToolMessage => m.role === 'tool')!,
  };
}

describe('tool availability at model request and dispatch', () => {
  it.each(['native', 'prompted'] as const)(
    'excludes chat groups from %s requests and rejects guessed calls',
    async (toolMode) => {
      const t = fixture({ group: 'git' });
      t.session.excludedToolGroups = ['git'];
      const provider = new ScriptedProvider([
        toolMode === 'native'
          ? [call(0, 'probe', {})]
          : [text('<tool_call>{"name":"probe","arguments":{}}</tool_call>')],
        [text('done')],
      ]);
      const runner = new AgentRunner({
        registry: t.registry,
        provider,
        workspace: t.workspace,
        process: new FakeProcess(),
        approvals: t.approvals,
        capabilities: new MemoryCapabilityStore(),
        logger: nullLogger,
      });
      await runner.run({
        session: t.session,
        providerId: 'p',
        model: { id: 'm', toolMode },
        mode: 'act',
        settings,
        grants: { edits: false },
        signal: new AbortController().signal,
        emit() {},
      });
      expect(provider.requests[0]!.tools).toBeUndefined();
      expect(t.prepare).not.toHaveBeenCalled();
      expect(t.execute).not.toHaveBeenCalled();
      expect(t.result().status).toBe('denied');
    },
  );
  it('rechecks a chat group changed during approval', async () => {
    const t = fixture({
      group: 'mcp:browser',
      source: { kind: 'mcp', serverId: 'browser' },
      risk: 'execute',
    });
    t.policy({ approvalMode: 'ask' });
    t.onApproval(() => {
      t.session.excludedToolGroups = ['mcp:browser'];
    });
    await t.run();
    expect(t.approvals.requests).toHaveLength(1);
    expect(t.execute).not.toHaveBeenCalled();
    expect(t.result().content).toContain('excluded from this chat');
  });
  it('blocks a newly excluded MCP group even when its tool is set to Allow', async () => {
    const t = fixture({
      group: 'mcp:browser',
      source: { kind: 'mcp', serverId: 'browser' },
      risk: 'execute',
      mcpPolicy: () => ({ server: 'Browser', allowed: true }),
    });
    t.onRequest(() => {
      t.session.excludedToolGroups = ['mcp:browser'];
    });
    await t.run();
    expect(t.execute).not.toHaveBeenCalled();
    expect(t.approvals.requests).toHaveLength(0);
    expect(t.result().status).toBe('denied');
  });
  it('blocks disabled tools guessed by the model before prepare', async () => {
    const t = fixture();
    t.policy({ disabledTools: ['probe'] });
    await t.run();
    expect(t.provider.requests[0]!.tools).toBeUndefined();
    expect(t.prepare).not.toHaveBeenCalled();
    expect(t.execute).not.toHaveBeenCalled();
    expect(t.result().status).toBe('denied');
  });

  it('does not accept a tool enabled only after the model request', async () => {
    const t = fixture();
    t.policy({ disabledTools: ['probe'] });
    t.onRequest(() => t.policy({ disabledTools: [] }));
    await t.run();
    expect(t.prepare).not.toHaveBeenCalled();
    expect(t.result().content).toContain('not offered');
  });

  it('blocks a tool disabled during streaming', async () => {
    const t = fixture();
    t.onRequest(() => t.policy({ disabledTools: ['probe'] }));
    await t.run();
    expect(t.prepare).not.toHaveBeenCalled();
    expect(t.result().status).toBe('denied');
  });

  it.each(['native', 'prompted'] as const)('enforces offered definitions in %s mode', async (toolMode) => {
    const t = fixture();
    // Swap a source definition after the request, retaining the same name.
    let dynamic: AnyTool = { ...t.tool };
    const registry = new ToolRegistry().addSource({ tools: () => [dynamic] });
    const provider = new ScriptedProvider([
      () => {
        dynamic = { ...dynamic, description: 'Changed schema or implementation' };
        return toolMode === 'native'
          ? [call(0, 'probe', {})]
          : [text('<tool_call>{"name":"probe","arguments":{}}</tool_call>')];
      },
      [text('done')],
    ]);
    const runner = new AgentRunner({
      registry,
      provider,
      workspace: t.workspace,
      process: new FakeProcess(),
      approvals: t.approvals,
      capabilities: new MemoryCapabilityStore(),
      logger: nullLogger,
    });
    await runner.run({
      session: t.session,
      providerId: 'p',
      model: { id: 'm', toolMode },
      mode: 'act',
      settings,
      grants: { edits: false },
      signal: new AbortController().signal,
      emit: () => {},
    });
    expect(t.prepare).not.toHaveBeenCalled();
    expect(t.result().status).toBe('denied');
  });

  it('forces approval for reads even in Auto and Plan', async () => {
    const t = fixture();
    t.policy({ forceAskTools: ['probe'] });
    await t.run({ mode: 'plan' });
    expect(t.approvals.requests).toHaveLength(1);
    expect(t.execute).toHaveBeenCalledOnce();
  });

  it('cannot use force-Ask to authorize a write in Plan', async () => {
    const t = fixture({ risk: 'write' });
    t.policy({ forceAskTools: ['probe'] });
    await t.run({ mode: 'plan' });
    expect(t.prepare).not.toHaveBeenCalled();
    expect(t.approvals.requests).toHaveLength(0);
    expect(t.result().status).toBe('denied');
  });

  it.each(['disable', 'trust'] as const)('rechecks %s after approval', async (change) => {
    const t = fixture({ risk: 'write' });
    t.policy({ approvalMode: 'ask' });
    t.onApproval(() => {
      if (change === 'disable') t.policy({ disabledTools: ['probe'] });
      else t.workspace.trusted = false;
    });
    await t.run();
    expect(t.approvals.requests).toHaveLength(1);
    expect(t.execute).not.toHaveBeenCalled();
    expect(t.result().status).toBe('denied');
  });

  it('does not prepare trusted reads in Restricted Mode', async () => {
    const t = fixture({ requiresTrust: true });
    t.workspace.trusted = false;
    await t.run({ mode: 'plan' });
    expect(t.prepare).not.toHaveBeenCalled();
    expect(t.execute).not.toHaveBeenCalled();
  });

  it('rechecks protected command paths when rules change before dispatch', async () => {
    const t = fixture({ risk: 'execute', prepare: async () => ({ paths: [], command: 'cat secrets.txt' }) });
    await t.run({
      emit: (event) => {
        if (event.type === 'tool_phase' && event.phase === 'running')
          t.policy({ protectedPaths: ['**/secrets.txt'] });
      },
    });
    expect(t.execute).not.toHaveBeenCalled();
    expect(t.result().status).toBe('denied');
  });

  it('provides a live execution check for a tool delayed after its initial dispatch', async () => {
    const effect = vi.fn();
    const t = fixture({
      risk: 'execute',
      execute: async (_args, ctx) => {
        await Promise.resolve();
        t.policy({ disabledTools: ['probe'] });
        ctx.revalidate?.();
        effect();
        return { content: 'changed' };
      },
    });
    await t.run();
    expect(effect).not.toHaveBeenCalled();
    expect(t.result().content).toContain('disabled');
  });

  it('checks cancellation immediately before dispatch', async () => {
    const t = fixture();
    const abort = new AbortController();
    await t.run({
      signal: abort.signal,
      emit: (event) => {
        if (event.type === 'tool_phase' && event.phase === 'running') abort.abort();
      },
    });
    expect(t.execute).not.toHaveBeenCalled();
    expect(t.result().status).toBe('cancelled');
  });

  it('blocks newly required approval immediately before dispatch', async () => {
    const t = fixture();
    await t.run({
      emit: (event) => {
        if (event.type === 'tool_phase' && event.phase === 'running') t.policy({ forceAskTools: ['probe'] });
      },
    });
    expect(t.execute).not.toHaveBeenCalled();
    expect(t.result().content).toContain('Permissions changed');
  });
});

describe('registry source boundaries', () => {
  it('rejects collisions between sources and preserves native names', () => {
    const t = fixture();
    const duplicate = { ...t.tool, name: 'external' };
    t.registry.addSource({ tools: () => [t.tool, duplicate] }).addSource({ tools: () => [duplicate] });
    expect(t.registry.get('probe')).toBe(t.tool);
    expect(t.registry.get('external')).toBeUndefined();
    expect(t.registry.list('act').map((tool) => tool.name)).toEqual(['probe']);
  });

  it('does not reuse a schema cached for an older dynamic definition with the same name', () => {
    const t = fixture();
    const old = { ...t.tool, schema: z.object({ old: z.string() }) };
    const next = { ...t.tool, schema: z.object({ next: z.number() }) };
    expect(t.registry.schema(old).function.parameters.properties).toHaveProperty('old');
    expect(t.registry.schema(next).function.parameters.properties).toHaveProperty('next');
  });

  it('validates native override settings at the host boundary', () => {
    expect(settingUpdateSchema.safeParse({ key: 'tools.disabled', value: ['read_file'] }).success).toBe(true);
    expect(settingUpdateSchema.safeParse({ key: 'tools.forceAsk', value: ['../oops'] }).success).toBe(false);
  });
});
