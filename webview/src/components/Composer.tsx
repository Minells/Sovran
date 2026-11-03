import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { RunView } from '../../../src/shared/protocol';
import { elapsed, toolInfo } from '../lib/format';
import { useStore } from '../state/store';
import { getUiState, post, setUiState } from '../vscode';
import { Icon } from './primitives';

export function ModeToggle() {
  const { app } = useStore();
  const options = [
    { value: 'plan' as const, label: 'Plan', icon: 'eye', title: 'Plan · read-only: investigates and proposes a plan (Alt+M)' },
    { value: 'act' as const, label: 'Act', icon: 'edit', title: 'Act · can edit files and run commands, with your approval (Alt+M)' },
  ];
  return (
    <div className="sv-segment" role="radiogroup" aria-label="Agent mode">
      {options.map((o) => {
        const disabled = o.value === 'act' && !app.workspace.trusted;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            data-value={o.value}
            aria-checked={app.mode === o.value}
            title={disabled ? 'Act mode needs a trusted workspace' : o.title}
            disabled={disabled}
            onClick={() => post({ type: 'setMode', mode: o.value })}
          >
            <Icon name={o.icon} />
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function RunStatus({ run }: { run: RunView }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const a = run.activity;
  const label =
    a.phase === 'awaiting_approval'
      ? 'Waiting for your approval'
      : a.phase === 'running' && a.toolName
        ? `${toolInfo(a.toolName).doing} ${a.label}`
        : a.label;
  return (
    <div className="sv-run" data-phase={a.phase} role="status">
      <span className="sv-pulse" aria-hidden="true" />
      <span className="sv-run__label">
        <strong>{label}</strong>
      </span>
      <span className="sv-tabular" title="Model round-trips in this request">
        step {Math.max(1, run.iteration)}/{run.maxIterations} · {elapsed(now - run.startedAt)}
      </span>
    </div>
  );
}

export function Composer() {
  const { app, state } = useStore();
  const [text, setText] = useState(() => getUiState().draft ?? '');
  const ref = useRef<HTMLTextAreaElement>(null);
  const running = !!app.run;
  const provider = app.providers.find((p) => p.id === app.selected?.providerId);
  const model = provider?.models.find((m) => m.id === app.selected?.modelId);
  const canSend = text.trim().length > 0 && !running && !!app.selected;

  // A host "focus composer" request may prefill text. Adjust state during render (React's
  // recommended pattern for reacting to a changed input) instead of setting state in an effect.
  const [seenFocus, setSeenFocus] = useState(state.focusToken);
  if (state.focusToken !== seenFocus) {
    setSeenFocus(state.focusToken);
    if (state.focusText) setText(state.focusText);
  }
  useEffect(() => setUiState({ draft: text }), [text]);
  useEffect(() => {
    if (state.focusToken) ref.current?.focus();
  }, [state.focusToken]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  const submit = () => {
    if (!canSend) return;
    post({ type: 'send', text: text.trim() });
    setText('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape' && running) {
      e.preventDefault();
      post({ type: 'cancel' });
    } else if (e.altKey && (e.key === 'm' || e.key === 'M' || e.code === 'KeyM')) {
      e.preventDefault();
      post({ type: 'setMode', mode: app.mode === 'plan' ? 'act' : 'plan' });
    }
  };

  const editor = app.context.editor;
  const placeholder = !app.selected
    ? 'Add a model provider to start'
    : app.mode === 'plan'
      ? 'Ask about the code, or describe what to plan…'
      : 'Describe a change or give SOVRAN a task…';

  return (
    <div className="sv-composer">
      <div className="sv-composer__box">
        {editor || app.context.attachments.length ? (
          <div className="sv-chips" aria-label="Context for the next message">
            {editor ? (
              <button
                type="button"
                className="sv-chip"
                aria-pressed={app.context.includeEditor}
                title={app.context.includeEditor ? `Including ${editor.path}. Click to exclude.` : `Click to include ${editor.path}`}
                onClick={() => post({ type: 'setIncludeEditor', value: !app.context.includeEditor })}
              >
                <Icon name={editor.startLine ? 'selection' : app.context.includeEditor ? 'eye' : 'eye-closed'} />
                <span>{editor.label}</span>
              </button>
            ) : null}
            {app.context.attachments.map((a) => (
              <button key={a.id} type="button" className="sv-chip" title={`${a.path} · click to remove`} onClick={() => post({ type: 'removeAttachment', id: a.id })}>
                <Icon name="file" />
                <span>{a.label}</span>
                <Icon name="close" />
              </button>
            ))}
          </div>
        ) : null}
        <textarea
          ref={ref}
          rows={2}
          value={text}
          placeholder={placeholder}
          aria-label="Message SOVRAN"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="sv-composer__bar">
          <ModeToggle />
          <button type="button" className="sv-icon-btn" title="Add files to context" aria-label="Add files to context" onClick={() => post({ type: 'attachFiles' })}>
            <Icon name="attach" />
          </button>
          <button type="button" className="sv-model" title={provider ? `${provider.name} · ${app.selected?.modelId}` : 'Select a model'} onClick={() => post({ type: 'pickModel' })}>
            <Icon name="server-process" />
            <span>{model?.name ?? app.selected?.modelId ?? 'Select model'}</span>
            <Icon name="chevron-down" />
          </button>
          <span className="sv-composer__spacer" />
          {running ? (
            <button type="button" className="sv-send sv-send--stop" title="Stop (Esc)" aria-label="Stop the agent" onClick={() => post({ type: 'cancel' })}>
              <Icon name="debug-stop" />
            </button>
          ) : (
            <button type="button" className="sv-send" title="Send (Enter)" aria-label="Send message" disabled={!canSend} onClick={submit}>
              <Icon name="arrow-up" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
