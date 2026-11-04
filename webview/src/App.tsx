import { useEffect, useMemo, useReducer, useState } from 'react';
import type { HostMessage } from '../../src/shared/protocol';
import { ApprovalBar, approvalCopy } from './components/Approval';
import { Composer, RunStatus } from './components/Composer';
import { EmptyState } from './components/Home';
import { HistoryView, Notices, ProvidersView, useSetupActive } from './components/Panels';
import { Mark } from './components/primitives';
import { SettingsView } from './components/Settings';
import { Transcript } from './components/Transcript';
import { StoreContext, initialUiState, reducer, useStore } from './state/store';
import { post, setUiState } from './vscode';

function SessionTitle() {
  const { app } = useStore();
  const [editing, setEditing] = useState<string | null>(null);
  const session = app.session;
  if (!session) return null;
  if (editing !== null) {
    const commit = () => {
      if (editing.trim() && editing.trim() !== session.title) post({ type: 'renameSession', id: session.id, title: editing.trim() });
      setEditing(null);
    };
    return (
      <input
        className="sv-header__input"
        aria-label="Chat title"
        value={editing}
        autoFocus
        onChange={(e) => setEditing(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') setEditing(null);
        }}
      />
    );
  }
  return (
    <button
      type="button"
      className="sv-header__title"
      title={session.messages.length ? 'Rename chat' : undefined}
      disabled={session.messages.length === 0}
      onClick={() => setEditing(session.title)}
    >
      {session.title}
    </button>
  );
}

function ChatView() {
  const { app } = useStore();
  const setup = useSetupActive();
  const messages = app.session?.messages ?? [];
  // Tools run one at a time, so a chat waits for at most one decision; the first is the one to answer.
  const approval = app.approvals[0];
  return (
    <>
      <header className="sv-header">
        <Mark size={16} />
        <SessionTitle />
      </header>
      {!app.workspace.trusted ? (
        <div className="sv-banner" role="note">
          <i className="codicon codicon-shield" aria-hidden="true" />
          <span>Restricted Mode: Sovran can read and plan, but cannot edit files or run commands until you trust this workspace.</span>
        </div>
      ) : null}
      {approval ? <ApprovalBar key={approval.id} approval={approval} /> : null}
      <main className="sv-main">
        {messages.length ? (
          <Transcript key={app.session?.id} messages={messages} run={app.run} />
        ) : (
          <div className="sv-transcript">
            <EmptyState />
          </div>
        )}
        <Notices />
        {app.run ? <RunStatus run={app.run} /> : null}
        {/* Hidden while the guided setup is on screen; an existing conversation always keeps its composer. */}
        {messages.length > 0 || !setup ? <Composer /> : null}
      </main>
    </>
  );
}

function LiveAnnouncer() {
  const { app } = useStore();
  const phase = app.run?.activity.phase;
  const approval = app.approvals[0];
  const text = approval
    ? `Sovran is waiting for your approval: ${approvalCopy(approval).title} Press Enter to ${approvalCopy(approval).verb.toLowerCase()} or Escape to reject.`
    : !app.run
      ? ''
      : phase === 'running'
        ? `Sovran is ${app.run.activity.label}.`
        : 'Sovran is working.';
  return (
    <div className="sv-sr-only" aria-live="polite">
      {text}
    </div>
  );
}

function Shell() {
  const { app } = useStore();
  return (
    <div className="sv-app" data-surface={app.surface} data-mode={app.mode} data-approval={app.mode === 'act' ? app.approvalMode : undefined}>
      {app.view === 'history' ? <HistoryView /> : app.view === 'providers' ? <ProvidersView /> : app.view === 'settings' ? <SettingsView /> : <ChatView />}
      <LiveAnnouncer />
    </div>
  );
}

export function App() {
  const [state, dispatch] = useReducer(reducer, initialUiState);
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const data = e.data as HostMessage | undefined;
      if (data && typeof data === 'object' && typeof data.type === 'string') dispatch(data);
    };
    // Commands such as "Ask Sovran About Selection" go to the Sovran webview the user worked in last.
    const onFocus = () => post({ type: 'focused' });
    window.addEventListener('message', onMessage);
    window.addEventListener('focus', onFocus);
    post({ type: 'ready' });
    return () => {
      window.removeEventListener('message', onMessage);
      window.removeEventListener('focus', onFocus);
    };
  }, []);
  // Saved with the webview, so a chat in an editor tab comes back with the same chat after VS Code restarts.
  const sessionId = state.app?.session?.id;
  useEffect(() => {
    if (sessionId) setUiState({ sessionId });
  }, [sessionId]);
  const value = useMemo(() => (state.app ? { state, app: state.app, dispatch } : null), [state]);
  if (!value) return <div className="sv-app" aria-busy="true" />;
  return (
    <StoreContext.Provider value={value}>
      <Shell />
    </StoreContext.Provider>
  );
}
