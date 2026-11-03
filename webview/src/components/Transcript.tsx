import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import type { ApprovalView, AssistantMessageView, RunViewT, ToolCallView, ToolMessageView } from './types';
import type { SessionMessage } from '../../../src/shared/protocol';
import { renderMarkdown } from '../lib/markdown';
import { toolInfo, toolTarget } from '../lib/format';
import { post } from '../vscode';
import { useStore } from '../state/store';
import { Button, Icon, IconButton } from './primitives';

// ------------------------------------------------------------------------------------- markdown

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const action = target.closest<HTMLElement>('[data-action]');
    if (action) {
      const code = action.closest('.sv-code')?.querySelector('pre code')?.textContent ?? '';
      if (action.dataset.action === 'copy') {
        void navigator.clipboard?.writeText(code).then(() => {
          action.querySelector('.codicon')?.classList.replace('codicon-copy', 'codicon-check');
          setTimeout(() => action.querySelector('.codicon')?.classList.replace('codicon-check', 'codicon-copy'), 1200);
        });
      } else if (action.dataset.action === 'insert') {
        post({ type: 'insertCode', code });
      }
      return;
    }
    const pathEl = target.closest<HTMLElement>('[data-path]');
    if (pathEl?.dataset.path) {
      post({ type: 'openFile', path: pathEl.dataset.path, line: pathEl.dataset.line ? Number(pathEl.dataset.line) : undefined });
      return;
    }
    const link = target.closest('a');
    if (link) {
      e.preventDefault();
      const href = link.getAttribute('href') ?? '';
      if (/^https?:/i.test(href)) post({ type: 'openExternal', url: href });
    }
  };
  // Safe: markdown-it runs with html:false and the output is sanitized by DOMPurify.
  return <div className="sv-md" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
});

// ------------------------------------------------------------------------------------- diff

export function DiffView({ diff, maxLines = 400 }: { diff: string; maxLines?: number }) {
  const lines = diff.split('\n').filter((l) => !l.startsWith('--- ') && !l.startsWith('+++ '));
  const shown = lines.slice(0, maxLines);
  return (
    <pre className="sv-diff" aria-label="Proposed changes">
      {shown.map((l, i) => (
        <span key={i} className={l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : l.startsWith('@@') ? 'hunk' : undefined}>
          {l || ' '}
        </span>
      ))}
      {lines.length > maxLines ? <span className="hunk">… {lines.length - maxLines} more lines</span> : null}
    </pre>
  );
}

// ------------------------------------------------------------------------------------- approval

// eslint-disable-next-line no-control-regex
const HIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
/** Makes invisible and direction-changing characters visible so the approved text is the text that runs. */
export const revealHidden = (s: string) => s.replace(HIDDEN, (c) => `⟨U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}⟩`);

export function ApprovalCard({ approval }: { approval: ApprovalView }) {
  const { app } = useStore();
  const [rejecting, setRejecting] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [grant, setGrant] = useState(false);
  const d = approval.detail;
  const respond = (approved: boolean) =>
    post({
      type: 'approval',
      id: approval.id,
      approved,
      grant: approved && grant && d.kind === 'edit' ? 'session-edits' : undefined,
      feedback: !approved && feedback.trim() ? feedback.trim() : undefined,
    });

  const title =
    d.kind === 'edit' ? (d.isNew ? 'Create this file?' : 'Apply these changes?') : d.kind === 'command' ? 'Run this command?' : 'Allow reading a protected file?';
  const icon = d.kind === 'command' ? 'terminal' : d.kind === 'edit' ? 'git-pull-request-go-to-changes' : 'shield';

  return (
    <section className="sv-approval" aria-label={title}>
      <div className="sv-approval__title">
        <Icon name={icon} />
        <span>{title}</span>
      </div>
      {d.kind === 'command' ? (
        <>
          <pre className="sv-approval__command">{revealHidden(d.command)}</pre>
          <div className="sv-approval__meta">in {d.cwd}</div>
          {d.warnings.length ? (
            <ul className="sv-approval__warnings">
              {d.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          ) : null}
        </>
      ) : d.kind === 'edit' ? (
        <>
          <div className="sv-approval__meta">
            <code>{d.path}</code> · <span className="sv-tabular">+{d.added} −{d.removed}</span>
          </div>
          <DiffView diff={d.diff} maxLines={60} />
        </>
      ) : (
        <div className="sv-approval__meta">
          <code>{d.path}</code> · {d.reason}
        </div>
      )}
      {rejecting ? (
        <textarea
          className="sv-approval__feedback"
          placeholder="Tell SOVRAN what to do instead (optional)"
          aria-label="Feedback for the agent"
          value={feedback}
          autoFocus
          onChange={(e) => setFeedback(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) respond(false);
          }}
        />
      ) : null}
      <div className="sv-approval__actions">
        {rejecting ? (
          <>
            <Button variant="primary" onClick={() => respond(false)}>
              Send rejection
            </Button>
            <Button variant="ghost" onClick={() => setRejecting(false)}>
              Back
            </Button>
          </>
        ) : (
          <>
            <Button variant="primary" icon="check" onClick={() => respond(true)}>
              {d.kind === 'command' ? 'Run' : d.kind === 'edit' ? 'Apply' : 'Allow'}
            </Button>
            {d.kind === 'edit' ? (
              <Button icon="diff" onClick={() => post({ type: 'openApprovalDiff', id: approval.id })}>
                Review diff
              </Button>
            ) : null}
            <Button variant="ghost" onClick={() => setRejecting(true)}>
              Reject…
            </Button>
          </>
        )}
      </div>
      {d.kind === 'edit' && !rejecting && app.fileEdits === 'ask' ? (
        <label className="sv-check">
          <input type="checkbox" checked={grant} onChange={(e) => setGrant(e.target.checked)} />
          Apply future edits in this chat without asking
        </label>
      ) : null}
    </section>
  );
}

// ------------------------------------------------------------------------------------- tool row

type RowStatus = 'queued' | 'awaiting' | 'running' | 'success' | 'error' | 'denied' | 'cancelled';

const STATUS_ICON: Record<RowStatus, { name: string; spin?: boolean; label: string }> = {
  queued: { name: 'circle-outline', label: 'Queued' },
  awaiting: { name: 'circle-filled', label: 'Waiting for approval' },
  running: { name: 'loading', spin: true, label: 'Running' },
  success: { name: 'check', label: 'Done' },
  error: { name: 'error', label: 'Failed' },
  denied: { name: 'circle-slash', label: 'Not allowed' },
  cancelled: { name: 'debug-stop', label: 'Cancelled' },
};

export function ToolRow({
  call,
  result,
  approval,
  run,
  output,
}: {
  call: ToolCallView;
  result?: ToolMessageView;
  approval?: ApprovalView;
  run: RunViewT | null;
  output?: string;
}) {
  const info = toolInfo(call.name);
  const status: RowStatus = result
    ? result.status
    : approval
      ? 'awaiting'
      : run?.activity.callId === call.id && run.activity.phase === 'running'
        ? 'running'
        : run
          ? 'queued'
          : 'cancelled';
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = open ?? (status === 'awaiting' || (status === 'running' && call.name === 'execute_terminal'));
  const target = toolTarget(call.name, call.arguments) || result?.summary || '';
  const display = result?.display;
  const verb = status === 'running' || status === 'awaiting' || status === 'queued' ? info.doing : info.done;
  const st = STATUS_ICON[status];
  const showStatusIcon = status !== 'success';

  let meta: React.ReactNode = result?.summary && result.summary !== target ? result.summary : null;
  if (display?.kind === 'diff') {
    meta = (
      <>
        <span className="sv-plus">+{display.added}</span> <span className="sv-minus">−{display.removed}</span>
      </>
    );
  }
  if (status === 'denied') meta = 'not applied';

  return (
    <div className="sv-tool" data-status={status}>
      <button type="button" className="sv-tool__row" aria-expanded={expanded} onClick={() => setOpen(!expanded)}>
        <Icon name={showStatusIcon ? st.name : info.icon} spin={st.spin} className="sv-tool__icon" label={st.label} />
        <span className="sv-tool__verb">{verb}</span>
        <span className="sv-tool__target" title={target}>
          {target}
        </span>
        <span className="sv-tool__meta">{meta}</span>
        <Icon name="chevron-down" className="sv-tool__chevron" />
      </button>
      {expanded ? (
        <div className="sv-tool__detail">
          {approval ? <ApprovalCard approval={approval} /> : null}
          {!approval && status === 'running' && output ? <pre className="sv-output">{output}</pre> : null}
          {result ? <ToolResultDetail result={result} /> : null}
          {!result && !approval && status !== 'running' ? <pre className="sv-output">{call.arguments}</pre> : null}
        </div>
      ) : null}
    </div>
  );
}

function ToolResultDetail({ result }: { result: ToolMessageView }) {
  const d = result.display;
  if (d?.kind === 'diff') {
    return (
      <>
        <DiffView diff={d.diff} />
        <Button variant="ghost" icon="go-to-file" onClick={() => post({ type: 'openFile', path: d.path })}>
          Open {d.path}
        </Button>
      </>
    );
  }
  if (d?.kind === 'command') return <pre className="sv-output">{`$ ${d.command}\n${d.output || '(no output)'}`}</pre>;
  if (d?.kind === 'list' && result.status === 'success') {
    return (
      <ul className="sv-list">
        {d.items.map((item) => (
          <li key={item}>{item}</li>
        ))}
        {d.total > d.items.length ? <li>… {d.total - d.items.length} more</li> : null}
      </ul>
    );
  }
  return <pre className="sv-output">{result.content}</pre>;
}

// ------------------------------------------------------------------------------------- transcript

type Block = { kind: 'user'; message: Extract<SessionMessage, { role: 'user' }> } | { kind: 'turn'; id: string; messages: AssistantMessageView[] };

function groupBlocks(messages: SessionMessage[]): Block[] {
  const blocks: Block[] = [];
  for (const m of messages) {
    if (m.role === 'user') blocks.push({ kind: 'user', message: m });
    else if (m.role === 'assistant') {
      const last = blocks[blocks.length - 1];
      if (last?.kind === 'turn') last.messages.push(m);
      else blocks.push({ kind: 'turn', id: m.id, messages: [m] });
    }
  }
  return blocks;
}

const ERROR_ACTIONS = new Set(['auth', 'not_found', 'network', 'tls', 'timeout']);

function AssistantPart({ message, results, run }: { message: AssistantMessageView; results: Map<string, ToolMessageView>; run: RunViewT | null }) {
  const { app, state } = useStore();
  const approvals = new Map(app.approvals.map((a) => [a.callId, a]));
  return (
    <>
      {message.reasoning ? (
        <details className="sv-reasoning">
          <summary>
            <Icon name="chevron-right" className="sv-reasoning__chevron" />
            {message.streaming && !message.content ? 'Thinking…' : 'Reasoning'}
          </summary>
          <div className="sv-reasoning__body">{message.reasoning}</div>
        </details>
      ) : null}
      {message.content ? (
        <div className={message.streaming ? 'sv-streaming' : undefined}>
          <Markdown text={message.content} />
        </div>
      ) : null}
      {message.error ? (
        <div className="sv-error" role="alert">
          <Icon name="error" />
          <div>{message.error.message}</div>
          {message.error.hint ? <div className="sv-error__hint">{message.error.hint}</div> : null}
          {!run ? (
            <div className="sv-error__actions">
              <Button variant="ghost" icon="refresh" onClick={() => post({ type: 'retry' })}>
                Retry
              </Button>
              {ERROR_ACTIONS.has(message.error.kind) ? (
                <Button variant="ghost" icon="server-environment" onClick={() => post({ type: 'setView', view: 'providers' })}>
                  Check provider settings
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {message.toolCalls?.length ? (
        <div className="sv-tools">
          {message.toolCalls.map((c) => (
            <ToolRow key={c.id} call={c} result={results.get(c.id)} approval={approvals.get(c.id)} run={run} output={state.toolOutputs[c.id]} />
          ))}
        </div>
      ) : null}
    </>
  );
}

type UserMessageView = Extract<SessionMessage, { role: 'user' }>;

function UserBlock({ message, canEdit }: { message: UserMessageView; canEdit: boolean }) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = message.display ?? message.content;
  const submit = () => {
    if (!draft?.trim()) return;
    post({ type: 'editMessage', messageId: message.id, text: draft.trim() });
    setDraft(null);
  };
  if (draft !== null) {
    return (
      <div className="sv-user sv-user--editing">
        <textarea
          className="sv-approval__feedback"
          aria-label="Edit message"
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            } else if (e.key === 'Escape') setDraft(null);
          }}
        />
        <div className="sv-approval__actions">
          <Button variant="primary" onClick={submit} disabled={!draft.trim()}>
            Send
          </Button>
          <Button variant="ghost" onClick={() => setDraft(null)}>
            Cancel
          </Button>
          <span className="sv-hint-text">Messages after this one are removed.</span>
        </div>
      </div>
    );
  }
  return (
    <div className="sv-user">
      {message.attachments?.length ? (
        <div className="sv-user__context">
          {message.attachments.map((a) => (
            <button key={`${a.path}:${a.startLine ?? ''}`} type="button" className="sv-chip" onClick={() => post({ type: 'openFile', path: a.path, line: a.startLine })}>
              <Icon name={a.kind === 'selection' ? 'selection' : 'file'} />
              <span>
                {a.path.split('/').pop()}
                {a.startLine ? `:${a.startLine}-${a.endLine}` : ''}
              </span>
            </button>
          ))}
        </div>
      ) : null}
      {shown}
      {canEdit ? (
        <div className="sv-user__actions">
          <IconButton icon="edit" label="Edit and resend" onClick={() => setDraft(shown)} />
        </div>
      ) : null}
    </div>
  );
}

function TurnFooter({ user, isLast, running }: { user: UserMessageView | undefined; isLast: boolean; running: boolean }) {
  const cp = user?.checkpoint;
  const showRetry = isLast && !running;
  if (!cp && !showRetry) return null;
  const n = cp?.files.length ?? 0;
  return (
    <div className="sv-turn__footer">
      {cp && user ? (
        cp.restoredAt ? (
          <span className="sv-turn__files">
            <Icon name="discard" /> Changes to {n} file{n === 1 ? '' : 's'} undone
          </span>
        ) : (
          <>
            <span className="sv-turn__files" title={cp.files.join('\n')}>
              <Icon name="files" /> {n} file{n === 1 ? '' : 's'} changed
            </span>
            {!running ? (
              <Button variant="ghost" icon="discard" onClick={() => post({ type: 'restoreCheckpoint', messageId: user.id })}>
                Undo changes
              </Button>
            ) : null}
          </>
        )
      ) : null}
      <span className="sv-composer__spacer" />
      {showRetry ? (
        <Button variant="ghost" icon="refresh" onClick={() => post({ type: 'retry' })} title="Generate this response again">
          Retry
        </Button>
      ) : null}
    </div>
  );
}

function CompactionDivider({ summary, count }: { summary: string; count: number }) {
  return (
    <details className="sv-compaction">
      <summary>
        <Icon name="fold" /> {count} earlier message{count === 1 ? '' : 's'} summarized for the model · show summary
      </summary>
      <div className="sv-compaction__body">
        <Markdown text={summary} />
      </div>
    </details>
  );
}

export function Transcript({ messages, run }: { messages: SessionMessage[]; run: RunViewT | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const blocks = useMemo(() => groupBlocks(messages), [messages]);
  const results = useMemo(
    () => new Map(messages.filter((m): m is ToolMessageView => m.role === 'tool').map((m) => [m.toolCallId, m])),
    [messages],
  );
  const { app } = useStore();

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  useEffect(() => {
    stick.current = true;
  }, [app.session?.id]);

  const modelOf = (b: Extract<Block, { kind: 'turn' }>) => b.messages.find((m) => m.model)?.model?.modelId;
  const running = !!run;

  return (
    <div
      className="sv-transcript"
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      {blocks.map((b, i) => {
        if (b.kind === 'user') {
          return (
            <div key={b.message.id} className="sv-block">
              {app.compaction?.firstKeptId === b.message.id ? <CompactionDivider summary={app.compaction.summary} count={app.compaction.summarizedCount} /> : null}
              <UserBlock message={b.message} canEdit={!running} />
            </div>
          );
        }
        const prev = blocks[i - 1];
        const user = prev?.kind === 'user' ? prev.message : undefined;
        return (
          <article key={b.id} className="sv-turn" aria-label="SOVRAN response">
            <div className="sv-turn__label">
              <span className="sv-wordmark">Sovran</span>
              {modelOf(b) ? <span>{modelOf(b)}</span> : null}
            </div>
            {b.messages.map((m) => (
              <AssistantPart key={m.id} message={m} results={results} run={run} />
            ))}
            <TurnFooter user={user} isLast={i === blocks.length - 1} running={running} />
          </article>
        );
      })}
    </div>
  );
}
