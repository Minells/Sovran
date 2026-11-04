import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import type { ApprovalView, AssistantMessageView, RunViewT, ToolCallView, ToolMessageView } from './types';
import type { SessionMessage } from '../../../src/shared/protocol';
import { renderMarkdown } from '../lib/markdown';
import { toolInfo, toolTarget } from '../lib/format';
import { post } from '../vscode';
import { useStore } from '../state/store';
import { ApprovalDetail, approvalAnchor } from './Approval';
import { DiffView } from './Diff';
import { Button, Icon, IconButton, Mark } from './primitives';

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
          setTimeout(
            () => action.querySelector('.codicon')?.classList.replace('codicon-check', 'codicon-copy'),
            1200,
          );
        });
      } else if (action.dataset.action === 'insert') {
        post({ type: 'insertCode', code });
      }
      return;
    }
    const pathEl = target.closest<HTMLElement>('[data-path]');
    if (pathEl?.dataset.path) {
      post({
        type: 'openFile',
        path: pathEl.dataset.path,
        line: pathEl.dataset.line ? Number(pathEl.dataset.line) : undefined,
      });
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
  // A pending approval always shows its detail: the bar above links to it, so it must not be folded away.
  const expanded = status === 'awaiting' || (open ?? (status === 'running' && call.name === 'execute_terminal'));
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
  // Changes that ran without a human decision are marked, so an Auto-mode transcript stays auditable.
  const auto = result?.autoApproved ? (
    <span className="sv-auto-badge" title={result.autoApproved} aria-label={result.autoApproved}>
      <Icon name="zap" />
      auto
    </span>
  ) : null;

  return (
    <div className="sv-tool" data-status={status}>
      <button
        type="button"
        className="sv-tool__row"
        aria-expanded={expanded}
        disabled={status === 'awaiting'}
        onClick={() => setOpen(!expanded)}
      >
        <Icon
          name={showStatusIcon ? st.name : info.icon}
          spin={st.spin}
          className="sv-tool__icon"
          label={st.label}
        />
        <span className="sv-tool__verb">{verb}</span>
        <span className="sv-tool__target" title={target}>
          {target}
        </span>
        <span className="sv-tool__meta">
          {auto}
          {meta}
        </span>
        <Icon name="chevron-down" className="sv-tool__chevron" />
      </button>
      {expanded ? (
        <div className="sv-tool__detail">
          {approval ? <ApprovalDetail approval={approval} /> : null}
          {!approval && status === 'running' && output ? <pre className="sv-output">{output}</pre> : null}
          {result ? <ToolResultDetail result={result} /> : null}
          {!result && !approval && status !== 'running' ? (
            <pre className="sv-output">{call.arguments}</pre>
          ) : null}
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
        <DiffView diff={d.diff} label={`Changes to ${d.path}`} />
        <Button variant="ghost" icon="go-to-file" onClick={() => post({ type: 'openFile', path: d.path })}>
          Open {d.path}
        </Button>
      </>
    );
  }
  if (d?.kind === 'command')
    return <pre className="sv-output">{`$ ${d.command}\n${d.output || '(no output)'}`}</pre>;
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

type Block =
  | { kind: 'user'; message: Extract<SessionMessage, { role: 'user' }> }
  | { kind: 'turn'; id: string; messages: AssistantMessageView[] };

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
const READ_TOOLS = new Set([
  'read_file',
  'list_directory',
  'find_files',
  'search_files',
  'get_workspace_info',
  'get_active_editor_context',
]);

type ToolPart = { kind: 'tool'; key: string; call: ToolCallView };
type ReasoningPart = { kind: 'reasoning'; key: string; message: AssistantMessageView };
type Part =
  | ReasoningPart
  | ToolPart
  | { kind: 'text'; key: string; message: AssistantMessageView }
  | { kind: 'error'; key: string; message: AssistantMessageView }
  | { kind: 'explore'; key: string; items: Array<ToolPart | ReasoningPart> };

/**
 * Flattens a turn into display parts and folds runs of finished, successful read-only tool calls
 * ("exploration") into one collapsible row, so the transcript shows decisions rather than noise.
 */
function buildParts(messages: AssistantMessageView[], results: Map<string, ToolMessageView>): Part[] {
  const raw: Part[] = [];
  for (const m of messages) {
    if (m.reasoning) raw.push({ kind: 'reasoning', key: `${m.id}:r`, message: m });
    if (m.content) raw.push({ kind: 'text', key: `${m.id}:t`, message: m });
    if (m.error) raw.push({ kind: 'error', key: `${m.id}:e`, message: m });
    for (const call of m.toolCalls ?? []) raw.push({ kind: 'tool', key: call.id, call });
  }
  const out: Part[] = [];
  let bucket: Array<ToolPart | ReasoningPart> = [];
  const flush = () => {
    const tools = bucket.filter((p) => p.kind === 'tool').length;
    if (tools >= 2) out.push({ kind: 'explore', key: `x:${bucket[0]!.key}`, items: bucket });
    else out.push(...bucket);
    bucket = [];
  };
  for (const part of raw) {
    const explorable =
      part.kind === 'tool' &&
      READ_TOOLS.has(part.call.name) &&
      results.get(part.call.id)?.status === 'success';
    if (explorable || (part.kind === 'reasoning' && bucket.length > 0))
      bucket.push(part as ToolPart | ReasoningPart);
    else {
      flush();
      out.push(part);
    }
  }
  flush();
  return out;
}

export function exploreSummary(calls: ToolCallView[]): string {
  const count = (names: string[]) => calls.filter((c) => names.includes(c.name)).length;
  const reads = count(['read_file']);
  const searches = count(['search_files', 'find_files']);
  const listings = count(['list_directory']);
  const other = calls.length - reads - searches - listings;
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  return [
    reads && plural(reads, 'file read', 'files read'),
    searches && plural(searches, 'search', 'searches'),
    listings && plural(listings, 'folder listed', 'folders listed'),
    other && plural(other, 'check', 'checks'),
  ]
    .filter(Boolean)
    .join(', ');
}

function Reasoning({ message }: { message: AssistantMessageView }) {
  return (
    <details className="sv-reasoning">
      <summary>
        <Icon name="chevron-right" className="sv-reasoning__chevron" />
        {message.streaming && !message.content ? 'Thinking…' : 'Reasoning'}
      </summary>
      <div className="sv-reasoning__body">{message.reasoning}</div>
    </details>
  );
}

function ErrorBlock({ message, running }: { message: AssistantMessageView; running: boolean }) {
  const error = message.error!;
  return (
    <div className="sv-error" role="alert">
      <Icon name="error" />
      <div>{error.message}</div>
      {error.hint ? <div className="sv-error__hint">{error.hint}</div> : null}
      {!running ? (
        <div className="sv-error__actions">
          <Button variant="ghost" icon="refresh" onClick={() => post({ type: 'retry' })}>
            Retry
          </Button>
          {ERROR_ACTIONS.has(error.kind) ? (
            <Button
              variant="ghost"
              icon="server-environment"
              onClick={() => post({ type: 'setView', view: 'providers' })}
            >
              Check provider settings
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ExploreGroup({
  items,
  render,
}: {
  items: Array<ToolPart | ReasoningPart>;
  render: (p: ToolPart | ReasoningPart) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const calls = items.flatMap((p) => (p.kind === 'tool' ? [p.call] : []));
  return (
    <div className="sv-tool sv-explore" data-status="success">
      <button type="button" className="sv-tool__row" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="search" className="sv-tool__icon" />
        <span className="sv-tool__verb">Explored</span>
        <span className="sv-explore__summary">{exploreSummary(calls)}</span>
        <span className="sv-tool__meta" />
        <Icon name="chevron-down" className="sv-tool__chevron" />
      </button>
      {open ? (
        <div className="sv-tool__detail">
          <div className="sv-tools">{items.map(render)}</div>
        </div>
      ) : null}
    </div>
  );
}

function TurnBody({
  messages,
  results,
  run,
}: {
  messages: AssistantMessageView[];
  results: Map<string, ToolMessageView>;
  run: RunViewT | null;
}) {
  const { app, state } = useStore();
  const approvals = new Map(app.approvals.map((a) => [a.callId, a]));
  const parts = buildParts(messages, results);
  const renderTool = (p: ToolPart | ReasoningPart) =>
    p.kind === 'reasoning' ? (
      <Reasoning key={p.key} message={p.message} />
    ) : (
      <ToolRow
        key={p.key}
        call={p.call}
        result={results.get(p.call.id)}
        approval={approvals.get(p.call.id)}
        run={run}
        output={state.toolOutputs[p.call.id]}
      />
    );

  // Consecutive tool rows share one tight list; prose and errors keep the turn's looser rhythm.
  const segments: Array<{ key: string; tools: Part[] } | Part> = [];
  for (const p of parts) {
    const isRow = p.kind === 'tool' || p.kind === 'explore';
    const last = segments[segments.length - 1];
    if (isRow && last && 'tools' in last) last.tools.push(p);
    else if (isRow) segments.push({ key: `seg:${p.key}`, tools: [p] });
    else segments.push(p);
  }
  return (
    <>
      {segments.map((s) => {
        if ('tools' in s) {
          return (
            <div key={s.key} className="sv-tools">
              {s.tools.map((p) =>
                p.kind === 'explore' ? (
                  <ExploreGroup key={p.key} items={p.items} render={renderTool} />
                ) : (
                  renderTool(p as ToolPart)
                ),
              )}
            </div>
          );
        }
        if (s.kind === 'reasoning') return <Reasoning key={s.key} message={s.message} />;
        if (s.kind === 'error') return <ErrorBlock key={s.key} message={s.message} running={!!run} />;
        if (s.kind === 'text') {
          return (
            <div key={s.key} className={s.message.streaming ? 'sv-streaming' : undefined}>
              <Markdown text={s.message.content} />
            </div>
          );
        }
        return null;
      })}
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
          {message.attachments.map((a) =>
            a.external ? (
              // Files from the computer are outside the workspace, so they cannot be opened from here.
              <span key={a.path} className="sv-chip sv-chip--static" title={`${a.path} (from your computer)`}>
                <Icon name="device-desktop" />
                <span>{a.path.split('/').pop()}</span>
              </span>
            ) : (
              <button
                key={`${a.path}:${a.startLine ?? ''}`}
                type="button"
                className="sv-chip"
                onClick={() => post({ type: 'openFile', path: a.path, line: a.startLine })}
              >
                <Icon name={a.kind === 'selection' ? 'selection' : 'file'} />
                <span>
                  {a.path.split('/').pop()}
                  {a.startLine ? `:${a.startLine}-${a.endLine}` : ''}
                </span>
              </button>
            ),
          )}
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

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <IconButton
      icon={copied ? 'check' : 'copy'}
      label={copied ? 'Copied' : 'Copy response'}
      onClick={() => void navigator.clipboard?.writeText(text).then(() => setCopied(true))}
    />
  );
}

/**
 * Under a response: the files it changed (always visible, with Undo), and a quiet toolbar that appears on hover or
 * keyboard focus. Retry lives there, as an icon, because regenerating a response is a rare move.
 */
function TurnFooter({
  user,
  messages,
  isLast,
  running,
}: {
  user: UserMessageView | undefined;
  messages: AssistantMessageView[];
  isLast: boolean;
  running: boolean;
}) {
  const cp = user?.checkpoint;
  const streaming = isLast && running;
  const canRetry = isLast && !running;
  const text = messages
    .map((m) => m.content.trim())
    .filter(Boolean)
    .join('\n\n');
  const actions = !streaming && (canRetry || !!text);
  if (!cp && !actions) return null;
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
              <Button
                variant="ghost"
                icon="discard"
                onClick={() => post({ type: 'restoreCheckpoint', messageId: user.id })}
              >
                Undo changes
              </Button>
            ) : null}
          </>
        )
      ) : null}
      <span className="sv-composer__spacer" />
      {actions ? (
        <div className="sv-turn__actions" role="toolbar" aria-label="Response actions">
          {text ? <CopyButton text={text} /> : null}
          {canRetry ? (
            <IconButton icon="refresh" label="Retry" title="Retry: generate this response again" onClick={() => post({ type: 'retry' })} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function CompactionDivider({ summary, count }: { summary: string; count: number }) {
  return (
    <details className="sv-compaction">
      <summary>
        <Icon name="fold" /> {count} earlier message{count === 1 ? '' : 's'} summarized for the model · show
        summary
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
    () =>
      new Map(messages.filter((m): m is ToolMessageView => m.role === 'tool').map((m) => [m.toolCallId, m])),
    [messages],
  );
  const { app } = useStore();
  // Remounted per session (keyed by the parent), so these start pinned to the bottom.
  const [pinned, setPinned] = useState(true);

  // Follows new content while the user is at the bottom. Instantly: CSS smooth scrolling would animate every streamed
  // chunk, keep restarting, and fight the user's own scrolling.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  // A new approval while following: a detail taller than the view is shown from its start (a diff reads top-down), and
  // following stops so the view stays there. The scroll event that follows updates `pinned`.
  const approvalId = app.approvals[0]?.id;
  useLayoutEffect(() => {
    const el = ref.current;
    const detail = approvalId ? document.getElementById(approvalAnchor(approvalId)) : null;
    if (!el || !detail || !stick.current) return;
    const row = detail.closest('.sv-tool') ?? detail;
    const top = row.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 8;
    if (top < el.scrollHeight - el.clientHeight) {
      el.scrollTop = Math.max(0, top);
      stick.current = false;
    }
  }, [approvalId]);

  const reduceMotion = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const jumpToLatest = () => {
    const el = ref.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: reduceMotion() ? 'auto' : 'smooth' });
    stick.current = true;
    setPinned(true);
  };
  const modelOf = (b: Extract<Block, { kind: 'turn' }>) => b.messages.find((m) => m.model)?.model?.modelId;
  const running = !!run;

  return (
    <div className="sv-transcript-wrap">
      <div
        className="sv-transcript"
        ref={ref}
        // Focusable, so the arrow and Page keys scroll it; Enter and Escape still answer a pending approval.
        tabIndex={0}
        aria-label="Conversation"
        onScroll={(e) => {
          const el = e.currentTarget;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          stick.current = atBottom;
          if (atBottom !== pinned) setPinned(atBottom);
        }}
      >
        {blocks.map((b, i) => {
          if (b.kind === 'user') {
            return (
              <div key={b.message.id} className="sv-block">
                {app.compaction?.firstKeptId === b.message.id ? (
                  <CompactionDivider
                    summary={app.compaction.summary}
                    count={app.compaction.summarizedCount}
                  />
                ) : null}
                <UserBlock message={b.message} canEdit={!running} />
              </div>
            );
          }
          const prev = blocks[i - 1];
          const user = prev?.kind === 'user' ? prev.message : undefined;
          return (
            <article key={b.id} className="sv-turn" aria-label="Sovran response">
              <div className="sv-turn__label">
                <Mark size={12} />
                <span className="sv-wordmark">sovran</span>
                {modelOf(b) ? <span>{modelOf(b)}</span> : null}
              </div>
              <TurnBody messages={b.messages} results={results} run={run} />
              <TurnFooter user={user} messages={b.messages} isLast={i === blocks.length - 1} running={running} />
            </article>
          );
        })}
      </div>
      {/* While a decision waits, nothing new arrives and the bar links to the proposal, so no jump button covers it. */}
      {!pinned && !approvalId ? (
        <button type="button" className="sv-jump" onClick={jumpToLatest}>
          <Icon name="arrow-down" />
          Latest
        </button>
      ) : null}
    </div>
  );
}
