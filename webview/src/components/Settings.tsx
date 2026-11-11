import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { ApprovalMode, SelectedModel, SettingKey, SettingUpdate } from '../../../src/shared/protocol';
import { hasShellMetacharacters } from '../../../src/core/permissions/shell';
import { sendsKeyInsecurely } from '../../../src/shared/endpoints';
import { effectiveLimits, type LimitSource } from '../../../src/core/providers/limits';
import { APPROVAL_OPTIONS } from '../lib/approvals';
import { useStore } from '../state/store';
import { getUiState, post, setUiState } from '../vscode';
import { McpArea } from './McpSettings';
import { ChatToolGroups, NativeToolSettings } from './ToolSettings';
import { Button, CheckRow, Icon, IconButton } from './primitives';

const update = (setting: SettingUpdate) => post({ type: 'updateSetting', setting });
const ref = (s: SelectedModel | null) => (s ? `${s.providerId}\u0000${s.modelId}` : '');

// --------------------------------------------------------------------------------------------- areas

export type SettingsArea = 'models' | 'approvals' | 'agent' | 'mcp' | 'context' | 'data';

const AREAS: ReadonlyArray<{ id: SettingsArea; label: string; icon: string; description: string }> = [
  {
    id: 'models',
    label: 'Models',
    icon: 'server-process',
    description: 'Which model answers in each mode, where it runs and how chats are named.',
  },
  {
    id: 'approvals',
    label: 'Approvals',
    icon: 'shield',
    description: 'How much Act mode may do without asking you first.',
  },
  { id: 'agent', label: 'Agent', icon: 'hubot', description: 'Limits and visibility for each request.' },
  {
    id: 'mcp',
    label: 'Tools',
    icon: 'mcp',
    description:
      'Choose tools for this chat, set built-in tool permissions and connect optional integrations.',
  },
  {
    id: 'context',
    label: 'Context',
    icon: 'book',
    description: 'What Sovran sends to the model with your messages.',
  },
  {
    id: 'data',
    label: 'Data',
    icon: 'lock',
    description:
      'Sovran has no server and no telemetry. Requests go to configured endpoints and public web URLs you approve. Read web content can be sent to your model and saved in chat history.',
  },
];

const isArea = (v: unknown): v is SettingsArea => AREAS.some((a) => a.id === v);

/**
 * The areas as tabs that stay on screen. Follows the WAI-ARIA tabs pattern: one tab stop for the whole list
 * (roving tabindex), arrows and Home/End move between areas, and the selected area is announced as selected.
 */
function AreaTabs({ current, onSelect }: { current: SettingsArea; onSelect: (area: SettingsArea) => void }) {
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = AREAS.findIndex((a) => a.id === current);
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: AREAS.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    const j = (next + AREAS.length) % AREAS.length;
    onSelect(AREAS[j]!.id);
    tabs.current[j]?.focus();
  };
  return (
    <div className="sv-settings__tabs" role="tablist" aria-label="Settings areas" onKeyDown={onKeyDown}>
      {AREAS.map((a, i) => {
        const selected = a.id === current;
        return (
          <button
            key={a.id}
            ref={(el) => {
              tabs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`sv-tab-${a.id}`}
            className="sv-settings__tab"
            aria-selected={selected}
            aria-controls={`sv-area-${a.id}`}
            tabIndex={selected ? 0 : -1}
            title={a.label}
            onClick={() => onSelect(a.id)}
          >
            <Icon name={a.icon} />
            <span className="sv-settings__tab-label">{a.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function AreaPanel({ area, children }: { area: SettingsArea; children: ReactNode }) {
  const a = AREAS.find((x) => x.id === area)!;
  return (
    <section
      className="sv-settings__area"
      role="tabpanel"
      id={`sv-area-${area}`}
      aria-labelledby={`sv-tab-${area}`}
    >
      <p className="sv-settings__intro">{a.description}</p>
      <div className="sv-settings__body">{children}</div>
    </section>
  );
}

const OVERRIDE_NOTE = 'This workspace overrides this setting in its .vscode/settings.json.';

// --------------------------------------------------------------------------------------------- models

const MODEL_ROLE = {
  act: { label: 'Act model', help: 'Used for new chats and in Act mode.' },
  plan: {
    label: 'Plan model',
    help: 'Plan mode can use a larger reasoning model, while Act uses a fast coder.',
  },
  title: {
    label: 'Title model',
    help: 'A small, fast model is enough: the title is generated while the answer streams.',
  },
} as const;

function ModelSelect({ role }: { role: 'act' | 'plan' | 'title' }) {
  const { app } = useStore();
  const id = useId();
  const value = role === 'act' ? app.selected : role === 'plan' ? app.planModel : app.titleModel;
  const choices = app.providers.flatMap((p) => p.models.map((m) => ({ provider: p, model: m })));
  const onChange = (raw: string) => {
    const [providerId, modelId] = raw.split('\u0000');
    post(
      providerId && modelId ? { type: 'setModel', role, providerId, modelId } : { type: 'setModel', role },
    );
  };
  return (
    <div className="sv-field">
      <label htmlFor={id}>{MODEL_ROLE[role].label}</label>
      <select
        id={id}
        value={ref(value)}
        onChange={(e) => onChange(e.target.value)}
        disabled={!choices.length}
      >
        {role === 'plan' ? <option value="">Same as Act model</option> : null}
        {role === 'title' ? <option value="">Same as the chat's model</option> : null}
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
      <span className="sv-field__help">{MODEL_ROLE[role].help}</span>
      {role !== 'title' ? <ModelLimits selection={value ?? (role === 'plan' ? app.selected : null)} /> : null}
    </div>
  );
}

const SOURCE_LABEL: Record<LimitSource, string> = {
  model: 'set for this model',
  server: 'reported by the server',
  default: 'default, the server does not report it',
};

/** The limits a request with this model will use, and where each comes from. */
function ModelLimits({ selection }: { selection: SelectedModel | null }) {
  const { app } = useStore();
  const m =
    selection &&
    app.providers.find((p) => p.id === selection.providerId)?.models.find((x) => x.id === selection.modelId);
  if (!m) return null;
  const e = effectiveLimits(m, m.serverLimits);
  return (
    <span className="sv-field__help sv-tabular" data-testid="model-limits">
      Context {e.contextWindow.toLocaleString('en-US')} tokens ({SOURCE_LABEL[e.contextSource]}) ·{' '}
      {e.reserveTokens.toLocaleString('en-US')} kept for the reply (
      {e.reserveSource === 'model'
        ? 'set for this model'
        : e.reserveSource === 'server'
          ? "the server's limit"
          : 'default'}
      )
    </span>
  );
}

function ChatTitles() {
  const { app } = useStore();
  const on = app.settings.generateTitles;
  return (
    <div className="sv-subfield">
      <CheckRow
        checked={on}
        onChange={(value) => update({ key: 'sessions.generateTitles', value })}
        label="Name chats with the model"
        description="Sends the first message in one short extra request and uses the reply as the chat title. When off, the title is the first words of the message."
      />
      {on ? <ModelSelect role="title" /> : null}
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
                <span
                  className="sv-dot"
                  data-state={insecure || needsKey ? 'warn' : 'ok'}
                  aria-hidden="true"
                />
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

/** The second way to configure providers: a YAML file kept in sync with Settings, or ignored, or not there. */
function ConfigFileField() {
  const { app } = useStore();
  const f = app.configFile;
  const n = f.providers;
  const providers = `${n} provider${n === 1 ? '' : 's'}`;
  const status = {
    missing: 'Not created. Providers live in Settings only.',
    ok: `In sync with Settings · ${n ? providers : 'no providers yet'}`,
    error: n
      ? `Has problems · Settings keep the last valid version (${providers})`
      : 'Has problems · not applied',
    ignored: 'Ignored · Settings are used alone',
  }[f.state];
  const icon = { missing: 'file-code', ok: 'sync', error: 'error', ignored: 'circle-slash' }[f.state];
  const help = {
    missing:
      'Prefer text? Create the file: it starts with the providers you have in Settings, and from then on the two stay in sync. Save the file and Settings follow; change providers here and the file follows, keeping your comments.',
    ok: 'Save the file and Settings follow; change providers here and the file follows, keeping your comments. API keys stay in Secret Storage, never in the file.',
    error:
      'Fix the problems and save: the file then wins. Changes made here meanwhile are kept in Settings only.',
    ignored:
      'Use it again to sync once more: providers missing on either side are added, and where both define one, Settings win.',
  }[f.state];
  return (
    <div className="sv-field">
      <span className="sv-field__label">Configuration file</span>
      <div className="sv-config-file" data-state={f.state}>
        <Icon name={icon} />
        <div className="sv-config-file__text">
          <code>{f.path}</code>
          <span role="status">{status}</span>
        </div>
      </div>
      {f.state === 'error' && f.problems.length ? (
        <ul className="sv-config-file__problems" aria-label="Problems in the configuration file">
          {f.problems.map((p, i) => (
            <li key={i}>
              <span className="sv-tabular">Line {p.line}</span> {p.message}
            </li>
          ))}
        </ul>
      ) : null}
      <span className="sv-field__help">{help}</span>
      <div className="sv-approval__actions">
        {f.state === 'ignored' ? (
          <Button icon="sync" onClick={() => post({ type: 'useConfigFile' })}>
            Use config.yaml again
          </Button>
        ) : (
          <Button icon="file-code" onClick={() => post({ type: 'openConfigFile' })}>
            {f.state === 'missing' ? 'Create config.yaml' : 'Open config.yaml'}
          </Button>
        )}
        {f.state === 'ok' || f.state === 'error' ? (
          <>
            <Button variant="ghost" icon="refresh" onClick={() => post({ type: 'reloadConfigFile' })}>
              Reload
            </Button>
            <Button variant="ghost" icon="circle-slash" onClick={() => post({ type: 'stopConfigFile' })}>
              Stop using config.yaml…
            </Button>
          </>
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
        <label
          key={o.value}
          className="sv-option"
          data-tone={o.tone}
          data-checked={app.approvalMode === o.value}
        >
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
      <select
        id={id}
        value={app.settings.defaultApprovalMode}
        onChange={(e) => update({ key: 'approvals.mode', value: e.target.value as ApprovalMode })}
      >
        {APPROVAL_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {app.settings.defaultApprovalMode === 'auto' ? (
        <span className="sv-field__note">
          Every new window starts without approvals. Prefer Ask and switch to Auto per task.
        </span>
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
  const error = value
    ? (validate?.(value) ?? '') || (items.includes(value) ? 'Already in the list.' : '')
    : '';
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
              <IconButton
                icon="close"
                label={`Remove ${item}`}
                onClick={() => onChange(items.filter((x) => x !== item))}
              />
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
      <span className={invalid ? 'sv-field__error' : 'sv-field__help'}>
        {invalid ? `Enter a number from ${min} to ${max}.` : help}
      </span>
      {note ? <span className="sv-field__note">{note}</span> : null}
    </div>
  );
}

// --------------------------------------------------------------------------------------------- view

export function SettingsView() {
  const { app } = useStore();
  const s = app.settings;
  const [area, setArea] = useState<SettingsArea>(() => {
    const saved = getUiState().settingsArea;
    return isArea(saved) ? saved : 'models';
  });
  const select = (next: SettingsArea) => {
    setArea(next);
    // Coming back to Settings opens the same area.
    setUiState({ settingsArea: next });
  };
  const note = (key: SettingKey) => (s.overriddenByWorkspace.includes(key) ? OVERRIDE_NOTE : undefined);
  type BooleanSetting = Extract<SettingUpdate, { value: boolean }>;
  // Safe by construction: every key in BooleanSetting takes a boolean value.
  const toggle = (key: BooleanSetting['key']) => (value: boolean) => update({ key, value } as BooleanSetting);

  return (
    <div className="sv-panel sv-settings">
      <div className="sv-settings__top">
        <div className="sv-panel__head">
          <IconButton
            icon="arrow-left"
            label="Back to chat"
            onClick={() => post({ type: 'setView', view: 'chat' })}
          />
          <h2>Settings</h2>
          <Button
            variant="ghost"
            icon="json"
            title="Open all Sovran settings in the VS Code settings editor"
            onClick={() => post({ type: 'openSettings' })}
          >
            All settings
          </Button>
        </div>
        <AreaTabs current={area} onSelect={select} />
      </div>

      {area === 'models' ? (
        <AreaPanel area="models">
          <ModelSelect role="act" />
          <ModelSelect role="plan" />
          <ChatTitles />
          <ProvidersSummary />
          <ConfigFileField />
        </AreaPanel>
      ) : null}

      {area === 'approvals' ? (
        <AreaPanel area="approvals">
          <ApprovalModeChoice />
          <DefaultApprovalMode />
          <ListEditor
            label="Allowed commands"
            help='Commands that start with an entry run without asking, e.g. "npm test". Risky commands still ask.'
            items={s.allowedCommands}
            placeholder="npm test"
            validate={(v) =>
              hasShellMetacharacters(v) ? 'Shell operators such as ; | & $ > < cannot be allowed.' : ''
            }
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
        </AreaPanel>
      ) : null}

      {area === 'agent' ? (
        <AreaPanel area="agent">
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
        </AreaPanel>
      ) : null}

      {area === 'mcp' ? (
        <AreaPanel area="mcp">
          <ChatToolGroups />
          <NativeToolSettings />
          <details>
            <summary>Advanced native overrides</summary>
            <ListEditor
              label="Disabled native tools"
              help="Tool names excluded from requests and blocked during execution, including pending approvals."
              items={s.disabledTools}
              placeholder="execute_terminal"
              validate={(v) =>
                /^[a-zA-Z0-9_-]{1,64}$/.test(v)
                  ? ''
                  : 'Use a tool name with letters, digits, underscores or hyphens.'
              }
              onChange={(value) => update({ key: 'tools.disabled', value })}
            />
            <ListEditor
              label="Always review native tools"
              help="These native tools ask before running, including reads and tools in Auto mode. Integration permissions are set below."
              items={s.forceAskTools}
              placeholder="read_file"
              validate={(v) =>
                /^[a-zA-Z0-9_-]{1,64}$/.test(v)
                  ? ''
                  : 'Use a tool name with letters, digits, underscores or hyphens.'
              }
              onChange={(value) => update({ key: 'tools.forceAsk', value })}
            />
          </details>
          <McpArea />
        </AreaPanel>
      ) : null}

      {area === 'context' ? (
        <AreaPanel area="context">
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
        </AreaPanel>
      ) : null}

      {area === 'data' ? (
        <AreaPanel area="data">
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
        </AreaPanel>
      ) : null}
    </div>
  );
}
