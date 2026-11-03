import { useEffect, useMemo, useReducer, useState } from 'react';
import type { HostMessage } from '../../src/shared/protocol';
import { Composer, RunStatus } from './components/Composer';
import { EmptyState, HistoryView, Notices, ProvidersView } from './components/Panels';
import { Mark } from './components/primitives';
import { Transcript } from './components/Transcript';
import { StoreContext, initialUiState, reducer, useStore } from './state/store';
import { post } from './vscode';

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
  const messages = app.session?.messages ?? [];
  return (
    <>
      <header className="sv-header">
        <Mark size={14} />
        <SessionTitle />
      </header>
      {!app.workspace.trusted ? (
        <div className="sv-banner" role="note">
          <i className="codicon codicon-shield" aria-hidden="true" />
          <span>Restricted Mode: SOVRAN can read and plan, but cannot edit files or run commands until you trust this workspace.</span>
        </div>
      ) : null}
      <main className="sv-main">
        {messages.length ? (
          <Transcript messages={messages} run={app.run} />
        ) : (
          <div className="sv-transcript">
            <EmptyState />
          </div>
        )}
        <Notices />
        {app.run ? <RunStatus run={app.run} /> : null}
        {app.providers.length > 0 || messages.length > 0 ? <Composer /> : null}
      </main>
    </>
  );
}

function LiveAnnouncer() {
  const { app } = useStore();
  const phase = app.run?.activity.phase;
  const text = !app.run ? '' : phase === 'awaiting_approval' ? 'SOVRAN is waiting for your approval.' : phase === 'running' ? `SOVRAN is ${app.run.activity.label}.` : 'SOVRAN is working.';
  return (
    <div className="sv-sr-only" aria-live="polite">
      {text}
    </div>
  );
}

function Shell() {
  const { app } = useStore();
  return (
    <div className="sv-app" data-mode={app.mode}>
      {app.view === 'history' ? <HistoryView /> : app.view === 'providers' ? <ProvidersView /> : <ChatView />}
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
    window.addEventListener('message', onMessage);
    post({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);
  const value = useMemo(() => (state.app ? { state, app: state.app, dispatch } : null), [state]);
  if (!value) return <div className="sv-app" aria-busy="true" />;
  return (
    <StoreContext.Provider value={value}>
      <Shell />
    </StoreContext.Provider>
  );
}
