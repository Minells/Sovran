import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { ProviderInput, ProviderView, SessionSummary, ToolMode } from '../../../src/shared/protocol';
import { sendsKeyInsecurely } from '../../../src/shared/endpoints';
import { dayGroup, relativeTime } from '../lib/format';
import { useStore } from '../state/store';
import { post } from '../vscode';
import { AuthField, SetupWizard } from './Onboarding';
import { Button, Icon, IconButton } from './primitives';

// ------------------------------------------------------------------------------------- setup

/** True while the first-run setup should be on screen (no provider yet, or the guided setup is still open). */
export function useSetupActive(): boolean {
  const { app, state } = useStore();
  return app.providers.length === 0 || state.setupActive;
}

// ------------------------------------------------------------------------------------- provider form

interface ModelDraft {
  id: string;
  contextWindow?: number;
  toolMode?: ToolMode;
}

export function ProviderForm({ initial, onDone }: { initial: Partial<ProviderInput> & { id?: string }; onDone: () => void }) {
  const { state } = useStore();
  const [name, setName] = useState(initial.name ?? '');
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl ?? '');
  const [authType, setAuthType] = useState<ProviderInput['authType']>(initial.authType ?? 'bearer');
  const [headerName, setHeaderName] = useState(initial.headerName ?? 'api-key');
  const [timeout, setTimeoutValue] = useState(initial.timeoutSeconds ? String(initial.timeoutSeconds) : '');
  const [models, setModels] = useState<ModelDraft[]>(initial.models ?? []);
  const [newModel, setNewModel] = useState('');
  const [touched, setTouched] = useState(false);
  const discovered = initial.id ? (state.providerTests[initial.id]?.models ?? []).filter((m) => !models.some((x) => x.id === m)) : [];

  const urlError = useMemo(() => {
    try {
      const p = new URL(baseUrl).protocol;
      return p === 'http:' || p === 'https:' ? '' : 'Use an http:// or https:// URL.';
    } catch {
      return 'Enter the full base URL, for example http://localhost:11434/v1';
    }
  }, [baseUrl]);
  const nameError = name.trim() ? '' : 'Give this provider a name.';

  const addModel = (id: string) => {
    const v = id.trim();
    if (v && !models.some((m) => m.id === v)) setModels([...models, { id: v }]);
    setNewModel('');
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (urlError || nameError) return;
    post({
      type: 'saveProvider',
      provider: {
        id: initial.id,
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        authType,
        headerName: authType === 'header' ? headerName.trim() : undefined,
        timeoutSeconds: timeout ? Math.min(1800, Math.max(5, Number(timeout))) : undefined,
        models: models.map((m) => ({ id: m.id, contextWindow: m.contextWindow, toolMode: m.toolMode })),
      },
    });
    onDone();
  };

  return (
    <form className="sv-form" onSubmit={submit} noValidate aria-label={initial.id ? `Edit ${initial.name}` : 'Add provider'}>
      <div className="sv-field">
        <label htmlFor="sv-p-name">Name</label>
        <input id="sv-p-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus={!initial.name} />
        {touched && nameError ? <span className="sv-field__error">{nameError}</span> : null}
      </div>
      <div className="sv-field">
        <label htmlFor="sv-p-url">Base URL</label>
        <input id="sv-p-url" value={baseUrl} placeholder="https://llm.internal.example/v1" onChange={(e) => setBaseUrl(e.target.value)} spellCheck={false} />
        {touched && urlError ? <span className="sv-field__error">{urlError}</span> : <span className="sv-field__help">Usually ends in /v1. Sovran calls /chat/completions and /models.</span>}
      </div>
      <AuthField
        authType={authType}
        setAuthType={setAuthType}
        headerName={headerName}
        setHeaderName={setHeaderName}
        insecure={!urlError && sendsKeyInsecurely(baseUrl, authType)}
      />
      <div className="sv-field">
        <label htmlFor="sv-p-timeout">Timeout (seconds)</label>
        <input id="sv-p-timeout" inputMode="numeric" value={timeout} placeholder="120" onChange={(e) => setTimeoutValue(e.target.value.replace(/\D/g, ''))} />
        <span className="sv-field__help">Large local models can take a minute to load.</span>
      </div>
      <div className="sv-field">
        <label htmlFor="sv-p-model">Models</label>
        {models.map((m, i) => (
          <div key={m.id} className="sv-model-row">
            <code title={m.id}>{m.id}</code>
            <input
              aria-label={`Context window for ${m.id}`}
              inputMode="numeric"
              placeholder="ctx 32768"
              value={m.contextWindow ?? ''}
              onChange={(e) => {
                const v = e.target.value.replace(/\D/g, '');
                setModels(models.map((x, j) => (j === i ? { ...x, contextWindow: v ? Number(v) : undefined } : x)));
              }}
            />
            <select
              aria-label={`Tool calling for ${m.id}`}
              value={m.toolMode ?? 'auto'}
              onChange={(e) => setModels(models.map((x, j) => (j === i ? { ...x, toolMode: e.target.value as ToolMode } : x)))}
            >
              <option value="auto">Tools: auto</option>
              <option value="native">native</option>
              <option value="prompted">prompted</option>
              <option value="none">none</option>
            </select>
            <IconButton icon="trash" label={`Remove ${m.id}`} onClick={() => setModels(models.filter((_, j) => j !== i))} />
          </div>
        ))}
        <div className="sv-inline">
          <input
            id="sv-p-model"
            value={newModel}
            placeholder="Model ID, e.g. qwen2.5-coder:14b"
            onChange={(e) => setNewModel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addModel(newModel);
              }
            }}
          />
          <Button onClick={() => addModel(newModel)} disabled={!newModel.trim()}>
            Add
          </Button>
        </div>
        {discovered.length ? (
          <div className="sv-discovered" aria-label="Models found on the server">
            {discovered.slice(0, 30).map((m) => (
              <button key={m} type="button" className="sv-chip" onClick={() => addModel(m)}>
                <Icon name="add" />
                <span>{m}</span>
              </button>
            ))}
          </div>
        ) : (
          <span className="sv-field__help">{initial.id ? 'Use Test connection to discover models.' : 'You can also discover models after saving.'}</span>
        )}
      </div>
      <div className="sv-approval__actions">
        <Button type="submit" variant="primary">
          Save provider
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

// ------------------------------------------------------------------------------------- providers view

function ProviderCard({ p, onEdit }: { p: ProviderView; onEdit: () => void }) {
  const { state } = useStore();
  const test = state.providerTests[p.id];
  const [pendingRequest, setPendingRequest] = useState<string | null>(null);
  // Derived, not synchronized: the test is running until a result for our request id arrives.
  const testing = pendingRequest !== null && test?.requestId !== pendingRequest;
  const learnedPrompted = p.models.filter((m) => m.learnedToolMode === 'prompted' && m.toolMode === 'auto').length;
  return (
    <section className="sv-card" aria-label={p.name}>
      <div className="sv-card__head">
        <span className="sv-card__title">{p.name}</span>
        <IconButton icon="edit" label={`Edit ${p.name}`} onClick={onEdit} />
        <IconButton icon="trash" label={`Remove ${p.name}`} onClick={() => post({ type: 'deleteProvider', id: p.id })} />
      </div>
      <div className="sv-card__url">{p.baseUrl}</div>
      <div className="sv-badges">
        {p.authType === 'none' ? (
          <span className="sv-badge">No auth</span>
        ) : p.hasKey ? (
          <span className="sv-badge sv-badge--ok">
            <Icon name="key" /> Key stored
          </span>
        ) : (
          <span className="sv-badge sv-badge--warn">
            <Icon name="warning" /> No key
          </span>
        )}
        <span className="sv-badge">
          {p.models.length} model{p.models.length === 1 ? '' : 's'}
        </span>
        {learnedPrompted ? <span className="sv-badge" title="These models rejected native tool calling; Sovran uses prompted tools">prompted tools ×{learnedPrompted}</span> : null}
        {sendsKeyInsecurely(p.baseUrl, p.authType) ? (
          <span className="sv-badge sv-badge--warn" title="The API key is sent over plain http to another machine. Use an https URL.">
            <Icon name="unlock" /> Key sent over http
          </span>
        ) : null}
      </div>
      {test ? (
        <div className={`sv-test ${test.ok ? 'sv-test--ok' : 'sv-test--err'}`} role="status">
          <Icon name={test.ok ? 'pass' : 'error'} />
          <div>
            <div>
              {test.message}
              {test.latencyMs !== undefined ? <span className="sv-tabular"> · {test.latencyMs} ms</span> : null}
            </div>
            {test.hint ? <div className="sv-test__hint">{test.hint}</div> : null}
          </div>
        </div>
      ) : null}
      <div className="sv-approval__actions">
        <Button
          icon={testing ? 'loading' : 'plug'}
          disabled={testing}
          onClick={() => {
            const requestId = `${p.id}-${Date.now()}`;
            setPendingRequest(requestId);
            post({ type: 'testProvider', requestId, providerId: p.id });
          }}
        >
          {testing ? 'Testing…' : 'Test connection'}
        </Button>
        {p.authType !== 'none' ? (
          <Button variant="ghost" icon="key" onClick={() => post({ type: 'setApiKey', providerId: p.id })}>
            {p.hasKey ? 'Replace key' : 'Set key'}
          </Button>
        ) : null}
        {test?.models?.some((m) => !p.models.some((x) => x.id === m)) ? (
          <Button variant="ghost" icon="add" onClick={onEdit}>
            Add discovered models
          </Button>
        ) : null}
      </div>
    </section>
  );
}

export function ProvidersView() {
  const { app } = useStore();
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const current = editing && editing !== 'new' ? app.providers.find((p) => p.id === editing) : undefined;
  return (
    <div className="sv-panel">
      <div className="sv-panel__head">
        <IconButton icon="arrow-left" label="Back to chat" onClick={() => post({ type: 'setView', view: 'chat' })} />
        <h2>Model providers</h2>
        {!editing && app.providers.length ? (
          <Button icon="add" onClick={() => setEditing('new')}>
            Add
          </Button>
        ) : null}
      </div>
      {editing ? (
        <ProviderForm
          key={editing}
          initial={
            current
              ? {
                  id: current.id,
                  name: current.name,
                  baseUrl: current.baseUrl,
                  authType: current.authType,
                  headerName: current.headerName,
                  timeoutSeconds: current.timeoutSeconds,
                  models: current.models.map((m) => ({ id: m.id, contextWindow: m.contextWindow, toolMode: m.toolMode })),
                }
              : { authType: 'bearer', models: [] }
          }
          onDone={() => setEditing(null)}
        />
      ) : app.providers.length === 0 ? (
        <SetupWizard />
      ) : (
        app.providers.map((p) => <ProviderCard key={p.id} p={p} onEdit={() => setEditing(p.id)} />)
      )}
      {!editing ? (
        <p className="sv-fineprint">
          <Icon name="settings-gear" />
          <span>
            Advanced options (headers, temperature, max output) live in{' '}
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                post({ type: 'openSettings' });
              }}
            >
              settings
            </a>
            .
          </span>
        </p>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------------------------- history

export function HistoryView() {
  const { app } = useStore();
  const [query, setQuery] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const map = new Map<string, SessionSummary[]>();
    for (const s of app.sessions) {
      if (q && !s.title.toLowerCase().includes(q)) continue;
      const g = dayGroup(s.updatedAt);
      map.set(g, [...(map.get(g) ?? []), s]);
    }
    return [...map.entries()];
  }, [app.sessions, query]);

  return (
    <div className="sv-panel">
      <div className="sv-panel__head">
        <IconButton icon="arrow-left" label="Back to chat" onClick={() => post({ type: 'setView', view: 'chat' })} />
        <h2>Chats</h2>
        <Button icon="add" onClick={() => post({ type: 'newSession' })}>
          New
        </Button>
      </div>
      {app.sessions.length > 5 ? <input className="sv-search" placeholder="Search chats" aria-label="Search chats" value={query} onChange={(e) => setQuery(e.target.value)} /> : null}
      {app.sessions.length === 0 ? <p className="sv-tagline">No saved chats yet. Conversations appear here after the first message.</p> : null}
      {groups.map(([group, items]) => (
        <div key={group} className="sv-history-group">
          <p className="sv-section-label">{group}</p>
          {items.map((s) =>
            renaming?.id === s.id ? (
              <div key={s.id} className="sv-history-item">
                <input
                  className="sv-header__input"
                  aria-label="Chat title"
                  value={renaming.title}
                  autoFocus
                  onChange={(e) => setRenaming({ id: s.id, title: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && renaming.title.trim()) {
                      post({ type: 'renameSession', id: s.id, title: renaming.title.trim() });
                      setRenaming(null);
                    } else if (e.key === 'Escape') setRenaming(null);
                  }}
                  onBlur={() => setRenaming(null)}
                />
              </div>
            ) : (
              <div key={s.id} className="sv-history-item" aria-current={app.session?.id === s.id}>
                <button type="button" className="sv-history-item__main" onClick={() => post({ type: 'openSession', id: s.id })}>
                  <span className="sv-history-item__title">{s.title}</span>
                  <span className="sv-history-item__meta">
                    {relativeTime(s.updatedAt)} · {s.messageCount} message{s.messageCount === 1 ? '' : 's'}
                  </span>
                </button>
                <div className="sv-history-item__actions">
                  <IconButton icon="edit" label={`Rename ${s.title}`} onClick={() => setRenaming({ id: s.id, title: s.title })} />
                  <IconButton icon="trash" label={`Delete ${s.title}`} onClick={() => post({ type: 'deleteSession', id: s.id })} />
                </div>
              </div>
            ),
          )}
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------------------------- notices

export function Notices() {
  const { state, dispatch } = useStore();
  useEffect(() => {
    const timers = state.notices
      .filter((n) => n.level === 'info')
      .map((n) => setTimeout(() => dispatch({ type: 'dismissNotice', id: n.id }), 6000));
    return () => timers.forEach(clearTimeout);
  }, [state.notices, dispatch]);
  if (!state.notices.length) return null;
  return (
    <div className="sv-notices" aria-live="polite">
      {state.notices.map((n) => (
        <div key={n.id} className="sv-notice" data-level={n.level} role={n.level === 'error' ? 'alert' : 'status'}>
          <Icon name={n.level === 'error' ? 'error' : n.level === 'warning' ? 'warning' : 'info'} />
          <span>{n.message}</span>
          <IconButton icon="close" label="Dismiss" onClick={() => dispatch({ type: 'dismissNotice', id: n.id })} />
        </div>
      ))}
    </div>
  );
}
