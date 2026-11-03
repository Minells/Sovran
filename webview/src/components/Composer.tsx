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

const fmtTokens = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export function ContextMeter() {
  const { app } = useStore();
  const usage = app.usage;
  if (!usage || usage.contextWindow <= 0) return null;
  const pct = Math.min(1, usage.tokens / usage.contextWindow);
  const level = pct >= 0.9 ? 'high' : pct >= 0.7 ? 'mid' : 'low';
  const percent = Math.round(pct * 100);
  const title = `${usage.source === 'server' ? 'Reported by the server' : 'Estimated'}: ${usage.tokens.toLocaleString('en-US')} of ${usage.contextWindow.toLocaleString(
    'en-US',
  )} tokens (${percent}%) in the last request. Click to summarize older messages and free context.`;
  return (
    <button type="button" className="sv-meter" data-level={level} title={title} aria-label={`Context ${percent}% used. Summarize older messages.`} onClick={() => post({ type: 'compact' })}>
      <span className="sv-meter__bar" aria-hidden="true">
        <span style={{ width: `${Math.max(4, percent)}%` }} />
      </span>
      <span className="sv-tabular">
        {fmtTokens(usage.tokens)}/{fmtTokens(usage.contextWindow)}
      </span>
    </button>
  );
}

type Trigger = { kind: 'mention'; start: number; end: number; query: string } | { kind: 'command'; query: string } | null;

function detectTrigger(text: string, caret: number): Trigger {
  const before = text.slice(0, caret);
  const cmd = /^\/([\w-]*)$/.exec(before);
  if (cmd && caret === text.length) return { kind: 'command', query: cmd[1]!.toLowerCase() };
  const m = /(^|\s)@([^\s@]*)$/.exec(before);
  if (m) return { kind: 'mention', start: caret - m[2]!.length - 1, end: caret, query: m[2]! };
  return null;
}

interface SuggestItem {
  id: string;
  label: string;
  detail: string;
  icon: string;
}

export function Composer() {
  const { app, state } = useStore();
  const [text, setText] = useState(() => getUiState().draft ?? '');
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const requestSeq = useRef(0);
  const [requestId, setRequestId] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const running = !!app.run;
  const effective = app.mode === 'plan' && app.planModel ? app.planModel : app.selected;
  const provider = app.providers.find((p) => p.id === effective?.providerId);
  const model = provider?.models.find((m) => m.id === effective?.modelId);
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

  const trigger = detectTrigger(text, caret);
  const triggerKey = trigger ? `${trigger.kind}:${trigger.kind === 'mention' ? trigger.start : 0}:${trigger.query}` : null;
  const open = trigger !== null && triggerKey !== dismissed;

  // Ask the host for file matches when the @-query changes (debounced).
  const mentionQuery = open && trigger?.kind === 'mention' ? trigger.query : null;
  useEffect(() => {
    if (mentionQuery === null) return;
    const t = setTimeout(() => {
      const id = `s${++requestSeq.current}`;
      setRequestId(id);
      post({ type: 'suggestFiles', requestId: id, query: mentionQuery });
    }, 80);
    return () => clearTimeout(t);
  }, [mentionQuery]);

  const items: SuggestItem[] = !open
    ? []
    : trigger?.kind === 'command'
      ? app.commands
          .filter((c) => c.name.startsWith(trigger.query) || (trigger.query.length > 1 && c.name.includes(trigger.query)))
          .map((c) => ({ id: c.name, label: `/${c.name}`, detail: c.description, icon: c.source === 'workspace' ? 'file-code' : 'symbol-event' }))
      : state.fileSuggestions && state.fileSuggestions.requestId === requestId
        ? state.fileSuggestions.items.map((f) => ({ id: f.path, label: f.label, detail: f.path, icon: 'file' }))
        : [];
  const activeIndex = Math.min(active, Math.max(0, items.length - 1));

  const choose = (item: SuggestItem) => {
    if (!trigger) return;
    if (trigger.kind === 'command') {
      setText(`/${item.id} `);
      setCaret(item.id.length + 2);
    } else {
      const next = text.slice(0, trigger.start) + text.slice(trigger.end);
      setText(next);
      setCaret(trigger.start);
      post({ type: 'attachPath', path: item.id });
    }
    setActive(0);
    ref.current?.focus();
  };

  const submit = () => {
    if (!canSend) return;
    post({ type: 'send', text: text.trim() });
    setText('');
    setCaret(0);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open && items.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((activeIndex + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length);
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault();
        choose(items[activeIndex]!);
        return;
      }
    }
    if (open && e.key === 'Escape') {
      e.preventDefault();
      setDismissed(triggerKey);
      return;
    }
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
      ? 'Ask, explore or plan (read-only)'
      : 'Ask Sovran, or give it a task';
  const altKey = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform) ? '⌥' : 'Alt+';
  const listId = 'sv-suggest';

  return (
    <div className="sv-composer">
      {open && (items.length || trigger?.kind === 'mention') ? (
        <ul className="sv-suggest" id={listId} role="listbox" aria-label={trigger?.kind === 'command' ? 'Commands' : 'Files'}>
          {items.length === 0 ? (
            <li className="sv-suggest__empty">{trigger?.kind === 'mention' ? 'Type to search files' : 'No matching command'}</li>
          ) : (
            items.map((item, i) => (
              <li
                key={item.id}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === activeIndex}
                className="sv-suggest__item"
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(item);
                }}
                onMouseEnter={() => setActive(i)}
              >
                <Icon name={item.icon} />
                <span className="sv-suggest__label">{item.label}</span>
                <span className="sv-suggest__detail">{item.detail}</span>
              </li>
            ))
          )}
        </ul>
      ) : null}
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
          aria-label="Message Sovran"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open && items.length > 0}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open && items.length ? `${listId}-${activeIndex}` : undefined}
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
            setActive(0);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={onKeyDown}
        />
        <div className="sv-composer__bar">
          <ModeToggle />
          <button type="button" className="sv-icon-btn" title="Add files to context" aria-label="Add files to context" onClick={() => post({ type: 'attachFiles' })}>
            <Icon name="attach" />
          </button>
          <button
            type="button"
            className="sv-model"
            title={provider ? `${app.mode === 'plan' ? 'Plan' : 'Act'} model · ${provider.name} · ${effective?.modelId}` : 'Select a model'}
            onClick={() => post({ type: 'pickModel' })}
          >
            <Icon name="server-process" />
            <span>{model?.name ?? effective?.modelId ?? 'Select model'}</span>
            <Icon name="chevron-down" />
          </button>
          <span className="sv-composer__spacer" />
          <ContextMeter />
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
      {focused && !open ? (
        <div className="sv-composer__hint" aria-hidden="true">
          <span>
            <kbd>↵</kbd> send
          </span>
          <span>
            <kbd>⇧↵</kbd> new line
          </span>
          <span>
            <kbd>@</kbd> files
          </span>
          <span>
            <kbd>/</kbd> commands
          </span>
          <span>
            <kbd>{altKey}M</kbd> mode
          </span>
          {running ? (
            <span>
              <kbd>Esc</kbd> stop
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
