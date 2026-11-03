import { useId, useState, type ReactNode } from 'react';
import type { ApprovalMode, SelectedModel, SettingKey, SettingUpdate } from '../../../src/shared/protocol';
import { hasShellMetacharacters } from '../../../src/core/permissions/shell';
import { sendsKeyInsecurely } from '../../../src/shared/endpoints';
import { APPROVAL_OPTIONS } from '../lib/approvals';
import { useStore } from '../state/store';
import { post } from '../vscode';
import { Button, CheckRow, Icon, IconButton } from './primitives';

const update = (setting: SettingUpdate) => post({ type: 'updateSetting', setting });
const ref = (s: SelectedModel | null) => (s ? `${s.providerId}\u0000${s.modelId}` : '');

function Section({ id, icon, title, description, children }: { id: string; icon: string; title: string; description?: string; children: ReactNode }) {
  return (
    <section className="sv-settings__section" aria-labelledby={`${id}-title`} id={id}>
      <header className="sv-settings__head">
        <Icon name={icon} />
        <div>
          <h3 id={`${id}-title`}>{title}</h3>
          {description ? <p className="sv-field__help">{description}</p> : null}
        </div>
      </header>
      <div className="sv-settings__body">{children}</div>
    </section>
  );
}

const OVERRIDE_NOTE = 'This workspace overrides this setting in its .vscode/settings.json.';

// --------------------------------------------------------------------------------------------- models

function ModelSelect({ role }: { role: 'act' | 'plan' }) {
  const { app } = useStore();
  const id = useId();
  const value = role === 'act' ? app.selected : app.planModel;
  const choices = app.providers.flatMap((p) => p.models.map((m) => ({ provider: p, model: m })));
  const onChange = (raw: string) => {
    const [providerId, modelId] = raw.split('\u0000');
    post(providerId && modelId ? { type: 'setModel', role, providerId, modelId } : { type: 'setModel', role });
  };
  return (
    <div className="sv-field">
      <label htmlFor={id}>{role === 'act' ? 'Act model' : 'Plan model'}</label>
      <select id={id} value={ref(value)} onChange={(e) => onChange(e.target.value)} disabled={!choices.length}>
        {role === 'plan' ? <option value="">Same as Act model</option> : null}
        {role === 'act' && !value ? <option value="">Choose a model</option> : null}
        {app.providers
          .filter((p) => p.models.length)
          .map((p) => (
            <optgroup key={p.id} label={p.name}>
              {p.models.map((m) => (
                <option key={m.id} value={ref({ providerId: p.id, modelId: m.id })}>
                  {m.name ?? m.id}
                </option>
              ))}
            </optgroup>
          ))}
      </select>
      <span className="sv-field__help">
        {role === 'act'
          ? 'Used for new chats and in Act mode.'
          : 'Plan mode can use a larger reasoning model, while Act uses a fast coder.'}
      </span>
    </div>
  );
}

function ProvidersSummary() {
  const { app } = useStore();
  return (
    <div className="sv-field">
      <span className="sv-field__label">Providers</span>
      {app.providers.length ? (
        <ul className="sv-provider-list">
          {app.providers.map((p) => {
            const insecure = sendsKeyInsecurely(p.baseUrl, p.authType);
            const needsKey = p.authType !== 'none' && !p.hasKey;
            return (
              <li key={p.id}>
                <span className="sv-dot" data-state={insecure || needsKey ? 'warn' : 'ok'} aria-hidden="true" />
                <span className="sv-provider-list__name">{p.name}</span>
                <span className="sv-provider-list__meta">
                  {p.models.length} model{p.models.length === 1 ? '' : 's'}
                  {needsKey ? ' · no key' : ''}
                  {insecure ? ' · key sent over http' : ''}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <span className="sv-field__help">No provider yet.</span>
      )}
      <div className="sv-approval__actions">
        <Button icon="server-environment" onClick={() => post({ type: 'setView', view: 'providers' })}>
          Manage providers
        </Button>
        {app.providers.length ? (
          <Button variant="ghost" icon="refresh" onClick={() => post({ type: 'discoverModels' })}>
            Discover models
          </Button>
        ) : null}
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------------------------- approvals

function ApprovalModeChoice() {
  const { app } = useStore();
  const disabled = !app.workspace.trusted;
  return (
    <fieldset className="sv-field sv-options" disabled={disabled}>
      <legend>Approvals in this window</legend>
      {APPROVAL_OPTIONS.map((o) => (
        <label key={o.value} className="sv-option" data-tone={o.tone} data-checked={app.approvalMode === o.value}>
          <input
            type="radio"
            name="sv-approval-mode"
            value={o.value}
            checked={app.approvalMode === o.value}
            onChange={() => post({ type: 'setApprovalMode', mode: o.value })}
          />
          <Icon name={o.icon} className="sv-option__icon" />
          <span className="sv-option__text">
            <span className="sv-option__label">{o.label}</span>
            <span className="sv-option__detail">{o.detail}</span>
          </span>
        </label>
      ))}
      <span className="sv-field__help">
        {disabled
          ? 'Trust this workspace to let Sovran make changes.'
          : 'Plan mode is always read-only. Change this from the composer at any time, or with Alt+A.'}
      </span>
    </fieldset>
  );
}

function DefaultApprovalMode() {
  const { app } = useStore();
  const id = useId();
  return (
    <div className="sv-field">
      <label htmlFor={id}>When a window opens, start in</label>
      <select id={id} value={app.settings.defaultApprovalMode} onChange={(e) => update({ key: 'approvals.mode', value: e.target.value as ApprovalMode })}>
        {APPROVAL_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {app.settings.defaultApprovalMode === 'auto' ? (
        <span className="sv-field__note">Every new window starts without approvals. Prefer Ask and switch to Auto per task.</span>
      ) : null}
    </div>
  );
}

/** Editable list of strings (allowed commands, protected paths). Writes the whole list on every change. */
function ListEditor({
  label,
  help,
  items,
  placeholder,
  validate,
  onChange,
  onReset,
  mono = true,
}: {
  label: string;
  help: string;
  items: string[];
  placeholder: string;
  validate?: (value: string) => string;
  onChange: (next: string[]) => void;
  onReset?: () => void;
  mono?: boolean;
}) {
  const [draft, setDraft] = useState('');
  const id = useId();
  const value = draft.trim();
  const error = value ? (validate?.(value) ?? '') || (items.includes(value) ? 'Already in the list.' : '') : '';
  const add = () => {
    if (!value || error) return;
    onChange([...items, value]);
    setDraft('');
  };
  return (
    <div className="sv-field">
      <label htmlFor={id}>{label}</label>
      {items.length ? (
        <ul className="sv-list-editor" aria-label={`${label}: current entries`}>
          {items.map((item) => (
            <li key={item}>
              <code className={mono ? undefined : 'sv-plain'}>{item}</code>
              <IconButton icon="close" label={`Remove ${item}`} onClick={() => onChange(items.filter((x) => x !== item))} />
            </li>
          ))}
        </ul>
      ) : (
        <span className="sv-field__help">Nothing here yet.</span>
      )}
      <div className="sv-inline">
        <input
          id={id}
          value={draft}
          placeholder={placeholder}
          spellCheck={false}
          aria-invalid={!!error}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
        />
        <Button onClick={add} disabled={!value || !!error}>
          Add
        </Button>
      </div>
      <span className={error ? 'sv-field__error' : 'sv-field__help'}>{error || help}</span>
      {onReset ? (
        <button type="button" className="sv-link" onClick={onReset}>
          Restore defaults
        </button>
      ) : null}
    </div>
  );
}

// --------------------------------------------------------------------------------------------- numbers

function NumberSetting({
  label,
  help,
  value,
  min,
  max,
  onCommit,
  note,
}: {
  label: string;
  help: string;
  value: number;
  min: number;
  max: number;
  onCommit: (value: number) => void;
  note?: string;
}) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? String(value);
  const parsed = Number(shown);
  const invalid = draft !== null && (!/^\d+$/.test(shown) || parsed < min || parsed > max);
  const commit = () => {
    if (draft === null) return;
    if (!invalid && parsed !== value) onCommit(parsed);
    setDraft(null);
  };
  return (
    <div className="sv-field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className="sv-number"
        inputMode="numeric"
        value={shown}
        aria-invalid={invalid}
        onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ''))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') setDraft(null);
        }}
      />
      <span className={invalid ? 'sv-field__error' : 'sv-field__help'}>{invalid ? `Enter a number from ${min} to ${max}.` : help}</span>
      {note ? <span className="sv-field__note">{note}</span> : null}
    </div>
  );
}

// --------------------------------------------------------------------------------------------- view

export function SettingsView() {
  const { app } = useStore();
  const s = app.settings;
  const note = (key: SettingKey) => (s.overriddenByWorkspace.includes(key) ? OVERRIDE_NOTE : undefined);
  type BooleanSetting = Extract<SettingUpdate, { value: boolean }>;
  // Safe by construction: every key in BooleanSetting takes a boolean value.
  const toggle = (key: BooleanSetting['key']) => (value: boolean) => update({ key, value } as BooleanSetting);

  return (
    <div className="sv-panel sv-settings">
      <div className="sv-panel__head">
        <IconButton icon="arrow-left" label="Back to chat" onClick={() => post({ type: 'setView', view: 'chat' })} />
        <h2>Settings</h2>
        <Button variant="ghost" icon="json" title="Open all Sovran settings in the VS Code settings editor" onClick={() => post({ type: 'openSettings' })}>
          All settings
        </Button>
      </div>
      <nav className="sv-settings__nav" aria-label="Settings sections">
        {[
          ['models', 'Models'],
          ['approvals', 'Approvals'],
          ['agent', 'Agent'],
          ['context', 'Context'],
          ['data', 'Data'],
        ].map(([id, label]) => (
          <a
            key={id}
            href={`#${id}`}
            onClick={(e) => {
              e.preventDefault();
              document.getElementById(id!)?.scrollIntoView({ block: 'start' });
            }}
          >
            {label}
          </a>
        ))}
      </nav>

      <Section id="models" icon="server-process" title="Models" description="Which model answers in each mode, and where it runs.">
        <ModelSelect role="act" />
        <ModelSelect role="plan" />
        <ProvidersSummary />
      </Section>

      <Section id="approvals" icon="shield" title="Approvals & safety" description="How much Act mode may do without asking you first.">
        <ApprovalModeChoice />
        <DefaultApprovalMode />
        <ListEditor
          label="Allowed commands"
          help='Commands that start with an entry run without asking, e.g. "npm test". Risky commands still ask.'
          items={s.allowedCommands}
          placeholder="npm test"
          validate={(v) => (hasShellMetacharacters(v) ? 'Shell operators such as ; | & $ > < cannot be allowed.' : '')}
          onChange={(value) => update({ key: 'approvals.allowedCommands', value })}
        />
        <ListEditor
          label="Protected files"
          help="Glob patterns Sovran never reads, changes or names in a command without asking, in every mode."
          items={s.protectedPaths}
          placeholder="**/secrets/**"
          onChange={(value) => update({ key: 'security.protectedPaths', value })}
          onReset={
            s.defaultProtectedPaths.length && s.defaultProtectedPaths.join() !== s.protectedPaths.join()
              ? () => update({ key: 'security.protectedPaths', value: s.defaultProtectedPaths })
              : undefined
          }
        />
      </Section>

      <Section id="agent" icon="hubot" title="Agent" description="Limits and visibility for each request.">
        <NumberSetting
          label="Maximum steps per request"
          help="Model round-trips before Sovran stops and asks you to continue."
          value={s.maxIterations}
          min={1}
          max={200}
          note={note('agent.maxIterations')}
          onCommit={(value) => update({ key: 'agent.maxIterations', value })}
        />
        <NumberSetting
          label="Command timeout (seconds)"
          help="Commands that run longer are stopped."
          value={s.terminalTimeoutSeconds}
          min={5}
          max={3600}
          onCommit={(value) => update({ key: 'terminal.timeoutSeconds', value })}
        />
        <CheckRow
          checked={s.mirrorToTerminal}
          onChange={toggle('terminal.mirrorToTerminal')}
          label="Show commands in a terminal"
          description="Mirrors every command and its output to a Sovran terminal."
        />
        <CheckRow
          checked={s.openDiffOnProposal}
          onChange={toggle('diff.openOnProposal')}
          label="Open the diff editor for proposed changes"
          description="Opens VS Code's diff editor when a change waits for your approval."
          note={note('diff.openOnProposal')}
        />
      </Section>

      <Section id="context" icon="book" title="Context" description="What Sovran sends to the model with your messages.">
        <CheckRow
          checked={s.includeActiveEditor}
          onChange={toggle('context.includeActiveEditor')}
          label="Attach the active file"
          description="Files outside the workspace and protected files are never attached."
          note={note('context.includeActiveEditor')}
        />
        <CheckRow
          checked={s.autoCompact}
          onChange={toggle('context.autoCompact')}
          label="Summarize older messages when the context is full"
          note={note('context.autoCompact')}
        />
        <CheckRow
          checked={s.projectInstructions}
          onChange={toggle('context.projectInstructions')}
          label="Follow AGENTS.md project instructions"
          description="Only in trusted workspaces."
          note={note('context.projectInstructions')}
        />
        <NumberSetting
          label="Maximum characters per tool result"
          help="Longer file contents and command output are shortened in the middle."
          value={s.maxToolResultChars}
          min={2000}
          max={200_000}
          note={note('context.maxToolResultChars')}
          onCommit={(value) => update({ key: 'context.maxToolResultChars', value })}
        />
      </Section>

      <Section id="data" icon="lock" title="Data & privacy" description="Sovran has no server and no telemetry. Requests go only to the endpoints you configure.">
        <CheckRow
          checked={s.persistSessions}
          onChange={toggle('sessions.persist')}
          label="Save chats in this workspace"
          description="Stored as plain text in VS Code's workspace storage. Applies after a window reload."
          note={note('sessions.persist')}
        />
        <div className="sv-approval__actions">
          <Button icon="output" onClick={() => post({ type: 'showLogs' })}>
            Show logs
          </Button>
          <Button variant="ghost" icon="key" onClick={() => post({ type: 'setView', view: 'providers' })}>
            API keys
          </Button>
        </div>
      </Section>
    </div>
  );
}
