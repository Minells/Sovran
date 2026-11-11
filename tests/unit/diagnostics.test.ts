import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AgentRunner, type AgentSettings } from '../../src/core/agent/agentRunner';
import { CheckpointRecorder } from '../../src/core/checkpoints/checkpoints';
import type { PolicySettings } from '../../src/core/permissions/policy';
import { nullLogger, type FileDiagnostics } from '../../src/core/ports';
import { MemoryCapabilityStore } from '../../src/core/providers/capabilities';
import type { Session, ToolMessage } from '../../src/core/sessions/model';
import { createBuiltinRegistry } from '../../src/core/tools/builtin';
import { diagnosticsTool } from '../../src/core/tools/builtin/diagnosticsTool';
import type { ToolContext } from '../../src/core/tools/types';
import {
  call,
  FakeProcess,
  MemoryWorkspace,
  ScriptedApprovals,
  ScriptedProvider,
  text,
} from '../fixtures/fakes';

class DiagnosticWorkspace extends MemoryWorkspace {
  entries: FileDiagnostics[] = [];
  diagnostics(absPath?: string): FileDiagnostics[] {
    return this.entries.filter((e) => absPath === undefined || e.path === absPath);
  }
  add(file: string, message: string, severity: 'error' | 'warning' | 'info' | 'hint' = 'error', line = 1) {
    this.entries.push({ path: this.abs(file), diagnostics: [{ message, severity, line, source: 'test' }] });
  }
}

function fixture() {
  const ws = new DiagnosticWorkspace({ 'src/a.ts': '', 'src/b.ts': '', '.env': '', 'lib/c.ts': '' });
  ws.add('src/a.ts', 'Active problem', 'error', 3);
  ws.add('src/b.ts', 'Unopened problem', 'warning', 8);
  ws.add('.env', 'SECRET');
  ws.add('lib/c.ts', 'Other folder');
  ws.active = {
    path: ws.abs('src/a.ts'),
    languageId: 'typescript',
    isDirty: true,
    lineCount: 10,
    diagnostics: [],
  };
  const ctx: ToolContext = {
    workspace: ws,
    process: new FakeProcess(),
    signal: new AbortController().signal,
    settings: { maxToolResultChars: 2000, terminalTimeoutMs: 1000, protectedPaths: ['**/.env'] },
  };
  const read = (args: unknown = {}) =>
    diagnosticsTool.execute(diagnosticsTool.schema.parse(args), ctx, { paths: [] });
  return { ws, ctx, read };
}

describe('cached workspace diagnostics', () => {
  it('returns cached active and unopened-file diagnostics without reading files or spawning processes', async () => {
    const { ws, ctx, read } = fixture();
    const readFile = vi.spyOn(ws, 'readFile');
    const findFiles = vi.spyOn(ws, 'findFiles');
    const result = await read();
    expect(result.content).toContain('"src/a.ts":3: error: "Active problem" ("test")');
    expect(result.content).toContain('"src/b.ts":8: warning: "Unopened problem"');
    expect(result.content).toContain('no analysis was run');
    expect(result.content).not.toContain('SECRET');
    expect(readFile).not.toHaveBeenCalled();
    expect(findFiles).not.toHaveBeenCalled();
    expect((ctx.process as FakeProcess).commands).toEqual([]);
  });

  it('selects the active document cache, including dirty buffers, rather than only activeEditor diagnostics', async () => {
    const { read } = fixture();
    const result = await read({ scope: 'active' });
    expect(result.content).toContain('Active problem');
    expect(result.content).not.toContain('Unopened problem');
  });

  it('reports no active file and unsupported hosts clearly', async () => {
    const { ws, ctx, read } = fixture();
    ws.active = null;
    expect((await read({ scope: 'active' })).content).toBe('No active file editor.');
    ctx.workspace = new MemoryWorkspace();
    await expect(read()).rejects.toThrow(/does not support/);
  });

  it('does not claim that an empty cache proves there are no problems', async () => {
    const { ws, read } = fixture();
    ws.entries = [];
    expect((await read()).content).toContain('No matching cached diagnostics');
    expect((await read()).content).toContain('Only diagnostics already reported');
  });

  it('filters a literal directory or exact file and avoids sibling prefixes', async () => {
    const { ws, read } = fixture();
    ws.set('src-other/a.ts', '');
    ws.add('src-other/a.ts', 'Sibling');
    const directory = await read({ path: 'src' });
    expect(directory.content).toContain('Active problem');
    expect(directory.content).toContain('Unopened problem');
    expect(directory.content).not.toMatch(/Other folder|Sibling/);
    const file = await read({ path: 'src/a.ts' });
    expect(file.content).toContain('Active problem');
    expect(file.content).not.toContain('Unopened problem');
  });

  it.each(['error', 'warning', 'info', 'hint'] as const)('filters %s exactly', async (severity) => {
    const { ws, read } = fixture();
    ws.entries = [];
    for (const s of ['error', 'warning', 'info', 'hint'] as const) ws.add('src/a.ts', `${s} message`, s);
    const result = await read({ severity });
    expect(result.summary).toBe('1 cached diagnostic(s)');
    expect(result.content).toContain(`${severity} message`);
  });

  it('caps result count after filtering and marks only actual truncation', async () => {
    const { read } = fixture();
    const result = await read({ max_results: 1, severity: 'error' });
    expect(result.summary).toBe('1 cached diagnostic(s) (limited)');
    expect((await read({ max_results: 1, severity: 'warning' })).summary).toBe('1 cached diagnostic(s)');
  });

  it('bounds long diagnostic content and quotes embedded newlines', async () => {
    const { ws, read, ctx } = fixture();
    ws.entries = [];
    ws.add('src/a.ts', 'message\nwith\nnewlines');
    expect((await read()).content).toContain('"message\\nwith\\nnewlines"');
    ws.add('src/a.ts', 'x'.repeat(100_000));
    const result = await read();
    expect(result.content.length).toBeLessThanOrEqual(ctx.settings.maxToolResultChars);
    expect(result.content).toContain('Results limited');
  });

  it('rejects invalid/contradictory arguments and external selectors before querying the cache', async () => {
    const { ws, read } = fixture();
    const snapshot = vi.spyOn(ws, 'diagnostics');
    for (const args of [
      { max_results: 0 },
      { max_results: 501 },
      { severity: 'fatal' },
      { path: ' ' },
      { extra: true },
    ]) {
      expect(diagnosticsTool.schema.safeParse(args).success).toBe(false);
    }
    await expect(read({ scope: 'active', path: 'src' })).rejects.toThrow(/either/);
    await expect(read({ path: '../outside' })).rejects.toThrow(/escapes/);
    expect(snapshot).not.toHaveBeenCalled();
  });

  it('omits external and broken-link diagnostics without exposing their messages or paths', async () => {
    const { ws, read } = fixture();
    ws.add('../outside.ts', 'OUTSIDE');
    ws.broken.add(ws.abs('broken.ts'));
    ws.add('broken.ts', 'BROKEN');
    const result = await read();
    expect(result.content).not.toMatch(/OUTSIDE|BROKEN|outside.ts|broken.ts/);
  });

  it('omits explicitly selected protected files too', async () => {
    const { read } = fixture();
    expect((await read({ path: '.env' })).content).not.toContain('SECRET');
  });

  it('checks real paths for external links and aliases to protected workspace files', async () => {
    const { ws, read } = fixture();
    ws.set('external.ts', '');
    ws.links.set(ws.abs('external.ts'), path.resolve('/elsewhere/file.ts'));
    ws.add('external.ts', 'EXTERNAL LINK');
    ws.set('alias.ts', '');
    ws.links.set(ws.abs('alias.ts'), ws.abs('.env'));
    ws.add('alias.ts', 'ALIASED SECRET');
    const result = await read();
    expect(result.content).not.toMatch(/EXTERNAL LINK|ALIASED SECRET/);
    await expect(read({ path: 'external.ts' })).rejects.toThrow(/symbolic link/);
  });

  it('handles missing unsaved files, root symlinks and protected directory aliases', async () => {
    const { ws, read, ctx } = fixture();
    ws.links.set(ws.root, path.resolve('/real-project'));
    ws.add('new.ts', 'Not saved yet');
    expect((await read({ path: 'new.ts' })).content).toContain('Not saved yet');
    // Use a workspace without a root alias so MemoryWorkspace can represent a second symlink.
    ws.links.clear();
    ws.dirs.add(ws.abs('alias'));
    ws.links.set(ws.abs('alias'), ws.abs('private'));
    ctx.settings.protectedPaths = ['private/**'];
    ws.add('alias/new.ts', 'NEW SECRET');
    expect((await read()).content).not.toContain('NEW SECRET');
  });

  it('labels all roots, supports root-name selection and honors root-local protected patterns', async () => {
    const { ws, read, ctx } = fixture();
    const second = ws.abs('../ws-two');
    ws.roots = () => [
      { name: 'one', path: ws.root },
      { name: 'two', path: second },
    ];
    ws.dirs.add(second);
    ws.set('../ws-two/app.ts', '');
    ws.set('../ws-two/private.ts', '');
    ws.add('../ws-two/app.ts', 'SECOND');
    ws.add('../ws-two/private.ts', 'PRIVATE');
    ctx.settings.protectedPaths = ['**/.env', 'private.ts'];
    const result = await read({ path: 'two' });
    expect(result.content).toContain('"two/app.ts":1: error: "SECOND"');
    expect((await read()).content).toContain('"one/src/a.ts"');
    expect(result.content).not.toContain('Active problem');
    expect(result.content).not.toContain('PRIVATE');
  });

  it('passes the optional capability through checkpoints with its receiver and no file snapshot', async () => {
    const { ws, ctx, read } = fixture();
    const recorder = new CheckpointRecorder(ws);
    ctx.workspace = recorder;
    expect((await read()).content).toContain('Unopened problem');
    expect(recorder.changedFiles()).toEqual([]);
    expect(new CheckpointRecorder(new MemoryWorkspace()).diagnostics).toBeUndefined();
  });

  it('stops on cancellation or late revocation while verifying paths', async () => {
    const { ctx, read } = fixture();
    const abort = new AbortController();
    ctx.signal = abort.signal;
    abort.abort();
    await expect(read()).rejects.toThrow(/Cancelled/);
    ctx.signal = new AbortController().signal;
    ctx.revalidate = vi
      .fn()
      .mockImplementationOnce(() => {})
      .mockImplementation(() => {
        throw new Error('disabled');
      });
    await expect(read()).rejects.toThrow(/disabled/);
  });
});

describe('diagnostics in the agent pipeline', () => {
  it.each(['disabled', 'reject', 'revoke', 'cancel', 'protect'] as const)(
    'honors %s before reading diagnostic contents',
    async (action) => {
      const { ws, ctx } = fixture();
      const snapshot = vi.spyOn(ws, 'diagnostics');
      const abort = new AbortController();
      const policy: PolicySettings = {
        approvalMode: 'auto',
        allowedCommands: [],
        protectedPaths: ctx.settings.protectedPaths,
        forceAskTools: ['get_diagnostics'],
        disabledTools: action === 'disabled' ? ['get_diagnostics'] : [],
      };
      const approvals = new ScriptedApprovals(() => {
        expect(snapshot).not.toHaveBeenCalled();
        if (action === 'revoke') policy.disabledTools = ['get_diagnostics'];
        if (action === 'cancel') abort.abort();
        if (action === 'protect') policy.protectedPaths = ['**/.env', '**/src/b.ts'];
        return { approved: action !== 'reject' };
      });
      const session: Session = {
        id: 's',
        title: 'Test',
        createdAt: 0,
        updatedAt: 0,
        mode: 'plan',
        messages: [],
      };
      const runner = new AgentRunner({
        registry: createBuiltinRegistry(),
        provider: new ScriptedProvider([[call(0, 'get_diagnostics', {})], [text('done')]]),
        workspace: new CheckpointRecorder(ws),
        process: ctx.process,
        approvals,
        capabilities: new MemoryCapabilityStore(),
        logger: nullLogger,
      });
      const settings: AgentSettings = {
        maxIterations: 3,
        policy,
        tools: ctx.settings,
        defaultContextWindow: 32768,
        defaultMaxOutputTokens: 4096,
      };
      await runner.run({
        session,
        providerId: 'p',
        model: { id: 'm' },
        mode: 'plan',
        settings,
        policy: () => policy,
        grants: { edits: false },
        signal: abort.signal,
        emit: () => {},
      });
      const result = session.messages.find((m): m is ToolMessage => m.role === 'tool')!;
      expect(result.content).not.toContain('Unopened problem');
      if (action === 'protect') {
        expect(snapshot).toHaveBeenCalledOnce();
        expect(result.status).toBe('success');
      } else {
        expect(snapshot).not.toHaveBeenCalled();
        expect(result.status).toBe(action === 'cancel' ? 'cancelled' : 'denied');
      }
    },
  );

  it.each(['plan', 'act'] as const)(
    'works in %s through the built-in registry and checkpoint decorator',
    async (mode) => {
      const { ws, ctx } = fixture();
      // Cached read-only access stays useful in Restricted Mode too.
      ws.trusted = false;
      const registry = createBuiltinRegistry();
      const provider = new ScriptedProvider([
        [call(0, 'get_diagnostics', { severity: 'warning' })],
        [text('done')],
      ]);
      const approvals = new ScriptedApprovals();
      const session: Session = { id: 's', title: 'Test', createdAt: 0, updatedAt: 0, mode, messages: [] };
      const settings: AgentSettings = {
        maxIterations: 3,
        policy: { approvalMode: 'auto', allowedCommands: [], protectedPaths: ctx.settings.protectedPaths },
        tools: ctx.settings,
        defaultContextWindow: 32768,
        defaultMaxOutputTokens: 4096,
      };
      const runner = new AgentRunner({
        registry,
        provider,
        workspace: new CheckpointRecorder(ws),
        process: ctx.process,
        approvals,
        capabilities: new MemoryCapabilityStore(),
        logger: nullLogger,
      });
      await runner.run({
        session,
        providerId: 'p',
        model: { id: 'm' },
        mode,
        settings,
        grants: { edits: false },
        signal: ctx.signal,
        emit: () => {},
      });
      const result = session.messages.find((m): m is ToolMessage => m.role === 'tool')!;
      expect(result.status).toBe('success');
      expect(result.content).toContain('Unopened problem');
      expect(approvals.requests).toEqual([]);
      expect(registry.get('get_diagnostics')).toMatchObject({ group: 'context', source: { kind: 'native' } });
    },
  );
});
