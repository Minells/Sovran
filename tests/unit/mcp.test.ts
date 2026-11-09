import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentRunner, type AgentSettings } from '../../src/core/agent/agentRunner';
import type { AgentEvent } from '../../src/core/agent/events';
import { buildSystemPrompt } from '../../src/core/agent/systemPrompt';
import {
  fromEntry,
  mergeMcpEntries,
  newServerId,
  parseMcpServers,
  toEntry,
  toolPolicy,
} from '../../src/core/mcp/config';
import { McpHub, tellingLine } from '../../src/core/mcp/hub';
import {
  commandCandidates,
  commandNotFound,
  expandVariables,
  inheritedEnvironment,
  McpConfigError,
  resolveLaunch,
  type McpVariables,
} from '../../src/core/mcp/launch';
import { isMcpToolName, mcpToolName } from '../../src/core/mcp/naming';
import { formatToolResult } from '../../src/core/mcp/results';
import { parseMcpSnippet, stripJsonc } from '../../src/shared/mcpImport';
import { decide, type PolicyInput } from '../../src/core/permissions/policy';
import { nullLogger } from '../../src/core/ports';
import { MemoryCapabilityStore } from '../../src/core/providers/capabilities';
import type { Session, ToolMessage } from '../../src/core/sessions/model';
import { createBuiltinRegistry } from '../../src/core/tools/builtin';
import { defineTool, type ToolContext } from '../../src/core/tools/types';
import {
  FakeProcess,
  MemoryWorkspace,
  ScriptedApprovals,
  ScriptedProvider,
  call,
  text,
} from '../fixtures/fakes';
import { MemoryTransports, notesServer, server, until } from '../fixtures/mcp';

// ------------------------------------------------------------------------------------------------ config

describe('MCP configuration', () => {
  it('reads local and remote servers and fills in the defaults', () => {
    const { servers, problems } = parseMcpServers([
      {
        id: 'files',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '${workspaceFolder}'],
      },
      {
        id: 'docs',
        name: 'Docs',
        url: 'https://mcp.example.com/mcp',
        auth: { type: 'bearer' },
        timeoutSeconds: 30,
        allowedTools: ['search'],
      },
    ]);
    expect(problems).toEqual([]);
    expect(servers[0]).toEqual({
      id: 'files',
      name: 'files',
      enabled: true,
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '${workspaceFolder}'],
      auth: { type: 'none' },
      timeoutSeconds: 60,
      allowedTools: [],
      disabledTools: [],
    });
    expect(servers[1]).toMatchObject({
      name: 'Docs',
      url: 'https://mcp.example.com/mcp',
      auth: { type: 'bearer' },
      timeoutSeconds: 30,
      allowedTools: ['search'],
    });
  });

  it('skips invalid entries and says why, keeping the valid ones', () => {
    const { servers, problems } = parseMcpServers([
      { id: 'both', command: 'x', url: 'https://a.example/mcp' },
      { id: 'neither' },
      { id: 'Bad Id', command: 'x' },
      { id: 'tok', command: 'x', auth: { type: 'bearer' } },
      { id: 'web', url: 'https://a.example/mcp', auth: { type: 'env', envName: 'TOKEN' } },
      { id: 'ftp', url: 'ftp://a.example/mcp' },
      { id: 'ok', command: 'x' },
      { id: 'ok', command: 'y' },
      'not an object',
    ]);
    expect(servers.map((s) => s.id)).toEqual(['ok']);
    expect(servers[0]!.command).toBe('x');
    expect(problems).toHaveLength(8);
    expect(problems[0]).toContain('Set either a command');
    expect(problems[3]).toContain('environment variable');
    expect(problems[4]).toContain('in a header');
    expect(problems[6]).toContain('listed twice');
    expect(parseMcpServers(undefined)).toEqual({ servers: [], problems: [] });
  });

  it('writes settings without defaults and reads them back unchanged', () => {
    const s = fromEntry({
      id: 'gh',
      command: 'npx',
      args: ['gh-mcp'],
      auth: { type: 'env', envName: 'GITHUB_TOKEN' },
      disabledTools: ['a', 'a'],
    });
    expect(s.disabledTools).toEqual(['a']);
    const entry = toEntry(s);
    expect(entry).toEqual({
      id: 'gh',
      command: 'npx',
      args: ['gh-mcp'],
      auth: { type: 'env', envName: 'GITHUB_TOKEN' },
      disabledTools: ['a'],
    });
    expect(fromEntry(entry)).toEqual(s);
    expect(toEntry({ ...s, name: 'GitHub', enabled: false, timeoutSeconds: 90 })).toMatchObject({
      name: 'GitHub',
      enabled: false,
      timeoutSeconds: 90,
    });
  });

  it('keeps entries it cannot read exactly where the user wrote them', () => {
    const typo = { id: 'docs', comand: 'x' };
    const raw = [{ id: 'a', command: 'x' }, typo, { id: 'b', command: 'y' }, { id: 'a', command: 'dup' }];
    const [a, b] = parseMcpServers(raw).servers;
    expect(mergeMcpEntries(raw, [{ ...a!, allowedTools: ['t'] }, b!])).toEqual([
      { id: 'a', command: 'x', allowedTools: ['t'] },
      typo,
      { id: 'b', command: 'y' },
      { id: 'a', command: 'dup' },
    ]);
    // Removing a server drops only its entry; a new one goes at the end.
    expect(mergeMcpEntries(raw, [b!, fromEntry({ id: 'c', url: 'https://c.example/mcp' })])).toEqual([
      typo,
      { id: 'b', command: 'y' },
      { id: 'a', command: 'dup' },
      { id: 'c', url: 'https://c.example/mcp' },
    ]);
    expect(mergeMcpEntries(undefined, [])).toEqual([]);
  });

  it('derives a readable id from the name that no other server uses', () => {
    expect(newServerId('GitHub Issues', new Set())).toBe('github-issues');
    expect(newServerId('Città & Co.', new Set())).toBe('citta-co');
    expect(newServerId('!!!', new Set())).toBe('server');
    expect(newServerId('Docs', new Set(['docs', 'docs-2']))).toBe('docs-3');
    expect(newServerId('x'.repeat(60), new Set())).toHaveLength(28);
  });

  it('turns tools off, allows them, or asks', () => {
    const s = { allowedTools: ['a', 'b'], disabledTools: ['b'] };
    expect(toolPolicy(s, 'a')).toBe('allow');
    expect(toolPolicy(s, 'b')).toBe('off');
    expect(toolPolicy(s, 'c')).toBe('ask');
  });
});

describe('MCP launch', () => {
  const vars: McpVariables = {
    workspaceFolder: '/ws',
    userHome: '/home/me',
    env: { TOKEN: 's3cret', HTTPS_PROXY: 'http://proxy:8080', AWS_SECRET_ACCESS_KEY: 'x', PATH: '/bin' },
  };

  it('expands the known variables and reports anything else', () => {
    const problems: string[] = [];
    expect(expandVariables('${workspaceFolder}/src:${userHome}:${env:TOKEN}', vars, problems)).toBe(
      '/ws/src:/home/me:s3cret',
    );
    expect(problems).toEqual([]);
    expandVariables(
      '${env:MISSING} ${input:token} ${workspaceFolder}',
      { ...vars, workspaceFolder: undefined },
      problems,
    );
    expect(problems).toEqual([
      "${env:MISSING} is not set in VS Code's environment.",
      expect.stringContaining('${input:token} is not a variable Sovran knows'),
      '${workspaceFolder} needs an open folder.',
    ]);
  });

  it('passes proxies and certificate bundles to local servers, but not other variables', () => {
    expect(inheritedEnvironment(vars.env)).toEqual({ HTTPS_PROXY: 'http://proxy:8080' });
  });

  it('puts the token where the server expects it and resolves the working folder', () => {
    const local = server({
      id: 'gh',
      command: 'npx',
      args: ['${workspaceFolder}'],
      env: { MODE: 'ro' },
      auth: { type: 'env', envName: 'GITHUB_TOKEN' },
      cwd: 'tools',
    });
    expect(resolveLaunch(local, vars, 'tok')).toEqual({
      kind: 'stdio',
      command: 'npx',
      args: ['/ws'],
      env: { HTTPS_PROXY: 'http://proxy:8080', MODE: 'ro', GITHUB_TOKEN: 'tok' },
      cwd: expect.stringMatching(/[/\\]ws[/\\]tools$/),
    });
    expect(
      resolveLaunch(server({ id: 'a', command: 'x' }), { ...vars, workspaceFolder: undefined }, undefined),
    ).toMatchObject({ cwd: '/home/me' });

    const bearer = server({
      id: 'web',
      command: undefined,
      url: 'https://${env:TOKEN}.example/mcp',
      headers: { 'X-Team': 'core' },
      auth: { type: 'bearer' },
    });
    expect(resolveLaunch(bearer, vars, 'tok')).toEqual({
      kind: 'http',
      url: 'https://s3cret.example/mcp',
      headers: { 'X-Team': 'core', Authorization: 'Bearer tok' },
    });
    const header = { ...bearer, auth: { type: 'header' as const, headerName: 'X-Api-Key' } };
    expect(resolveLaunch(header, vars, 'tok')).toMatchObject({ headers: { 'X-Api-Key': 'tok' } });
  });

  it('refuses to start without its token, listing every problem', () => {
    const s = server({
      id: 'gh',
      command: 'npx',
      args: ['${env:NOPE}'],
      auth: { type: 'env', envName: 'T' },
    });
    expect(() => resolveLaunch(s, vars, undefined)).toThrow(McpConfigError);
    expect(() => resolveLaunch(s, vars, undefined)).toThrow(
      /No token is stored for gh.*\$\{env:NOPE\} is not set/,
    );
  });
});

describe('MCP commands', () => {
  it('looks a command up on PATH, or at the path it names', () => {
    const posix = {
      cwd: '/ws',
      path: '/usr/local/bin:/usr/bin',
      pathext: undefined,
      platform: 'linux' as const,
    };
    expect(commandCandidates('npx', posix)).toEqual(['/usr/local/bin/npx', '/usr/bin/npx']);
    expect(commandCandidates('./bin/server', posix)).toEqual(['/ws/bin/server']);
    expect(commandCandidates('/opt/mcp/server', posix)).toEqual(['/opt/mcp/server']);
    expect(commandCandidates('npx', { ...posix, path: undefined })).toEqual([]);
  });

  it('tries the PATHEXT extensions on Windows, as cmd.exe does', () => {
    const win = {
      cwd: 'C:\\ws',
      path: 'C:\\Program Files\\nodejs;"C:\\Tools"',
      pathext: '.COM;.EXE;.CMD',
      platform: 'win32' as const,
    };
    expect(commandCandidates('npx', win)).toEqual([
      'C:\\ws\\npx.COM',
      'C:\\ws\\npx.EXE',
      'C:\\ws\\npx.CMD',
      'C:\\Program Files\\nodejs\\npx.COM',
      'C:\\Program Files\\nodejs\\npx.EXE',
      'C:\\Program Files\\nodejs\\npx.CMD',
      'C:\\Tools\\npx.COM',
      'C:\\Tools\\npx.EXE',
      'C:\\Tools\\npx.CMD',
    ]);
    expect(commandCandidates('node.exe', { ...win, path: 'C:\\nodejs' })).toEqual([
      'C:\\ws\\node.exe',
      'C:\\nodejs\\node.exe',
    ]);
    expect(commandCandidates('C:\\nodejs\\node', win)).toEqual([
      'C:\\nodejs\\node.COM',
      'C:\\nodejs\\node.EXE',
      'C:\\nodejs\\node.CMD',
    ]);
    expect(commandCandidates('tools\\server.cmd', win)).toEqual(['C:\\ws\\tools\\server.cmd']);
    expect(commandNotFound('uvx')).toBe(
      'Could not start "uvx": it was not found. Install it, or use its full path.',
    );
  });

  it('explains a failure with the line of stderr that gives the reason', () => {
    const node = [
      'file:///srv/index.js:3',
      "Error: Cannot find module '@x/sdk'",
      '    at Module._resolveFilename (node:internal)',
      '',
      'Node.js v22.23.4',
    ];
    expect(tellingLine(node)).toBe("Error: Cannot find module '@x/sdk'");
    expect(
      tellingLine([
        'Traceback (most recent call last):',
        '  File "server.py", line 1',
        'ModuleNotFoundError: No module named mcp',
      ]),
    ).toBe('ModuleNotFoundError: No module named mcp');
    expect(tellingLine(['starting', 'listening on stdio'])).toBe('listening on stdio');
    expect(tellingLine([])).toBeUndefined();
  });
});

describe('MCP tool names', () => {
  it('namespaces tools by server and keeps them within the limits of OpenAI-compatible servers', () => {
    expect(mcpToolName('github', 'create_issue')).toBe('mcp__github__create_issue');
    expect(isMcpToolName('mcp__github__create_issue')).toBe(true);
    expect(isMcpToolName('read_file')).toBe(false);
    const long = mcpToolName('server', 'a'.repeat(80));
    expect(long).toHaveLength(64);
    expect(long).toMatch(/^mcp__server__a+_[0-9a-f]{8}$/);
    const dotted = mcpToolName('s', 'files.read');
    expect(dotted).toMatch(/^mcp__s__files_read_[0-9a-f]{8}$/);
    expect(dotted).not.toBe(mcpToolName('s', 'files_read'));
    expect(mcpToolName('s', 'files/read')).not.toBe(dotted);
  });
});

describe('MCP results', () => {
  it('gives the model text and labels what it cannot read', () => {
    const r = formatToolResult({
      content: [
        { type: 'text', text: 'First' },
        { type: 'image', data: 'A'.repeat(4096), mimeType: 'image/png' },
        { type: 'resource', resource: { uri: 'file:///a.md', text: '# A' } },
        {
          type: 'resource',
          resource: { uri: 'file:///b.bin', blob: 'AAAA', mimeType: 'application/octet-stream' },
        },
        { type: 'resource_link', uri: 'https://x.example/doc', name: 'Doc', description: 'Spec' },
        { type: 'hologram' },
      ],
    });
    expect(r.isError).toBe(false);
    expect(r.text.split('\n\n')).toEqual([
      'First',
      '[Image (image/png, 3 KB) returned by the tool; it is not shown to the model.]',
      'Resource file:///a.md:\n# A',
      '[Binary resource file:///b.bin (application/octet-stream, 1 KB); it is not shown to the model.]',
      'Link to resource "Doc" <https://x.example/doc>: Spec',
      '[Content of type "hologram" that Sovran cannot show.]',
    ]);
  });

  it('shows structured content when there is no text, and says when there was nothing', () => {
    expect(formatToolResult({ content: [], structuredContent: { total: 3 } }).text).toBe(
      '{\n  "total": 3\n}',
    );
    expect(
      formatToolResult({ content: [{ type: 'text', text: 'ok' }], structuredContent: { total: 3 } }).text,
    ).toBe('ok');
    expect(formatToolResult({})).toEqual({ text: 'The tool returned no content.', isError: false });
    expect(formatToolResult({ isError: true })).toEqual({
      text: 'The tool failed without saying why.',
      isError: true,
    });
  });
});

// ------------------------------------------------------------------------------------------------ policy

describe('MCP policy', () => {
  const base: PolicyInput = {
    risk: 'execute',
    mode: 'act',
    workspaceTrusted: true,
    paths: [],
    settings: { approvalMode: 'ask', allowedCommands: [], protectedPaths: [] },
    grants: { edits: false },
  };

  it('asks in every approval mode, Auto included, until the user allows the tool', () => {
    for (const approvalMode of ['ask', 'edits', 'auto'] as const) {
      const settings = { ...base.settings, approvalMode };
      expect(decide({ ...base, settings, mcp: { server: 'GitHub', allowed: false } }).action).toBe('ask');
      expect(decide({ ...base, settings, mcp: { server: 'GitHub', allowed: true } })).toEqual({
        action: 'allow',
        reason: 'Ran without asking (you allowed this tool of GitHub).',
      });
    }
  });

  it('never runs in Plan mode or in an untrusted workspace, even when allowed', () => {
    expect(decide({ ...base, mode: 'plan', mcp: { server: 'GitHub', allowed: true } }).action).toBe('deny');
    expect(
      decide({ ...base, workspaceTrusted: false, mcp: { server: 'GitHub', allowed: true } }).action,
    ).toBe('deny');
  });
});

describe('tool sources', () => {
  const ctx = {} as ToolContext;
  const external = defineTool({
    name: 'mcp__s__ping',
    description: 'Ping',
    schema: z.record(z.string(), z.unknown()),
    parameters: { type: 'object', properties: { host: { type: 'string' } } },
    risk: 'execute',
    label: () => 'ping',
    execute: async () => ({ content: 'pong' }),
  });
  const shadow = { ...external, name: 'read_file' };

  it('offers source tools in Act mode only, with their own JSON Schema, and never lets them shadow a built-in tool', async () => {
    const registry = createBuiltinRegistry().addSource({ tools: () => [external, shadow] });
    expect(registry.list('act').map((t) => t.name)).toContain('mcp__s__ping');
    expect(registry.list('plan').map((t) => t.name)).not.toContain('mcp__s__ping');
    expect(registry.list('act').filter((t) => t.name === 'read_file')).toHaveLength(1);
    expect(registry.get('read_file')).not.toBe(shadow);
    expect(registry.schema(external).function.parameters).toEqual({
      type: 'object',
      properties: { host: { type: 'string' } },
    });
    expect(await registry.get('mcp__s__ping')!.execute({}, ctx, { paths: [] })).toEqual({ content: 'pong' });
  });
});

// ------------------------------------------------------------------------------------------------ hub

describe('McpHub', () => {
  let hub: McpHub | undefined;
  afterEach(async () => hub?.dispose());

  const connect = async (
    configs = [server({ id: 'notes', name: 'Notes' })],
    factories = { notes: notesServer },
  ) => {
    const transports = new MemoryTransports(factories);
    let changes = 0;
    hub = new McpHub({
      transports,
      logger: nullLogger,
      client: { name: 'sovran', version: '0.0.0' },
      onChange: () => changes++,
    });
    hub.update(configs, true);
    await until(() =>
      hub!.states().every((s) => (s.status !== 'starting' && s.status !== 'stopped') || !s.config.enabled),
    );
    return { hub, transports, changes: () => changes };
  };

  it('connects, lists the tools with what the server says about them, and offers them to the agent', async () => {
    const { hub } = await connect();
    const [state] = hub.states();
    expect(state).toMatchObject({ status: 'connected', server: { name: 'notes', version: '1.2.0' } });
    expect(state!.tools.map((t) => [t.name, t.modelName, t.policy, t.hints])).toEqual([
      ['read_note', 'mcp__notes__read_note', 'ask', ['read-only']],
      ['delete_note', 'mcp__notes__delete_note', 'ask', ['destructive']],
      ['broken', 'mcp__notes__broken', 'ask', []],
    ]);
    expect(state!.tools[0]!.definitionTokens).toBeGreaterThan(15);
    const tools = hub.tools();
    expect(tools.map((t) => t.name)).toEqual([
      'mcp__notes__read_note',
      'mcp__notes__delete_note',
      'mcp__notes__broken',
    ]);
    expect(tools[0]).toMatchObject({
      risk: 'execute',
      description: 'Read note. Reads a note by name. (MCP server "Notes")',
    });
    expect(tools[0]!.parameters).toMatchObject({
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    });
    expect(tools[0]!.parameters).not.toHaveProperty('$schema');
    expect(hub.tools()).toBe(tools);
    expect(hub.describe('mcp__notes__read_note')).toEqual({ server: 'Notes', tool: 'Read note' });
  });

  it('prepares an approval with the arguments and calls the tool', async () => {
    const { hub } = await connect();
    const tool = hub.tools()[0]!;
    const signal = new AbortController().signal;
    const prepared = await tool.prepare!({ name: 'welcome' }, { signal } as ToolContext);
    expect(prepared).toEqual({
      paths: [],
      mcp: { server: 'Notes', allowed: false },
      approval: {
        kind: 'mcp',
        serverId: 'notes',
        server: 'Notes',
        tool: 'read_note',
        title: 'Read note',
        arguments: '{\n  "name": "welcome"\n}',
        hints: ['read-only'],
      },
    });
    expect(tool.label({})).toBe('Read note · Notes');
    expect(await tool.execute({ name: 'welcome' }, { signal } as ToolContext, prepared)).toEqual({
      content: 'Hello from MCP',
      isError: false,
      summary: 'Read note · Notes',
    });
    expect(await hub.callTool('notes', 'broken', {}, signal)).toEqual({
      content: 'disk full',
      isError: true,
    });
    await expect(hub.callTool('notes', 'read_note', { name: 3 }, signal)).resolves.toMatchObject({
      isError: true,
    });
    await expect(hub.callTool('missing', 'x', {}, signal)).rejects.toThrow(
      'The MCP server missing is not connected',
    );
  });

  it('applies tool policies without reconnecting, and reconnects when the connection changes', async () => {
    const config = server({ id: 'notes', name: 'Notes' });
    const { hub, transports } = await connect([config]);
    hub.update(
      [{ ...config, name: 'My notes', allowedTools: ['read_note'], disabledTools: ['broken'] }],
      true,
    );
    expect(transports.created.get('notes')).toBe(1);
    expect(hub.tools().map((t) => t.name)).toEqual(['mcp__notes__read_note', 'mcp__notes__delete_note']);
    const prepared = await hub.tools()[0]!.prepare!({ name: 'x' }, {} as ToolContext);
    expect(prepared.mcp).toEqual({ server: 'My notes', allowed: true });

    // Turned off while a run had already listed it: the call is refused.
    const deleteNote = hub.tools()[1]!;
    hub.update([{ ...config, disabledTools: ['delete_note'] }], true);
    await expect(deleteNote.prepare!({ name: 'x' }, {} as ToolContext)).rejects.toThrow('turned off');

    hub.update([{ ...config, args: ['--other'] }], true);
    await until(() => transports.created.get('notes') === 2 && hub.states()[0]!.status === 'connected');
  });

  it('rechecks Off and abort inside the final MCP dispatch', async () => {
    const config = server({ id: 'notes', name: 'Notes' });
    const { hub } = await connect([config]);
    const tool = hub.tools()[0]!;
    const signal = new AbortController().signal;
    const prepared = await tool.prepare!({ name: 'welcome' }, { signal } as ToolContext);
    hub.update([{ ...config, disabledTools: ['read_note'] }], true);
    await expect(tool.execute({ name: 'welcome' }, { signal } as ToolContext, prepared)).rejects.toThrow(
      'turned off',
    );
    await expect(hub.callTool('notes', 'read_note', {}, signal)).rejects.toThrow('turned off');
    hub.update([config], true);
    const abort = new AbortController();
    abort.abort();
    await expect(hub.callTool('notes', 'read_note', {}, abort.signal)).rejects.toThrow('Cancelled');
    await hub.restart('notes');
    await expect(tool.execute({ name: 'welcome' }, { signal } as ToolContext, prepared)).rejects.toThrow('no longer available');
  });

  it('starts nothing while inactive or disabled, and stops servers that are removed', async () => {
    const transports = new MemoryTransports({ notes: notesServer, other: notesServer });
    hub = new McpHub({ transports, logger: nullLogger, client: { name: 'sovran', version: '0' } });
    hub.update([server({ id: 'notes' }), server({ id: 'other', enabled: false })], false);
    expect(hub.states().map((s) => s.status)).toEqual(['stopped', 'disabled']);
    expect(hub.tools()).toEqual([]);
    expect(transports.created.size).toBe(0);
    hub.update([server({ id: 'notes' }), server({ id: 'other', enabled: false })], true);
    await until(() => hub!.states()[0]!.status === 'connected');
    expect(transports.created.get('other')).toBeUndefined();
    hub.update([], true);
    expect(hub.states()).toEqual([]);
    expect(hub.tools()).toEqual([]);
  });

  it('follows the tool list when the server changes it', async () => {
    const { hub, transports } = await connect();
    transports.servers
      .get('notes')!
      .registerTool('new_tool', { description: 'Added later', inputSchema: z.object({}) }, async () => ({
        content: [],
      }));
    await until(() => hub.tools().some((t) => t.name === 'mcp__notes__new_tool'));
  });

  it('reports a server that cannot start, and one that stops, without throwing', async () => {
    const failing = {
      create: async () => {
        throw new McpConfigError('No token is stored for GitHub. Add it with Set token.');
      },
    };
    const broken = new McpHub({
      transports: failing,
      logger: nullLogger,
      client: { name: 'sovran', version: '0' },
    });
    broken.update([server({ id: 'gh', name: 'GitHub' })], true);
    await until(() => broken.states()[0]!.status === 'error');
    expect(broken.states()[0]!.error).toBe('No token is stored for GitHub. Add it with Set token.');
    await broken.dispose();

    const { hub, transports } = await connect();
    await transports.servers.get('notes')!.close();
    await until(() => hub.states()[0]!.status === 'error');
    expect(hub.states()[0]!.error).toBe('The server stopped: notes ready');
    expect(hub.tools()).toEqual([]);
    await expect(hub.callTool('notes', 'read_note', {}, new AbortController().signal)).rejects.toThrow(
      'Restart it in Sovran Settings',
    );
    await hub.restart('notes');
    expect(hub.states()[0]!.status).toBe('connected');
    expect(transports.created.get('notes')).toBe(2);
  });
});

// ------------------------------------------------------------------------------------------------ agent

describe('MCP tools in the agent loop', () => {
  const settings: AgentSettings = {
    maxIterations: 5,
    policy: { approvalMode: 'auto', allowedCommands: [], protectedPaths: [] },
    tools: { terminalTimeoutMs: 1000, maxToolResultChars: 20_000, protectedPaths: [] },
    defaultContextWindow: 32_768,
    defaultMaxOutputTokens: 4096,
  };
  let hub: McpHub | undefined;
  afterEach(async () => hub?.dispose());

  async function run(
    opts: {
      allowed?: string[];
      mode?: 'plan' | 'act';
      approve?: boolean;
      duringApproval?: (hub: McpHub) => void;
      duringRequest?: (hub: McpHub) => void;
      duringDispatch?: (hub: McpHub) => void;
    } = {},
  ) {
    hub = new McpHub({
      transports: new MemoryTransports({ notes: notesServer }),
      logger: nullLogger,
      client: { name: 'sovran', version: '0' },
    });
    hub.update([server({ id: 'notes', name: 'Notes', allowedTools: opts.allowed ?? [] })], true);
    await until(() => hub!.states()[0]!.status === 'connected');
    const provider = new ScriptedProvider([
      () => {
        opts.duringRequest?.(hub!);
        return [call(0, 'mcp__notes__read_note', { name: 'welcome' })];
      },
      [text('done')],
    ]);
    const approvals = new ScriptedApprovals(() => {
      opts.duringApproval?.(hub!);
      return { approved: opts.approve ?? true };
    });
    const session: Session = {
      id: 's',
      title: 't',
      createdAt: 0,
      updatedAt: 0,
      mode: 'act',
      messages: [{ role: 'user', id: 'u', content: 'read', createdAt: 0 }],
    };
    const events: AgentEvent[] = [];
    const runner = new AgentRunner({
      provider,
      registry: createBuiltinRegistry().addSource(hub),
      workspace: new MemoryWorkspace({}),
      process: new FakeProcess(),
      approvals,
      capabilities: new MemoryCapabilityStore(),
      logger: nullLogger,
    });
    await runner.run({
      session,
      providerId: 'p',
      model: { id: 'm', toolMode: 'native' },
      mode: opts.mode ?? 'act',
      settings,
      grants: { edits: false },
      signal: new AbortController().signal,
      emit: (e) => {
        events.push(e);
        if (e.type === 'tool_phase' && e.phase === 'running') opts.duringDispatch?.(hub!);
      },
    });
    const result = session.messages.find((m): m is ToolMessage => m.role === 'tool');
    return { provider, approvals, result, events };
  }

  it('asks before calling an MCP tool even in Auto mode, then gives the model its result', async () => {
    const { provider, approvals, result } = await run();
    expect(provider.requests[0]!.tools?.map((t) => t.function.name)).toContain('mcp__notes__read_note');
    expect(approvals.requests).toHaveLength(1);
    expect(approvals.requests[0]).toMatchObject({
      toolName: 'mcp__notes__read_note',
      title: 'Read note · Notes',
      detail: { kind: 'mcp', server: 'Notes', tool: 'read_note' },
    });
    expect(result).toMatchObject({
      status: 'success',
      content: 'Hello from MCP',
      summary: 'Read note · Notes',
    });
    expect(result!.autoApproved).toBeUndefined();
    expect(provider.requests[0]!.messages[0]!.content).toContain(
      'Tools named mcp__<server>__<tool> come from MCP servers',
    );
  });

  it('runs an allowed tool without asking and labels it in the transcript', async () => {
    const { approvals, result } = await run({ allowed: ['read_note'] });
    expect(approvals.requests).toHaveLength(0);
    expect(result).toMatchObject({
      status: 'success',
      autoApproved: 'Ran without asking (you allowed this tool of Notes).',
    });
  });

  it('tells the model when the user rejects the call', async () => {
    const { result } = await run({ approve: false });
    expect(result).toMatchObject({ status: 'denied', content: 'The user rejected this action.' });
  });

  it('never offers MCP tools in Plan mode', async () => {
    const { provider } = await run({ mode: 'plan' });
    expect(provider.requests[0]!.tools?.map((t) => t.function.name) ?? []).not.toContain(
      'mcp__notes__read_note',
    );
  });

  it('blocks MCP Off applied while its approval is open', async () => {
    const { result } = await run({
      duringApproval: (hub) => hub.update([server({ id: 'notes', disabledTools: ['read_note'] })], true),
    });
    expect(result?.status).toBe('denied');
  });

  it('re-evaluates Allow changed to Ask while the model responds', async () => {
    const { result, approvals } = await run({
      allowed: ['read_note'],
      duringRequest: (hub) => hub.update([server({ id: 'notes', name: 'Notes' })], true),
    });
    expect(approvals.requests).toHaveLength(1);
    expect(result?.status).toBe('success');
  });

  it('preserves an explicit approval when Ask changes to Allow', async () => {
    const { result, approvals } = await run({
      duringApproval: (hub) =>
        hub.update([server({ id: 'notes', name: 'Notes', allowedTools: ['read_note'] })], true),
    });
    expect(approvals.requests).toHaveLength(1);
    expect(result?.status).toBe('success');
    expect(result?.autoApproved).toBeUndefined();
  });

  it('blocks Allow changed to Ask immediately before dispatch', async () => {
    const { result, approvals } = await run({
      allowed: ['read_note'],
      duringDispatch: (hub) => hub.update([server({ id: 'notes', name: 'Notes' })], true),
    });
    expect(approvals.requests).toHaveLength(0);
    expect(result?.status).toBe('denied');
    expect(result?.content).toContain('Permissions changed');
  });

  it('mentions MCP tools in the system prompt only when there are some', () => {
    const base = {
      mode: 'act' as const,
      toolMode: 'native' as const,
      os: 'linux',
      shell: 'bash',
      folders: [],
      date: '2026-11-05',
      trusted: true,
    };
    const schema = (name: string) => ({
      type: 'function' as const,
      function: { name, description: '', parameters: {} },
    });
    expect(buildSystemPrompt({ ...base, tools: [schema('read_file')] })).not.toContain('MCP');
    expect(buildSystemPrompt({ ...base, tools: [schema('mcp__a__b')] })).toContain(
      'MCP servers the user connected',
    );
  });
});

// ------------------------------------------------------------------------------------------------ snippets

describe('README snippets', () => {
  const drafts = (text: string) => {
    const r = parseMcpSnippet(text);
    if ('error' in r) throw new Error(r.error);
    return r.drafts;
  };

  it('reads the Claude Desktop, Cursor and Cline format, moving a token out of env', () => {
    const [d] = drafts(`{
      // from the README
      "mcpServers": {
        "github": {
          "command": "npx",
          "args": ["-y", "@modelcontextprotocol/server-github"],
          "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_abc123", "GITHUB_HOST": "https://github.example" },
          "autoApprove": ["search_repositories"],
        },
      },
    }`);
    expect(d).toEqual({
      name: 'github',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_HOST: 'https://github.example' },
      auth: { type: 'env', envName: 'GITHUB_PERSONAL_ACCESS_TOKEN' },
      token: 'ghp_abc123',
      notes: [
        'GITHUB_PERSONAL_ACCESS_TOKEN moves to Secret Storage.',
        expect.stringContaining('Auto-approved tools are not imported'),
      ],
    });
  });

  it('reads VS Code mcp.json with an input placeholder, and remote servers with a bearer header', () => {
    const list = drafts(`{
      "inputs": [{ "id": "pat", "type": "promptString", "password": true }],
      "servers": {
        "github": { "type": "http", "url": "https://api.githubcopilot.com/mcp/", "headers": { "Authorization": "Bearer \${input:pat}", "X-MCP-Toolsets": "issues" } },
        "docs": { "type": "sse", "url": "https://docs.example/sse", "headers": { "X-Api-Key": "k-987654" } }
      }
    }`);
    expect(list[0]).toEqual({
      name: 'github',
      transport: 'http',
      url: 'https://api.githubcopilot.com/mcp/',
      headers: { 'X-MCP-Toolsets': 'issues' },
      auth: { type: 'bearer' },
      notes: ['Enter the token below: it is sent as "Authorization: Bearer <token>".'],
    });
    expect(list[1]).toMatchObject({ auth: { type: 'header', headerName: 'X-Api-Key' }, token: 'k-987654' });
    expect(list[1]!.notes[0]).toContain('older SSE transport');
  });

  it('accepts one server, a fragment without braces, and a command line in one string', () => {
    expect(drafts('{ "command": "uvx", "args": ["mcp-server-fetch"] }')[0]).toMatchObject({
      name: 'MCP server',
      command: 'uvx',
      args: ['mcp-server-fetch'],
    });
    expect(drafts('"fetch": { "command": "uvx mcp-server-fetch --ignore-robots-txt" }')[0]).toMatchObject({
      name: 'fetch',
      command: 'uvx',
      args: ['mcp-server-fetch', '--ignore-robots-txt'],
      notes: ['The command line was split into the command and its arguments.'],
    });
    expect(drafts('{ "mcp": { "servers": { "a": { "url": "https://a.example/mcp" } } } }')[0]).toMatchObject({
      name: 'a',
      transport: 'http',
    });
  });

  it('keeps one token per server and leaves look-alike names alone', () => {
    const [d] = drafts(
      '{ "s": { "command": "x", "env": { "TOKENIZER_PATH": "/m", "API_KEY": "<your key>", "SECRET": "s3" } } }',
    );
    expect(d!.auth).toEqual({ type: 'env', envName: 'API_KEY' });
    expect(d!.token).toBeUndefined();
    expect(d!.env).toEqual({ TOKENIZER_PATH: '/m', SECRET: 's3' });
    expect(d!.notes[1]).toContain('SECRET also looks like a secret');
  });

  it('explains what is wrong with the paste', () => {
    expect(parseMcpSnippet('')).toEqual({ error: expect.stringContaining('Paste the JSON') });
    expect(parseMcpSnippet('{ nope')).toEqual({ error: expect.stringContaining('not valid JSON') });
    expect(parseMcpSnippet('[1, 2]')).toEqual({ error: expect.stringContaining('Expected a JSON object') });
    expect(parseMcpSnippet('{ "mcpServers": { "a": { "env": {} } } }')).toEqual({
      error: expect.stringContaining('No server found'),
    });
  });

  it('strips comments without touching URLs inside strings', () => {
    expect(stripJsonc('{ "u": "https://x.example//a", /* c */ "b": 1, } // end')).toBe(
      '{ "u": "https://x.example//a",  "b": 1 } \n',
    );
  });
});
