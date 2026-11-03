import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  approvalMode: 'ask',
  planModel: null,
  usage: null,
  compaction: null,
  commands: [
    { name: 'review', description: 'Review code', source: 'builtin' },
    { name: 'compact', description: 'Summarize older messages', source: 'builtin' },
  ],
  settings: {
    defaultApprovalMode: 'ask',
    allowedCommands: ['npm test'],
    protectedPaths: ['**/.env'],
    defaultProtectedPaths: ['**/.env', '**/*.pem'],
    maxIterations: 25,
    terminalTimeoutSeconds: 120,
    mirrorToTerminal: true,
    openDiffOnProposal: true,
    includeActiveEditor: true,
    autoCompact: true,
    projectInstructions: true,
    maxToolResultChars: 20000,
    persistSessions: true,
    overriddenByWorkspace: [],
  },
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
  it('handshakes with the host and renders the start page with starters', async () => {
    mount(baseState());
    expect(sent[0]).toEqual({ type: 'ready' });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/\S/);
    expect(screen.getByTitle('Local · coder. Click to change the model.')).toHaveTextContent('coder');
    expect(screen.getByText('on this machine')).toBeInTheDocument();
    expect(screen.getByText('Act mode · you approve every change')).toBeInTheDocument();
    const starters = within(screen.getByRole('list', { name: 'Suggestions' })).getAllByRole('button');
    expect(starters.map((b) => b.textContent)).toEqual([
      expect.stringContaining('Explain a.ts'),
      expect.stringContaining('Fix problems'),
      expect.stringContaining('Write tests'),
      expect.stringContaining('Review my changes'),
    ]);
    await userEvent.click(starters[0]!);
    expect(sent).toContainEqual({ type: 'send', text: 'Explain the active file' });
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
        approvals: [{ id: 'ap', callId: 'c1', toolName: 'execute_terminal', title: 'rm -rf build', detail: { kind: 'command', command: 'rm -rf build', cwd: '.', warnings: ['Deletes files and folders recursively.'], allowPrefix: null } }],
      }),
    );
    expect(screen.getByText('Deletes files and folders recursively.')).toBeInTheDocument();
    // Commands that must always ask are never offered for the allow-list.
    expect(screen.queryByRole('button', { name: 'Always allow…' })).not.toBeInTheDocument();
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

  it('keeps one line of key hints that follows what the keys do right now', async () => {
    mount(baseState());
    // Visible before the composer is focused, so focusing it does not shift the layout.
    expect(screen.getByText('commands')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Message Sovran'), 'hi');
    expect(screen.getByText('new line')).toBeInTheDocument();
    expect(screen.queryByText('commands')).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Message Sovran'), ' /');
    expect(screen.getByText('send')).toBeInTheDocument();
  });

  it('lists every shortcut in a popover and closes it with Escape', async () => {
    mount(baseState());
    const button = screen.getByRole('button', { name: /Shortcuts/ });
    await userEvent.click(button);
    const dialog = screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(within(dialog).getByText('Switch Plan / Act')).toBeInTheDocument();
    expect(within(dialog).getByText('Change approvals')).toBeInTheDocument();
    expect(button).toHaveAttribute('aria-expanded', 'true');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).not.toBeInTheDocument();
    expect(button).toHaveFocus();
  });
});

describe('start page', () => {
  it('builds starters from the selection and fills the composer for Plan a change', async () => {
    const { unmount } = mount(baseState({ context: { editor: { path: 'src/a.ts', label: 'a.ts:3-9', startLine: 3, endLine: 9 }, includeEditor: true, attachments: [] } }));
    await userEvent.click(screen.getByRole('button', { name: /Explain the selection/ }));
    expect(sent).toContainEqual({ type: 'send', text: 'Explain the selected code' });
    unmount();
    sent.length = 0;

    mount(baseState({ mode: 'plan' }));
    expect(screen.getByText('Plan mode · read-only')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Plan a change/ }));
    expect(screen.getByLabelText('Message Sovran')).toHaveValue('Plan how to ');
    expect(screen.getByLabelText('Message Sovran')).toHaveFocus();
    expect(sent.some((m) => m.type === 'send')).toBe(false);
  });

  it('does not offer a file Sovran will not send as a subject', () => {
    mount(baseState({ context: { editor: { path: '/home/u/.aws/credentials', label: 'credentials', blocked: 'outside' }, includeEditor: true, attachments: [] } }));
    expect(screen.getByRole('button', { name: /Explain this workspace/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Explain credentials/ })).not.toBeInTheDocument();
  });

  it('opens a recent chat or the full history', async () => {
    mount(
      baseState({
        sessions: [
          { id: 's', title: 'New chat', createdAt: 0, updatedAt: Date.now(), messageCount: 0 },
          { id: 'old', title: 'Older work', createdAt: 0, updatedAt: Date.now() - 7_200_000, messageCount: 4 },
          { id: 'new', title: 'Latest work', createdAt: 0, updatedAt: Date.now() - 60_000, messageCount: 2 },
        ],
      }),
    );
    const nav = screen.getByRole('navigation', { name: 'Recent chats' });
    // Newest first, and never the chat that is already open.
    expect(within(nav).getAllByRole('listitem').map((li) => li.textContent)).toEqual([expect.stringContaining('Latest work'), expect.stringContaining('Older work')]);
    await userEvent.click(within(nav).getByRole('button', { name: /Latest work/ }));
    expect(sent).toContainEqual({ type: 'openSession', id: 'new' });
    await userEvent.click(within(nav).getByRole('button', { name: /All chats/ }));
    expect(sent).toContainEqual({ type: 'setView', view: 'history' });
  });

  it('shows a warning dot and a model picker when no model is selected', async () => {
    mount(baseState({ selected: null }));
    expect(screen.getByText('No model selected.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Choose a model' }));
    expect(sent).toContainEqual({ type: 'pickModel' });
  });

  it('cycles tips', async () => {
    mount(baseState());
    const tip = () => screen.getByText('Tip').nextElementSibling?.textContent;
    const first = tip();
    await userEvent.click(screen.getByRole('button', { name: 'Next tip' }));
    expect(tip()).not.toBe(first);
  });
});

describe('attach menu', () => {
  const lastOf = <T extends WebviewMessage['type']>(type: T) => [...sent].reverse().find((m) => m.type === type) as Extract<WebviewMessage, { type: T }>;
  const open = async (state = baseState()) => {
    mount(state);
    await userEvent.click(screen.getByRole('button', { name: 'Attach files' }));
    const list = lastOf('listDirectory');
    expect(list.path).toBe('');
    host({
      type: 'directoryListing',
      requestId: list.requestId,
      listing: {
        path: '',
        entries: [
          { name: 'src', path: 'src', type: 'directory' },
          { name: '.env', path: '.env', type: 'file', protected: true },
          { name: 'README.md', path: 'README.md', type: 'file' },
        ],
      },
    });
    await waitFor(() => expect(sent.some((m) => m.type === 'suggestFiles')).toBe(true));
    const suggest = lastOf('suggestFiles');
    expect(suggest.query).toBe('');
    host({
      type: 'fileSuggestions',
      requestId: suggest.requestId,
      items: [
        { path: 'src/a.ts', label: 'a.ts', hint: 'active' },
        { path: 'src/b.ts', label: 'b.ts', hint: 'open' },
        { path: 'zzz.txt', label: 'zzz.txt' },
      ],
    });
    return screen.getByRole('dialog', { name: 'Attach files' });
  };

  it('suggests open files, browses folders and toggles attachments', async () => {
    const dialog = await open();
    expect(within(dialog).getByRole('group', { name: 'Suggested' })).toHaveTextContent(/a\.ts.*active editor.*b\.ts.*open/);
    // Files without a hint are not "suggested".
    expect(within(dialog).queryByText('zzz.txt')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('option', { name: /\.env/ })).toHaveAttribute('title', expect.stringContaining('protected'));

    await userEvent.click(within(dialog).getByRole('option', { name: /README\.md/ }));
    expect(sent).toContainEqual({ type: 'attachPath', path: 'README.md' });
    host({ type: 'patch', patch: { context: { editor: null, includeEditor: true, attachments: [{ id: 'att1', path: 'README.md', label: 'README.md' }] } } });
    const readme = within(dialog).getByRole('option', { name: /README\.md/ });
    expect(readme).toHaveAttribute('aria-selected', 'true');
    await userEvent.click(readme);
    expect(sent).toContainEqual({ type: 'removeAttachment', id: 'att1' });

    await userEvent.click(within(dialog).getByRole('option', { name: 'src, folder' }));
    expect(lastOf('listDirectory').path).toBe('src');
    expect(within(dialog).getByRole('option', { name: 'Up one folder' })).toBeInTheDocument();
    // Backspace in the empty search field goes back up.
    await userEvent.keyboard('{Backspace}');
    expect(lastOf('listDirectory').path).toBe('');
  });

  it('is keyboard operable from the search field', async () => {
    const dialog = await open();
    const search = within(dialog).getByRole('combobox', { name: 'Search files' });
    expect(search).toHaveFocus();
    // Suggested a.ts, b.ts, then src/, .env, README.md: three steps down reach the folder.
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    expect(search).toHaveAttribute('aria-activedescendant', within(dialog).getByRole('option', { name: 'src, folder' }).id);
    await userEvent.keyboard('{ArrowRight}');
    expect(lastOf('listDirectory').path).toBe('src');
    await userEvent.keyboard('{ArrowLeft}');
    expect(lastOf('listDirectory').path).toBe('');
    await userEvent.keyboard('{ArrowUp}{Enter}');
    expect(sent).toContainEqual({ type: 'attachPath', path: 'src/b.ts' });
  });

  it('searches the workspace, uploads from the computer and closes with Escape', async () => {
    const dialog = await open();
    await userEvent.type(within(dialog).getByRole('combobox', { name: 'Search files' }), 'conf');
    await waitFor(() => expect(lastOf('suggestFiles').query).toBe('conf'));
    host({ type: 'fileSuggestions', requestId: lastOf('suggestFiles').requestId, items: [{ path: 'src/config.ts', label: 'config.ts' }] });
    expect(within(dialog).getByRole('group', { name: 'Results' })).toHaveTextContent('config.ts');
    await userEvent.keyboard('{Enter}');
    expect(sent).toContainEqual({ type: 'attachPath', path: 'src/config.ts' });

    // Escape clears the search first, then closes and returns focus to the attach button.
    await userEvent.keyboard('{Escape}');
    expect(within(dialog).getByRole('combobox', { name: 'Search files' })).toHaveValue('');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Attach files' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Attach files' })).toHaveFocus();

    await userEvent.click(screen.getByRole('button', { name: 'Attach files' }));
    await userEvent.click(screen.getByRole('button', { name: /Upload from computer/ }));
    expect(sent).toContainEqual({ type: 'uploadFiles' });
    expect(screen.queryByRole('dialog', { name: 'Attach files' })).not.toBeInTheDocument();
  });

  it('marks files picked from the computer', () => {
    mount(baseState({ context: { editor: null, includeEditor: true, attachments: [{ id: 'x', path: '~/Downloads/spec.md', label: 'spec.md', external: true }] } }));
    expect(screen.getByRole('button', { name: 'Remove spec.md' })).toHaveAttribute('title', expect.stringContaining('from your computer'));
  });

  it('shows the folder error from the host', async () => {
    mount(baseState());
    await userEvent.click(screen.getByRole('button', { name: 'Attach files' }));
    host({ type: 'directoryListing', requestId: lastOf('listDirectory').requestId, listing: { path: '', entries: [], error: 'Open a folder to browse its files.' } });
    expect(screen.getByText('Open a folder to browse its files.')).toBeInTheDocument();
  });
});

describe('response actions', () => {
  const twoTurns = () =>
    baseState({
      session: {
        id: 's',
        title: 't',
        messages: [
          { role: 'user', id: 'u1', content: 'one', createdAt: 0 },
          { role: 'assistant', id: 'a1', content: 'First answer', createdAt: 0 },
          { role: 'user', id: 'u2', content: 'two', createdAt: 0 },
          { role: 'assistant', id: 'a2', content: 'Second answer', createdAt: 0 },
        ],
      },
    });

  it('offers Retry only on the last response, as an icon in a quiet toolbar', () => {
    mount(twoTurns());
    const [first, last] = screen.getAllByRole('toolbar', { name: 'Response actions' });
    expect(within(first!).queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    const retry = within(last!).getByRole('button', { name: 'Retry' });
    expect(retry).not.toHaveTextContent('Retry');
    expect(retry).toHaveAttribute('title', expect.stringContaining('generate this response again'));
  });

  it('copies a response', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    mount(twoTurns());
    const [first] = screen.getAllByRole('button', { name: 'Copy response' });
    await userEvent.click(first!);
    expect(writeText).toHaveBeenCalledWith('First answer');
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('hides the actions while the response is still being written', () => {
    mount({ ...twoTurns(), run: { sessionId: 's', iteration: 1, maxIterations: 25, startedAt: Date.now(), activity: { phase: 'streaming', label: 'Writing' } } });
    expect(screen.getAllByRole('toolbar', { name: 'Response actions' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
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

  it('keeps the latest folder listing with its request id', () => {
    const listing = { path: 'src', entries: [{ name: 'a.ts', path: 'src/a.ts', type: 'file' as const }] };
    const s = reducer(initialUiState, { type: 'directoryListing', requestId: 'r1', listing });
    expect(s.directoryListing).toEqual({ requestId: 'r1', listing });
  });
});

describe('approval modes', () => {
  const commandApproval = (over: Partial<AppState> = {}) =>
    baseState({
      session: { id: 's', title: 't', messages: [{ role: 'assistant', id: 'a', content: '', createdAt: 0, toolCalls: [{ id: 'c1', name: 'execute_terminal', arguments: '{"command":"npm run build -- --prod"}' }] }] },
      run: { sessionId: 's', iteration: 1, maxIterations: 25, startedAt: Date.now(), activity: { phase: 'awaiting_approval', label: 'npm', callId: 'c1' } },
      approvals: [
        {
          id: 'ap',
          callId: 'c1',
          toolName: 'execute_terminal',
          title: 'npm run build -- --prod',
          reason: 'Terminal commands require approval.',
          detail: { kind: 'command', command: 'npm run build -- --prod', cwd: '.', warnings: [], allowPrefix: 'npm run build' },
        },
      ],
      ...over,
    });

  it('offers Ask, Auto-edit and Auto in Act mode and hides the picker in Plan mode', async () => {
    mount(baseState());
    const picker = screen.getByRole('button', { name: /Approvals: Ask/ });
    await userEvent.click(picker);
    const menu = screen.getByRole('menu', { name: 'Approvals in Act mode' });
    expect(within(menu).getAllByRole('menuitemradio').map((i) => i.textContent)).toEqual([
      expect.stringContaining('Ask'),
      expect.stringContaining('Auto-edit'),
      expect.stringContaining('Auto'),
    ]);
    expect(within(menu).getByRole('menuitemradio', { name: 'Ask' })).toHaveAttribute('aria-checked', 'true');
    expect(within(menu).getByRole('menuitemradio', { name: 'Auto' })).toHaveAccessibleDescription(/risky actions still ask/);
    await userEvent.click(within(menu).getByRole('menuitemradio', { name: 'Auto' }));
    expect(sent).toContainEqual({ type: 'setApprovalMode', mode: 'auto' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    host({ type: 'patch', patch: { mode: 'plan' } });
    expect(screen.queryByRole('button', { name: /Approvals:/ })).not.toBeInTheDocument();
  });

  it('is keyboard operable and cycles with Alt+A', async () => {
    mount(baseState({ approvalMode: 'edits' }));
    const picker = screen.getByRole('button', { name: /Approvals: Auto-edit/ });
    picker.focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitemradio', { name: 'Auto-edit' })).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitemradio', { name: 'Auto' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(picker).toHaveFocus();
    fireEvent.keyDown(screen.getByLabelText('Message Sovran'), { key: 'a', altKey: true });
    expect(sent).toContainEqual({ type: 'setApprovalMode', mode: 'auto' });
  });

  it('marks Auto mode in the composer and in the empty state', () => {
    mount(baseState({ approvalMode: 'auto' }));
    expect(screen.getByRole('button', { name: /Approvals: Auto\./ })).toHaveAttribute('data-tone', 'warn');
    expect(screen.getByText('Act mode · Sovran acts without asking')).toBeInTheDocument();
    expect(screen.getByLabelText('Message Sovran')).toHaveAttribute('placeholder', expect.stringContaining('Auto mode'));
  });

  it('explains why Auto mode still asks', () => {
    mount(commandApproval({ approvalMode: 'auto', approvals: [{ ...commandApproval().approvals[0]!, reason: 'Pushes commits to a remote repository.' }] }));
    expect(screen.getByRole('note')).toHaveTextContent('Auto mode still asks here: Pushes commits to a remote repository.');
  });

  it('does not repeat a reason that is already listed as a warning', () => {
    const reason = 'Pushes commits to a remote repository.';
    const base = commandApproval().approvals[0]!;
    const detail = base.detail.kind === 'command' ? { ...base.detail, warnings: [reason] } : base.detail;
    mount(commandApproval({ approvalMode: 'auto', approvals: [{ ...base, reason, detail }] }));
    expect(screen.getByRole('note')).toHaveTextContent('Auto mode still asks here, for the reason below.');
    expect(screen.getAllByText(reason)).toHaveLength(1);
  });

  it('runs and always allows a command prefix the user can narrow', async () => {
    mount(commandApproval());
    await userEvent.click(screen.getByRole('button', { name: 'Always allow…' }));
    const input = screen.getByLabelText('Always run commands that start with:');
    expect(input).toHaveValue('npm run build');
    await userEvent.clear(input);
    await userEvent.type(input, 'npm run lint');
    expect(screen.getByText('The entry must be the start of this command.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run and always allow' })).toBeDisabled();
    await userEvent.clear(input);
    await userEvent.type(input, 'npm run build');
    await userEvent.click(screen.getByRole('button', { name: 'Run and always allow' }));
    expect(sent).toContainEqual({ type: 'approval', id: 'ap', approved: true, grant: undefined, feedback: undefined, allowCommand: 'npm run build' });
  });

  it('labels actions that ran without asking', () => {
    mount(
      baseState({
        session: {
          id: 's',
          title: 't',
          messages: [
            { role: 'assistant', id: 'a', content: '', createdAt: 0, toolCalls: [{ id: 'c1', name: 'execute_terminal', arguments: '{"command":"npm test"}' }] },
            { role: 'tool', id: 't', toolCallId: 'c1', toolName: 'execute_terminal', content: 'ok', status: 'success', createdAt: 0, autoApproved: 'Ran without asking (Auto mode).' },
          ],
        },
      }),
    );
    expect(screen.getByLabelText('Ran without asking (Auto mode).')).toHaveTextContent('auto');
  });

  it('never presents a file outside the workspace as included', () => {
    mount(baseState({ context: { editor: { path: '/home/u/.aws/credentials', label: 'credentials', blocked: 'outside' }, includeEditor: true, attachments: [] } }));
    const chip = screen.getByLabelText(/outside the workspace, so it is not shared/);
    expect(chip.tagName).toBe('SPAN');
    expect(screen.queryByRole('button', { name: /credentials/ })).not.toBeInTheDocument();
  });
});

describe('settings view', () => {
  const settingsState = (over: Partial<AppState> = {}) =>
    baseState({
      view: 'settings',
      providers: [
        { id: 'local', name: 'Local', baseUrl: 'http://localhost:1234/v1', authType: 'none', hasKey: false, models: [{ id: 'coder', toolMode: 'auto' }, { id: 'thinker', toolMode: 'auto' }] },
        { id: 'corp', name: 'Corp', baseUrl: 'http://gw.corp.example/v1', authType: 'bearer', hasKey: true, models: [{ id: 'big', toolMode: 'auto' }] },
      ],
      ...over,
    });

  it('configures the Act and Plan models', async () => {
    mount(settingsState());
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    const plan = screen.getByLabelText('Plan model');
    await userEvent.selectOptions(plan, within(plan).getByRole('option', { name: 'thinker' }));
    expect(sent).toContainEqual({ type: 'setModel', role: 'plan', providerId: 'local', modelId: 'thinker' });
    await userEvent.selectOptions(plan, within(plan).getByRole('option', { name: 'Same as Act model' }));
    expect(sent).toContainEqual({ type: 'setModel', role: 'plan' });
    const act = screen.getByLabelText('Act model');
    await userEvent.selectOptions(act, within(act).getByRole('option', { name: 'big' }));
    expect(sent).toContainEqual({ type: 'setModel', role: 'act', providerId: 'corp', modelId: 'big' });
    expect(screen.getByText(/key sent over http/)).toBeInTheDocument();
  });

  it('changes the approval mode for this window and the default for new windows', async () => {
    mount(settingsState());
    await userEvent.click(screen.getByRole('radio', { name: /Auto-edit/ }));
    expect(sent).toContainEqual({ type: 'setApprovalMode', mode: 'edits' });
    await userEvent.selectOptions(screen.getByLabelText('When a window opens, start in'), 'auto');
    expect(sent).toContainEqual({ type: 'updateSetting', setting: { key: 'approvals.mode', value: 'auto' } });
  });

  it('edits the allowed commands and rejects shell operators', async () => {
    mount(settingsState());
    const input = screen.getByLabelText('Allowed commands');
    await userEvent.type(input, 'npm test && curl x');
    expect(screen.getByText(/Shell operators such as/)).toBeInTheDocument();
    await userEvent.clear(input);
    await userEvent.type(input, 'cargo test{Enter}');
    expect(sent).toContainEqual({ type: 'updateSetting', setting: { key: 'approvals.allowedCommands', value: ['npm test', 'cargo test'] } });
    await userEvent.click(screen.getByRole('button', { name: 'Remove npm test' }));
    expect(sent).toContainEqual({ type: 'updateSetting', setting: { key: 'approvals.allowedCommands', value: [] } });
  });

  it('toggles options, validates numbers and restores protected defaults', async () => {
    mount(settingsState());
    await userEvent.click(screen.getByLabelText(/Attach the active file/));
    expect(sent).toContainEqual({ type: 'updateSetting', setting: { key: 'context.includeActiveEditor', value: false } });
    const steps = screen.getByLabelText('Maximum steps per request');
    await userEvent.clear(steps);
    await userEvent.type(steps, '500');
    expect(screen.getByText('Enter a number from 1 to 200.')).toBeInTheDocument();
    await userEvent.clear(steps);
    await userEvent.type(steps, '40{Enter}');
    expect(sent).toContainEqual({ type: 'updateSetting', setting: { key: 'agent.maxIterations', value: 40 } });
    await userEvent.click(screen.getByRole('button', { name: 'Restore defaults' }));
    expect(sent).toContainEqual({ type: 'updateSetting', setting: { key: 'security.protectedPaths', value: ['**/.env', '**/*.pem'] } });
  });

  it('notes settings overridden by the workspace', () => {
    mount(settingsState({ settings: { ...baseState().settings, overriddenByWorkspace: ['agent.maxIterations'] } }));
    expect(screen.getAllByText(/This workspace overrides this setting/)).toHaveLength(1);
  });
});

describe('guided setup', () => {
  it('connects, discovers models and starts chatting without leaving the panel', async () => {
    mount(baseState({ providers: [], selected: null }));
    expect(screen.queryByLabelText('Message Sovran')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Ollama/ }));
    expect(screen.getByLabelText('Base URL')).toHaveValue('http://localhost:11434/v1');
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));
    const save = sent.find((m) => m.type === 'saveProvider') as Extract<WebviewMessage, { type: 'saveProvider' }>;
    expect(save.provider).toMatchObject({ name: 'Ollama', baseUrl: 'http://localhost:11434/v1', authType: 'none', models: [] });
    expect(screen.getByText('Connecting…')).toBeInTheDocument();

    // The host saves the provider (the app now has one), then reports the connection test.
    host({ type: 'patch', patch: { providers: [{ id: 'ollama', name: 'Ollama', baseUrl: 'http://localhost:11434/v1', authType: 'none', hasKey: false, models: [] }] } });
    host({ type: 'providerSaved', requestId: save.requestId!, providerId: 'ollama' });
    expect(screen.getByText('Connecting…')).toBeInTheDocument();
    host({ type: 'providerTest', requestId: save.requestId!, providerId: 'ollama', result: { ok: true, models: ['qwen2.5-coder:14b', 'llama3.1:8b'], message: 'Connected' } });

    expect(screen.getByRole('heading', { name: 'Choose a model' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: 'llama3.1:8b' }));
    await userEvent.click(screen.getByRole('button', { name: 'Start chatting' }));
    expect(sent).toContainEqual({ type: 'addModels', providerId: 'ollama', modelIds: ['llama3.1:8b'], select: 'llama3.1:8b' });
    expect(screen.getByLabelText('Message Sovran')).toBeInTheDocument();
  });

  it('reports a failed connection with its hint and allows a manual model ID', async () => {
    mount(baseState({ providers: [], selected: null }));
    await userEvent.click(screen.getByRole('button', { name: /Custom endpoint/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(screen.getByText('Give this provider a name.')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Name'), 'Corp');
    await userEvent.type(screen.getByLabelText('Base URL'), 'http://gw.corp.example/v1');
    expect(screen.getByRole('note')).toHaveTextContent('unencrypted');
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));
    const save = [...sent].reverse().find((m) => m.type === 'saveProvider') as Extract<WebviewMessage, { type: 'saveProvider' }>;
    host({ type: 'providerSaved', requestId: save.requestId!, providerId: 'corp' });
    host({ type: 'providerTest', requestId: save.requestId!, providerId: 'corp', result: { ok: false, message: 'HTTP 404: Not Found', hint: 'Add model IDs manually.' } });
    expect(screen.getByRole('alert')).toHaveTextContent('HTTP 404');
    await userEvent.click(screen.getByRole('button', { name: 'Enter a model ID instead' }));
    await userEvent.type(screen.getByLabelText('Model ID'), 'coder-large');
    await userEvent.click(screen.getByRole('button', { name: 'Start chatting' }));
    expect(sent).toContainEqual({ type: 'addModels', providerId: 'corp', modelIds: ['coder-large'], select: 'coder-large' });
  });
});
