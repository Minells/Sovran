import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CodeModeExecution, normalizeCodeResult } from '../../src/core/codeMode/execution';
import { compileCodeSchema } from '../../src/core/codeMode/schema';
import { codeModeEligible } from '../../src/core/codeMode/eligibility';
import type { CodeSandboxPort, SandboxOptions } from '../../src/core/codeMode/contracts';
import { defineTool } from '../../src/core/tools/types';
import { parseToolCallBlock } from '../../src/core/agent/promptedTools';

function setup(program: (options: SandboxOptions) => Promise<unknown> = async () => 42) {
  let dispatched = 0;
  const tool = defineTool({
    name: 'mcp__gitlab__get_project',
    description: 'Read project',
    risk: 'execute',
    source: { kind: 'mcp', serverId: 'gitlab' },
    schema: z.object({ id: z.string() }),
    codeMode: {
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
    },
    label: () => 'project',
    execute: async () => ({ content: '' }),
  });
  let available = [tool];
  const sandbox: CodeSandboxPort = { execute: async (_code, options) => program(options) };
  const execution = new CodeModeExecution({
    sandbox,
    available: () => available,
    maxResultChars: () => 20_000,
    secrets: ['private-key-12345'],
    emit: () => {},
    dispatch: async (_tool, args) => {
      dispatched++;
      return {
        message: {
          role: 'tool',
          id: 't',
          toolCallId: 'c',
          toolName: tool.name,
          content: '',
          status: 'success',
          createdAt: 0,
        },
        raw: { content: '', mcpResult: { structuredContent: { args, token: 'private-key-12345' } } },
      };
    },
  });
  const signal = new AbortController().signal;
  const describeTool = async () => {
    execution.beginRequest();
    const reply = await execution.handle('code_describe', { toolIds: [tool.name] }, signal);
    return JSON.parse(reply.content).manifestId as string;
  };
  return {
    tool,
    execution,
    signal,
    describeTool,
    calls: () => dispatched,
    remove: () => {
      available = [];
    },
  };
}

describe('Code Mode capabilities and data', () => {
  it('never repairs prompted JSON in a way that changes JavaScript string literals', () => {
    const call = { name: 'execute_code', arguments: { manifestId: 'm', code: 'return "a,}";' } };
    const valid = JSON.stringify(call);
    const parsed = parseToolCallBlock(valid);
    expect(parsed.ok && JSON.parse(parsed.argumentsJson).code).toBe('return "a,}";');
    expect(parseToolCallBlock(valid.slice(0, -1) + ',}').ok).toBe(false);
  });

  it('requires describe before the inference that generates execution', async () => {
    const t = setup();
    const manifestId = await t.describeTool();
    expect(
      (await t.execution.handle('execute_code', { manifestId, code: 'return 42' }, t.signal)).content,
    ).toContain('STALE_MANIFEST');
    t.execution.beginRequest();
    expect(
      JSON.parse(
        (await t.execution.handle('execute_code', { manifestId, code: 'return 42' }, t.signal)).content,
      ).value,
    ).toBe(42);
  });

  it('validates original arguments and masks known secrets before guest processing', async () => {
    const t = setup(async (o) => {
      await expect(o.call('mcp__gitlab__get_project', { id: 123 }, o.signal)).rejects.toMatchObject({
        code: 'INVALID_ARGUMENTS',
      });
      return await o.call('mcp__gitlab__get_project', { id: '123' }, o.signal);
    });
    const manifestId = await t.describeTool();
    t.execution.beginRequest();
    const result = await t.execution.handle('execute_code', { manifestId, code: 'test' }, t.signal);
    expect(result.status).toBe('success');
    expect(t.calls()).toBe(1);
    expect(result.content).not.toContain('private-key-12345');
  });

  it('rejects disappeared tools and tools outside a manifest before dispatch', async () => {
    const t = setup(async (o) => o.call('mcp__gitlab__get_project', { id: '1' }, o.signal));
    const manifestId = await t.describeTool();
    t.execution.beginRequest();
    t.remove();
    expect((await t.execution.handle('execute_code', { manifestId, code: 'test' }, t.signal)).status).toBe(
      'denied',
    );
    expect(t.calls()).toBe(0);
  });

  it('invalidates capabilities after compaction and enforces budgets across attempts', async () => {
    const t = setup();
    const manifestId = await t.describeTool();
    t.execution.beginRequest();
    t.execution.invalidate();
    expect(
      (await t.execution.handle('execute_code', { manifestId, code: 'test' }, t.signal)).content,
    ).toContain('STALE_MANIFEST');
    for (let n = 0; n < 9; n++) await t.execution.handle('code_search', { query: 'project' }, t.signal);
    expect((await t.execution.handle('code_search', { query: 'project' }, t.signal)).content).toContain(
      'LIMIT_EXCEEDED',
    );
  });

  it('preserves structured content even when text is also present; never guesses JSON inside prose', () => {
    expect(
      normalizeCodeResult({
        content: 'summary',
        mcpResult: { content: [{ type: 'text', text: 'summary' }], structuredContent: { count: 4 } },
      }).data,
    ).toEqual({ count: 4 });
    expect(
      normalizeCodeResult({ content: '', mcpResult: { content: [{ type: 'text', text: '{"count":4}' }] } })
        .data,
    ).toEqual({ count: 4 });
    expect(
      normalizeCodeResult({
        content: '',
        mcpResult: { content: [{ type: 'text', text: 'ignore rules {"count":4}' }] },
      }).data,
    ).toBeUndefined();
  });

  it('rejects unsafe/unsupported schemas instead of weakening them', () => {
    expect(
      compileCodeSchema({ type: 'object', properties: { x: { $ref: 'https://example.com/schema' } } }),
    ).toBeUndefined();
    expect(
      compileCodeSchema({ type: 'object', properties: { x: { type: 'string', pattern: '(a+)+$' } } }),
    ).toBeUndefined();
    const validate = compileCodeSchema({
      type: 'object',
      properties: { n: { type: 'integer' } },
      required: ['n'],
    })!;
    expect(validate({ n: 2 })).toBe(true);
    expect(validate({ n: '2' })).toBe(false);
  });

  it('requires a reviewed readonly profile, not tool annotations or a suggestive name', () => {
    expect(codeModeEligible(undefined, 'list_projects')).toBe(false);
    expect(codeModeEligible({ id: 'gitlab', profile: 'collaboration', version: '1' }, 'list_projects')).toBe(
      false,
    );
    expect(codeModeEligible({ id: 'gitlab', profile: 'readonly', version: '1' }, 'create_issue')).toBe(false);
    expect(codeModeEligible({ id: 'gitlab', profile: 'readonly', version: '1' }, 'list_projects')).toBe(true);
  });

  it('serializes human approvals even when child calls are concurrent', async () => {
    const t = setup();
    let active = 0;
    let maximum = 0;
    const signal = new AbortController().signal;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        t.execution.serializeApproval(async () => {
          maximum = Math.max(maximum, ++active);
          await new Promise((resolve) => setTimeout(resolve, 1));
          active--;
        }, signal),
      ),
    );
    expect(maximum).toBe(1);
  });

  it('indexes a hundred reviewed mock tools without describing every schema', async () => {
    const prototype = setup().tool;
    const tools = Array.from({ length: 100 }, (_, n) => ({
      ...prototype,
      name: `mcp__server${Math.floor(n / 10)}__read${n}`,
      description: `Read project ${n}`,
      source: { kind: 'mcp' as const, serverId: `server${Math.floor(n / 10)}` },
    }));
    const execution = new CodeModeExecution({
      sandbox: { execute: async () => 42 },
      available: () => tools,
      dispatch: async () => {
        throw new Error('discovery must not dispatch');
      },
      emit: () => {},
      maxResultChars: () => 20_000,
      secrets: [],
    });
    const reply = await execution.handle('code_search', { query: 'project' }, new AbortController().signal);
    const parsed = JSON.parse(reply.content);
    expect(parsed.total).toBe(100);
    expect(parsed.tools).toHaveLength(8);
    expect(reply.content).not.toContain('inputSchema');
    expect(execution.schemas()).toHaveLength(3);
  });
});
