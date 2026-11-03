import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppState, HostMessage, WebviewMessage } from '../../src/shared/protocol';
import { App } from './App';
import { renderMarkdown } from './lib/markdown';
import { reducer, initialUiState } from './state/store';
import { onPost, setUiState } from './vscode';

const baseState = (over: Partial<AppState> = {}): AppState => ({
  view: 'chat',
  workspace: { name: 'w', trusted: true, hasFolder: true },
  providers: [{ id: 'local', name: 'Local', baseUrl: 'http://localhost:1234/v1', authType: 'none', hasKey: false, models: [{ id: 'coder', toolMode: 'auto' }] }],
  selected: { providerId: 'local', modelId: 'coder' },
  mode: 'act',
  sessions: [],
  session: { id: 's', title: 'New chat', messages: [] },
  run: null,
  approvals: [],
  context: { editor: { path: 'src/a.ts', label: 'a.ts' }, includeEditor: true, attachments: [] },
  grants: { edits: false },
  fileEdits: 'ask',
  planModel: null,
  usage: null,
  compaction: null,
  commands: [
    { name: 'review', description: 'Review code', source: 'builtin' },
    { name: 'compact', description: 'Summarize older messages', source: 'builtin' },
  ],
  ...over,
});

let sent: WebviewMessage[] = [];
let unsubscribe: () => void;
beforeEach(() => {
  setUiState({ draft: '' }); // drafts persist across mounts by design; isolate tests
  sent = [];
  unsubscribe = onPost((m) => sent.push(m));
});
afterEach(() => unsubscribe());

function host(m: HostMessage) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: m }));
  });
}

function mount(state: AppState) {
  const utils = render(<App />);
  host({ type: 'state', state });
  return utils;
}

describe('App', () => {
  it('handshakes with the host and renders the empty state with starters', () => {
    mount(baseState());
    expect(sent[0]).toEqual({ type: 'ready' });
    expect(screen.getByRole('img', { name: /Own your intelligence/ })).toBeInTheDocument();
    expect(screen.getByText('Act mode · you approve every change')).toBeInTheDocument();
  });

  it('shows onboarding without a composer when no provider exists', () => {
    mount(baseState({ providers: [], selected: null }));
    expect(screen.getByText('Connect a model you control')).toBeInTheDocument();
    expect(screen.queryByLabelText('Message Sovran')).not.toBeInTheDocument();
  });

  it('sends on Enter, keeps Shift+Enter as newline, and clears the draft', async () => {
    mount(baseState());
    const box = screen.getByLabelText('Message Sovran');
    await userEvent.type(box, 'first line{Shift>}{Enter}{/Shift}second');
    expect(box).toHaveValue('first line\nsecond');
    await userEvent.type(box, '{Enter}');
    expect(sent).toContainEqual({ type: 'send', text: 'first line\nsecond' });
    expect(box).toHaveValue('');
  });

  it('streams assistant deltas into the transcript', () => {
    mount(baseState({ session: { id: 's', title: 't', messages: [{ role: 'user', id: 'u', content: 'hi', createdAt: 0 }] } }));
    host({ type: 'messageUpsert', sessionId: 's', message: { role: 'assistant', id: 'a', content: '', streaming: true, createdAt: 0 } });
    host({ type: 'messageDelta', sessionId: 's', messageId: 'a', field: 'content', text: 'Hello **wor' });
    host({ type: 'messageDelta', sessionId: 's', messageId: 'a', field: 'content', text: 'ld**' });
    expect(screen.getByText('world').tagName).toBe('STRONG');
    // Deltas for another session are ignored.
    host({ type: 'messageDelta', sessionId: 'other', messageId: 'a', field: 'content', text: 'LEAK' });
    expect(screen.queryByText(/LEAK/)).not.toBeInTheDocument();
  });

  it('renders an approval card inline and sends the decision with a session grant', async () => {
    const messages: AppState['session'] = {
      id: 's',
      title: 't',
      messages: [
        { role: 'user', id: 'u', content: 'edit', createdAt: 0 },
        { role: 'assistant', id: 'a', content: '', createdAt: 0, toolCalls: [{ id: 'c1', name: 'edit_file', arguments: '{"path":"src/a.ts"}' }] },
      ],
    };
    mount(
      baseState({
        session: messages,
        run: { sessionId: 's', iteration: 1, maxIterations: 25, startedAt: Date.now(), activity: { phase: 'awaiting_approval', label: 'src/a.ts', callId: 'c1' } },
        approvals: [{ id: 'ap', callId: 'c1', toolName: 'edit_file', title: 'src/a.ts', detail: { kind: 'edit', path: 'src/a.ts', isNew: false, diff: '@@ -1 +1 @@\n-a\n+b', added: 1, removed: 1 } }],
      }),
    );
    const card = screen.getByRole('region', { name: 'Apply these changes?' });
    expect(screen.getByText('Waiting for your approval')).toBeInTheDocument();
    await userEvent.click(within(card).getByLabelText(/without asking/));
    await userEvent.click(within(card).getByRole('button', { name: 'Apply' }));
    expect(sent).toContainEqual({ type: 'approval', id: 'ap', approved: true, grant: 'session-edits', feedback: undefined });
  });

  it('rejects with feedback', async () => {
    mount(
      baseState({
        session: { id: 's', title: 't', messages: [{ role: 'assistant', id: 'a', content: '', createdAt: 0, toolCalls: [{ id: 'c1', name: 'execute_terminal', arguments: '{"command":"rm -rf build"}' }] }] },
        run: { sessionId: 's', iteration: 1, maxIterations: 25, startedAt: Date.now(), activity: { phase: 'awaiting_approval', label: 'rm', callId: 'c1' } },
        approvals: [{ id: 'ap', callId: 'c1', toolName: 'execute_terminal', title: 'rm -rf build', detail: { kind: 'command', command: 'rm -rf build', cwd: '.', warnings: ['Recursively force-deletes files.'] } }],
      }),
    );
    expect(screen.getByText('Recursively force-deletes files.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Reject…' }));
    await userEvent.type(screen.getByLabelText('Feedback for the agent'), 'use npm run clean');
    await userEvent.click(screen.getByRole('button', { name: 'Send rejection' }));
    expect(sent).toContainEqual({ type: 'approval', id: 'ap', approved: false, grant: undefined, feedback: 'use npm run clean' });
  });

  it('switches mode via the radio group and Alt+M, and disables Act when untrusted', async () => {
    mount(baseState());
    await userEvent.click(screen.getByRole('radio', { name: /Plan/ }));
    expect(sent).toContainEqual({ type: 'setMode', mode: 'plan' });
    fireEvent.keyDown(screen.getByLabelText('Message Sovran'), { key: 'm', altKey: true });
    expect(sent.filter((m) => m.type === 'setMode')).toHaveLength(2);
    host({ type: 'patch', patch: { workspace: { name: 'w', trusted: false, hasFolder: true }, mode: 'plan' } });
    expect(screen.getByRole('radio', { name: /Act/ })).toBeDisabled();
    expect(screen.getByRole('note')).toHaveTextContent('Restricted Mode');
  });

  it('shows a stop button while running and cancels with Escape', () => {
    mount(baseState({ run: { sessionId: 's', iteration: 2, maxIterations: 25, startedAt: Date.now(), activity: { phase: 'thinking', label: 'Thinking' } } }));
    expect(screen.getByLabelText('Stop the agent')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByLabelText('Message Sovran'), { key: 'Escape' });
    expect(sent).toContainEqual({ type: 'cancel' });
  });

  it('renders provider errors with a hint and a settings action', () => {
    mount(
      baseState({
        session: { id: 's', title: 't', messages: [{ role: 'assistant', id: 'a', content: '', createdAt: 0, error: { kind: 'network', message: 'Connection refused', hint: 'Is the server running?' } }] },
      }),
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Connection refused');
    expect(screen.getByText('Is the server running?')).toBeInTheDocument();
  });
});

describe('v0.2 recovery & productivity', () => {
  const doneTurn = (over: Partial<Extract<AppState['session'], object>['messages'][number]> = {}) =>
    baseState({
      session: {
        id: 's',
        title: 't',
        messages: [
          { role: 'user', id: 'u1', content: 'expanded prompt', display: '/review a.ts', createdAt: 0, checkpoint: { id: 'cp', files: ['src/a.ts', 'src/b.ts'] }, ...over } as never,
          { role: 'assistant', id: 'a1', content: 'Done.', createdAt: 0 },
        ],
      },
    });

  it('shows what the user typed, the changed files and an Undo action', async () => {
    mount(doneTurn());
    expect(screen.getByText('/review a.ts')).toBeInTheDocument();
    expect(screen.queryByText('expanded prompt')).not.toBeInTheDocument();
    expect(screen.getByText(/2 files changed/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Undo changes' }));
    expect(sent).toContainEqual({ type: 'restoreCheckpoint', messageId: 'u1' });
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(sent).toContainEqual({ type: 'retry' });
  });

  it('marks undone changes and hides Undo', () => {
    mount(doneTurn({ checkpoint: { id: 'cp', files: ['src/a.ts'], restoredAt: 1 } } as never));
    expect(screen.getByText(/Changes to 1 file undone/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Undo changes' })).not.toBeInTheDocument();
  });

  it('edits and resends a previous message', async () => {
    mount(doneTurn());
    await userEvent.click(screen.getByRole('button', { name: 'Edit and resend' }));
    const box = screen.getByLabelText('Edit message');
    expect(box).toHaveValue('/review a.ts');
    await userEvent.clear(box);
    await userEvent.type(box, 'review b.ts instead{Enter}');
    expect(sent).toContainEqual({ type: 'editMessage', messageId: 'u1', text: 'review b.ts instead' });
  });

  it('shows the context meter with a warning level and compacts on click', async () => {
    mount(baseState({ usage: { tokens: 26_000, contextWindow: 32_768, source: 'estimate' } }));
    const meter = screen.getByRole('button', { name: /Context 79% used/ });
    expect(meter).toHaveAttribute('data-level', 'mid');
    expect(meter).toHaveTextContent('26k/33k');
    await userEvent.click(meter);
    expect(sent).toContainEqual({ type: 'compact' });
  });

  it('renders the compaction divider with the summary', () => {
    mount({ ...doneTurn(), compaction: { summary: '## Goal\nShip it', firstKeptId: 'u1', summarizedCount: 6 } });
    expect(screen.getByText(/6 earlier messages summarized/)).toBeInTheDocument();
  });

  it('completes slash commands from the popup with the keyboard', async () => {
    mount(baseState());
    const box = screen.getByLabelText('Message Sovran');
    await userEvent.type(box, '/re');
    const list = screen.getByRole('listbox', { name: 'Commands' });
    expect(within(list).getAllByRole('option').map((o) => o.textContent)).toEqual([expect.stringContaining('/review')]);
    await userEvent.keyboard('{Enter}');
    expect(box).toHaveValue('/review ');
    expect(sent.some((m) => m.type === 'send')).toBe(false);
  });

  it('suggests files for @-mentions and attaches the chosen one', async () => {
    mount(baseState());
    const box = screen.getByLabelText('Message Sovran');
    await userEvent.type(box, 'look at @sess');
    await waitFor(() => expect(sent.some((m) => m.type === 'suggestFiles')).toBe(true));
    const req = [...sent].reverse().find((m) => m.type === 'suggestFiles') as Extract<WebviewMessage, { type: 'suggestFiles' }>;
    expect(req.query).toBe('sess');
    host({ type: 'fileSuggestions', requestId: req.requestId, items: [{ path: 'src/auth/session.ts', label: 'session.ts' }, { path: 'docs/sessions.md', label: 'sessions.md' }] });
    expect(screen.getAllByRole('option')).toHaveLength(2);
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(sent).toContainEqual({ type: 'attachPath', path: 'docs/sessions.md' });
    expect(box).toHaveValue('look at ');
  });

  it('shows the Plan model in Plan mode', () => {
    mount(
      baseState({
        mode: 'plan',
        providers: [{ id: 'local', name: 'Local', baseUrl: 'http://x/v1', authType: 'none', hasKey: false, models: [{ id: 'coder', toolMode: 'auto' }, { id: 'thinker', toolMode: 'auto' }] }],
        planModel: { providerId: 'local', modelId: 'thinker' },
      }),
    );
    expect(screen.getByTitle(/Plan model · Local · thinker/)).toBeInTheDocument();
  });
});

describe('brand refresh UX', () => {
  it('folds consecutive successful reads into one exploration row', async () => {
    const read = (id: string, name: string, args: string) => [
      { role: 'assistant', id: `a${id}`, content: '', createdAt: 0, toolCalls: [{ id: `c${id}`, name, arguments: args }] },
      { role: 'tool', id: `t${id}`, toolCallId: `c${id}`, toolName: name, content: 'ok', status: 'success', createdAt: 0 },
    ];
    mount(
      baseState({
        session: {
          id: 's',
          title: 't',
          messages: [
            { role: 'user', id: 'u', content: 'go', createdAt: 0 },
            ...read('1', 'read_file', '{"path":"src/a.ts"}'),
            ...read('2', 'read_file', '{"path":"src/b.ts"}'),
            ...read('3', 'search_files', '{"query":"TTL"}'),
            { role: 'assistant', id: 'a4', content: 'Found it.', createdAt: 0 },
          ] as never,
        },
      }),
    );
    const row = screen.getByRole('button', { name: /Explored/ });
    expect(row).toHaveTextContent('2 files read, 1 search');
    expect(screen.queryByText('src/a.ts')).not.toBeInTheDocument();
    await userEvent.click(row);
    expect(screen.getByText('src/a.ts')).toBeInTheDocument();
  });

  it('shows keyboard hints only while the composer is focused', async () => {
    mount(baseState());
    expect(screen.queryByText('commands')).not.toBeInTheDocument();
    await userEvent.click(screen.getByLabelText('Message Sovran'));
    expect(screen.getByText('commands')).toBeInTheDocument();
  });
});

describe('markdown safety', () => {
  it('never renders raw HTML or javascript: links from model output', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)><script>alert(1)</script> [x](javascript:alert(1)) [ok](https://example.com)');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).not.toMatch(/href="javascript:/i);
    expect(html).toContain('href="https://example.com"');
  });
  it('makes workspace paths clickable and highlights code', () => {
    expect(renderMarkdown('see `src/a.ts:12`')).toContain('data-path="src/a.ts" data-line="12"');
    expect(renderMarkdown('```ts\nconst a = 1;\n```')).toContain('hljs-keyword');
  });
});

describe('approval spoofing defense', () => {
  it('reveals hidden and bidi characters in commands', async () => {
    const { revealHidden } = await import('./components/Transcript');
    expect(revealHidden('ls \u202Eabc\u200B')).toBe('ls ⟨U+202E⟩abc⟨U+200B⟩');
  });
});

describe('reducer', () => {
  it('caps notices and ignores patches before the first state', () => {
    let s = reducer(initialUiState, { type: 'patch', patch: { mode: 'plan' } });
    expect(s.app).toBeNull();
    for (let i = 0; i < 5; i++) s = reducer(s, { type: 'notice', id: String(i), level: 'info', message: `n${i}` });
    expect(s.notices.map((n) => n.message)).toEqual(['n2', 'n3', 'n4']);
  });
});
