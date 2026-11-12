import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentRunner, type AgentSettings } from '../../src/core/agent/agentRunner';
import { CheckpointRecorder } from '../../src/core/checkpoints/checkpoints';
import { nullLogger, type SemanticLocation, type SemanticQuery } from '../../src/core/ports';
import { MemoryCapabilityStore } from '../../src/core/providers/capabilities';
import type { Session, ToolMessage } from '../../src/core/sessions/model';
import { createBuiltinRegistry } from '../../src/core/tools/builtin';
import {
  definitionTool,
  documentSymbolsTool,
  referencesTool,
} from '../../src/core/tools/builtin/semanticTools';
import type { AnyTool, ToolContext } from '../../src/core/tools/types';
import { querySemantic } from '../../src/extension/adapters/VscodeSemanticNavigation';
import {
  call,
  FakeProcess,
  MemoryWorkspace,
  ScriptedApprovals,
  ScriptedProvider,
  text,
} from '../fixtures/fakes';

const vscode = vi.hoisted(() => ({
  trusted: true,
  command: vi.fn(),
  open: vi.fn(),
  file: (fsPath: string) => ({ scheme: 'file', fsPath }),
}));

vi.mock('vscode', () => ({
  workspace: {
    get isTrusted() {
      return vscode.trusted;
    },
    openTextDocument: vscode.open,
  },
  commands: { executeCommand: vscode.command },
  Uri: { file: vscode.file },
  Position: class Position {
    constructor(
      readonly line: number,
      readonly character: number,
    ) {}
  },
}));

afterEach(() => {
  vscode.trusted = true;
  vscode.command.mockReset();
  vscode.open.mockReset();
  vi.restoreAllMocks();
});

class SemanticWorkspace extends MemoryWorkspace {
  locations: SemanticLocation[] = [];
  querySemantic = vi.fn(
    async (_query: SemanticQuery, _signal: AbortSignal): Promise<Iterable<SemanticLocation>> =>
      this.locations,
  );
}

function fixture() {
  const workspace = new SemanticWorkspace({ 'src/app.ts': '', 'src/util.ts': '', '.env': '' });
  const ctx: ToolContext = {
    workspace,
    process: new FakeProcess(),
    signal: new AbortController().signal,
    settings: { protectedPaths: ['**/.env'], terminalTimeoutMs: 1000, maxToolResultChars: 2000 },
  };
  const run = (tool: AnyTool, args: unknown) => tool.execute(tool.schema.parse(args), ctx, { paths: [] });
  return { workspace, ctx, run };
}

const position = { path: 'src/app.ts', line: 2, column: 3 };

describe('native semantic navigation', () => {
  it('resolves files for the provider and quotes returned symbols', async () => {
    const { workspace, ctx, run } = fixture();
    workspace.locations = [{ path: workspace.abs('src/app.ts'), line: 2, column: 3, name: 'Format\nDate' }];
    expect((await run(documentSymbolsTool, { path: 'src/app.ts' })).content).toBe(
      '"src/app.ts":2:3 "Format\\nDate"',
    );
    expect(workspace.querySemantic).toHaveBeenCalledWith(
      { kind: 'symbols', path: workspace.abs('src/app.ts') },
      ctx.signal,
    );
    workspace.locations = [{ path: workspace.abs('src/util.ts'), line: 4, column: 7 }];
    expect((await run(definitionTool, position)).content).toBe('"src/util.ts":4:7');
    expect(workspace.querySemantic).toHaveBeenLastCalledWith(
      { kind: 'definition', path: workspace.abs('src/app.ts'), line: 2, column: 3 },
      ctx.signal,
    );
  });

  it('filters protected, external, broken and symlinked paths before applying the cap', async () => {
    const { workspace, run } = fixture();
    const external = path.resolve('/outside/secret.ts');
    workspace.links.set(workspace.abs('protected.ts'), workspace.abs('.env'));
    workspace.links.set(workspace.abs('outside.ts'), external);
    workspace.broken.add(workspace.abs('broken.ts'));
    workspace.locations = [
      { path: workspace.abs('.env'), line: 1, column: 1, name: 'secret' },
      { path: workspace.abs('protected.ts'), line: 1, column: 1, name: 'alias' },
      { path: workspace.abs('outside.ts'), line: 1, column: 1 },
      { path: external, line: 1, column: 1 },
      { path: workspace.abs('broken.ts'), line: 1, column: 1 },
      { path: workspace.abs('src/util.ts'), line: 3, column: 2 },
      { path: workspace.abs('src/util.ts'), line: 3, column: 2 },
    ];
    expect(await run(referencesTool, { ...position, max_results: 1 })).toEqual({
      content: '"src/util.ts":3:2',
      summary: '1 location(s)',
    });
    workspace.locations.push({ path: workspace.abs('src/app.ts'), line: 4, column: 2 });
    expect((await run(referencesTool, { ...position, max_results: 1 })).summary).toBe(
      '1 location(s) (limited)',
    );
  });

  it('prefixes multi-root results and rejects protected aliases as inputs', async () => {
    const { workspace, ctx, run } = fixture();
    const other = workspace.abs('other');
    workspace.set('other/index.ts', '');
    vi.spyOn(workspace, 'roots').mockReturnValue([
      { name: 'other', path: other },
      { name: 'main', path: workspace.root },
    ]);
    workspace.locations = [{ path: workspace.abs('other/index.ts'), line: 1, column: 1 }];
    expect((await run(definitionTool, { ...position, path: 'main/src/app.ts' })).content).toBe(
      '"other/index.ts":1:1',
    );
    ctx.settings.protectedPaths = ['other/index.ts'];
    workspace.links.set(workspace.abs('other/alias.ts'), workspace.abs('other/index.ts'));
    workspace.querySemantic.mockClear();
    await expect(run(definitionTool, { ...position, path: 'other/alias.ts' })).rejects.toThrow(
      /unprotected file/,
    );
    expect(workspace.querySemantic).not.toHaveBeenCalled();
  });

  it('rejects invalid or unavailable inputs before querying and explains empty results', async () => {
    const { workspace, ctx, run } = fixture();
    expect(definitionTool.schema.safeParse({ ...position, column: 0 }).success).toBe(false);
    expect(documentSymbolsTool.schema.safeParse({ path: 'src/app.ts', max_results: 201 }).success).toBe(
      false,
    );
    for (const file of ['.env', '../external.ts', 'src', 'missing.ts'])
      await expect(run(referencesTool, { ...position, path: file })).rejects.toThrow(/unprotected file/);
    workspace.trusted = false;
    await expect(run(referencesTool, position)).rejects.toThrow(/Trust the workspace/);
    expect(workspace.querySemantic).not.toHaveBeenCalled();
    workspace.trusted = true;
    expect((await run(referencesTool, position)).content).toMatch(/may be unavailable.*search_files/);
    ctx.workspace = new MemoryWorkspace({ 'src/app.ts': '' });
    await expect(run(referencesTool, position)).rejects.toThrow(/does not support semantic navigation/);
  });

  it('bounds the size of a result and drops an in-flight query after cancellation', async () => {
    const { workspace, ctx, run } = fixture();
    workspace.locations = [{ path: workspace.abs('src/app.ts'), line: 2, column: 3, name: 'a'.repeat(3000) }];
    const result = await run(documentSymbolsTool, { path: 'src/app.ts' });
    expect(result.content).toContain('Results limited');
    expect(result.content.length).toBeLessThanOrEqual(ctx.settings.maxToolResultChars);
    const cancel = new AbortController();
    ctx.signal = cancel.signal;
    workspace.querySemantic.mockImplementationOnce(async () => {
      cancel.abort();
      return workspace.locations;
    });
    await expect(run(referencesTool, position)).rejects.toThrow(/Cancelled/);
  });
});

describe('VS Code language commands', () => {
  const file = path.resolve('/ws/src/app.ts');
  const range = (line: number, character: number) => ({ start: { line, character } });
  const document = { lineCount: 2, lineAt: () => ({ text: '😀 call()' }) };
  const signal = () => new AbortController().signal;

  it('normalizes hierarchical and flat symbols using identifier positions', async () => {
    vscode.open.mockResolvedValue(document);
    vscode.command.mockResolvedValue([
      {
        name: 'Class',
        location: { uri: vscode.file(file), range: range(0, 0) },
        selectionRange: range(0, 6),
        children: [{ name: 'method', selectionRange: range(1, 3), children: [] }],
      },
      { name: 'flat', location: { uri: vscode.file(file), range: range(2, 0) } },
      { name: 'virtual', location: { uri: { scheme: 'untitled' }, range: range(2, 0) } },
    ]);
    expect([...(await querySemantic({ kind: 'symbols', path: file }, signal()))]).toEqual([
      { path: file, line: 1, column: 7, name: 'Class' },
      { path: file, line: 2, column: 4, name: 'method' },
      { path: file, line: 3, column: 1, name: 'flat' },
    ]);
    expect(vscode.command).toHaveBeenCalledWith('vscode.executeDocumentSymbolProvider', vscode.file(file));
  });

  it('normalizes definition links and positions, and validates UTF-16 columns using the document', async () => {
    vscode.open.mockResolvedValue(document);
    const uri = vscode.file(file);
    vscode.command.mockResolvedValue([
      { targetUri: uri, targetRange: range(0, 0), targetSelectionRange: range(1, 3) },
      { uri, range: range(0, 2) },
    ]);
    expect([
      ...(await querySemantic({ kind: 'definition', path: file, line: 2, column: 4 }, signal())),
    ]).toEqual([
      { path: file, line: 2, column: 4 },
      { path: file, line: 1, column: 3 },
    ]);
    expect(vscode.command).toHaveBeenCalledWith('vscode.executeDefinitionProvider', uri, {
      line: 1,
      character: 3,
    });
    await expect(
      querySemantic({ kind: 'references', path: file, line: 2, column: 99 }, signal()),
    ).rejects.toThrow(/outside the current file/);
    expect(vscode.command).toHaveBeenCalledOnce();
  });

  it.each(['cancel', 'timeout'] as const)('stops waiting for VS Code on %s', async (reason) => {
    const user = new AbortController();
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
    vscode.open.mockResolvedValue(document);
    let finish!: (value: unknown) => void;
    vscode.command.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = querySemantic({ kind: 'references', path: file, line: 1, column: 4 }, user.signal);
    await Promise.resolve();
    (reason === 'cancel' ? user : timeout).abort();
    await expect(pending).rejects.toThrow(reason === 'cancel' ? /Cancelled/ : /within 10 seconds/);
    expect(vscode.command).toHaveBeenCalledWith('vscode.executeReferenceProvider', vscode.file(file), {
      line: 0,
      character: 3,
    });
    finish([{ uri: vscode.file(file), range: range(0, 3) }]);
  });
});

describe('semantic navigation through the agent', () => {
  it.each(['plan', 'act', 'restricted', 'excluded', 'off', 'reject', 'protect'] as const)(
    'honors %s through the registry and checkpoint decorator',
    async (scenario) => {
      const { workspace, ctx } = fixture();
      workspace.locations = [{ path: workspace.abs('src/util.ts'), line: 2, column: 4 }];
      workspace.trusted = scenario !== 'restricted';
      const mode = scenario === 'act' ? 'act' : 'plan';
      const registry = createBuiltinRegistry();
      const name = referencesTool.name;
      const approvals = new ScriptedApprovals(() => {
        expect(workspace.querySemantic).not.toHaveBeenCalled();
        return { approved: false };
      });
      const settings: AgentSettings = {
        maxIterations: 3,
        policy: {
          approvalMode: 'auto',
          allowedCommands: [],
          protectedPaths: ctx.settings.protectedPaths,
          disabledTools: scenario === 'off' ? [name] : [],
          forceAskTools: scenario === 'reject' ? [name] : [],
        },
        tools: ctx.settings,
        defaultContextWindow: 32768,
        defaultMaxOutputTokens: 4096,
      };
      if (scenario === 'protect')
        workspace.querySemantic.mockImplementationOnce(async () => {
          settings.policy.protectedPaths = ['src/util.ts'];
          return workspace.locations;
        });
      const runner = new AgentRunner({
        registry,
        provider: new ScriptedProvider([[call(0, name, position)], [text('done')]]),
        workspace: new CheckpointRecorder(workspace),
        process: ctx.process,
        approvals,
        capabilities: new MemoryCapabilityStore(),
        logger: nullLogger,
      });
      const session: Session = { id: 's', title: 'Test', createdAt: 0, updatedAt: 0, mode, messages: [] };
      if (scenario === 'excluded') session.excludedToolGroups = ['context'];
      await runner.run({
        session,
        providerId: 'p',
        model: { id: 'm' },
        mode,
        settings,
        policy: () => settings.policy,
        grants: { edits: false },
        signal: ctx.signal,
        emit: () => {},
      });
      const result = session.messages.find((m): m is ToolMessage => m.role === 'tool');
      if (scenario === 'plan' || scenario === 'act') {
        expect(result).toMatchObject({ status: 'success', content: '"src/util.ts":2:4' });
        expect(workspace.querySemantic).toHaveBeenCalledOnce();
      } else if (scenario === 'protect') {
        expect(result).toMatchObject({
          status: 'error',
          content: expect.stringContaining('Protected paths changed'),
        });
        expect(result?.content).not.toContain('src/util.ts');
      } else {
        expect(result?.status).toBe('denied');
        expect(workspace.querySemantic).not.toHaveBeenCalled();
      }
    },
  );
});
