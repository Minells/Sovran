import { describe, expect, it } from 'vitest';
import { AgentRunner, type AgentSettings } from '../../src/core/agent/agentRunner';
import type { AgentEvent } from '../../src/core/agent/events';
import { CheckpointRecorder, planRestore, restoreFiles } from '../../src/core/checkpoints/checkpoints';
import { BUILTIN_COMMANDS, expandCommand, mergeCommands, parseCustomCommand, parseSlash } from '../../src/core/commands/slashCommands';
import { planCompaction, renderForSummary } from '../../src/core/context/compaction';
import { nullLogger } from '../../src/core/ports';
import { MemoryCapabilityStore } from '../../src/core/providers/capabilities';
import { messagesForModel, type Session, type SessionMessage } from '../../src/core/sessions/model';
import { createBuiltinRegistry } from '../../src/core/tools/builtin';
import { searchFilesTool } from '../../src/core/tools/builtin/readTools';
import { fuzzyScore, rankFuzzy } from '../../src/core/util/fuzzy';
import { FakeProcess, MemoryWorkspace, ScriptedApprovals, ScriptedProvider, call, text } from '../fixtures/fakes';

const settings: AgentSettings = {
  maxIterations: 10,
  policy: { fileEdits: 'auto', allowedCommands: [], protectedPaths: ['**/.env'] },
  tools: { terminalTimeoutMs: 1000, maxToolResultChars: 20_000, protectedPaths: ['**/.env'] },
  defaultContextWindow: 32_768,
  defaultMaxOutputTokens: 4096,
};

describe('checkpoints', () => {
  it('snapshots each file before its first write, and restores clean files', async () => {
    const ws = new MemoryWorkspace({ 'a.ts': 'original' });
    const rec = new CheckpointRecorder(ws);
    await rec.writeFile(ws.abs('a.ts'), 'v1');
    await rec.writeFile(ws.abs('a.ts'), 'v2');
    await rec.writeFile(ws.abs('new.ts'), 'created');
    const files = rec.changedFiles();
    expect(files.map((f) => [f.existed, f.before])).toEqual([
      [true, 'original'],
      [false, ''],
    ]);
    const plan = await planRestore(files, ws);
    expect(plan.map((p) => p.state)).toEqual(['clean', 'clean']);
    const res = await restoreFiles(plan, ws, false);
    expect(res.restored).toHaveLength(2);
    expect(ws.get('a.ts')).toBe('original');
    expect(ws.get('new.ts')).toBeUndefined();
  });

  it('detects files the user changed afterwards and skips them unless forced', async () => {
    const ws = new MemoryWorkspace({ 'a.ts': 'original' });
    const rec = new CheckpointRecorder(ws);
    await rec.writeFile(ws.abs('a.ts'), 'agent');
    ws.set('a.ts', 'user edit after agent');
    const plan = await planRestore(rec.changedFiles(), ws);
    expect(plan[0]!.state).toBe('modified');
    expect((await restoreFiles(plan, ws, false)).skipped).toHaveLength(1);
    expect(ws.get('a.ts')).toBe('user edit after agent');
    await restoreFiles(plan, ws, true);
    expect(ws.get('a.ts')).toBe('original');
  });

  it('ignores writes that end up identical to the original', async () => {
    const ws = new MemoryWorkspace({ 'a.ts': 'same' });
    const rec = new CheckpointRecorder(ws);
    await rec.writeFile(ws.abs('a.ts'), 'other');
    await rec.writeFile(ws.abs('a.ts'), 'same');
    expect(rec.changedFiles()).toHaveLength(0);
  });

  it('records agent edits transparently when the runner uses a recorder', async () => {
    const ws = new MemoryWorkspace({ 'src/a.ts': 'const a = 1;\n' });
    const rec = new CheckpointRecorder(ws);
    const runner = new AgentRunner({
      provider: new ScriptedProvider([[call(0, 'edit_file', { path: 'src/a.ts', old_string: '1', new_string: '2' })], [text('done')]]),
      registry: createBuiltinRegistry(),
      workspace: rec,
      process: new FakeProcess(),
      approvals: new ScriptedApprovals(),
      capabilities: new MemoryCapabilityStore(),
      logger: nullLogger,
    });
    const session: Session = { id: 's', title: 't', createdAt: 0, updatedAt: 0, mode: 'act', messages: [{ role: 'user', id: 'u', content: 'go', createdAt: 0 }] };
    await runner.run({ session, providerId: 'p', model: { id: 'm' }, mode: 'act', settings, grants: { edits: false }, signal: new AbortController().signal, emit: () => {} });
    expect(rec.changedFiles().map((f) => f.before)).toEqual(['const a = 1;\n']);
  });
});

describe('compaction', () => {
  const turn = (i: number, big = 'x'.repeat(5000)): SessionMessage[] => [
    { role: 'user', id: `u${i}`, content: `question ${i}`, createdAt: 0 },
    { role: 'assistant', id: `a${i}`, content: '', toolCalls: [{ id: `c${i}`, name: 'read_file', arguments: '{"path":"f"}' }], createdAt: 0 },
    { role: 'tool', id: `t${i}`, toolCallId: `c${i}`, toolName: 'read_file', content: big, status: 'success', createdAt: 0 },
    // Assistant prose cannot be elided like tool output, so these turns really overflow the window.
    { role: 'assistant', id: `b${i}`, content: `answer ${i} ${'y'.repeat(4000)}`, createdAt: 0 },
  ];

  it('cuts only at user-turn boundaries and keeps the last turns', () => {
    const msgs = [...turn(1), ...turn(2), ...turn(3)];
    expect(planCompaction(msgs, 2)).toEqual({ firstKeptIndex: 4 });
    expect(planCompaction(turn(1), 2)).toBeNull();
    const text = renderForSummary(msgs.slice(0, 4), 'old summary', 3000);
    expect(text).toContain('PREVIOUS SUMMARY:\nold summary');
    expect(text).toContain('ASSISTANT CALLED read_file');
    expect(text.length).toBeLessThan(3200);
  });

  it('auto-compacts once when the context is full, then sends the summary instead of old turns', async () => {
    const provider = new ScriptedProvider([
      (req) => {
        expect(req.tools).toBeUndefined();
        expect(req.messages[0]!.content).toMatch(/compress the history/);
        return [text('<think>hmm</think>## Goal\nShip the TTL change')];
      },
      (req) => {
        expect(req.messages[0]!.content).toContain('# Summary of the earlier conversation\n## Goal\nShip the TTL change');
        expect(req.messages.some((m) => m.content?.includes('question 1'))).toBe(false);
        return [text('final answer')];
      },
    ]);
    const runner = new AgentRunner({
      provider,
      registry: createBuiltinRegistry(),
      workspace: new MemoryWorkspace(),
      process: new FakeProcess(),
      approvals: new ScriptedApprovals(),
      capabilities: new MemoryCapabilityStore(),
      logger: nullLogger,
    });
    const session: Session = {
      id: 's',
      title: 't',
      createdAt: 0,
      updatedAt: 0,
      mode: 'act',
      messages: [...turn(1), ...turn(2), ...turn(3), { role: 'user', id: 'u4', content: 'now finish', createdAt: 0 }],
    };
    const events: AgentEvent[] = [];
    const outcome = await runner.run({
      session,
      providerId: 'p',
      model: { id: 'm', contextWindow: 4000, maxOutputTokens: 500 },
      mode: 'act',
      settings,
      grants: { edits: false },
      signal: new AbortController().signal,
      emit: (e) => events.push(e),
      autoCompact: true,
    });
    expect(outcome.reason).toBe('completed');
    expect(session.compaction).toMatchObject({ firstKeptId: 'u3', summarizedCount: 8 });
    expect(session.compaction!.summary).not.toContain('<think>');
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['compaction_started', 'compacted', 'context']));
    expect(messagesForModel(session)[0]!.id).toBe('u3');
    // The transcript itself is untouched.
    expect(session.messages[0]!.id).toBe('u1');
  });

  it('falls back to dropping turns when summarization fails', async () => {
    const runner = new AgentRunner({
      provider: new ScriptedProvider([new Error('boom'), [text('ok')]]),
      registry: createBuiltinRegistry(),
      workspace: new MemoryWorkspace(),
      process: new FakeProcess(),
      approvals: new ScriptedApprovals(),
      capabilities: new MemoryCapabilityStore(),
      logger: nullLogger,
    });
    const session: Session = { id: 's', title: 't', createdAt: 0, updatedAt: 0, mode: 'act', messages: [...turn(1), ...turn(2), ...turn(3), { role: 'user', id: 'u4', content: 'go', createdAt: 0 }] };
    const events: AgentEvent[] = [];
    await runner.run({
      session, providerId: 'p', model: { id: 'm', contextWindow: 4000, maxOutputTokens: 500 }, mode: 'act', settings,
      grants: { edits: false }, signal: new AbortController().signal, emit: (e) => events.push(e), autoCompact: true,
    });
    expect(session.compaction).toBeUndefined();
    expect(events.some((e) => e.type === 'notice' && /Could not summarize/.test(e.message))).toBe(true);
  });

  it('forwards server-reported usage', async () => {
    const runner = new AgentRunner({
      provider: new ScriptedProvider([[text('hi'), { type: 'usage', promptTokens: 1234, completionTokens: 5 }]]),
      registry: createBuiltinRegistry(),
      workspace: new MemoryWorkspace(),
      process: new FakeProcess(),
      approvals: new ScriptedApprovals(),
      capabilities: new MemoryCapabilityStore(),
      logger: nullLogger,
    });
    const events: AgentEvent[] = [];
    const session: Session = { id: 's', title: 't', createdAt: 0, updatedAt: 0, mode: 'act', messages: [{ role: 'user', id: 'u', content: 'go', createdAt: 0 }] };
    await runner.run({ session, providerId: 'p', model: { id: 'm' }, mode: 'act', settings, grants: { edits: false }, signal: new AbortController().signal, emit: (e) => events.push(e) });
    expect(events).toContainEqual({ type: 'usage', promptTokens: 1234, completionTokens: 5 });
    expect(events.find((e) => e.type === 'context')).toMatchObject({ contextWindow: 32_768, budgetTokens: 32_768 - 4096 });
  });
});

describe('search_files with a fast search port', () => {
  it('still filters protected paths returned by the searcher', async () => {
    const ws = new MemoryWorkspace({ 'src/a.ts': 'TOKEN', '.env': 'TOKEN=secret' });
    ws.searchText = async () => ({
      matches: [
        { path: ws.abs('src/a.ts'), line: 1, text: 'TOKEN' },
        { path: ws.abs('.env'), line: 1, text: 'TOKEN=secret' },
      ],
      limitHit: false,
    });
    const r = await searchFilesTool.execute(
      { query: 'TOKEN', is_regex: false, case_sensitive: false, glob: '**/*', max_results: 50 },
      { workspace: ws, process: new FakeProcess(), signal: new AbortController().signal, settings: settings.tools },
      { paths: [] },
    );
    expect(r.content).toContain('src/a.ts:1: TOKEN');
    expect(r.content).not.toContain('secret');
  });
});

describe('slash commands', () => {
  it('parses and expands built-ins with a sensible default target', () => {
    expect(parseSlash('/Review src/a.ts')).toEqual({ name: 'review', args: 'src/a.ts' });
    expect(parseSlash('not a command')).toBeNull();
    const review = BUILTIN_COMMANDS.find((c) => c.name === 'review')!;
    expect(expandCommand(review, 'src/a.ts')).toContain('Review src/a.ts like a senior engineer');
    expect(expandCommand(review, '')).toContain('Review the attached code');
  });
  it('loads custom commands and never lets them override actions', () => {
    const custom = parseCustomCommand('Release-Notes.md', '# Draft release notes\nSummarize changes since the last tag.');
    expect(custom).toMatchObject({ name: 'release-notes', description: 'Draft release notes', source: 'workspace' });
    expect(expandCommand(custom!, 'v1.2')).toMatch(/last tag\.\n\nv1\.2$/);
    expect(parseCustomCommand('bad name!.md', 'x')).toBeNull();
    const merged = mergeCommands([
      { name: 'compact', description: 'evil', kind: 'prompt', source: 'workspace', template: 'x' },
      { name: 'review', description: 'team review', kind: 'prompt', source: 'workspace', template: 'y' },
    ]);
    expect(merged.find((c) => c.name === 'compact')!.kind).toBe('action');
    expect(merged.find((c) => c.name === 'review')!.description).toBe('team review');
  });
});

describe('fuzzy matching', () => {
  it('prefers file-name and word-start matches', () => {
    const files = ['src/assessment/index.ts', 'src/auth/session.ts', 'docs/SESSION_NOTES.md', 'test/sess.spec.ts'];
    expect(rankFuzzy('sess', files, 4)[0]).toBe('test/sess.spec.ts');
    expect(rankFuzzy('authses', files, 4)[0]).toBe('src/auth/session.ts');
    expect(fuzzyScore('xyz', 'src/a.ts')).toBeNull();
  });
});
