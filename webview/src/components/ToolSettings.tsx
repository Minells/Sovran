import { useEffect, useId, useRef } from 'react';
import { TOOL_GROUP_LABELS } from '../../../src/core/tools/groups';
import type { AppState, NativeToolSetting, NativeToolView } from '../../../src/shared/protocol';
import { useStore } from '../state/store';
import { post } from '../vscode';
import { CheckRow } from './primitives';
import { SettingsDisclosure } from './SettingsDisclosure';

export function setNativeToolOverride(key: NativeToolSetting, name: string, included: boolean) {
  post({ type: 'setNativeToolOverride', key, name, included });
}

function chatToolSummary(app: AppState) {
  const groups = app.toolGroups ?? [];
  const selected = groups.filter((group) => group.selected);
  const available = selected.reduce((sum, group) => sum + group.availableTools, 0);
  const excluded = groups.length - selected.length;
  // With on-demand loading, what each request carries now; the rest loads when the chat needs it.
  const tokens = selected.reduce((sum, group) => sum + (group.sentTokens ?? group.definitionTokens), 0);
  const deferred = selected.reduce(
    (sum, group) => sum + (group.sentTokens === undefined ? 0 : group.definitionTokens - group.sentTokens),
    0,
  );
  const mode = app.mode === 'plan' ? 'Plan' : 'Act';
  const status = !app.session
    ? 'No active chat'
    : app.toolAvailability === 'no-model'
      ? 'Choose a model to use tools'
      : app.toolAvailability === 'model-disabled'
        ? 'Tools are off for this model'
        : !app.toolGroups
          ? 'Availability unknown'
          : available
            ? `${available} available in ${mode}`
            : 'No tools available for this chat';
  return { status, excluded, tokens, deferred };
}

export function ChatToolMenu() {
  const ref = useRef<HTMLDetailsElement>(null);
  const {
    state: { app },
  } = useStore();
  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) ref.current.open = false;
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  if (!app?.session || !app.toolGroups) return null;
  return (
    <details
      ref={ref}
      className="sv-chat-tools"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && ref.current?.open) {
          event.preventDefault();
          event.stopPropagation();
          ref.current.open = false;
          ref.current.querySelector('summary')?.focus();
        }
      }}
    >
      <summary title="Choose tools for this chat">Tools</summary>
      <div className="sv-chat-tools__menu">
        <ChatToolGroups app={app} />
      </div>
    </details>
  );
}

export function ChatToolSettings({ app }: { app: AppState }) {
  const { status, excluded } = chatToolSummary(app);
  return (
    <SettingsDisclosure
      title="Tools for this chat"
      status={status}
      description={excluded ? `${excluded} group${excluded === 1 ? '' : 's'} excluded` : undefined}
    >
      <ChatToolGroups app={app} inSettings />
    </SettingsDisclosure>
  );
}

function ChatToolGroups({ app, inSettings = false }: { app: AppState; inSettings?: boolean }) {
  const sessionId = app.session?.id;
  if (!sessionId || !app.toolGroups?.length) {
    return <p className="sv-field__help">Tool groups appear here when available for the chat.</p>;
  }
  const { status, tokens, deferred } = chatToolSummary(app);
  const servers = new Map(app.mcp.servers.map((server) => [`mcp:${server.id}`, server]));
  const groups = app.toolGroups;
  const renderGroup = (group: NonNullable<AppState['toolGroups']>[number]) => {
    const server = servers.get(group.id);
    let description = `${group.availableTools} available`;
    if (group.definitionTokens && group.selected && group.loading === 'on-demand') {
      const sent = group.sentTokens ?? 0;
      const later = (group.definitionTokens - sent).toLocaleString();
      description += sent
        ? ` · ~${sent.toLocaleString()} tokens, ~${later} more when needed`
        : ` · loads when needed, ~${later} tokens`;
    } else if (group.definitionTokens) {
      description += `${group.loading === 'loaded' && group.selected ? ' · loaded' : ''} · ~${group.definitionTokens.toLocaleString()} tokens${group.selected ? '' : ' when selected'}`;
    } else if (server) {
      if (!app.mcp.active) description = 'Unavailable in Restricted Mode';
      else if (server.status === 'starting') description = 'Connecting…';
      else if (server.status !== 'connected') description = 'Disconnected';
      else if (app.mode === 'plan') description = 'Available in Act mode';
    }
    return (
      <CheckRow
        key={group.id}
        label={group.label}
        checked={group.selected}
        description={description}
        onChange={(selected) => post({ type: 'setToolGroup', sessionId, group: group.id, selected })}
      />
    );
  };
  const builtIn = groups.filter((group) => !group.id.startsWith('mcp:'));
  const integrations = groups.filter((group) => group.id.startsWith('mcp:'));

  return (
    <fieldset className="sv-tool-groups">
      <legend className={inSettings ? 'sv-visually-hidden' : undefined}>Tools for this chat</legend>
      {!inSettings ? <p className="sv-field__help">{status}</p> : null}
      {tokens ? (
        <p className="sv-field__help sv-tabular">
          Estimated definition tokens per request: ~{tokens.toLocaleString()}
          {deferred ? ` · ~${deferred.toLocaleString()} more load when needed` : ''}
        </p>
      ) : null}
      {integrations.length && builtIn.length ? (
        <p className="sv-tool-groups__label">Built-in groups</p>
      ) : null}
      {builtIn.map(renderGroup)}
      {integrations.length ? <p className="sv-tool-groups__label">Integration groups</p> : null}
      {integrations.map(renderGroup)}
      <p className="sv-field__help">
        Applies to this chat. Global permissions still apply. Excluding a group blocks its pending calls.
      </p>
    </fieldset>
  );
}

export function NativeToolSettings({ app }: { app: AppState }) {
  const disabled = new Set(app.settings.disabledTools);
  const forceAsk = new Set(app.settings.forceAskTools);
  const groups = new Map<string, NativeToolView[]>();
  for (const tool of app.nativeTools ?? []) {
    const group = groups.get(tool.group);
    if (group) group.push(tool);
    else groups.set(tool.group, [tool]);
  }
  if (!groups.size) return null;
  return (
    <>
      <p className="sv-field__help">Always ask requires approval even for reads and in Auto mode.</p>
      {[...groups].map(([group, tools]) => {
        const overrides = tools.filter((tool) => disabled.has(tool.name) || forceAsk.has(tool.name)).length;
        return (
          <SettingsDisclosure
            key={group}
            title={TOOL_GROUP_LABELS[group] ?? group}
            status={overrides ? `${overrides} override${overrides === 1 ? '' : 's'}` : undefined}
          >
            {tools.map((tool) => (
              <NativeTool
                key={tool.name}
                tool={tool}
                disabled={disabled.has(tool.name)}
                ask={forceAsk.has(tool.name)}
              />
            ))}
          </SettingsDisclosure>
        );
      })}
    </>
  );
}

function NativeTool({ tool, disabled, ask }: { tool: NativeToolView; disabled: boolean; ask: boolean }) {
  const id = useId();
  return (
    <div className="sv-native-tool" role="group" aria-labelledby={id}>
      <div className="sv-native-tool__title">
        <code id={id}>{tool.name}</code>
        <span className="sv-field__help">{tool.risk}</span>
      </div>
      <p className="sv-field__help">{tool.description}</p>
      <div className="sv-native-tool__controls">
        <CheckRow
          label="Enabled"
          checked={!disabled}
          onChange={(enabled) => setNativeToolOverride('tools.disabled', tool.name, !enabled)}
        />
        <CheckRow
          label="Always ask"
          checked={ask}
          onChange={(checked) => setNativeToolOverride('tools.forceAsk', tool.name, checked)}
        />
      </div>
      {tool.unavailable && !disabled ? <p className="sv-field__note">{tool.unavailable}</p> : null}
    </div>
  );
}
