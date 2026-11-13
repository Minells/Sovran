import { ChatToolMenu } from './ToolSettings';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { EditorContextView, RunView } from '../../../src/shared/protocol';
import { APPROVAL_OPTIONS, approvalOption, nextApprovalMode } from '../lib/approvals';
import { documentInfo, elapsed, imageDescription, toolInfo } from '../lib/format';
import { pastedImages, toBase64 } from '../lib/paste';
import { IMAGE_LIMITS } from '../../../src/core/images/images';
import { altLabel, shortcutList } from '../lib/keys';
import { useStore } from '../state/store';
import { getUiState, post, setUiState } from '../vscode';
import { AttachMenu } from './AttachMenu';
import { Icon, MenuButton } from './primitives';

export function ModeToggle() {
  const { app } = useStore();
  const options = [
    {
      value: 'plan' as const,
      label: 'Plan',
      icon: 'eye',
      title: 'Plan · read-only: investigates and proposes a plan (Alt+M)',
    },
    {
      value: 'act' as const,
      label: 'Act',
      icon: 'edit',
      title: 'Act · can edit files and run commands, with your approval (Alt+M)',
    },
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

/** How much Act mode may do without asking. Hidden in Plan mode, which is always read-only. */
export function ApprovalPicker() {
  const { app } = useStore();
  if (app.mode !== 'act' || !app.workspace.trusted) return null;
  const current = approvalOption(app.approvalMode);
  return (
    <MenuButton
      value={app.approvalMode}
      options={APPROVAL_OPTIONS}
      onSelect={(mode) => post({ type: 'setApprovalMode', mode })}
      label={`Approvals: ${current.label}. Change how much Sovran may do without asking`}
      title={`${current.label}: ${current.description} (${altLabel()}A)`}
      icon={current.icon}
      tone={current.tone}
      heading="Approvals in Act mode"
      footer={{
        label: 'Approval settings…',
        icon: 'settings-gear',
        onSelect: () => post({ type: 'setView', view: 'settings' }),
      }}
      className="sv-approval-picker"
      // The default (Ask) stays quiet; the modes that let Sovran act unattended are always spelled out.
      iconOnly={app.approvalMode === 'ask'}
    />
  );
}

/** Every shortcut in one place, opened from the hint line instead of crowding it. A non-modal dialog. */
function ShortcutsButton({ approvals }: { approvals: boolean }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus();
    const onPointer = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!panelRef.current?.contains(target) && !buttonRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
  }, [open]);

  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };
  return (
    <div className="sv-menu-anchor sv-shortcuts">
      <button
        ref={buttonRef}
        type="button"
        className="sv-hint-btn"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Keyboard shortcuts"
        onClick={() => (open ? close() : setOpen(true))}
      >
        <Icon name="keyboard" />
        <span className="sv-hint-btn__label">Shortcuts</span>
      </button>
      {open ? (
        <div
          ref={panelRef}
          className="sv-menu sv-shortcuts__panel"
          role="dialog"
          aria-label="Keyboard shortcuts"
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              close();
            }
          }}
        >
          <div className="sv-menu__heading">Keyboard shortcuts</div>
          <dl className="sv-shortcuts__list">
            {shortcutList({ approvals }).map((s) => (
              <div key={`${s.keys} ${s.label}`} className="sv-shortcuts__row">
                <dt>
                  <kbd>{s.keys}</kbd>
                </dt>
                <dd>{s.label}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
    </div>
  );
}

/** The active-file chip. Files Sovran never attaches automatically say so instead of pretending to be included. */
function EditorChip({ editor, included }: { editor: EditorContextView; included: boolean }) {
  if (editor.blocked) {
    const why =
      editor.blocked === 'outside'
        ? `${editor.path} is outside the workspace, so it is not shared with the model.`
        : `${editor.path} is a protected file, so it is not shared automatically.`;
    return (
      <span className="sv-chip sv-chip--static sv-chip--blocked" title={why} aria-label={why}>
        <Icon name="lock" />
        <span>{editor.label}</span>
      </span>
    );
  }
  return (
    <button
      type="button"
      className="sv-chip"
      aria-pressed={included}
      title={included ? `Including ${editor.path}. Click to exclude.` : `Click to include ${editor.path}`}
      onClick={() => post({ type: 'setIncludeEditor', value: !included })}
    >
      <Icon name={editor.startLine ? 'selection' : included ? 'eye' : 'eye-closed'} />
      <span>{editor.label}</span>
    </button>
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

const fmtTokens = (n: number) =>
  n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

export function ContextMeter() {
  const { app } = useStore();
  const usage = app.usage;
  if (!usage || usage.contextWindow <= 0) return null;
  const pct = Math.min(1, usage.tokens / usage.contextWindow);
  const level = pct >= 0.9 ? 'high' : pct >= 0.7 ? 'mid' : 'low';
  const percent = Math.round(pct * 100);
  const split = usage.breakdown;
  const loaded = (app.toolGroups ?? []).filter((group) => group.loading === 'loaded').map((group) => group.label);
  const title = [
    `${usage.source === 'server' ? 'Reported by the server' : 'Estimated'}: ${usage.tokens.toLocaleString('en-US')} of ${usage.contextWindow.toLocaleString(
      'en-US',
    )} tokens (${percent}%) in the last request.`,
    split
      ? `About ${fmtTokens(split.system)} for instructions, ${fmtTokens(split.tools)} for tools, ${fmtTokens(split.messages)} for the conversation.`
      : '',
    loaded.length ? `Tools loaded in this chat: ${loaded.join(', ')}.` : '',
    'Click to summarize older messages and free context.',
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <button
      type="button"
      className="sv-meter"
      data-level={level}
      title={title}
      aria-label={`Context ${percent}% used. Summarize older messages.`}
      onClick={() => post({ type: 'compact' })}
    >
      <span className="sv-meter__bar" aria-hidden="true">
        <span style={{ width: `${Math.max(4, percent)}%` }} />
      </span>
      <span className="sv-tabular">
        {fmtTokens(usage.tokens)}/{fmtTokens(usage.contextWindow)}
      </span>
    </button>
  );
}

type Trigger =
  { kind: 'mention'; start: number; end: number; query: string } | { kind: 'command'; query: string } | null;

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
  const { app, state, dispatch } = useStore();
  const [text, setText] = useState(() => getUiState().draft ?? '');
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [attachOpen, setAttachOpen] = useState(false);
  const attachRef = useRef<HTMLButtonElement>(null);
  const requestSeq = useRef(0);
  const [requestId, setRequestId] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const running = !!app.run;
  // While a decision is pending, Enter and Escape in the empty input answer it (see ApprovalBar).
  const awaiting = app.approvals.length > 0;
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
  const triggerKey = trigger
    ? `${trigger.kind}:${trigger.kind === 'mention' ? trigger.start : 0}:${trigger.query}`
    : null;
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
          .filter(
            (c) =>
              c.name.startsWith(trigger.query) ||
              (trigger.query.length > 1 && c.name.includes(trigger.query)),
          )
          .map((c) => ({
            id: c.name,
            label: `/${c.name}`,
            detail: c.description,
            icon: c.source === 'workspace' ? 'file-code' : 'symbol-event',
          }))
      : state.fileSuggestions && state.fileSuggestions.requestId === requestId
        ? state.fileSuggestions.items.map((f) => ({
            id: f.path,
            label: f.label,
            detail: f.hint ? `${f.path} · ${f.hint === 'active' ? 'active editor' : 'open'}` : f.path,
            icon: 'file',
          }))
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
    if (awaiting && !text.trim() && (e.key === 'Enter' || e.key === 'Escape')) {
      // Left to the approval bar: Enter approves, Escape rejects. Stopping the whole run stays on the Stop button.
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
    } else if (
      e.altKey &&
      (e.key === 'a' || e.key === 'A' || e.code === 'KeyA') &&
      app.mode === 'act' &&
      app.workspace.trusted
    ) {
      e.preventDefault();
      post({ type: 'setApprovalMode', mode: nextApprovalMode(app.approvalMode) });
    }
  };

  const closeAttach = useCallback((refocus: boolean) => {
    setAttachOpen(false);
    if (refocus) attachRef.current?.focus();
  }, []);

  const editor = app.context.editor;
  const placeholder = !app.selected
    ? 'Add a model provider to start'
    : app.mode === 'plan'
      ? 'Ask, explore or plan (read-only)'
      : app.approvalMode === 'auto'
        ? 'Give Sovran a task. Auto mode: it acts without asking'
        : 'Ask Sovran, or give it a task';
  const altKey = altLabel();
  const listId = 'sv-suggest';
  const suggesting = open && (items.length > 0 || trigger?.kind === 'mention');
  // One line, always there (no jump on focus), and it says what the keys do right now.
  const hints: Array<[string, string]> =
    awaiting && !text.trim()
      ? [
          ['↵', 'approve'],
          ['Esc', 'reject'],
        ]
      : running
        ? [['Esc', 'stop']]
        : suggesting
          ? [
              ['↑↓', 'choose'],
              ['↵', 'select'],
              ['Esc', 'close'],
            ]
          : text.trim()
            ? [
                ['↵', 'send'],
                ['⇧↵', 'new line'],
              ]
            : [
                ['@', 'files'],
                ['/', 'commands'],
                [`${altKey}M`, 'mode'],
              ];

  return (
    <div className="sv-composer">
      {attachOpen ? <AttachMenu trigger={attachRef} onClose={closeAttach} /> : null}
      {suggesting ? (
        <ul
          className="sv-suggest"
          id={listId}
          role="listbox"
          aria-label={trigger?.kind === 'command' ? 'Commands' : 'Files'}
        >
          {items.length === 0 ? (
            <li className="sv-suggest__empty">
              {trigger?.kind === 'mention' ? 'Type to search files' : 'No matching command'}
            </li>
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
            {editor ? <EditorChip editor={editor} included={app.context.includeEditor} /> : null}
            {app.context.attachments.map((a) => {
              const doc = a.image ? imageDescription(a.image) : documentInfo(a.format, a.detail);
              return (
                <button
                  key={a.id}
                  type="button"
                  className="sv-chip"
                  data-external={a.external || undefined}
                  title={`${a.image?.pasted ? '' : a.path}${a.external ? ' (from your computer)' : ''}${doc ? `${a.image?.pasted ? '' : ' · '}${doc.description}` : ''} · click to remove`}
                  aria-label={`Remove ${a.label}`}
                  onClick={() => post({ type: 'removeAttachment', id: a.id })}
                >
                  <Icon name={doc?.icon ?? (a.external ? 'device-desktop' : 'file')} />
                  <span>{a.label}</span>
                  <Icon name="close" />
                </button>
              );
            })}
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
          // Empty, it passes Enter and Escape to a pending approval.
          data-approval-keys=""
          onPaste={(e) => {
            // A screenshot becomes an attachment; a paste with text in it stays a text paste.
            const images = pastedImages(e.clipboardData);
            if (!images.length) return;
            e.preventDefault();
            for (const file of images) {
              if (file.size > IMAGE_LIMITS.maxBytes) {
                const mb = IMAGE_LIMITS.maxBytes / 1024 / 1024;
                dispatch({
                  type: 'notice',
                  id: `paste-${Date.now()}`,
                  level: 'warning',
                  message: `The pasted image is larger than ${mb} MB. Paste a smaller one (a crop, or a JPEG).`,
                });
                continue;
              }
              void toBase64(file).then((data) => post({ type: 'attachImage', data }));
            }
          }}
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
            setActive(0);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onKeyDown={onKeyDown}
        />
        <div className="sv-composer__bar">
          <ModeToggle />
          <ApprovalPicker />
          <button
            ref={attachRef}
            type="button"
            className="sv-icon-btn sv-attach-btn"
            title="Attach files from the workspace or your computer"
            aria-label="Attach files"
            aria-haspopup="dialog"
            aria-expanded={attachOpen}
            onClick={() => (attachOpen ? closeAttach(false) : setAttachOpen(true))}
          >
            <Icon name="attach" />
          </button>
          <button
            type="button"
            className="sv-model"
            title={
              provider
                ? `${app.mode === 'plan' ? 'Plan' : 'Act'} model · ${provider.name} · ${effective?.modelId}`
                : 'Select a model'
            }
            onClick={() => post({ type: 'pickModel' })}
          >
            <Icon name="server-process" />
            <span>{model?.name ?? effective?.modelId ?? 'Select model'}</span>
            <Icon name="chevron-down" />
          </button>
          <ChatToolMenu />
          <span className="sv-composer__spacer" />
          <ContextMeter />
          {running ? (
            <button
              type="button"
              className="sv-send sv-send--stop"
              title="Stop (Esc)"
              aria-label="Stop the agent"
              onClick={() => post({ type: 'cancel' })}
            >
              <Icon name="debug-stop" />
            </button>
          ) : (
            <button
              type="button"
              className="sv-send"
              title="Send (Enter)"
              aria-label="Send message"
              disabled={!canSend}
              onClick={submit}
            >
              <Icon name="arrow-up" />
            </button>
          )}
        </div>
      </div>
      <div className="sv-composer__hint">
        <span className="sv-composer__keys" aria-hidden="true">
          {hints.map(([key, label]) => (
            <span key={key}>
              <kbd>{key}</kbd> {label}
            </span>
          ))}
        </span>
        <ShortcutsButton approvals={app.mode === 'act' && app.workspace.trusted} />
      </div>
    </div>
  );
}
