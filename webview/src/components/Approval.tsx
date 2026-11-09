import { useEffect, useEffectEvent, useRef, useState } from 'react';
import type { ApprovalView, McpToolHint } from '../../../src/shared/protocol';
import { hasShellMetacharacters } from '../../../src/core/permissions/shell';
import { approvalOption } from '../lib/approvals';
import { useStore } from '../state/store';
import { post } from '../vscode';
import { DiffView } from './Diff';
import { Button, Icon } from './primitives';

/*
 * Approvals have two parts. The bar right above the chat input is where the user decides: it never scrolls away, holds
 * every decision (with Enter and Escape as shortcuts) and shows everything a decision needs that is short (the
 * command, warnings, the path). The detail inline in the transcript is where the user reads a long proposal (the diff),
 * in the flow of the conversation. Nothing is decided in two places.
 */

const HIDDEN =
  // eslint-disable-next-line no-control-regex -- invisible/control characters are exactly what this detects
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
/** Makes invisible and direction-changing characters visible so the approved text is the text that runs. */
export const revealHidden = (s: string) =>
  s.replace(HIDDEN, (c) => `⟨U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}⟩`);

/** Mirrors the host's allow-list rule: the entry, or the entry followed by arguments. The host re-checks it. */
const coversCommand = (entry: string, command: string) => {
  const e = entry.trim().replace(/\s+/g, ' ');
  const c = command.trim().replace(/\s+/g, ' ');
  return e.length > 0 && (c === e || c.startsWith(`${e} `));
};

/** MCP annotations, phrased as the server's claims: Sovran cannot check them. */
const MCP_HINTS: Record<McpToolHint, { icon: string; text: string }> = {
  'read-only': { icon: 'eye', text: 'The server says this tool only reads data.' },
  destructive: { icon: 'warning', text: 'The server says this tool can change or delete data.' },
  'open-world': { icon: 'globe', text: 'The server says this tool reaches services outside your machine.' },
};

/**
 * Enter is ignored for this long after the bar appears, so an Enter pressed for something else just then (sending a
 * message, a key held down) cannot approve an action the user has not seen. Escape (reject) is never delayed.
 */
export const ARM_MS = 400;

/** DOM id of the inline detail, so the bar can bring it into view. */
export const approvalAnchor = (id: string) => `sv-approval-${id}`;

export function approvalCopy(approval: ApprovalView) {
  const d = approval.detail;
  if (d.kind === 'web') return { title: 'Read this public web page?', verb: 'Fetch', icon: 'globe' };
  if (d.kind === 'edit') {
    return { title: d.isNew ? 'Create this file?' : 'Apply these changes?', verb: d.isNew ? 'Create' : 'Apply', icon: 'git-pull-request-go-to-changes' };
  }
  if (d.kind === 'command') return { title: 'Run this command?', verb: 'Run', icon: 'terminal' };
  if (d.kind === 'git') {
    const verb = { stage: 'Stage', unstage: 'Unstage', commit: 'Commit' }[d.operation];
    return { title: d.operation === 'commit' ? 'Commit these staged changes?' : `${verb} these files?`, verb, icon: 'git-commit' };
  }
  if (d.kind === 'mcp') return { title: 'Run this MCP tool?', verb: 'Run', icon: 'mcp' };
  return { title: 'Allow reading a protected file?', verb: 'Allow', icon: 'shield' };
}

const TEXT_FIELD = 'textarea, select, [contenteditable]:not([contenteditable="false"]), input:not([type="checkbox"]):not([type="radio"])';
/** Controls Enter already activates. A checkbox is not one of them: Enter there approves, with the box as ticked. */
const ENTER_CONTROL = 'button, a[href], summary, [role="button"], [role="tab"], [role="radio"], [role="option"], [role^="menuitem"]';

/**
 * What a key press means for a pending approval: Enter approves, Escape rejects. The keys stay with whatever has them
 * already: text being typed (anywhere, including the chat input), menus and lists, a focused button (Enter presses
 * it), and handlers that took the key (`preventDefault`). The empty chat input passes them on, so after sending a
 * message the user can answer without reaching for the mouse. Modified keys and auto-repeat never count.
 */
export function approvalKey(e: KeyboardEvent): 'approve' | 'reject' | null {
  if (e.key !== 'Enter' && e.key !== 'Escape') return null;
  if (e.defaultPrevented || e.isComposing || e.repeat || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return null;
  const t = e.target instanceof Element ? e.target : null;
  if (t?.closest('[role="menu"], [role="dialog"], [role="listbox"]')) return null;
  if (t?.matches(TEXT_FIELD)) {
    const value = (t as HTMLInputElement).value ?? '';
    if (!t.hasAttribute('data-approval-keys') || value.trim()) return null;
  } else if (e.key === 'Enter' && t?.closest(ENTER_CONTROL)) {
    return null;
  }
  return e.key === 'Enter' ? 'approve' : 'reject';
}

type Step = 'decide' | 'feedback' | 'allow';

/** The decision for the first pending approval, above the chat input. Keyed by approval id, so each starts fresh. */
export function ApprovalBar({ approval }: { approval: ApprovalView }) {
  const { app } = useStore();
  const d = approval.detail;
  const copy = approvalCopy(approval);
  const [step, setStep] = useState<Step>('decide');
  const [feedback, setFeedback] = useState('');
  const [grant, setGrant] = useState(false);
  const [allowEntry, setAllowEntry] = useState('');
  const armed = useRef(false);

  useEffect(() => {
    const t = setTimeout(() => (armed.current = true), ARM_MS);
    return () => clearTimeout(t);
  }, []);

  const allowError =
    step !== 'allow' || d.kind !== 'command'
      ? ''
      : !allowEntry.trim()
        ? 'Enter the start of the command to allow.'
        : hasShellMetacharacters(allowEntry)
          ? 'Shell operators cannot be allowed.'
          : !coversCommand(allowEntry, d.command)
            ? 'The entry must be the start of this command.'
            : '';

  const respond = (approved: boolean, always?: { allowCommand: string } | { allowTool: true }) =>
    post({
      type: 'approval',
      id: approval.id,
      approved,
      grant: approved && grant && d.kind === 'edit' ? 'session-edits' : undefined,
      feedback: !approved && feedback.trim() ? feedback.trim() : undefined,
      ...always,
    });

  // Enter and Escape decide while no form is open. An Effect Event reads the checkbox as it is at the key press.
  const onKey = useEffectEvent((e: KeyboardEvent) => {
    const decision = approvalKey(e);
    if (!decision) return;
    e.preventDefault();
    if (decision === 'approve' && !armed.current) return;
    respond(decision === 'approve');
  });
  useEffect(() => {
    if (step !== 'decide') return;
    const listener = (e: KeyboardEvent) => onKey(e);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [step]);

  const showDetail = () => {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    document.getElementById(approvalAnchor(approval.id))?.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
  };

  // In an unattended mode the bar explains why this action still needs a human, without repeating a listed warning.
  const paused = app.approvalMode !== 'ask' && !!approval.reason;
  const reasonListed = d.kind === 'command' && !!approval.reason && d.warnings.includes(approval.reason);
  const target = d.kind === 'web' ? d.url : d.kind === 'command' || d.kind === 'mcp' || d.kind === 'git' ? null : d.path;

  return (
    <section className="sv-approval-bar" aria-label={copy.title} data-kind={d.kind}>
      <div className="sv-approval-bar__head">
        <Icon name={copy.icon} className="sv-approval-bar__icon" />
        <div className="sv-approval-bar__summary">
          <span className="sv-approval-bar__title">{copy.title}</span>
          {target ? (
            d.kind === 'edit' ? (
              <button type="button" className="sv-approval-bar__target" title="Show the changes in the chat" onClick={showDetail}>
                <code>{target}</code>
                <span className="sv-tabular sv-approval-bar__stats">
                  <span className="sv-plus">+{d.added}</span> <span className="sv-minus">−{d.removed}</span>
                </span>
              </button>
            ) : (
              <code className="sv-approval-bar__path">{revealHidden(target)}</code>
            )
          ) : d.kind === 'git' ? (
            <span className="sv-approval-bar__path">
              <code>{revealHidden(d.repository)}</code> · {revealHidden(d.branch)}
            </span>
          ) : d.kind === 'mcp' ? (
            <span className="sv-approval-bar__path">
              <code>{d.tool}</code> on {d.server}
            </span>
          ) : null}
        </div>
        {step === 'decide' ? (
          <div className="sv-approval-bar__actions">
            <button type="button" className="sv-btn" onClick={() => respond(false)} title="Reject (Esc)" aria-label="Reject" aria-keyshortcuts="Escape">
              Reject <kbd aria-hidden="true">Esc</kbd>
            </button>
            <button
              type="button"
              className="sv-btn sv-btn--primary"
              onClick={() => respond(true)}
              title={`${copy.verb} (Enter)`}
              aria-label={copy.verb}
              aria-keyshortcuts="Enter"
            >
              <Icon name="check" />
              {copy.verb} <kbd aria-hidden="true">↵</kbd>
            </button>
          </div>
        ) : null}
      </div>

      {paused ? (
        <div className="sv-approval__paused" role="note">
          <Icon name="shield" />
          <span>
            {approvalOption(app.approvalMode).label} mode still asks here
            {reasonListed ? ', for the reason below.' : `: ${approval.reason}`}
          </span>
        </div>
      ) : null}

      {d.kind === 'web' ? (
        <div className="sv-approval__meta">
          Reads this public URL and its robots.txt, with up to 3 redirects per resource within the same origin.
          No login or browser cookies. Page body up to 1 MiB, robots.txt up to 128 KiB and 30 seconds total. Every URL asks for approval.
        </div>
      ) : d.kind === 'git' ? (
        <>
          <button type="button" className="sv-link-btn" onClick={showDetail}>
            Review {d.files.length} file(s){d.message !== undefined ? ' and commit message' : ''}
          </button>
          <ul className="sv-approval__warnings">
            {d.warnings.map((warning) => <li key={warning}>{warning}</li>)}
          </ul>
        </>
      ) : d.kind === 'command' ? (
        <>
          <pre className="sv-approval__command">{revealHidden(d.command)}</pre>
          <div className="sv-approval__meta">{d.cwd === '.' ? 'in the workspace folder' : `in ${d.cwd}`}</div>
          {d.warnings.length ? (
            <ul className="sv-approval__warnings">
              {d.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          ) : null}
        </>
      ) : d.kind === 'read' ? (
        <div className="sv-approval__meta">{d.reason}</div>
      ) : d.kind === 'mcp' ? (
        <>
          {d.hints.length ? (
            <ul className="sv-approval__hints" aria-label="What the server says about this tool">
              {d.hints.map((h) => (
                <li key={h} data-tone={h === 'destructive' ? 'warn' : undefined}>
                  <Icon name={MCP_HINTS[h].icon} />
                  {MCP_HINTS[h].text}
                </li>
              ))}
            </ul>
          ) : null}
          <pre className="sv-approval__command sv-approval__arguments" aria-label="Arguments">
            {revealHidden(d.arguments)}
          </pre>
        </>
      ) : null}

      {step === 'decide' ? (
        <div className="sv-approval-bar__options">
          {d.kind === 'edit' && app.approvalMode === 'ask' ? (
            <label className="sv-check">
              <input type="checkbox" checked={grant} onChange={(e) => setGrant(e.target.checked)} />
              Apply future edits in this chat without asking
            </label>
          ) : null}
          {d.kind === 'command' && d.allowPrefix ? (
            <button
              type="button"
              className="sv-link-btn"
              title={`Run now and stop asking for "${d.allowPrefix}" commands`}
              onClick={() => {
                setAllowEntry(d.allowPrefix ?? '');
                setStep('allow');
              }}
            >
              Always allow…
            </button>
          ) : null}
          {d.kind === 'mcp' ? (
            <button
              type="button"
              className="sv-link-btn"
              title={`Run now and stop asking for ${d.tool}. Change it in Settings → MCP.`}
              onClick={() => respond(true, { allowTool: true })}
            >
              Always allow {d.tool}
            </button>
          ) : null}
          <button type="button" className="sv-link-btn" onClick={() => setStep('feedback')}>
            Reject with feedback…
          </button>
        </div>
      ) : step === 'feedback' ? (
        <div className="sv-approval-bar__form">
          <textarea
            className="sv-approval__feedback"
            placeholder="Tell Sovran what to do instead (optional)"
            aria-label="Feedback for the agent"
            value={feedback}
            autoFocus
            onChange={(e) => setFeedback(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                respond(false);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setStep('decide');
              }
            }}
          />
          <div className="sv-approval-bar__form-actions">
            <span className="sv-hint-text">
              <kbd>↵</kbd> send · <kbd>⇧↵</kbd> new line · <kbd>Esc</kbd> back
            </span>
            <Button variant="ghost" onClick={() => setStep('decide')}>
              Back
            </Button>
            <Button variant="primary" onClick={() => respond(false)}>
              Send rejection
            </Button>
          </div>
        </div>
      ) : d.kind === 'command' ? (
        <div className="sv-approval-bar__form sv-allow">
          <label className="sv-allow__label" htmlFor={`allow-${approval.id}`}>
            Always run commands that start with:
          </label>
          <input
            id={`allow-${approval.id}`}
            className="sv-allow__input"
            value={allowEntry}
            spellCheck={false}
            autoFocus
            aria-invalid={!!allowError}
            onChange={(e) => setAllowEntry(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !allowError) {
                e.preventDefault();
                respond(true, { allowCommand: allowEntry.trim() });
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setStep('decide');
              }
            }}
          />
          <span className={allowError ? 'sv-field__error' : 'sv-field__help'}>
            {allowError || 'Saved to your allowed commands. Risky commands and shell operators still ask.'}
          </span>
          <div className="sv-approval-bar__form-actions">
            <Button variant="ghost" onClick={() => setStep('decide')}>
              Back
            </Button>
            <Button variant="primary" icon="check" disabled={!!allowError} onClick={() => respond(true, { allowCommand: allowEntry.trim() })}>
              Run and always allow
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

/**
 * The proposal inside the transcript, under the tool call that made it. File changes are read here (the bar above is
 * only a summary); commands, MCP calls and protected reads are short and the bar shows them whole, so this only points there.
 */
export function ApprovalDetail({ approval }: { approval: ApprovalView }) {
  const d = approval.detail;
  return (
    <div className="sv-approval" id={approvalAnchor(approval.id)} data-kind={d.kind}>
      {d.kind === 'git' ? (
        <>
          <div className="sv-approval__meta">
            <code>{revealHidden(d.repository)}</code> · {revealHidden(d.branch)}
          </div>
          <ul className="sv-list" aria-label="Files included in the Git action">
            {d.files.map((file) => <li key={file}><code>{revealHidden(JSON.stringify(file))}</code></li>)}
          </ul>
          {d.message !== undefined ? (
            <pre className="sv-approval__command" aria-label="Commit message">{revealHidden(d.message)}</pre>
          ) : null}
          {d.preview ? (
            <>
              <p className="sv-approval__meta">The preview may be shortened. Inspect truncated sections before approving.</p>
              <DiffView diff={d.preview} label="Git change preview" />
            </>
          ) : null}
        </>
      ) : d.kind === 'edit' ? (
        <>
          <div className="sv-approval__meta">
            <span className="sv-tabular">
              <span className="sv-plus">+{d.added}</span> <span className="sv-minus">−{d.removed}</span>
              {d.isNew ? ' · new file' : ''}
            </span>
            <span className="sv-composer__spacer" />
            <Button variant="ghost" icon="diff" onClick={() => post({ type: 'openApprovalDiff', id: approval.id })}>
              Open diff editor
            </Button>
          </div>
          <DiffView diff={d.diff} />
        </>
      ) : null}
      <p className="sv-approval__hint">
        <Icon name="arrow-down" />
        <span>Waiting for your decision above the chat input</span>
        <span className="sv-nowrap">
          · <kbd>↵</kbd> {approvalCopy(approval).verb.toLowerCase()}
        </span>
        <span className="sv-nowrap">
          · <kbd>Esc</kbd> reject
        </span>
      </p>
    </div>
  );
}
