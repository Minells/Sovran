import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState, HostMessage, McpServerView, WebviewMessage } from '../../src/shared/protocol';
import { App } from './App';
import { renderMarkdown } from './lib/markdown';
import { reducer, initialUiState } from './state/store';
import { onPost, setUiState } from './vscode';

const baseState = (over: Partial<AppState> = {}): AppState => ({
  surface: 'sidebar',
  view: 'chat',
  workspace: { name: 'w', trusted: true, hasFolder: true },
  providers: [
    {
      id: 'local',
      name: 'Local',
      baseUrl: 'http://localhost:1234/v1',
      authType: 'none',
      hasKey: false,
      models: [{ id: 'coder', toolMode: 'auto' }],
    },
  ],
  selected: { providerId: 'local', modelId: 'coder' },
  mode: 'act',
  sessions: [],
  liveSessions: [],
  session: { id: 's', title: 'New chat', messages: [] },
  run: null,
  approvals: [],
  context: { editor: { path: 'src/a.ts', label: 'a.ts' }, includeEditor: true, attachments: [] },
  grants: { edits: false },
  approvalMode: 'ask',
  planModel: null,
  titleModel: null,
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
    disabledTools: [],
    forceAskTools: [],
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
    generateTitles: true,
    overriddenByWorkspace: [],
  },
  configFile: { path: '~/.sovran/config.yaml', state: 'missing', providers: 0, problems: [] },
  mcp: { active: true, servers: [] },
  ...over,
});

let sent: WebviewMessage[] = [];
let unsubscribe: () => void;
beforeEach(() => {
  setUiState({ draft: '', settingsArea: undefined }); // drafts and the Settings area persist across mounts by design; isolate tests
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

function clickButton(name: RegExp) {
  return userEvent.click(screen.getByRole('button', { name }));
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
    mount(
      baseState({
        session: { id: 's', title: 't', messages: [{ role: 'user', id: 'u', content: 'hi', createdAt: 0 }] },
      }),
    );
    host({
      type: 'messageUpsert',
      sessionId: 's',
      message: { role: 'assistant', id: 'a', content: '', streaming: true, createdAt: 0 },
    });
    host({ type: 'messageDelta', sessionId: 's', messageId: 'a', field: 'content', text: 'Hello **wor' });
    host({ type: 'messageDelta', sessionId: 's', messageId: 'a', field: 'content', text: 'ld**' });
    expect(screen.getByText('world').tagName).toBe('STRONG');
    // Deltas for another session are ignored.
    host({ type: 'messageDelta', sessionId: 'other', messageId: 'a', field: 'content', text: 'LEAK' });
    expect(screen.queryByText(/LEAK/)).not.toBeInTheDocument();
  });

  it('puts the decision above the chat input, the diff inline, and sends the decision with a session grant', async () => {
    const messages: AppState['session'] = {
      id: 's',
      title: 't',
      messages: [
        { role: 'user', id: 'u', content: 'edit', createdAt: 0 },
        {
          role: 'assistant',
          id: 'a',
          content: '',
          createdAt: 0,
          toolCalls: [{ id: 'c1', name: 'edit_file', arguments: '{"path":"src/a.ts"}' }],
        },
      ],
    };
    mount(
      baseState({
        session: messages,
        run: {
          sessionId: 's',
          iteration: 1,
          maxIterations: 25,
          startedAt: Date.now(),
          activity: { phase: 'awaiting_approval', label: 'src/a.ts', callId: 'c1' },
        },
        approvals: [
          {
            id: 'ap',
            callId: 'c1',
            toolName: 'edit_file',
            title: 'src/a.ts',
            detail: {
              kind: 'edit',
              path: 'src/a.ts',
              isNew: false,
              diff: '@@ -1 +1 @@\n-a\n+b',
              added: 1,
              removed: 1,
            },
          },
        ],
      }),
    );
    const bar = screen.getByRole('region', { name: 'Apply these changes?' });
    // Outside the conversation (so it never scrolls away), right above the input; it replaces the run status line.
    expect(
      bar.compareDocumentPosition(screen.getByLabelText('Conversation')) & Node.DOCUMENT_POSITION_PRECEDING,
    ).toBeTruthy();
    expect(
      bar.compareDocumentPosition(screen.getByLabelText('Message Sovran')) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.queryByText('Waiting for your approval')).not.toBeInTheDocument();
    // The diff is read in the transcript, under the tool call; the decision is only in the bar.
    const diff = screen.getByRole('group', { name: 'Proposed changes' });
    expect(within(bar).queryByRole('group')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Apply' })).toHaveLength(1);
    expect(diff).toHaveTextContent('−a');
    await userEvent.click(within(bar).getByLabelText(/without asking/));
    await userEvent.click(within(bar).getByRole('button', { name: 'Apply' }));
    expect(sent).toContainEqual({
      type: 'approval',
      id: 'ap',
      approved: true,
      grant: 'session-edits',
      feedback: undefined,
    });
  });

  it('rejects with feedback', async () => {
    mount(
      baseState({
        session: {
          id: 's',
          title: 't',
          messages: [
            {
              role: 'assistant',
              id: 'a',
              content: '',
              createdAt: 0,
              toolCalls: [{ id: 'c1', name: 'execute_terminal', arguments: '{"command":"rm -rf build"}' }],
            },
          ],
        },
        run: {
          sessionId: 's',
          iteration: 1,
          maxIterations: 25,
          startedAt: Date.now(),
          activity: { phase: 'awaiting_approval', label: 'rm', callId: 'c1' },
        },
        approvals: [
          {
            id: 'ap',
            callId: 'c1',
            toolName: 'execute_terminal',
            title: 'rm -rf build',
            detail: {
              kind: 'command',
              command: 'rm -rf build',
              cwd: '.',
              warnings: ['Deletes files and folders recursively.'],
              allowPrefix: null,
            },
          },
        ],
      }),
    );
    expect(screen.getByText('Deletes files and folders recursively.')).toBeInTheDocument();
    // Commands that must always ask are never offered for the allow-list.
    expect(screen.queryByRole('button', { name: 'Always allow…' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Reject with feedback…' }));
    // While the form is open the bar offers only its own actions.
    expect(screen.queryByRole('button', { name: 'Run' })).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Feedback for the agent'), 'use npm run clean');
    await userEvent.click(screen.getByRole('button', { name: 'Send rejection' }));
    expect(sent).toContainEqual({
      type: 'approval',
      id: 'ap',
      approved: false,
      grant: undefined,
      feedback: 'use npm run clean',
    });
  });

  it('sends feedback with Enter and goes back with Escape without rejecting', async () => {
    mount(
      baseState({
        session: {
          id: 's',
          title: 't',
          messages: [
            {
              role: 'assistant',
              id: 'a',
              content: '',
              createdAt: 0,
              toolCalls: [{ id: 'c1', name: 'execute_terminal', arguments: '{"command":"make"}' }],
            },
          ],
        },
        run: {
          sessionId: 's',
          iteration: 1,
          maxIterations: 25,
          startedAt: Date.now(),
          activity: { phase: 'awaiting_approval', label: 'make', callId: 'c1' },
        },
        approvals: [
          {
            id: 'ap',
            callId: 'c1',
            toolName: 'execute_terminal',
            title: 'make',
            detail: { kind: 'command', command: 'make', cwd: '.', warnings: [], allowPrefix: 'make' },
          },
        ],
      }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Reject with feedback…' }));
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByLabelText('Feedback for the agent')).not.toBeInTheDocument();
    expect(sent.some((m) => m.type === 'approval')).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Reject with feedback…' }));
    await userEvent.type(
      screen.getByLabelText('Feedback for the agent'),
      'use the Makefile target "build"{Enter}',
    );
    expect(sent).toContainEqual({
      type: 'approval',
      id: 'ap',
      approved: false,
      grant: undefined,
      feedback: 'use the Makefile target "build"',
    });
  });

  it('switches mode via the radio group and Alt+M, and disables Act when untrusted', async () => {
    mount(baseState());
    await userEvent.click(screen.getByRole('radio', { name: /Plan/ }));
    expect(sent).toContainEqual({ type: 'setMode', mode: 'plan' });
    fireEvent.keyDown(screen.getByLabelText('Message Sovran'), { key: 'm', altKey: true });
    expect(sent.filter((m) => m.type === 'setMode')).toHaveLength(2);
    host({
      type: 'patch',
      patch: { workspace: { name: 'w', trusted: false, hasFolder: true }, mode: 'plan' },
    });
    expect(screen.getByRole('radio', { name: /Act/ })).toBeDisabled();
    expect(screen.getByRole('note')).toHaveTextContent('Restricted Mode');
  });

  it('shows a stop button while running and cancels with Escape', () => {
    mount(
      baseState({
        run: {
          sessionId: 's',
          iteration: 2,
          maxIterations: 25,
          startedAt: Date.now(),
          activity: { phase: 'thinking', label: 'Thinking' },
        },
      }),
    );
    expect(screen.getByLabelText('Stop the agent')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByLabelText('Message Sovran'), { key: 'Escape' });
    expect(sent).toContainEqual({ type: 'cancel' });
  });

  it('renders provider errors with a hint and a settings action', () => {
    mount(
      baseState({
        session: {
          id: 's',
          title: 't',
          messages: [
            {
              role: 'assistant',
              id: 'a',
              content: '',
              createdAt: 0,
              error: { kind: 'network', message: 'Connection refused', hint: 'Is the server running?' },
            },
          ],
        },
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
          {
            role: 'user',
            id: 'u1',
            content: 'expanded prompt',
            display: '/review a.ts',
            createdAt: 0,
            checkpoint: { id: 'cp', files: ['src/a.ts', 'src/b.ts'] },
            ...over,
          } as never,
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
    mount({
      ...doneTurn(),
      compaction: { summary: '## Goal\nShip it', firstKeptId: 'u1', summarizedCount: 6 },
    });
    expect(screen.getByText(/6 earlier messages summarized/)).toBeInTheDocument();
  });

  it('completes slash commands from the popup with the keyboard', async () => {
    mount(baseState());
    const box = screen.getByLabelText('Message Sovran');
    await userEvent.type(box, '/re');
    const list = screen.getByRole('listbox', { name: 'Commands' });
    expect(
      within(list)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual([expect.stringContaining('/review')]);
    await userEvent.keyboard('{Enter}');
    expect(box).toHaveValue('/review ');
    expect(sent.some((m) => m.type === 'send')).toBe(false);
  });

  it('suggests files for @-mentions and attaches the chosen one', async () => {
    mount(baseState());
    const box = screen.getByLabelText('Message Sovran');
    await userEvent.type(box, 'look at @sess');
    await waitFor(() => expect(sent.some((m) => m.type === 'suggestFiles')).toBe(true));
    const req = [...sent].reverse().find((m) => m.type === 'suggestFiles') as Extract<
      WebviewMessage,
      { type: 'suggestFiles' }
    >;
    expect(req.query).toBe('sess');
    host({
      type: 'fileSuggestions',
      requestId: req.requestId,
      items: [
        { path: 'src/auth/session.ts', label: 'session.ts' },
        { path: 'docs/sessions.md', label: 'sessions.md' },
      ],
    });
    expect(screen.getAllByRole('option')).toHaveLength(2);
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(sent).toContainEqual({ type: 'attachPath', path: 'docs/sessions.md' });
    expect(box).toHaveValue('look at ');
  });

  it('shows the Plan model in Plan mode', () => {
    mount(
      baseState({
        mode: 'plan',
        providers: [
          {
            id: 'local',
            name: 'Local',
            baseUrl: 'http://x/v1',
            authType: 'none',
            hasKey: false,
            models: [
              { id: 'coder', toolMode: 'auto' },
              { id: 'thinker', toolMode: 'auto' },
            ],
          },
        ],
        planModel: { providerId: 'local', modelId: 'thinker' },
      }),
    );
    expect(screen.getByTitle(/Plan model · Local · thinker/)).toBeInTheDocument();
  });
});

describe('brand refresh UX', () => {
  it('folds consecutive successful reads into one exploration row', async () => {
    const read = (id: string, name: string, args: string) => [
      {
        role: 'assistant',
        id: `a${id}`,
        content: '',
        createdAt: 0,
        toolCalls: [{ id: `c${id}`, name, arguments: args }],
      },
      {
        role: 'tool',
        id: `t${id}`,
        toolCallId: `c${id}`,
        toolName: name,
        content: 'ok',
        status: 'success',
        createdAt: 0,
      },
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
    const { unmount } = mount(
      baseState({
        context: {
          editor: { path: 'src/a.ts', label: 'a.ts:3-9', startLine: 3, endLine: 9 },
          includeEditor: true,
          attachments: [],
        },
      }),
    );
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
    mount(
      baseState({
        context: {
          editor: { path: '/home/u/.aws/credentials', label: 'credentials', blocked: 'outside' },
          includeEditor: true,
          attachments: [],
        },
      }),
    );
    expect(screen.getByRole('button', { name: /Explain this workspace/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Explain credentials/ })).not.toBeInTheDocument();
  });

  it('opens a recent chat or the full history', async () => {
    mount(
      baseState({
        sessions: [
          { id: 's', title: 'New chat', createdAt: 0, updatedAt: Date.now(), messageCount: 0 },
          {
            id: 'old',
            title: 'Older work',
            createdAt: 0,
            updatedAt: Date.now() - 7_200_000,
            messageCount: 4,
          },
          { id: 'new', title: 'Latest work', createdAt: 0, updatedAt: Date.now() - 60_000, messageCount: 2 },
        ],
      }),
    );
    const nav = screen.getByRole('navigation', { name: 'Recent chats' });
    // Newest first, and never the chat that is already open.
    expect(
      within(nav)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([expect.stringContaining('Latest work'), expect.stringContaining('Older work')]);
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
  const lastOf = <T extends WebviewMessage['type']>(type: T) =>
    [...sent].reverse().find((m) => m.type === type) as Extract<WebviewMessage, { type: T }>;
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
    expect(within(dialog).getByRole('group', { name: 'Suggested' })).toHaveTextContent(
      /a\.ts.*active editor.*b\.ts.*open/,
    );
    // Files without a hint are not "suggested".
    expect(within(dialog).queryByText('zzz.txt')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('option', { name: /\.env/ })).toHaveAttribute(
      'title',
      expect.stringContaining('protected'),
    );

    await userEvent.click(within(dialog).getByRole('option', { name: /README\.md/ }));
    expect(sent).toContainEqual({ type: 'attachPath', path: 'README.md' });
    host({
      type: 'patch',
      patch: {
        context: {
          editor: null,
          includeEditor: true,
          attachments: [{ id: 'att1', path: 'README.md', label: 'README.md' }],
        },
      },
    });
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
    expect(search).toHaveAttribute(
      'aria-activedescendant',
      within(dialog).getByRole('option', { name: 'src, folder' }).id,
    );
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
    host({
      type: 'fileSuggestions',
      requestId: lastOf('suggestFiles').requestId,
      items: [{ path: 'src/config.ts', label: 'config.ts' }],
    });
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
    mount(
      baseState({
        context: {
          editor: null,
          includeEditor: true,
          attachments: [{ id: 'x', path: '~/Downloads/spec.md', label: 'spec.md', external: true }],
        },
      }),
    );
    expect(screen.getByRole('button', { name: 'Remove spec.md' })).toHaveAttribute(
      'title',
      expect.stringContaining('from your computer'),
    );
  });

  it('says which documents Sovran will send as converted text', () => {
    mount(
      baseState({
        context: {
          editor: null,
          includeEditor: true,
          attachments: [
            { id: 'p', path: 'docs/spec.pdf', label: 'spec.pdf', format: 'pdf', detail: '12 pages' },
            {
              id: 'x',
              path: '~/Downloads/budget.xlsx',
              label: 'budget.xlsx',
              external: true,
              format: 'xlsx',
              detail: '3 sheets',
            },
            { id: 't', path: 'notes.md', label: 'notes.md' },
          ],
        },
      }),
    );
    const pdf = screen.getByRole('button', { name: 'Remove spec.pdf' });
    expect(pdf).toHaveAttribute('title', 'docs/spec.pdf · PDF document, 12 pages · click to remove');
    expect(pdf.querySelector('.codicon-file-pdf')).not.toBeNull();
    const sheet = screen.getByRole('button', { name: 'Remove budget.xlsx' });
    expect(sheet).toHaveAttribute(
      'title',
      '~/Downloads/budget.xlsx (from your computer) · Excel workbook, 3 sheets · click to remove',
    );
    expect(sheet.querySelector('.codicon-table')).not.toBeNull();
    expect(
      screen.getByRole('button', { name: 'Remove notes.md' }).querySelector('.codicon-file'),
    ).not.toBeNull();
  });

  it('turns a pasted screenshot into an image attachment, and leaves text pastes alone', async () => {
    mount(baseState({ context: { editor: null, includeEditor: true, attachments: [] } }));
    const input = screen.getByRole('combobox', { name: 'Message Sovran' });
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const shot = new File([png], 'image.png', { type: 'image/png' });
    const pasted = fireEvent.paste(input, { clipboardData: { files: [shot], types: ['Files'] } });
    expect(pasted).toBe(false); // handled: nothing is pasted as text
    await waitFor(() =>
      expect(sent).toContainEqual({ type: 'attachImage', data: btoa(String.fromCharCode(...png)) }),
    );

    // Copied from a document: text and a picture of it. The text is pasted, as before.
    sent = [];
    const mixed = fireEvent.paste(input, {
      clipboardData: { files: [shot], types: ['text/plain', 'Files'] },
    });
    expect(mixed).toBe(true);
    expect(sent.filter((m) => m.type === 'attachImage')).toEqual([]);
  });

  it('says so when a pasted image is too large to send', () => {
    mount(baseState({ context: { editor: null, includeEditor: true, attachments: [] } }));
    const big = new File([new Uint8Array(1)], 'huge.png', { type: 'image/png' });
    Object.defineProperty(big, 'size', { value: 9 * 1024 * 1024 });
    fireEvent.paste(screen.getByRole('combobox', { name: 'Message Sovran' }), {
      clipboardData: { files: [big], types: ['Files'] },
    });
    expect(
      screen.getByText('The pasted image is larger than 8 MB. Paste a smaller one (a crop, or a JPEG).'),
    ).toBeInTheDocument();
    expect(sent.filter((m) => m.type === 'attachImage')).toEqual([]);
  });

  it('shows images on the chips of the next message and of sent messages', () => {
    mount(
      baseState({
        context: {
          editor: null,
          includeEditor: true,
          attachments: [
            {
              id: 'p',
              path: 'Pasted image 1',
              label: 'Pasted image 1',
              image: { mime: 'image/png', width: 1280, height: 720, pasted: true },
            },
            { id: 'w', path: 'docs/ui.jpg', label: 'ui.jpg', image: { mime: 'image/jpeg' } },
          ],
        },
        session: {
          id: 's',
          title: 't',
          messages: [
            {
              role: 'user',
              id: 'u1',
              content: 'what is wrong?',
              createdAt: 0,
              images: [
                {
                  id: 'a'.repeat(64),
                  name: 'docs/ui.png',
                  source: 'workspace',
                  mime: 'image/png',
                  bytes: 10,
                  width: 800,
                  height: 600,
                },
                {
                  id: 'b'.repeat(64),
                  name: 'Pasted image 1',
                  source: 'pasted',
                  mime: 'image/webp',
                  bytes: 10,
                },
              ],
            },
          ],
        },
      }),
    );
    const pasted = screen.getByRole('button', { name: 'Remove Pasted image 1' });
    expect(pasted).toHaveAttribute('title', 'PNG image, 1280×720 · click to remove');
    expect(pasted.querySelector('.codicon-file-media')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Remove ui.jpg' })).toHaveAttribute(
      'title',
      'docs/ui.jpg · JPEG image · click to remove',
    );
    // A workspace image opens in VS Code; a pasted one has no file to open.
    const sentImage = screen.getByRole('button', { name: 'ui.png' });
    expect(sentImage).toHaveAttribute('title', 'PNG image, 800×600');
    fireEvent.click(sentImage);
    expect(sent).toContainEqual({ type: 'openFile', path: 'docs/ui.png' });
    expect(screen.getByTitle('WebP image')).toHaveTextContent('Pasted image 1');
  });

  it('shows the documents a sent message carried', () => {
    mount(
      baseState({
        session: {
          id: 's',
          title: 't',
          messages: [
            {
              role: 'user',
              id: 'u1',
              content: 'summarize',
              createdAt: 0,
              attachments: [
                {
                  kind: 'file',
                  path: 'docs/deck.pptx',
                  content: '## Slide 1',
                  format: 'pptx',
                  detail: '8 slides',
                },
                // A saved chat from a later version may name a format this one does not know: it shows as a file.
                { kind: 'file', path: 'docs/new.xyz', content: 'x', format: 'xyz' as never },
              ],
            },
          ],
        },
      }),
    );
    const deck = screen.getByRole('button', { name: 'deck.pptx' });
    expect(deck).toHaveAttribute('title', 'PowerPoint presentation, 8 slides');
    expect(deck.querySelector('.codicon-preview')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'new.xyz' }).querySelector('.codicon-file')).not.toBeNull();
  });

  it('shows the folder error from the host', async () => {
    mount(baseState());
    await userEvent.click(screen.getByRole('button', { name: 'Attach files' }));
    host({
      type: 'directoryListing',
      requestId: lastOf('listDirectory').requestId,
      listing: { path: '', entries: [], error: 'Open a folder to browse its files.' },
    });
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
    mount({
      ...twoTurns(),
      run: {
        sessionId: 's',
        iteration: 1,
        maxIterations: 25,
        startedAt: Date.now(),
        activity: { phase: 'streaming', label: 'Writing' },
      },
    });
    expect(screen.getAllByRole('toolbar', { name: 'Response actions' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });
});

describe('markdown safety', () => {
  it('never renders raw HTML or javascript: links from model output', () => {
    const html = renderMarkdown(
      '<img src=x onerror=alert(1)><script>alert(1)</script> [x](javascript:alert(1)) [ok](https://example.com)',
    );
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
    const { revealHidden } = await import('./components/Approval');
    expect(revealHidden('ls \u202Eabc\u200B')).toBe('ls ⟨U+202E⟩abc⟨U+200B⟩');
  });
});

describe('reducer', () => {
  it('caps notices and ignores patches before the first state', () => {
    let s = reducer(initialUiState, { type: 'patch', patch: { mode: 'plan' } });
    expect(s.app).toBeNull();
    for (let i = 0; i < 5; i++)
      s = reducer(s, { type: 'notice', id: String(i), level: 'info', message: `n${i}` });
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
      session: {
        id: 's',
        title: 't',
        messages: [
          {
            role: 'assistant',
            id: 'a',
            content: '',
            createdAt: 0,
            toolCalls: [
              { id: 'c1', name: 'execute_terminal', arguments: '{"command":"npm run build -- --prod"}' },
            ],
          },
        ],
      },
      run: {
        sessionId: 's',
        iteration: 1,
        maxIterations: 25,
        startedAt: Date.now(),
        activity: { phase: 'awaiting_approval', label: 'npm', callId: 'c1' },
      },
      approvals: [
        {
          id: 'ap',
          callId: 'c1',
          toolName: 'execute_terminal',
          title: 'npm run build -- --prod',
          reason: 'Terminal commands require approval.',
          detail: {
            kind: 'command',
            command: 'npm run build -- --prod',
            cwd: '.',
            warnings: [],
            allowPrefix: 'npm run build',
          },
        },
      ],
      ...over,
    });

  it('offers Ask, Auto-edit and Auto in Act mode and hides the picker in Plan mode', async () => {
    mount(baseState());
    const picker = screen.getByRole('button', { name: /Approvals: Ask/ });
    await userEvent.click(picker);
    const menu = screen.getByRole('menu', { name: 'Approvals in Act mode' });
    expect(
      within(menu)
        .getAllByRole('menuitemradio')
        .map((i) => i.textContent),
    ).toEqual([
      expect.stringContaining('Ask'),
      expect.stringContaining('Auto-edit'),
      expect.stringContaining('Auto'),
    ]);
    expect(within(menu).getByRole('menuitemradio', { name: 'Ask' })).toHaveAttribute('aria-checked', 'true');
    expect(within(menu).getByRole('menuitemradio', { name: 'Auto' })).toHaveAccessibleDescription(
      /risky actions still ask/,
    );
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
    expect(screen.getByLabelText('Message Sovran')).toHaveAttribute(
      'placeholder',
      expect.stringContaining('Auto mode'),
    );
  });

  it('explains why Auto mode still asks', () => {
    mount(
      commandApproval({
        approvalMode: 'auto',
        approvals: [{ ...commandApproval().approvals[0]!, reason: 'Pushes commits to a remote repository.' }],
      }),
    );
    expect(screen.getByRole('note')).toHaveTextContent(
      'Auto mode still asks here: Pushes commits to a remote repository.',
    );
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
    expect(sent).toContainEqual({
      type: 'approval',
      id: 'ap',
      approved: true,
      grant: undefined,
      feedback: undefined,
      allowCommand: 'npm run build',
    });
  });

  it('labels actions that ran without asking', () => {
    mount(
      baseState({
        session: {
          id: 's',
          title: 't',
          messages: [
            {
              role: 'assistant',
              id: 'a',
              content: '',
              createdAt: 0,
              toolCalls: [{ id: 'c1', name: 'execute_terminal', arguments: '{"command":"npm test"}' }],
            },
            {
              role: 'tool',
              id: 't',
              toolCallId: 'c1',
              toolName: 'execute_terminal',
              content: 'ok',
              status: 'success',
              createdAt: 0,
              autoApproved: 'Ran without asking (Auto mode).',
            },
          ],
        },
      }),
    );
    expect(screen.getByLabelText('Ran without asking (Auto mode).')).toHaveTextContent('auto');
  });

  it('never presents a file outside the workspace as included', () => {
    mount(
      baseState({
        context: {
          editor: { path: '/home/u/.aws/credentials', label: 'credentials', blocked: 'outside' },
          includeEditor: true,
          attachments: [],
        },
      }),
    );
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
        {
          id: 'local',
          name: 'Local',
          baseUrl: 'http://localhost:1234/v1',
          authType: 'none',
          hasKey: false,
          models: [
            { id: 'coder', toolMode: 'auto' },
            { id: 'thinker', toolMode: 'auto' },
          ],
        },
        {
          id: 'corp',
          name: 'Corp',
          baseUrl: 'http://gw.corp.example/v1',
          authType: 'bearer',
          hasKey: true,
          models: [{ id: 'big', toolMode: 'auto' }],
        },
      ],
      ...over,
    });
  const tab = (name: string) => screen.getByRole('tab', { name });
  const openArea = (name: string) => userEvent.click(tab(name));

  it('keeps the six areas on screen and shows only the selected one', async () => {
    mount(settingsState());
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Models',
      'Approvals',
      'Agent',
      'Tools',
      'Context',
      'Data',
    ]);
    expect(tab('Models')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel', { name: 'Models' })).toContainElement(
      screen.getByLabelText('Act model'),
    );
    expect(screen.queryByLabelText('Allowed commands')).not.toBeInTheDocument();

    await openArea('Approvals');
    expect(tab('Approvals')).toHaveAttribute('aria-selected', 'true');
    expect(tab('Models')).toHaveAttribute('aria-selected', 'false');
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
    expect(screen.queryByLabelText('Allowed commands')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Act model')).not.toBeInTheDocument();
    // The areas never scroll away or disappear: all six are still there.
    expect(screen.getAllByRole('tab')).toHaveLength(6);
  });

  it('moves between areas with the arrow keys, Home and End, with one tab stop', async () => {
    mount(settingsState());
    tab('Models').focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(tab('Approvals')).toHaveFocus();
    expect(tab('Approvals')).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{End}');
    expect(tab('Data')).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{ArrowRight}');
    expect(tab('Models')).toHaveFocus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(tab('Data')).toHaveFocus();
    await userEvent.keyboard('{Home}');
    expect(tab('Models')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getAllByRole('tab').filter((t) => t.tabIndex === 0)).toEqual([tab('Models')]);
  });

  it('reopens the area the user left', async () => {
    const first = mount(settingsState());
    await openArea('Context');
    first.unmount();
    mount(settingsState());
    expect(tab('Context')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByLabelText(/Attach the active file/)).toBeInTheDocument();
  });

  it('configures the Act and Plan models', async () => {
    mount(settingsState());
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    await clickButton(/^Model options/);
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

  it('turns model-generated chat titles on and picks the model that writes them', async () => {
    const view = mount(settingsState({ settings: { ...baseState().settings, generateTitles: false } }));
    await clickButton(/^Model options/);
    expect(screen.queryByLabelText('Title model')).not.toBeInTheDocument();
    await userEvent.click(screen.getByLabelText(/Name chats with the model/));
    expect(sent).toContainEqual({
      type: 'updateSetting',
      setting: { key: 'sessions.generateTitles', value: true },
    });

    host({ type: 'patch', patch: { settings: { ...settingsState().settings, generateTitles: true } } });
    const title = screen.getByLabelText('Title model');
    expect(title).toHaveValue('');
    expect(within(title).getByRole('option', { name: "Same as the chat's model" })).toBeInTheDocument();
    await userEvent.selectOptions(title, within(title).getByRole('option', { name: 'coder' }));
    expect(sent).toContainEqual({ type: 'setModel', role: 'title', providerId: 'local', modelId: 'coder' });
    await userEvent.selectOptions(
      title,
      within(title).getByRole('option', { name: "Same as the chat's model" }),
    );
    expect(sent).toContainEqual({ type: 'setModel', role: 'title' });
    view.unmount();
  });

  it('offers to create the configuration file from the providers in Settings', async () => {
    mount(settingsState());
    await clickButton(/^Configuration file/);
    expect(screen.getByText('~/.sovran/config.yaml')).toBeInTheDocument();
    expect(screen.getByText('Not created. Providers live in Settings only.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Stop using/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Create config.yaml' }));
    expect(sent).toContainEqual({ type: 'openConfigFile' });
  });

  it('shows the sync with Settings and lets the user stop using the file', async () => {
    mount(
      settingsState({
        configFile: { path: '~/.sovran/config.yaml', state: 'ok', providers: 2, problems: [] },
      }),
    );
    await clickButton(/^Configuration file/);
    expect(screen.getByText('In sync with Settings · 2 providers')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(sent).toContainEqual({ type: 'reloadConfigFile' });
    await userEvent.click(screen.getByRole('button', { name: 'Stop using config.yaml…' }));
    expect(sent).toContainEqual({ type: 'stopConfigFile' });
  });

  it('lists the problems of a broken file and keeps the way back to Settings', async () => {
    mount(
      settingsState({
        configFile: {
          path: '~/.sovran/config.yaml',
          state: 'error',
          providers: 1,
          problems: [{ line: 7, message: 'Unknown field "base_url". Did you mean "baseUrl"?' }],
        },
      }),
    );
    await clickButton(/^Configuration file/);
    expect(screen.getByText(/Settings keep the last valid version \(1 provider\)/)).toBeInTheDocument();
    expect(
      within(screen.getByRole('list', { name: 'Problems in the configuration file' })).getByText(
        /Did you mean "baseUrl"/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop using config.yaml…' })).toBeInTheDocument();
  });

  it('uses an ignored file again on request', async () => {
    mount(
      settingsState({
        configFile: { path: '~/.sovran/config.yaml', state: 'ignored', providers: 0, problems: [] },
      }),
    );
    await clickButton(/^Configuration file/);
    expect(screen.getByText('Ignored · Settings are used alone')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Stop using/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Use config.yaml again' }));
    expect(sent).toContainEqual({ type: 'useConfigFile' });
  });

  it('changes the approval mode for this window and the default for new windows', async () => {
    mount(settingsState());
    await openArea('Approvals');
    await userEvent.click(screen.getByRole('radio', { name: /Auto-edit/ }));
    expect(sent).toContainEqual({ type: 'setApprovalMode', mode: 'edits' });
    await clickButton(/^Approval defaults and exceptions/);
    await userEvent.selectOptions(screen.getByLabelText('When a window opens, start in'), 'auto');
    expect(sent).toContainEqual({ type: 'updateSetting', setting: { key: 'approvals.mode', value: 'auto' } });
  });

  it('edits the allowed commands and rejects shell operators', async () => {
    mount(settingsState());
    await openArea('Approvals');
    await clickButton(/^Approval defaults and exceptions/);
    const input = screen.getByLabelText('Allowed commands');
    await userEvent.type(input, 'npm test && curl x');
    expect(screen.getByText(/Shell operators such as/)).toBeInTheDocument();
    await userEvent.clear(input);
    await userEvent.type(input, 'cargo test{Enter}');
    expect(sent).toContainEqual({
      type: 'updateSetting',
      setting: { key: 'approvals.allowedCommands', value: ['npm test', 'cargo test'] },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Remove npm test' }));
    expect(sent).toContainEqual({
      type: 'updateSetting',
      setting: { key: 'approvals.allowedCommands', value: [] },
    });
  });

  it('edits native tool controls and rejects invalid tool names', async () => {
    mount(settingsState());
    await openArea('Tools');
    await clickButton(/^Built-in tools/);
    await clickButton(/^Advanced native overrides/);
    const disabled = screen.getByLabelText('Disabled native tools');
    await userEvent.type(disabled, 'execute_terminal{Enter}');
    expect(sent).toContainEqual({
      type: 'setNativeToolOverride', key: 'tools.disabled', name: 'execute_terminal', included: true,
    });
    const review = screen.getByLabelText('Always ask for native tools');
    await userEvent.type(review, '../read_file');
    expect(
      screen.getByText('Use a tool name with letters, digits, underscores or hyphens.'),
    ).toBeInTheDocument();
    await userEvent.clear(review);
    await userEvent.type(review, 'read_file{Enter}');
    expect(sent).toContainEqual({
      type: 'setNativeToolOverride', key: 'tools.forceAsk', name: 'read_file', included: true,
    });
  });

  it('toggles options, validates numbers and restores protected defaults', async () => {
    mount(settingsState());
    await openArea('Context');
    await userEvent.click(screen.getByLabelText(/Attach the active file/));
    expect(sent).toContainEqual({
      type: 'updateSetting',
      setting: { key: 'context.includeActiveEditor', value: false },
    });
    await openArea('Agent');
    await clickButton(/^Execution limits/);
    const steps = screen.getByLabelText('Maximum steps per request');
    await userEvent.clear(steps);
    await userEvent.type(steps, '500');
    expect(screen.getByText('Enter a number from 1 to 200.')).toBeInTheDocument();
    await userEvent.clear(steps);
    await userEvent.type(steps, '40{Enter}');
    expect(sent).toContainEqual({
      type: 'updateSetting',
      setting: { key: 'agent.maxIterations', value: 40 },
    });
    await openArea('Approvals');
    await clickButton(/^Approval defaults and exceptions/);
    await userEvent.click(screen.getByRole('button', { name: 'Restore defaults' }));
    expect(sent).toContainEqual({
      type: 'updateSetting',
      setting: { key: 'security.protectedPaths', value: ['**/.env', '**/*.pem'] },
    });
  });

  it('consolidates built-in controls and current-chat groups in Tools with costs before selection', async () => {
    mount(
      settingsState({
        toolGroups: [{ id: 'git', label: 'Git', selected: false, availableTools: 8, definitionTokens: 1200 }],
        nativeTools: [{ name: 'git_status', description: 'Read Git status', risk: 'read', group: 'git' }],
      }),
    );
    await openArea('Tools');
    await clickButton(/^Tools for this chat/);
    expect(screen.getByText('8 available · ~1,200 tokens when selected')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox', { name: /^Git/ }));
    expect(sent).toContainEqual({ type: 'setToolGroup', sessionId: 's', group: 'git', selected: true });
    await clickButton(/^Built-in tools/);
    await clickButton(/^Git$/);
    const gitStatus = within(screen.getByRole('group', { name: 'git_status' }));
    await userEvent.click(gitStatus.getByLabelText('Enabled'));
    expect(sent).toContainEqual({
      type: 'setNativeToolOverride', key: 'tools.disabled', name: 'git_status', included: true,
    });
    await userEvent.click(gitStatus.getByLabelText('Always ask'));
    expect(sent).toContainEqual({
      type: 'setNativeToolOverride', key: 'tools.forceAsk', name: 'git_status', included: true,
    });
    expect(
      sent.some(
        (message) => message.type === 'installMcpIntegration' || message.type === 'setMcpServerEnabled',
      ),
    ).toBe(false);
  });

  it('summarizes Tools without opening advanced controls or writing settings', async () => {
    const group = { id: 'git', label: 'Git', selected: true, availableTools: 1, definitionTokens: 120 };
    mount(settingsState({
      toolAvailability: 'available',
      toolGroups: [group, { ...group, id: 'web', label: 'Web', selected: false }],
      settings: {
        ...baseState().settings,
        disabledTools: ['old_tool'],
        forceAskTools: ['old_tool'],
      },
    }));
    await openArea('Tools');
    const panel = within(screen.getByRole('tabpanel', { name: 'Tools' }));
    const summaries = panel.getAllByRole('button');
    expect(summaries.map((button) => button.getAttribute('aria-expanded'))).toEqual(['false', 'false', 'false']);
    expect(summaries[0]).toHaveAccessibleName('Tools for this chat 1 available in Act');
    expect(summaries[0]).toHaveAccessibleDescription('1 group excluded');
    expect(summaries[1]).toHaveAccessibleName(/Built-in tools 1 override/);
    expect(summaries[2]).toHaveAccessibleName('Integrations None configured');

    host({ type: 'patch', patch: {
      toolAvailability: 'model-disabled',
      toolGroups: [{ ...group, availableTools: 0, definitionTokens: 0 }],
    } });
    expect(summaries[0]).toHaveAccessibleName('Tools for this chat Tools are off for this model');
    summaries[0]!.focus();
    await userEvent.keyboard('{Enter}');
    expect(panel.getByRole('checkbox', { name: /^Git/ })).toBeChecked();
    expect(sent.every((message) => message.type === 'ready' || message.type === 'focused')).toBe(true);
  });

  it('notes settings overridden by the workspace', async () => {
    mount(
      settingsState({
        settings: { ...baseState().settings, overriddenByWorkspace: ['agent.maxIterations'] },
      }),
    );
    await openArea('Agent');
    await clickButton(/^Execution limits/);
    expect(screen.getAllByText(/This workspace overrides this setting/)).toHaveLength(1);
  });
});

describe('model limits', () => {
  const withLimits = (models: AppState['providers'][number]['models']) =>
    baseState({
      view: 'providers',
      providers: [
        {
          id: 'gw',
          name: 'Gateway',
          baseUrl: 'https://gw.example/v1',
          authType: 'bearer',
          hasKey: true,
          models,
        },
      ],
      selected: { providerId: 'gw', modelId: models[0]!.id },
    });

  it('shows what an empty limit means, and saves typed and cleared limits', async () => {
    mount(
      withLimits([
        {
          id: 'glm-5.3-flash',
          toolMode: 'auto',
          serverLimits: { contextWindow: 131072, maxOutputTokens: 32768 },
        },
        { id: 'local', toolMode: 'auto', contextWindow: 16384 },
      ]),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Edit Gateway' }));
    const glmCtx = screen.getByLabelText('Context window for glm-5.3-flash');
    expect(glmCtx).toHaveAttribute('placeholder', '131072');
    expect(glmCtx.closest('label')).toHaveTextContent('Context · server');
    expect(screen.getByLabelText('Max output tokens for glm-5.3-flash')).toHaveAttribute(
      'placeholder',
      '4096',
    );
    expect(screen.getByLabelText('Max output tokens for glm-5.3-flash').closest('label')).toHaveTextContent(
      'Max output · default',
    );
    expect(screen.getByLabelText('Max output tokens for local')).toHaveAttribute('placeholder', '4096');
    // A value typed by the user needs no source.
    expect(
      screen.getByLabelText('Context window for local').closest('label')!.querySelector('span'),
    ).toHaveTextContent(/^Context$/);
    expect(screen.getByLabelText('Context window for local')).toHaveValue('16384');

    await userEvent.type(screen.getByLabelText('Max output tokens for glm-5.3-flash'), '8192');
    await userEvent.clear(screen.getByLabelText('Context window for local'));
    await userEvent.click(screen.getByRole('button', { name: 'Save provider' }));
    const save = sent.find((m) => m.type === 'saveProvider') as Extract<
      WebviewMessage,
      { type: 'saveProvider' }
    >;
    expect(save.provider.models).toEqual([
      { id: 'glm-5.3-flash', contextWindow: undefined, maxOutputTokens: 8192, toolMode: 'auto' },
      { id: 'local', contextWindow: undefined, maxOutputTokens: undefined, toolMode: 'auto' },
    ]);
  });

  it('lowers the default reply reserve for a small window', async () => {
    mount(withLimits([{ id: 'small', toolMode: 'auto', serverLimits: { contextWindow: 8192 } }]));
    await userEvent.click(screen.getByRole('button', { name: 'Edit Gateway' }));
    expect(screen.getByLabelText('Max output tokens for small')).toHaveAttribute('placeholder', '2048');
  });

  it('tells in Settings which limits the selected model uses and where they come from', async () => {
    mount({
      ...withLimits([{ id: 'glm-5.3-flash', toolMode: 'auto', serverLimits: { contextWindow: 131072 } }]),
      view: 'settings',
    });
    await clickButton(/^Model options/);
    expect(screen.getAllByTestId('model-limits')[0]).toHaveTextContent(
      'Context 131,072 tokens (reported by the server) · 4,096 kept for the reply (default)',
    );
  });
});

describe('providers and the configuration file', () => {
  const twoProviders: AppState['providers'] = [
    {
      id: 'local',
      name: 'Local',
      baseUrl: 'http://localhost:1234/v1',
      authType: 'none',
      hasKey: false,
      models: [{ id: 'coder', toolMode: 'auto' }],
    },
    {
      id: 'gw',
      name: 'Gateway',
      baseUrl: 'https://gw.example/v1',
      authType: 'header',
      headerName: 'api-key',
      hasKey: true,
      models: [{ id: 'm', toolMode: 'auto' }],
    },
  ];

  it('edits every provider in the panel and says when the file follows', async () => {
    mount(
      baseState({
        view: 'providers',
        providers: twoProviders,
        configFile: { path: '~/.sovran/config.yaml', state: 'ok', providers: 2, problems: [] },
      }),
    );
    expect(screen.getByRole('note')).toHaveTextContent('In sync with ~/.sovran/config.yaml');
    for (const name of ['Local', 'Gateway']) {
      const card = screen.getByRole('region', { name });
      expect(within(card).getByRole('button', { name: `Edit ${name}` })).toBeInTheDocument();
      expect(within(card).getByRole('button', { name: `Remove ${name}` })).toBeInTheDocument();
    }
    // A non-standard key header is visible at a glance.
    expect(
      within(screen.getByRole('region', { name: 'Gateway' })).getByText('Header api-key'),
    ).toBeInTheDocument();
  });

  it('has no sync note without the file', () => {
    mount(baseState({ view: 'providers', providers: twoProviders }));
    expect(screen.queryByText(/In sync with/)).not.toBeInTheDocument();
  });

  it('offers the standard API key first, and says which header carries it', async () => {
    mount(baseState({ view: 'providers', providers: twoProviders }));
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    const auth = screen.getByRole('radiogroup', { name: 'Authentication' });
    expect(
      within(auth)
        .getAllByRole('radio')
        .map((r) => r.textContent),
    ).toEqual(['API key', 'Custom header', 'None']);
    expect(within(auth).getByRole('radio', { name: 'API key' })).toHaveAttribute('aria-checked', 'true');
    expect(
      screen.getByText(/Sent as "Authorization: Bearer <key>", the OpenAI standard/),
    ).toBeInTheDocument();
    await userEvent.click(within(auth).getByRole('radio', { name: 'Custom header' }));
    expect(
      screen.getByText(/Sent as "api-key: <key>"\. Use it only if your gateway documents this header/),
    ).toBeInTheDocument();
  });
});

describe('guided setup', () => {
  it('connects, discovers models and starts chatting without leaving the panel', async () => {
    mount(baseState({ providers: [], selected: null }));
    expect(screen.queryByLabelText('Message Sovran')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Ollama/ }));
    expect(screen.getByLabelText('Base URL')).toHaveValue('http://localhost:11434/v1');
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));
    const save = sent.find((m) => m.type === 'saveProvider') as Extract<
      WebviewMessage,
      { type: 'saveProvider' }
    >;
    expect(save.provider).toMatchObject({
      name: 'Ollama',
      baseUrl: 'http://localhost:11434/v1',
      authType: 'none',
      models: [],
    });
    expect(screen.getByText('Connecting…')).toBeInTheDocument();

    // The host saves the provider (the app now has one), then reports the connection test.
    host({
      type: 'patch',
      patch: {
        providers: [
          {
            id: 'ollama',
            name: 'Ollama',
            baseUrl: 'http://localhost:11434/v1',
            authType: 'none',
            hasKey: false,
            models: [],
          },
        ],
      },
    });
    host({ type: 'providerSaved', requestId: save.requestId!, providerId: 'ollama' });
    expect(screen.getByText('Connecting…')).toBeInTheDocument();
    host({
      type: 'providerTest',
      requestId: save.requestId!,
      providerId: 'ollama',
      result: { ok: true, models: ['qwen2.5-coder:14b', 'llama3.1:8b'], message: 'Connected' },
    });

    expect(screen.getByRole('heading', { name: 'Choose a model' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: 'llama3.1:8b' }));
    await userEvent.click(screen.getByRole('button', { name: 'Start chatting' }));
    expect(sent).toContainEqual({
      type: 'addModels',
      providerId: 'ollama',
      modelIds: ['llama3.1:8b'],
      select: 'llama3.1:8b',
    });
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
    const save = [...sent].reverse().find((m) => m.type === 'saveProvider') as Extract<
      WebviewMessage,
      { type: 'saveProvider' }
    >;
    host({ type: 'providerSaved', requestId: save.requestId!, providerId: 'corp' });
    host({
      type: 'providerTest',
      requestId: save.requestId!,
      providerId: 'corp',
      result: { ok: false, message: 'HTTP 404: Not Found', hint: 'Add model IDs manually.' },
    });
    expect(screen.getByRole('alert')).toHaveTextContent('HTTP 404');
    await userEvent.click(screen.getByRole('button', { name: 'Enter a model ID instead' }));
    await userEvent.type(screen.getByLabelText('Model ID'), 'coder-large');
    await userEvent.click(screen.getByRole('button', { name: 'Start chatting' }));
    expect(sent).toContainEqual({
      type: 'addModels',
      providerId: 'corp',
      modelIds: ['coder-large'],
      select: 'coder-large',
    });
  });
});

describe('approval shortcuts', () => {
  const editApproval = (over: Partial<AppState> = {}) =>
    baseState({
      session: {
        id: 's',
        title: 't',
        messages: [
          { role: 'user', id: 'u', content: 'edit', createdAt: 0 },
          {
            role: 'assistant',
            id: 'a',
            content: '',
            createdAt: 0,
            toolCalls: [{ id: 'c1', name: 'edit_file', arguments: '{"path":"src/a.ts"}' }],
          },
        ],
      },
      run: {
        sessionId: 's',
        iteration: 1,
        maxIterations: 25,
        startedAt: Date.now(),
        activity: { phase: 'awaiting_approval', label: 'src/a.ts', callId: 'c1' },
      },
      approvals: [
        {
          id: 'ap',
          callId: 'c1',
          toolName: 'edit_file',
          title: 'src/a.ts',
          detail: {
            kind: 'edit',
            path: 'src/a.ts',
            isNew: false,
            diff: '@@ -1 +1 @@\n-a\n+b',
            added: 1,
            removed: 1,
          },
        },
      ],
      ...over,
    });
  const decisions = () => sent.filter((m) => m.type === 'approval');
  const composer = () => screen.getByLabelText('Message Sovran');

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const arm = async () => {
    const { ARM_MS } = await import('./components/Approval');
    act(() => {
      vi.advanceTimersByTime(ARM_MS + 10);
    });
  };

  it('approves with Enter in the empty chat input once the bar has been on screen briefly', async () => {
    mount(editApproval());
    // An Enter pressed right as the bar appears (sending a message, a key held down) does nothing.
    fireEvent.keyDown(composer(), { key: 'Enter' });
    expect(decisions()).toEqual([]);
    await arm();
    fireEvent.keyDown(composer(), { key: 'Enter', repeat: true });
    expect(decisions()).toEqual([]);
    fireEvent.keyDown(composer(), { key: 'Enter' });
    expect(decisions()).toEqual([
      { type: 'approval', id: 'ap', approved: true, grant: undefined, feedback: undefined },
    ]);
  });

  it('rejects with Escape at once, and Escape no longer stops the whole run while a decision waits', async () => {
    mount(editApproval());
    fireEvent.keyDown(composer(), { key: 'Escape' });
    expect(decisions()).toEqual([
      { type: 'approval', id: 'ap', approved: false, grant: undefined, feedback: undefined },
    ]);
    expect(sent).not.toContainEqual({ type: 'cancel' });
  });

  it('leaves the keys alone while the user types, in fields, menus and on focused buttons', async () => {
    mount(editApproval());
    await arm();
    fireEvent.change(composer(), { target: { value: 'actually, wait' } });
    fireEvent.keyDown(composer(), { key: 'Enter' });
    fireEvent.keyDown(composer(), { key: 'Escape' });
    fireEvent.keyDown(document.body, { key: 'Enter', ctrlKey: true });
    // Enter on a focused button presses that button, never the approval.
    fireEvent.keyDown(screen.getByRole('button', { name: 'Reject' }), { key: 'Enter' });
    fireEvent.keyDown(screen.getByRole('button', { name: /Approvals: Ask/ }), { key: 'Enter' });
    expect(decisions()).toEqual([]);
    // Anywhere else in the chat (the transcript, the page) the keys decide.
    fireEvent.keyDown(screen.getByLabelText('Conversation'), { key: 'Enter' });
    expect(decisions()).toHaveLength(1);
  });

  it('applies the checkbox to Enter, and Enter on the checkbox itself approves', async () => {
    mount(editApproval());
    await arm();
    const box = screen.getByRole('checkbox', { name: /without asking/ });
    fireEvent.click(box);
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(decisions()).toEqual([
      { type: 'approval', id: 'ap', approved: true, grant: 'session-edits', feedback: undefined },
    ]);
  });

  it('shows what the keys do in the input hint and announces them', () => {
    mount(editApproval());
    expect(screen.getByText('approve').closest('.sv-composer__keys')).toHaveTextContent('↵ approve');
    expect(screen.getByText('reject').closest('.sv-composer__keys')).toHaveTextContent('Esc reject');
    expect(
      screen.getByText(
        /waiting for your approval: Apply these changes\? Press Enter to apply or Escape to reject/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply' })).toHaveAttribute('aria-keyshortcuts', 'Enter');
  });

  it('keeps the pending tool call expanded: its detail cannot be folded away', () => {
    mount(editApproval());
    const row = screen.getByRole('button', { name: /Editing/ });
    expect(row).toHaveAttribute('aria-expanded', 'true');
    expect(row).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Open diff editor' })).toBeInTheDocument();
  });
});

describe('approvalKey', () => {
  it('ignores modified and composing keys and text being typed', async () => {
    const { approvalKey } = await import('./components/Approval');
    const key = (init: KeyboardEventInit, target: Element = document.body) => {
      const e = new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true });
      Object.defineProperty(e, 'target', { value: target });
      return approvalKey(e);
    };
    expect(key({ key: 'Enter' })).toBe('approve');
    expect(key({ key: 'Escape' })).toBe('reject');
    expect(key({ key: 'a' })).toBeNull();
    expect(key({ key: 'Enter', shiftKey: true })).toBeNull();
    expect(key({ key: 'Enter', isComposing: true })).toBeNull();
    const input = document.createElement('input');
    expect(key({ key: 'Enter' }, input)).toBeNull();
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    const item = document.createElement('div');
    menu.appendChild(item);
    expect(key({ key: 'Escape' }, item)).toBeNull();
  });
});

describe('native Web approval', () => {
  it('shows the complete URL and scope in Auto with only a one-time approval', async () => {
    const url = 'https://example.com/docs?topic=auth';
    mount(
      baseState({
        approvalMode: 'auto',
        mode: 'plan',
        session: {
          id: 's',
          title: 'Web',
          messages: [
            {
              role: 'assistant',
              id: 'a',
              content: '',
              createdAt: 0,
              toolCalls: [{ id: 'c1', name: 'web_fetch', arguments: JSON.stringify({ url }) }],
            },
          ],
        },
        run: {
          sessionId: 's',
          iteration: 1,
          maxIterations: 25,
          startedAt: Date.now(),
          activity: { phase: 'awaiting_approval', label: url, callId: 'c1' },
        },
        approvals: [
          {
            id: 'ap',
            callId: 'c1',
            toolName: 'web_fetch',
            title: url,
            reason: 'Public Web access requires approval for each URL.',
            detail: { kind: 'web', url },
          },
        ],
      }),
    );
    const bar = screen.getByRole('region', { name: 'Read this public web page?' });
    expect(within(bar).getByText(url)).toBeInTheDocument();
    expect(within(bar).getByText(/Reads this public URL and its robots.txt/)).toBeInTheDocument();
    expect(within(bar).queryByRole('button', { name: /Always allow/ })).not.toBeInTheDocument();
    expect(within(bar).queryByRole('checkbox')).not.toBeInTheDocument();
    await userEvent.click(within(bar).getByRole('button', { name: 'Fetch' }));
    expect(sent).toContainEqual({ type: 'approval', id: 'ap', approved: true, feedback: undefined });
  });
});

describe('native Git approvals', () => {
  it.each(['stage', 'unstage', 'commit'] as const)(
    'shows repository/files and requires one-time approval for %s',
    async (operation) => {
      const verb = { stage: 'Stage', unstage: 'Unstage', commit: 'Commit' }[operation];
      mount(
        baseState({
          approvalMode: 'auto',
          session: {
            id: 's',
            title: 'Git',
            messages: [
              {
                role: 'assistant',
                id: 'a',
                content: '',
                createdAt: 0,
                toolCalls: [{ id: 'c1', name: `git_${operation}`, arguments: '{}' }],
              },
            ],
          },
          run: {
            sessionId: 's',
            iteration: 1,
            maxIterations: 25,
            startedAt: Date.now(),
            activity: { phase: 'awaiting_approval', label: 'Git', callId: 'c1' },
          },
          approvals: [
            {
              id: 'ap',
              callId: 'c1',
              toolName: `git_${operation}`,
              title: 'Git',
              reason: 'Git writes always ask.',
              detail: {
                kind: 'git',
                operation,
                repository: 'app',
                branch: 'refs/heads/main',
                files: ['src/a.ts'],
                ...(operation === 'commit'
                  ? { message: 'feat: reviewed\n\nLiteral $(touch forbidden)' }
                  : {}),
                preview: '@@ -1 +1 @@\n-old\n+new',
                warnings: ['Hooks and signing may run programs.', 'Git changes have no checkpoint undo.'],
              },
            },
          ],
        }),
      );
      const bar = screen.getByRole('region', {
        name: operation === 'commit' ? 'Commit these staged changes?' : `${verb} these files?`,
      });
      expect(within(bar).getByText(/refs\/heads\/main/)).toBeInTheDocument();
      expect(within(bar).getByText('Hooks and signing may run programs.')).toBeInTheDocument();
      expect(screen.getByRole('list', { name: 'Files included in the Git action' })).toHaveTextContent(
        'src/a.ts',
      );
      if (operation === 'commit')
        expect(screen.getByLabelText('Commit message')).toHaveTextContent('Literal $(touch forbidden)');
      expect(within(bar).queryByRole('button', { name: /Always allow/ })).not.toBeInTheDocument();
      expect(within(bar).queryByRole('checkbox')).not.toBeInTheDocument();
      await userEvent.click(within(bar).getByRole('button', { name: verb }));
      expect(sent).toContainEqual({ type: 'approval', id: 'ap', approved: true, feedback: undefined });
    },
  );
});

describe('diff view', () => {
  it('numbers lines, keeps removed lines that look like headers and expands long diffs', async () => {
    const { parseDiff } = await import('./components/Diff');
    const diff = [
      '===',
      '--- a/q.sql\t',
      '+++ b/q.sql\t',
      '@@ -10,3 +10,3 @@',
      ' select 1;',
      '--- a comment',
      '+-- the comment',
      ' end;',
      '\\ No newline at end of file',
    ].join('\n');
    expect(parseDiff(diff)).toEqual([
      { kind: 'hunk', text: '@@ -10,3 +10,3 @@' },
      { kind: 'ctx', text: 'select 1;', line: 10 },
      { kind: 'del', text: '-- a comment', line: 11 },
      { kind: 'add', text: '-- the comment', line: 11 },
      { kind: 'ctx', text: 'end;', line: 12 },
      { kind: 'note', text: 'No newline at end of file' },
    ]);

    const long = ['@@ -1,0 +1,100 @@', ...Array.from({ length: 100 }, (_, i) => `+line ${i}`)].join('\n');
    mount(
      baseState({
        session: {
          id: 's',
          title: 't',
          messages: [
            {
              role: 'assistant',
              id: 'a',
              content: '',
              createdAt: 0,
              toolCalls: [{ id: 'c1', name: 'write_file', arguments: '{"path":"big.ts"}' }],
            },
          ],
        },
        run: {
          sessionId: 's',
          iteration: 1,
          maxIterations: 25,
          startedAt: Date.now(),
          activity: { phase: 'awaiting_approval', label: 'big.ts', callId: 'c1' },
        },
        approvals: [
          {
            id: 'ap',
            callId: 'c1',
            toolName: 'write_file',
            title: 'big.ts',
            detail: { kind: 'edit', path: 'big.ts', isNew: true, diff: long, added: 100, removed: 0 },
          },
        ],
      }),
    );
    expect(screen.getByRole('region', { name: 'Create this file?' })).toBeInTheDocument();
    expect(screen.queryByText('line 99')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show 21 more lines' }));
    expect(screen.getByText('line 99')).toBeInTheDocument();
  });
});

describe('chats in editor tabs', () => {
  it('shows which chats run, wait or are open in an editor tab, and opens one in a tab', async () => {
    mount(
      baseState({
        view: 'history',
        sessions: [
          { id: 'a', title: 'Fix login', createdAt: 0, updatedAt: Date.now(), messageCount: 4 },
          { id: 'b', title: 'Write docs', createdAt: 0, updatedAt: Date.now(), messageCount: 2 },
          { id: 'c', title: 'Old idea', createdAt: 0, updatedAt: Date.now(), messageCount: 1 },
        ],
        liveSessions: [
          { id: 'a', inEditor: true, running: true, needsApproval: true },
          { id: 'b', inEditor: false, running: true, needsApproval: false },
        ],
      }),
    );
    const item = (title: string) => screen.getByRole('button', { name: new RegExp(`^${title}`) });
    expect(item('Fix login')).toHaveTextContent(/Needs approval.*In editor/);
    expect(item('Write docs')).toHaveTextContent('Working');
    expect(item('Old idea')).not.toHaveTextContent(/Working|In editor|Needs approval/);
    await userEvent.click(screen.getByRole('button', { name: 'Open Old idea in an editor tab' }));
    expect(sent).toContainEqual({ type: 'openSessionInEditor', id: 'c' });
  });

  it('remembers the chat it shows, so a restored editor tab reopens it', async () => {
    const { getUiState } = await import('./vscode');
    mount(baseState({ surface: 'panel', session: { id: 'chat-42', title: 'Panel chat', messages: [] } }));
    expect(getUiState().sessionId).toBe('chat-42');
    expect(document.querySelector('.sv-app')).toHaveAttribute('data-surface', 'panel');
  });
});

describe('pinned message', () => {
  const rect = (top: number, height = 40) =>
    ({
      top,
      bottom: top + height,
      left: 0,
      right: 300,
      width: 300,
      height,
      x: 0,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;
  /** A scroll area whose top edge is at y = 100, holding your messages at the given tops. */
  const layout = (tops: number[]) => {
    const scroller = document.createElement('div');
    scroller.getBoundingClientRect = () => rect(100, 500);
    tops.forEach((top, i) => {
      const el = document.createElement('div');
      el.dataset.userMessage = `u${i}`;
      el.getBoundingClientRect = () => rect(top);
      scroller.appendChild(el);
    });
    return scroller;
  };

  it('pins the message whose answer is being read, and the next message pushes it out', async () => {
    const { pickPinned } = await import('./components/StickyPrompt');
    // At the top of the conversation the message is in view: nothing to pin.
    expect(pickPinned(layout([112, 600]), 64)).toBeNull();
    // Its top reached the top of the view: it sticks, like position: sticky.
    expect(pickPinned(layout([108, 600]), 64)).toEqual({ id: 'u0', offset: 0 });
    expect(pickPinned(layout([-300, 600]), 64)).toEqual({ id: 'u0', offset: 0 });
    // The next message arrives under the pin and pushes it up (150 − (100 + 64 + 8)).
    expect(pickPinned(layout([-300, 150]), 64)).toEqual({ id: 'u0', offset: -22 });
    // Pushed out until only padding would show: gone. Then the next one takes over.
    expect(pickPinned(layout([-300, 112]), 64)).toBeNull();
    expect(pickPinned(layout([-300, 108]), 64)).toEqual({ id: 'u1', offset: 0 });
    expect(pickPinned(layout([]), 64)).toBeNull();
  });

  it('shows your message above its answer while scrolling, and goes back to it when selected', async () => {
    const long =
      'Explain the retry logic and every place it is used, with the configuration that controls it';
    mount(
      baseState({
        session: {
          id: 's',
          title: 't',
          messages: [
            { role: 'user', id: 'u1', content: long, createdAt: 0 },
            { role: 'assistant', id: 'a1', content: 'A long answer', createdAt: 0 },
            { role: 'user', id: 'u2', content: 'Thanks', display: '/thanks', createdAt: 0 },
          ],
        },
      }),
    );
    const conversation = screen.getByLabelText('Conversation');
    const [first, second] = [...conversation.querySelectorAll<HTMLElement>('[data-user-message]')];
    expect(first!.dataset.userMessage).toBe('u1');
    conversation.getBoundingClientRect = () => rect(0, 500);
    conversation.scrollTo = vi.fn() as never;
    let tops = [20, 900];
    first!.getBoundingClientRect = () => rect(tops[0]!);
    second!.getBoundingClientRect = () => rect(tops[1]!);
    const scroll = async () => {
      await act(async () => {
        fireEvent.scroll(conversation);
        await new Promise((r) => requestAnimationFrame(() => r(undefined)));
      });
    };
    await scroll();
    expect(screen.queryByRole('button', { name: /^Your message/ })).not.toBeInTheDocument();

    tops = [-400, 300];
    Object.defineProperty(conversation, 'scrollTop', { configurable: true, value: 1000 });
    await scroll();
    const pin = screen.getByRole('button', { name: `Your message: ${long}. Go to it` });
    expect(pin).toHaveTextContent(long);
    await userEvent.click(pin);
    // Back to the message, a little below the pinning line so it is read whole and not pinned over itself.
    // 1000 + (−400) − 0 − 12: the message lands 12 px below the top edge.
    expect(conversation.scrollTo).toHaveBeenCalledWith({ top: 588, behavior: 'smooth' });

    // The next exchange: its message (as typed) is pinned instead.
    tops = [-1400, -600];
    await scroll();
    expect(screen.getByRole('button', { name: /^Your message: \/thanks/ })).toBeInTheDocument();
  });
});

describe('MCP servers', () => {
  const github: McpServerView = {
    id: 'github',
    name: 'GitHub',
    enabled: true,
    transport: 'http',
    url: 'https://api.githubcopilot.com/mcp/',
    auth: { type: 'bearer' },
    hasToken: true,
    insecure: false,
    timeoutSeconds: 60,
    status: 'connected',
    server: { name: 'github-mcp-server', version: '1.4.2' },
    toolTokens: 2140,
    tools: [
      {
        name: 'search_issues',
        title: 'Search issues',
        modelName: 'mcp__github__search_issues',
        policy: 'allow',
        hints: ['read-only'],
        description: 'Search issues.',
      },
      {
        name: 'merge_pull_request',
        modelName: 'mcp__github__merge_pull_request',
        policy: 'off',
        hints: ['destructive'],
        description: 'Merges a pull request.',
      },
    ],
  };
  const jira: McpServerView = {
    id: 'jira',
    name: 'Jira',
    enabled: true,
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-atlassian', '--read-only mode'],
    auth: { type: 'env', envName: 'JIRA_API_TOKEN' },
    hasToken: false,
    insecure: false,
    timeoutSeconds: 120,
    status: 'error',
    error: 'No token is stored for Jira. Add it with Set token.',
    toolTokens: 0,
    tools: [],
  };
  const open = async (servers: McpServerView[], over: Partial<AppState> = {}) => {
    setUiState({ draft: '', settingsArea: 'mcp' });
    const view = mount(baseState({ view: 'settings', mcp: { active: true, servers }, ...over }));
    await clickButton(/^Integrations/);
    return view;
  };

  it('shows each server, how it is doing and what to do when it is not connected', async () => {
    await open([github, jira]);
    const card = screen.getByRole('region', { name: 'GitHub' });
    expect(within(card).getByRole('status')).toHaveTextContent('Connected');
    await userEvent.click(within(card).getByRole('button', { name: 'Advanced settings' }));
    expect(within(card).getByText('https://api.githubcopilot.com/mcp/')).toBeVisible();
    expect(within(card).getByText(/github-mcp-server 1.4.2/)).toBeVisible();
    expect(within(card).getByRole('button', { name: 'Replace token' })).toBeVisible();
    const broken = screen.getByRole('region', { name: 'Jira' });
    expect(within(broken).queryByText('uvx mcp-atlassian "--read-only mode"')).not.toBeInTheDocument();
    expect(within(broken).getByRole('alert')).toHaveTextContent('No token is stored for Jira');
    await userEvent.click(within(broken).getByRole('button', { name: 'Try again' }));
    expect(sent).toContainEqual({ type: 'restartMcpServer', id: 'jira' });
    await userEvent.click(within(broken).getByRole('button', { name: 'Set token' }));
    expect(sent).toContainEqual({ type: 'setMcpToken', id: 'jira' });
    await userEvent.click(within(card).getByRole('button', { name: 'Disconnect' }));
    expect(sent).toContainEqual({ type: 'setMcpServerEnabled', id: 'github', enabled: false });
    await userEvent.click(within(card).getByRole('button', { name: 'Remove GitHub' }));
    expect(sent).toContainEqual({ type: 'deleteMcpServer', id: 'github' });
  });

  it('lists the tools with what the server says about them and lets the user choose what each may do', async () => {
    await open([github]);
    expect(screen.queryByText(/tokens/)).not.toBeInTheDocument();
    await clickButton(/^Tool permissions/);
    const tools = screen.getByRole('list', { name: 'Tools of GitHub' });
    expect(within(tools).getByText('read-only')).toBeInTheDocument();
    expect(within(tools).getByText('can change data')).toBeInTheDocument();
    const merge = screen.getByRole('radiogroup', { name: 'merge_pull_request: when the agent uses it' });
    expect(within(merge).getByRole('radio', { name: 'Off' })).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(within(merge).getByRole('radio', { name: 'Ask' }));
    expect(sent).toContainEqual({
      type: 'setMcpToolPolicy',
      id: 'github',
      tool: 'merge_pull_request',
      policy: 'ask',
    });
    const search = screen.getByRole('radiogroup', { name: 'Search issues: when the agent uses it' });
    within(search).getByRole('radio', { name: 'Allow' }).focus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(sent).toContainEqual({
      type: 'setMcpToolPolicy',
      id: 'github',
      tool: 'search_issues',
      policy: 'ask',
    });
  });

  it('uses native Git instead of the basic preset and preserves saved Git MCP servers', async () => {
    const { unmount } = await open([]);
    await clickButton(/^Browse Catalog$/);
    const presets = screen.getByRole('list', { name: 'Integration catalog' });
    expect(within(presets).queryByRole('button', { name: /^Configure Git$/ })).not.toBeInTheDocument();
    unmount();
    await open([
      {
        ...jira,
        id: 'legacygit',
        name: 'Git',
        command: 'uvx',
        args: ['mcp-server-git', '--repository', '${workspaceFolder}'],
        status: 'connected',
        error: undefined,
      },
    ]);
    const saved = screen.getByRole('region', { name: 'Git' });
    await userEvent.click(within(saved).getByRole('button', { name: 'Advanced settings' }));
    expect(within(saved).getByText(/mcp-server-git/)).toBeVisible();
    expect(
      sent.some((message) => message.type === 'deleteMcpServer' || message.type === 'saveMcpServer'),
    ).toBe(false);
    await userEvent.click(within(saved).getByRole('button', { name: 'Edit Git' }));
    expect(screen.getByLabelText('Arguments')).toHaveValue(
      'mcp-server-git\n--repository\n${workspaceFolder}',
    );
  });

  it('shows the unified catalog and configures a preset without installing or connecting it', async () => {
    await open([]);
    await clickButton(/^Browse Catalog$/);
    const catalog = screen.getByRole('list', { name: 'Integration catalog' });
    expect(within(catalog).getAllByRole('listitem')).toHaveLength(5);
    expect(within(catalog).getByRole('button', { name: 'Configure Context7 MCP' })).toBeInTheDocument();
    expect(within(catalog).getByRole('button', { name: 'Configure GitLab MCP' })).toBeInTheDocument();
    expect(within(catalog).getAllByText('Remote · Not configured')).toHaveLength(3);
    expect(within(catalog).getByText(/Node\.js 20\+ with npm/)).toBeInTheDocument();
    expect(
      sent.some((message) =>
        ['installMcpIntegration', 'addMcpIntegration', 'setMcpServerEnabled', 'saveMcpServer'].includes(
          message.type,
        ),
      ),
    ).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Configure Playwright MCP' }));
    expect(sent).toContainEqual({
      type: 'addMcpIntegration',
      integration: 'playwright',
      profile: 'isolated',
    });
    expect(
      sent.some(
        (message) => message.type === 'installMcpIntegration' || message.type === 'setMcpServerEnabled',
      ),
    ).toBe(false);
  });

  it('can connect Context7 without a key and shows Connected only on the host status', async () => {
    const context7: McpServerView = {
      ...github,
      id: 'context7-mcp',
      name: 'Context7 MCP',
      url: 'https://mcp.context7.com/mcp',
      managed: { id: 'context7', profile: 'readonly', version: 'hosted-v1' },
      enabled: false,
      hasToken: false,
      status: 'disabled',
      tools: [],
      toolTokens: 0,
    };
    await open([context7]);
    const card = screen.getByRole('region', { name: 'Context7 MCP' });
    expect(within(card).getByRole('status')).toHaveTextContent('Configured');
    expect(within(card).getByRole('button', { name: 'Set API key (optional)' })).toBeVisible();
    await userEvent.click(within(card).getByRole('button', { name: 'Connect' }));
    expect(sent).toContainEqual({ type: 'setMcpServerEnabled', id: context7.id, enabled: true });
    expect(within(card).getByRole('status')).toHaveTextContent('Configured');
    host({
      type: 'patch',
      patch: { mcp: { active: true, servers: [{ ...context7, enabled: true, status: 'starting' }] } },
    });
    expect(within(card).getByRole('status')).toHaveTextContent('Connecting');
    expect(within(card).getByRole('button', { name: 'Disconnect' })).toBeEnabled();
    host({
      type: 'patch',
      patch: { mcp: { active: true, servers: [{ ...context7, enabled: true, status: 'connected' }] } },
    });
    expect(within(card).getByRole('status')).toHaveTextContent('Connected');
  });

  it('keeps custom local commands and field validation available', async () => {
    await open([]);
    await clickButton(/^Custom MCP Server$/);
    await userEvent.type(screen.getByLabelText('Name'), 'My files');
    await clickButton(/^Advanced connection settings$/);
    await userEvent.type(screen.getByLabelText('Environment'), 'bad name=1');
    await userEvent.click(screen.getByRole('button', { name: 'Add server' }));
    expect(
      screen.getByText('Enter the command that starts the server, for example npx.'),
    ).toBeInTheDocument();
    expect(screen.getByText(/Line 1: Use letters, digits and _/)).toBeInTheDocument();
    expect(sent.some((m) => m.type === 'saveMcpServer')).toBe(false);
    await userEvent.type(screen.getByLabelText('Command'), 'node');
    await userEvent.clear(screen.getByLabelText('Environment'));
    await userEvent.type(screen.getByLabelText('Environment'), 'LOG_LEVEL=debug');
    await userEvent.click(screen.getByRole('button', { name: 'Add server' }));
    expect(sent).toContainEqual({
      type: 'saveMcpServer',
      server: {
        name: 'My files',
        transport: 'stdio',
        command: 'node',
        env: { LOG_LEVEL: 'debug' },
        auth: { type: 'none' },
      },
    });
  });

  it('preserves the custom server draft when collapsed and returns focus after cancel', async () => {
    await open([]);
    const add = screen.getByRole('button', { name: 'Custom MCP Server' });
    await userEvent.click(add);
    const name = screen.getByLabelText('Name');
    expect(name).toHaveFocus();
    await userEvent.type(name, 'Draft server');
    await clickButton(/^Integrations/);
    expect(name).not.toBeVisible();
    await clickButton(/^Integrations/);
    expect(name).toHaveValue('Draft server');
    await clickButton(/^Cancel$/);
    expect(add).toHaveFocus();
    expect(sent.some((message) => message.type === 'saveMcpServer')).toBe(false);
  });

  it('makes existing-profile browser access and GitHub writes explicit choices', async () => {
    await open([]);
    await clickButton(/^Browse Catalog$/);
    await userEvent.click(
      within(screen.getByRole('listitem', { name: 'Playwright MCP' })).getByRole('button', {
        name: 'Advanced settings',
      }),
    );
    await userEvent.selectOptions(screen.getByLabelText('Browser profile'), 'extension');
    expect(screen.getByText(/Approved tabs can expose signed-in accounts/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Configure Playwright MCP' }));
    expect(sent).toContainEqual({
      type: 'addMcpIntegration',
      integration: 'playwright',
      profile: 'extension',
    });
    await clickButton(/^Browse Catalog$/);
    await userEvent.click(
      within(screen.getByRole('listitem', { name: 'GitHub MCP' })).getByRole('button', {
        name: 'Advanced settings',
      }),
    );
    expect(screen.getByLabelText('Access mode')).toHaveValue('readonly');
    await userEvent.selectOptions(screen.getByLabelText('Access mode'), 'collaboration');
    expect(screen.getByText(/writes start on Ask/)).toBeInTheDocument();
  });

  it('fills the form from a README snippet and moves its token to Secret Storage', async () => {
    await open([github]);
    await clickButton(/^Custom MCP Server$/);
    await userEvent.click(screen.getByText("Paste the JSON from the server's README"));
    const snippet =
      '{ "mcpServers": { "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_123456789" } } } }';
    fireEvent.change(screen.getByLabelText('JSON snippet'), { target: { value: snippet } });
    await userEvent.click(screen.getByRole('button', { name: 'Fill in the form' }));
    expect(screen.getByLabelText('Name')).toHaveValue('github');
    expect(screen.getByRole('list', { name: 'What the import changed' })).toHaveTextContent(
      'GITHUB_PERSONAL_ACCESS_TOKEN moves to Secret Storage.',
    );
    await clickButton(/^Advanced connection settings$/);
    expect(screen.getByLabelText('Environment')).toHaveValue('');
    expect(screen.getByLabelText('Environment variable name')).toHaveValue('GITHUB_PERSONAL_ACCESS_TOKEN');
    expect(screen.getByLabelText('Token')).toHaveAttribute('type', 'password');
    await userEvent.click(screen.getByRole('button', { name: 'Add server' }));
    expect(sent).toContainEqual({
      type: 'saveMcpServer',
      server: {
        name: 'github',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        auth: { type: 'env', envName: 'GITHUB_PERSONAL_ACCESS_TOKEN' },
        token: 'ghp_123456789',
      },
    });
  });

  it('edits a remote server without showing its token, and warns about plain http', async () => {
    await open([github]);
    await clickButton(/^Advanced settings/);
    await userEvent.click(screen.getByRole('button', { name: 'Edit GitHub' }));
    expect(screen.queryByText("Paste the JSON from the server's README")).not.toBeInTheDocument();
    expect(screen.getByLabelText('Token')).toHaveValue('');
    expect(screen.getByLabelText('Token')).toHaveAttribute(
      'placeholder',
      'Token stored for the current connection',
    );
    await userEvent.clear(screen.getByLabelText('URL'));
    await userEvent.type(screen.getByLabelText('URL'), 'http://mcp.corp.example/mcp');
    expect(screen.getByRole('note')).toHaveTextContent('the token would travel unencrypted');
    await userEvent.click(screen.getByRole('radio', { name: 'Local command' }));
    // A bearer token does not fit a local server: the choice falls back to none.
    expect(screen.getByRole('radio', { name: 'None' })).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(screen.getByRole('radio', { name: 'Remote URL' }));
    await userEvent.click(screen.getByRole('radio', { name: 'Bearer token' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save server' }));
    expect(sent).toContainEqual({
      type: 'saveMcpServer',
      server: {
        id: 'github',
        name: 'GitHub',
        transport: 'http',
        url: 'http://mcp.corp.example/mcp',
        auth: { type: 'bearer' },
      },
    });
  });

  it('explains Restricted Mode', async () => {
    await open([jira], {
      workspace: { name: 'w', trusted: false, hasFolder: true },
      mcp: { active: false, servers: [jira] },
    });
    expect(
      screen.getByText(/This workspace is in Restricted Mode, so MCP servers do not start/),
    ).toBeInTheDocument();
  });

  it('asks before an MCP tool runs, showing the arguments, and can stop asking for that tool', async () => {
    const args = '{\n  "title": "Bug"\n}';
    mount(
      baseState({
        approvalMode: 'auto',
        mcp: { active: true, servers: [github] },
        session: {
          id: 's',
          title: 't',
          messages: [
            {
              role: 'assistant',
              id: 'a',
              content: '',
              createdAt: 0,
              toolCalls: [{ id: 'c1', name: 'mcp__github__create_issue', arguments: '{"title":"Bug"}' }],
            },
          ],
        },
        run: {
          sessionId: 's',
          iteration: 1,
          maxIterations: 25,
          startedAt: Date.now(),
          activity: { phase: 'awaiting_approval', label: 'Create issue · GitHub', callId: 'c1' },
        },
        approvals: [
          {
            id: 'ap',
            callId: 'c1',
            toolName: 'mcp__github__create_issue',
            title: 'Create issue · GitHub',
            reason: 'Tools of MCP servers ask before they run, in every approval mode, until you allow them.',
            detail: {
              kind: 'mcp',
              server: 'GitHub',
              tool: 'create_issue',
              title: 'Create issue',
              arguments: args,
              hints: ['open-world'],
            },
          },
        ],
      }),
    );
    const bar = screen.getByRole('region', { name: 'Run this MCP tool?' });
    expect(bar).toHaveTextContent('create_issue on GitHub');
    expect(
      within(bar).getByText('The server says this tool reaches services outside your machine.'),
    ).toBeInTheDocument();
    expect(within(bar).getByLabelText('Arguments')).toHaveTextContent('"title": "Bug"');
    expect(within(bar).getByRole('note')).toHaveTextContent(
      'Auto mode still asks here: Tools of MCP servers ask before they run',
    );
    // The transcript row names the tool and its server.
    expect(screen.getByText('Create issue · GitHub', { selector: '.sv-tool__target' })).toBeInTheDocument();
    await userEvent.click(within(bar).getByRole('button', { name: 'Always allow create_issue' }));
    expect(sent).toContainEqual({
      type: 'approval',
      id: 'ap',
      approved: true,
      grant: undefined,
      feedback: undefined,
      allowTool: true,
    });
  });

  it('names MCP tools in the transcript, also after their server is gone', () => {
    mount(
      baseState({
        session: {
          id: 's',
          title: 't',
          messages: [
            { role: 'user', id: 'u', content: 'find it', createdAt: 0 },
            {
              role: 'assistant',
              id: 'a',
              content: '',
              createdAt: 0,
              toolCalls: [
                { id: 'c1', name: 'mcp__github__search_issues', arguments: '{}' },
                { id: 'c2', name: 'mcp__gone__lookup', arguments: '{}' },
              ],
            },
            {
              role: 'tool',
              id: 't1',
              toolCallId: 'c1',
              toolName: 'mcp__github__search_issues',
              content: 'none',
              status: 'success',
              summary: 'Search issues · GitHub',
              createdAt: 0,
            },
          ],
        },
        mcp: { active: true, servers: [github] },
      }),
    );
    expect(screen.getByText('Search issues · GitHub', { selector: '.sv-tool__target' })).toBeInTheDocument();
    expect(screen.getByText('lookup · gone', { selector: '.sv-tool__target' })).toBeInTheDocument();
    expect(screen.getAllByText('Used').length).toBeGreaterThan(0);
  });
});
