import { useId, useState, type FormEvent, type KeyboardEvent } from 'react';
import type {
  McpAuth,
  McpServerInput,
  McpServerView,
  McpToolPolicy,
  McpToolView,
} from '../../../src/shared/protocol';
import {
  ENV_NAME_PATTERN,
  HEADER_NAME_PATTERN,
  isHttpUrl,
  MCP_MESSAGES,
  MCP_TIMEOUT_SECONDS,
  transportProblems,
} from '../../../src/core/mcp/rules';
import { parseMcpSnippet, type McpDraft } from '../../../src/shared/mcpImport';
import { sendsKeyInsecurely } from '../../../src/shared/endpoints';
import { useStore } from '../state/store';
import { post } from '../vscode';
import { Button, Icon, IconButton } from './primitives';

/*
 * The MCP area of Settings: the servers the user connected, how each is doing, and what each of its tools may do.
 * Everything here writes user settings through the host; tokens go the other way only (webview → host → Secret
 * Storage), so the form never shows one back.
 */

// --------------------------------------------------------------------------------------------- presets

interface Preset {
  name: string;
  note: string;
  icon: string;
  draft: Omit<McpDraft, 'notes'>;
}

/** Well-known reference servers: one click fills the form, nothing starts until the user saves. */
const PRESETS: readonly Preset[] = [
  {
    name: 'Filesystem',
    note: 'files in this workspace',
    icon: 'files',
    draft: {
      name: 'Filesystem',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '${workspaceFolder}'],
      auth: { type: 'none' },
    },
  },
  {
    name: 'Fetch',
    note: 'web pages as Markdown, needs uv',
    icon: 'globe',
    draft: {
      name: 'Fetch',
      transport: 'stdio',
      command: 'uvx',
      args: ['mcp-server-fetch'],
      auth: { type: 'none' },
    },
  },
  {
    name: 'GitHub',
    note: 'remote, with a personal access token',
    icon: 'github',
    draft: {
      name: 'GitHub',
      transport: 'http',
      url: 'https://api.githubcopilot.com/mcp/',
      auth: { type: 'bearer' },
    },
  },
];

// --------------------------------------------------------------------------------------------- helpers

const STATUS: Record<McpServerView['status'], { label: string; dot: string }> = {
  connected: { label: 'Connected', dot: 'ok' },
  starting: { label: 'Starting…', dot: 'busy' },
  error: { label: 'Not connected', dot: 'error' },
  stopped: { label: 'Stopped', dot: 'off' },
  disabled: { label: 'Off', dot: 'off' },
};

const HINT_LABEL: Record<McpToolView['hints'][number], { label: string; title: string; tone?: 'warn' }> = {
  'read-only': {
    label: 'read-only',
    title: 'The server says this tool only reads data. It still asks unless you allow it.',
  },
  destructive: {
    label: 'can change data',
    title: 'The server says this tool can change or delete data.',
    tone: 'warn',
  },
  'open-world': {
    label: 'external',
    title: 'The server says this tool reaches services outside your machine.',
  },
};

const POLICIES: ReadonlyArray<{ value: McpToolPolicy; label: string; title: string }> = [
  { value: 'off', label: 'Off', title: 'Never offered to the model' },
  { value: 'ask', label: 'Ask', title: 'Asks before every use' },
  { value: 'allow', label: 'Allow', title: 'Runs without asking' },
];

const compact = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));

/** The command line or URL, as the user would type it. */
function summary(s: Pick<McpServerView, 'transport' | 'command' | 'args' | 'url'>): string {
  if (s.transport === 'http') return s.url ?? '';
  const quote = (a: string) => (/\s/.test(a) ? `"${a}"` : a);
  return [s.command ?? '', ...(s.args ?? []).map(quote)].join(' ');
}

/** "KEY=value" (environment) or "Name: value" (headers), one per line. */
function parsePairs(
  text: string,
  separator: '=' | ':',
  pattern: RegExp,
  message: string,
): { value: Record<string, string>; error: string } {
  const value: Record<string, string> = {};
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line) continue;
    const at = line.indexOf(separator);
    const key = at === -1 ? line : line.slice(0, at).trim();
    if (at === -1)
      return { value, error: `Line ${i + 1}: write ${separator === '=' ? 'NAME=value' : 'Name: value'}.` };
    if (!pattern.test(key)) return { value, error: `Line ${i + 1}: ${message}` };
    value[key] = line.slice(at + 1).trim();
  }
  return { value, error: '' };
}

const pairsText = (pairs: Record<string, string> | undefined, separator: string) =>
  Object.entries(pairs ?? {})
    .map(([k, v]) => `${k}${separator}${v}`)
    .join('\n');

// --------------------------------------------------------------------------------------------- tools

function PolicyChoice({ server, tool }: { server: McpServerView; tool: McpToolView }) {
  const label = `${tool.title ?? tool.name}: when the agent uses it`;
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = POLICIES.findIndex((p) => p.value === tool.policy);
    const next = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    const p = POLICIES[(next + POLICIES.length) % POLICIES.length]!;
    post({ type: 'setMcpToolPolicy', id: server.id, tool: tool.name, policy: p.value });
    (e.currentTarget.querySelector(`[data-value="${p.value}"]`) as HTMLButtonElement | null)?.focus();
  };
  return (
    <div className="sv-segment sv-mcp-policy" role="radiogroup" aria-label={label} onKeyDown={onKeyDown}>
      {POLICIES.map((p) => (
        <button
          key={p.value}
          type="button"
          role="radio"
          data-value={p.value}
          aria-checked={tool.policy === p.value}
          tabIndex={tool.policy === p.value ? 0 : -1}
          title={p.title}
          onClick={() => post({ type: 'setMcpToolPolicy', id: server.id, tool: tool.name, policy: p.value })}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}

function ToolList({ server }: { server: McpServerView }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const offered = server.tools.filter((t) => t.policy !== 'off').length;
  const allowed = server.tools.filter((t) => t.policy === 'allow').length;
  return (
    <div className="sv-mcp-tools">
      <button
        type="button"
        className="sv-mcp-tools__toggle"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        <Icon name={open ? 'chevron-down' : 'chevron-right'} />
        <span>
          {server.tools.length} tool{server.tools.length === 1 ? '' : 's'}
          {offered < server.tools.length ? ` · ${offered} offered` : ''}
          {allowed ? ` · ${allowed} allowed` : ''}
        </span>
        <span
          className="sv-mcp-tools__cost sv-tabular"
          title="Estimated tokens the offered tools add to every request"
        >
          ~{compact(server.toolTokens)} tokens
        </span>
      </button>
      {open ? (
        <ul id={id} className="sv-mcp-tools__list" aria-label={`Tools of ${server.name}`}>
          {server.tools.map((t) => (
            <li key={t.name} className="sv-mcp-tool" data-policy={t.policy}>
              <div className="sv-mcp-tool__head">
                <code className="sv-mcp-tool__name" title={t.modelName}>
                  {t.name}
                </code>
                {t.hints.map((h) => (
                  <span
                    key={h}
                    className={`sv-badge${HINT_LABEL[h].tone ? ' sv-badge--warn' : ''}`}
                    title={HINT_LABEL[h].title}
                  >
                    {HINT_LABEL[h].label}
                  </span>
                ))}
                <PolicyChoice server={server} tool={t} />
              </div>
              {t.title || t.description ? (
                <p className="sv-mcp-tool__description" title={t.description}>
                  {t.title && t.title !== t.name ? <strong>{t.title}. </strong> : null}
                  {t.description}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// --------------------------------------------------------------------------------------------- server card

function ServerCard({
  server: s,
  onEdit,
  active,
}: {
  server: McpServerView;
  onEdit: () => void;
  active: boolean;
}) {
  const status = STATUS[s.status];
  const needsToken = s.auth.type !== 'none' && !s.hasToken;
  const busy = s.status === 'starting';
  return (
    <section className="sv-card sv-mcp-card" aria-label={s.name} data-status={s.status}>
      <div className="sv-card__head">
        <span className="sv-mcp-dot" data-state={status.dot} aria-hidden="true" />
        <span className="sv-card__title">{s.name}</span>
        {s.enabled && active ? (
          <IconButton
            icon="debug-restart"
            label={`Restart ${s.name}`}
            onClick={() => post({ type: 'restartMcpServer', id: s.id })}
            disabled={busy}
          />
        ) : null}
        <IconButton icon="edit" label={`Edit ${s.name}`} onClick={onEdit} />
        <IconButton
          icon="trash"
          label={`Remove ${s.name}`}
          onClick={() => post({ type: 'deleteMcpServer', id: s.id })}
        />
        <button
          type="button"
          role="switch"
          className="sv-switch"
          aria-checked={s.enabled}
          aria-label={`Use ${s.name}`}
          title={s.enabled ? 'On: Sovran starts this server' : 'Off: the server does not start'}
          onClick={() => post({ type: 'setMcpServerEnabled', id: s.id, enabled: !s.enabled })}
        />
      </div>
      <div className="sv-card__url" title={summary(s)}>
        {summary(s)}
      </div>
      <div className="sv-badges">
        <span className="sv-badge">
          <Icon name={s.transport === 'http' ? 'globe' : 'terminal'} />
          {s.transport === 'http' ? 'Remote' : 'Local'}
        </span>
        <span className={`sv-badge${s.status === 'connected' ? ' sv-badge--ok' : ''}`} role="status">
          {busy ? <Icon name="loading" spin /> : null}
          {status.label}
          {s.status === 'connected' && s.server ? ` · ${s.server.name} ${s.server.version}` : ''}
        </span>
        {s.auth.type !== 'none' ? (
          s.hasToken ? (
            <span className="sv-badge sv-badge--ok">
              <Icon name="key" /> Token stored
            </span>
          ) : (
            <span className="sv-badge sv-badge--warn">
              <Icon name="warning" /> No token
            </span>
          )
        ) : null}
        {s.insecure ? (
          <span
            className="sv-badge sv-badge--warn"
            title="The token is sent over plain http to another machine. Use an https URL."
          >
            <Icon name="unlock" /> Token sent over http
          </span>
        ) : null}
      </div>
      {s.status === 'error' && s.error ? (
        <div className="sv-test sv-test--err" role="alert">
          <Icon name="error" />
          <div>
            <div>{s.error}</div>
            <div className="sv-approval__actions sv-mcp-card__fix">
              <Button icon="debug-restart" onClick={() => post({ type: 'restartMcpServer', id: s.id })}>
                Try again
              </Button>
              <Button variant="ghost" icon="output" onClick={() => post({ type: 'showLogs' })}>
                Show logs
              </Button>
            </div>
          </div>
        </div>
      ) : null}
      {s.status === 'connected' ? (
        s.tools.length ? (
          <ToolList server={s} />
        ) : (
          <span className="sv-field__help">This server offers no tools.</span>
        )
      ) : null}
      {s.auth.type !== 'none' ? (
        <div className="sv-approval__actions">
          <Button
            variant={needsToken ? 'secondary' : 'ghost'}
            icon="key"
            onClick={() => post({ type: 'setMcpToken', id: s.id })}
          >
            {s.hasToken ? 'Replace token' : 'Set token'}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

// --------------------------------------------------------------------------------------------- form

type TokenPlace = McpAuth['type'];

interface FormValues {
  id?: string;
  name: string;
  transport: 'stdio' | 'http';
  command: string;
  args: string;
  env: string;
  cwd: string;
  url: string;
  headers: string;
  tokenPlace: TokenPlace;
  tokenName: string;
  token: string;
  timeout: string;
}

function valuesOf(s: Partial<McpServerView> | Omit<McpDraft, 'notes'>): FormValues {
  const auth = s.auth ?? { type: 'none' };
  return {
    id: 'id' in s ? s.id : undefined,
    name: s.name ?? '',
    transport: s.transport ?? 'stdio',
    command: s.command ?? '',
    args: (s.args ?? []).join('\n'),
    env: pairsText(s.env, '='),
    cwd: s.cwd ?? '',
    url: s.url ?? '',
    headers: pairsText(s.headers, ': '),
    tokenPlace: auth.type,
    tokenName: auth.type === 'header' ? auth.headerName : auth.type === 'env' ? auth.envName : '',
    token: 'token' in s && s.token ? s.token : '',
    timeout:
      'timeoutSeconds' in s && s.timeoutSeconds && s.timeoutSeconds !== MCP_TIMEOUT_SECONDS.default
        ? String(s.timeoutSeconds)
        : '',
  };
}

/** The form's values as the message the host takes, or the first problem per field. */
function check(v: FormValues): {
  input?: McpServerInput;
  errors: Partial<
    Record<'name' | 'command' | 'url' | 'env' | 'headers' | 'tokenName' | 'timeout' | 'form', string>
  >;
} {
  const errors: ReturnType<typeof check>['errors'] = {};
  const local = v.transport === 'stdio';
  if (!v.name.trim()) errors.name = 'Give this server a name.';
  if (local && !v.command.trim())
    errors.command = 'Enter the command that starts the server, for example npx.';
  if (!local && !isHttpUrl(v.url)) errors.url = MCP_MESSAGES.url;
  const env = parsePairs(v.env, '=', ENV_NAME_PATTERN, MCP_MESSAGES.envName);
  if (local && env.error) errors.env = env.error;
  const headers = parsePairs(v.headers, ':', HEADER_NAME_PATTERN, MCP_MESSAGES.headerName);
  if (!local && headers.error) errors.headers = headers.error;
  const needsName = v.tokenPlace === 'header' || v.tokenPlace === 'env';
  if (
    needsName &&
    !(v.tokenPlace === 'env' ? ENV_NAME_PATTERN : HEADER_NAME_PATTERN).test(v.tokenName.trim())
  ) {
    errors.tokenName = v.tokenPlace === 'env' ? MCP_MESSAGES.envName : MCP_MESSAGES.headerName;
  }
  const timeout = v.timeout ? Number(v.timeout) : undefined;
  if (
    timeout !== undefined &&
    (!Number.isInteger(timeout) || timeout < MCP_TIMEOUT_SECONDS.min || timeout > MCP_TIMEOUT_SECONDS.max)
  ) {
    errors.timeout = `Enter a number of seconds from ${MCP_TIMEOUT_SECONDS.min} to ${MCP_TIMEOUT_SECONDS.max}.`;
  }
  if (Object.keys(errors).length) return { errors };

  const auth: McpAuth =
    v.tokenPlace === 'header'
      ? { type: 'header', headerName: v.tokenName.trim() }
      : v.tokenPlace === 'env'
        ? { type: 'env', envName: v.tokenName.trim() }
        : { type: v.tokenPlace };
  const args = v.args.split(/\r?\n/).filter((a) => a.trim());
  const input: McpServerInput = {
    ...(v.id ? { id: v.id } : {}),
    name: v.name.trim(),
    transport: v.transport,
    ...(local
      ? {
          command: v.command.trim(),
          ...(args.length ? { args } : {}),
          ...(Object.keys(env.value).length ? { env: env.value } : {}),
          ...(v.cwd.trim() ? { cwd: v.cwd.trim() } : {}),
        }
      : { url: v.url.trim(), ...(Object.keys(headers.value).length ? { headers: headers.value } : {}) }),
    auth,
    ...(timeout ? { timeoutSeconds: timeout } : {}),
    ...(auth.type !== 'none' && v.token.trim() ? { token: v.token.trim() } : {}),
  };
  const problem = transportProblems(input)[0];
  return problem ? { errors: { form: problem } } : { input, errors };
}

function ImportSnippet({ onDraft }: { onDraft: (draft: McpDraft) => void }) {
  const [text, setText] = useState('');
  const [result, setResult] = useState<ReturnType<typeof parseMcpSnippet> | null>(null);
  const id = useId();
  const drafts = result && 'drafts' in result ? result.drafts : [];
  return (
    <details className="sv-mcp-import">
      <summary>
        <Icon name="clippy" />
        Paste the JSON from the server's README
      </summary>
      <div className="sv-field">
        <label htmlFor={id} className="sv-sr-only">
          JSON snippet
        </label>
        <textarea
          id={id}
          className="sv-textarea sv-textarea--code"
          rows={6}
          spellCheck={false}
          value={text}
          placeholder={
            '{\n  "mcpServers": {\n    "github": { "command": "npx", "args": ["-y", "…"] }\n  }\n}'
          }
          onChange={(e) => {
            setText(e.target.value);
            setResult(null);
          }}
        />
        <span className="sv-field__help">
          The Claude Desktop, Cursor, Cline and VS Code formats all work. Tokens in it move to Secret Storage.
        </span>
        <div className="sv-approval__actions">
          <Button
            icon="arrow-down"
            disabled={!text.trim()}
            onClick={() => {
              const r = parseMcpSnippet(text);
              setResult(r);
              if ('drafts' in r && r.drafts.length === 1) onDraft(r.drafts[0]!);
            }}
          >
            Fill in the form
          </Button>
        </div>
        {result && 'error' in result ? (
          <span className="sv-field__error" role="alert">
            {result.error}
          </span>
        ) : null}
        {drafts.length > 1 ? (
          <div className="sv-discovered" role="group" aria-label="Servers in the snippet">
            <span className="sv-field__help">
              The snippet has {drafts.length} servers. Pick one; paste again for the others.
            </span>
            {drafts.map((d) => (
              <button key={d.name} type="button" className="sv-chip" onClick={() => onDraft(d)}>
                <Icon name={d.transport === 'http' ? 'globe' : 'terminal'} />
                <span>{d.name}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </details>
  );
}

function ServerForm({
  initial,
  hasToken,
  onDone,
}: {
  initial: FormValues;
  hasToken: boolean;
  onDone: () => void;
}) {
  const [v, setV] = useState(initial);
  const [notes, setNotes] = useState<string[]>([]);
  const [touched, setTouched] = useState(false);
  const set = (patch: Partial<FormValues>) => setV((x) => ({ ...x, ...patch }));
  const { input, errors } = check(v);
  const shown = touched ? errors : {};
  const local = v.transport === 'stdio';
  // The places a token can go depend on the transport; switching keeps a choice that still fits.
  const places: Array<[TokenPlace, string]> = local
    ? [
        ['none', 'None'],
        ['env', 'Environment variable'],
      ]
    : [
        ['none', 'None'],
        ['bearer', 'Bearer token'],
        ['header', 'Custom header'],
      ];
  const setTransport = (transport: 'stdio' | 'http') => {
    const fits =
      transport === 'stdio' ? v.tokenPlace === 'env' || v.tokenPlace === 'none' : v.tokenPlace !== 'env';
    set({ transport, ...(fits ? {} : { tokenPlace: 'none' as const, tokenName: '' }) });
  };
  const insecure =
    !local &&
    isHttpUrl(v.url) &&
    sendsKeyInsecurely(v.url.trim(), v.tokenPlace === 'env' ? 'none' : v.tokenPlace);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!input) return;
    post({ type: 'saveMcpServer', server: input });
    onDone();
  };

  return (
    <form
      className="sv-form sv-card sv-mcp-form"
      onSubmit={submit}
      noValidate
      aria-label={v.id ? `Edit ${initial.name}` : 'Add MCP server'}
    >
      <div className="sv-card__head">
        <Icon name="mcp" />
        <span className="sv-card__title">{v.id ? `Edit ${initial.name}` : 'New MCP server'}</span>
      </div>
      {!v.id ? (
        <ImportSnippet
          onDraft={(d) => {
            setV({ ...valuesOf(d), id: undefined });
            setNotes(d.notes);
            setTouched(false);
          }}
        />
      ) : null}
      {notes.length ? (
        <ul className="sv-mcp-notes" aria-label="What the import changed">
          {notes.map((n) => (
            <li key={n}>
              <Icon name="info" />
              {n}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="sv-field">
        <label htmlFor="sv-mcp-name">Name</label>
        <input
          id="sv-mcp-name"
          value={v.name}
          onChange={(e) => set({ name: e.target.value })}
          placeholder="GitHub"
          autoFocus={!v.name}
          aria-invalid={!!shown.name}
        />
        {shown.name ? <span className="sv-field__error">{shown.name}</span> : null}
      </div>
      <div className="sv-field">
        <fieldset>
          <legend>Where it runs</legend>
          <div className="sv-segment sv-segment--block" role="radiogroup" aria-label="Where it runs">
            <button type="button" role="radio" aria-checked={local} onClick={() => setTransport('stdio')}>
              <Icon name="terminal" /> Local command
            </button>
            <button type="button" role="radio" aria-checked={!local} onClick={() => setTransport('http')}>
              <Icon name="globe" /> Remote URL
            </button>
          </div>
        </fieldset>
        <span className="sv-field__help">
          {local
            ? 'Sovran starts the program and talks to it over stdin and stdout.'
            : 'Sovran connects to the server over Streamable HTTP.'}
        </span>
      </div>

      {local ? (
        <>
          <div className="sv-field">
            <label htmlFor="sv-mcp-command">Command</label>
            <input
              id="sv-mcp-command"
              value={v.command}
              onChange={(e) => set({ command: e.target.value })}
              placeholder="npx"
              spellCheck={false}
              aria-invalid={!!shown.command}
            />
            {shown.command ? (
              <span className="sv-field__error">{shown.command}</span>
            ) : (
              <span className="sv-field__help">
                The program only, for example npx, uvx, docker or a full path.
              </span>
            )}
          </div>
          <div className="sv-field">
            <label htmlFor="sv-mcp-args">Arguments</label>
            <textarea
              id="sv-mcp-args"
              className="sv-textarea sv-textarea--code"
              rows={3}
              value={v.args}
              onChange={(e) => set({ args: e.target.value })}
              placeholder={'-y\n@modelcontextprotocol/server-filesystem\n${workspaceFolder}'}
              spellCheck={false}
            />
            <span className="sv-field__help">
              One per line. {'${workspaceFolder}'}, {'${userHome}'} and {'${env:NAME}'} are filled in when the
              server starts.
            </span>
          </div>
          <div className="sv-field">
            <label htmlFor="sv-mcp-env">Environment</label>
            <textarea
              id="sv-mcp-env"
              className="sv-textarea sv-textarea--code"
              rows={2}
              value={v.env}
              onChange={(e) => set({ env: e.target.value })}
              placeholder="LOG_LEVEL=info"
              spellCheck={false}
              aria-invalid={!!shown.env}
            />
            {shown.env ? (
              <span className="sv-field__error">{shown.env}</span>
            ) : (
              <span className="sv-field__help">
                NAME=value, one per line. Saved in settings.json as plain text: put the token below instead.
              </span>
            )}
          </div>
          <div className="sv-field">
            <label htmlFor="sv-mcp-cwd">Working folder</label>
            <input
              id="sv-mcp-cwd"
              value={v.cwd}
              onChange={(e) => set({ cwd: e.target.value })}
              placeholder="The first workspace folder"
              spellCheck={false}
            />
          </div>
        </>
      ) : (
        <>
          <div className="sv-field">
            <label htmlFor="sv-mcp-url">URL</label>
            <input
              id="sv-mcp-url"
              value={v.url}
              onChange={(e) => set({ url: e.target.value })}
              placeholder="https://mcp.example.com/mcp"
              spellCheck={false}
              aria-invalid={!!shown.url}
            />
            {shown.url ? (
              <span className="sv-field__error">{shown.url}</span>
            ) : (
              <span className="sv-field__help">The server's MCP endpoint, often ending in /mcp.</span>
            )}
          </div>
          <div className="sv-field">
            <label htmlFor="sv-mcp-headers">Headers</label>
            <textarea
              id="sv-mcp-headers"
              className="sv-textarea sv-textarea--code"
              rows={2}
              value={v.headers}
              onChange={(e) => set({ headers: e.target.value })}
              placeholder="X-Team: platform"
              spellCheck={false}
              aria-invalid={!!shown.headers}
            />
            {shown.headers ? (
              <span className="sv-field__error">{shown.headers}</span>
            ) : (
              <span className="sv-field__help">
                Name: value, one per line. Saved in settings.json as plain text: put the token below instead.
              </span>
            )}
          </div>
        </>
      )}

      <div className="sv-field">
        <fieldset>
          <legend>Token</legend>
          <div className="sv-segment sv-segment--block" role="radiogroup" aria-label="Where the token goes">
            {places.map(([p, label]) => (
              <button
                key={p}
                type="button"
                role="radio"
                aria-checked={v.tokenPlace === p}
                onClick={() => set({ tokenPlace: p })}
              >
                {label}
              </button>
            ))}
          </div>
        </fieldset>
        {v.tokenPlace === 'header' || v.tokenPlace === 'env' ? (
          <input
            aria-label={v.tokenPlace === 'env' ? 'Environment variable name' : 'Header name'}
            value={v.tokenName}
            onChange={(e) => set({ tokenName: e.target.value })}
            placeholder={v.tokenPlace === 'env' ? 'GITHUB_PERSONAL_ACCESS_TOKEN' : 'X-Api-Key'}
            spellCheck={false}
            aria-invalid={!!shown.tokenName}
          />
        ) : null}
        {shown.tokenName ? <span className="sv-field__error">{shown.tokenName}</span> : null}
        {v.tokenPlace !== 'none' ? (
          <input
            type="password"
            aria-label="Token"
            autoComplete="off"
            value={v.token}
            onChange={(e) => set({ token: e.target.value })}
            placeholder={hasToken ? 'Stored. Leave empty to keep it' : 'Paste the token'}
          />
        ) : null}
        <span className="sv-field__help">
          {v.tokenPlace === 'none'
            ? 'For servers that need no credentials.'
            : `${
                v.tokenPlace === 'bearer'
                  ? 'Sent as "Authorization: Bearer <token>".'
                  : v.tokenPlace === 'header'
                    ? `Sent in the ${v.tokenName.trim() || 'chosen'} header.`
                    : `Given to the server as ${v.tokenName.trim() || 'this variable'}.`
              } Kept in VS Code Secret Storage, never in settings.`}
        </span>
        {insecure ? (
          <span className="sv-field__note" role="note">
            This URL uses http, so the token would travel unencrypted. Use https for anything that is not on
            this machine.
          </span>
        ) : null}
      </div>
      <div className="sv-field">
        <label htmlFor="sv-mcp-timeout">Timeout (seconds)</label>
        <input
          id="sv-mcp-timeout"
          className="sv-number"
          inputMode="numeric"
          value={v.timeout}
          placeholder={String(MCP_TIMEOUT_SECONDS.default)}
          onChange={(e) => set({ timeout: e.target.value.replace(/\D/g, '') })}
          aria-invalid={!!shown.timeout}
        />
        {shown.timeout ? (
          <span className="sv-field__error">{shown.timeout}</span>
        ) : (
          <span className="sv-field__help">A request that sends nothing for this long is stopped.</span>
        )}
      </div>
      {shown.form ? (
        <span className="sv-field__error" role="alert">
          {shown.form}
        </span>
      ) : null}
      <div className="sv-approval__actions">
        <Button type="submit" variant="primary">
          {v.id ? 'Save server' : 'Add server'}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

// --------------------------------------------------------------------------------------------- area

export function McpArea() {
  const { app } = useStore();
  const [editing, setEditing] = useState<{ key: string; values: FormValues; hasToken: boolean } | null>(null);
  const servers = app.mcp.servers;
  const edit = (s: McpServerView) => setEditing({ key: s.id, values: valuesOf(s), hasToken: s.hasToken });
  // The form unmounts whenever it closes, so a new one always starts from these values.
  const add = (preset?: Preset) =>
    setEditing({
      key: `new-${preset?.name ?? 'blank'}`,
      values: valuesOf(preset?.draft ?? {}),
      hasToken: false,
    });
  const offered = servers.reduce((n, s) => n + s.tools.filter((t) => t.policy !== 'off').length, 0);
  const cost = servers.reduce((n, s) => n + (s.status === 'connected' ? s.toolTokens : 0), 0);

  return (
    <>
      {!app.mcp.active ? (
        <p className="sv-fineprint sv-mcp-restricted" role="note">
          <Icon name="shield" />
          <span>
            This workspace is in Restricted Mode, so MCP servers do not start. Trust the workspace to use
            their tools.
          </span>
        </p>
      ) : null}
      {editing ? (
        <ServerForm
          key={editing.key}
          initial={editing.values}
          hasToken={editing.hasToken}
          onDone={() => setEditing(null)}
        />
      ) : (
        <>
          {servers.map((s) => (
            <ServerCard key={s.id} server={s} onEdit={() => edit(s)} active={app.mcp.active} />
          ))}
          {servers.length ? (
            <div className="sv-approval__actions">
              <Button icon="add" onClick={() => add()}>
                Add server
              </Button>
              {offered ? (
                <span className="sv-field__help sv-tabular">
                  {offered} tool{offered === 1 ? '' : 's'} offered · ~{compact(cost)} tokens per request
                </span>
              ) : null}
            </div>
          ) : (
            <div className="sv-field">
              <span className="sv-field__label">Add a server</span>
              <ul className="sv-presets" aria-label="Common MCP servers">
                {PRESETS.map((p) => (
                  <li key={p.name}>
                    <button type="button" className="sv-preset" onClick={() => add(p)}>
                      <Icon name={p.icon} className="sv-preset__icon" />
                      <span className="sv-preset__name">
                        {p.name} <span className="sv-tagline">· {p.note}</span>
                      </span>
                      <span className="sv-preset__url">{summary(p.draft)}</span>
                      <Icon name="chevron-right" className="sv-preset__chevron" />
                    </button>
                  </li>
                ))}
                <li>
                  <button type="button" className="sv-preset" onClick={() => add()}>
                    <Icon name="add" className="sv-preset__icon" />
                    <span className="sv-preset__name">Another server</span>
                    <span className="sv-preset__url">A command, a URL or a README snippet</span>
                    <Icon name="chevron-right" className="sv-preset__chevron" />
                  </button>
                </li>
              </ul>
            </div>
          )}
          <p className="sv-fineprint">
            <Icon name="shield" />
            <span>
              Each tool asks before it runs, in every approval mode, until you set it to Allow. Tools are
              offered in Act mode only, and every tool you offer costs context in each request: turn off the
              ones you do not need.
            </span>
          </p>
        </>
      )}
    </>
  );
}
