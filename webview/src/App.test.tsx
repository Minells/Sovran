import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppState, HostMessage, WebviewMessage } from '../../src/shared/protocol';
import { App } from './App';
import { renderMarkdown } from './lib/markdown';
import { reducer, initialUiState } from './state/store';
import { onPost } from './vscode';

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
  ...over,
});

let sent: WebviewMessage[] = [];
let unsubscribe: () => void;
beforeEach(() => {
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
    expect(screen.getByText('Own your intelligence.')).toBeInTheDocument();
    expect(screen.getByText('Act mode · you approve every change')).toBeInTheDocument();
  });

  it('shows onboarding without a composer when no provider exists', () => {
    mount(baseState({ providers: [], selected: null }));
    expect(screen.getByText('Connect a model you control')).toBeInTheDocument();
    expect(screen.queryByLabelText('Message SOVRAN')).not.toBeInTheDocument();
  });

  it('sends on Enter, keeps Shift+Enter as newline, and clears the draft', async () => {
    mount(baseState());
    const box = screen.getByLabelText('Message SOVRAN');
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
    fireEvent.keyDown(screen.getByLabelText('Message SOVRAN'), { key: 'm', altKey: true });
    expect(sent.filter((m) => m.type === 'setMode')).toHaveLength(2);
    host({ type: 'patch', patch: { workspace: { name: 'w', trusted: false, hasFolder: true }, mode: 'plan' } });
    expect(screen.getByRole('radio', { name: /Act/ })).toBeDisabled();
    expect(screen.getByRole('note')).toHaveTextContent('Restricted Mode');
  });

  it('shows a stop button while running and cancels with Escape', () => {
    mount(baseState({ run: { sessionId: 's', iteration: 2, maxIterations: 25, startedAt: Date.now(), activity: { phase: 'thinking', label: 'Thinking' } } }));
    expect(screen.getByLabelText('Stop the agent')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByLabelText('Message SOVRAN'), { key: 'Escape' });
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

describe('reducer', () => {
  it('caps notices and ignores patches before the first state', () => {
    let s = reducer(initialUiState, { type: 'patch', patch: { mode: 'plan' } });
    expect(s.app).toBeNull();
    for (let i = 0; i < 5; i++) s = reducer(s, { type: 'notice', id: String(i), level: 'info', message: `n${i}` });
    expect(s.notices.map((n) => n.message)).toEqual(['n2', 'n3', 'n4']);
  });
});
