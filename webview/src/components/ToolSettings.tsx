import { useEffect, useRef } from 'react';
import { TOOL_GROUP_LABELS } from '../../../src/core/tools/groups';
import type { SettingUpdate } from '../../../src/shared/protocol';
import { useStore } from '../state/store';
import { post } from '../vscode';
import { CheckRow } from './primitives';

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
  if (!app?.toolGroups) return null;
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
        <ChatToolGroups />
      </div>
    </details>
  );
}

export function ChatToolGroups() {
  const {
    state: { app },
  } = useStore();
  if (!app?.session || !app.toolGroups) return null;
  const selected = app.toolGroups.filter((group) => group.selected);
  const tokens = selected.reduce((sum, group) => sum + group.definitionTokens, 0);
  return (
    <fieldset className="sv-tool-groups">
      <legend>Tools for this chat</legend>
      <p className="sv-field__help">
        {selected.reduce((sum, group) => sum + group.availableTools, 0)} tools available · ~
        {tokens.toLocaleString()} definition tokens per request. Estimates depend on mode and connection.
        Changes also block pending calls.
      </p>
      {app.toolGroups.map((group) => (
        <CheckRow
          key={group.id}
          label={group.label}
          checked={group.selected}
          description={`${group.availableTools} available · ~${group.definitionTokens.toLocaleString()} tokens when selected`}
          onChange={(value) =>
            post({ type: 'setToolGroup', sessionId: app.session!.id, group: group.id, selected: value })
          }
        />
      ))}
      <p className="sv-field__help">
        Saved with this chat. Global tool permissions still apply. Selecting a group does not install or
        connect an integration.
      </p>
    </fieldset>
  );
}

export function NativeToolSettings() {
  const {
    state: { app },
  } = useStore();
  if (!app?.nativeTools) return null;
  const settings = app.settings;
  const change = (
    key: 'tools.disabled' | 'tools.forceAsk',
    current: string[],
    name: string,
    included: boolean,
  ) => {
    const setting: SettingUpdate = {
      key,
      value: included ? [...new Set([...current, name])] : current.filter((item) => item !== name),
    };
    post({ type: 'updateSetting', setting });
  };
  return (
    <section aria-label="Built-in tools">
      <h3>Built-in tools</h3>
      <p className="sv-field__help">
        Applies to every chat. Always review adds approval; the default keeps the existing approval rules for
        each tool.
      </p>
      {[...new Set(app.nativeTools.map((tool) => tool.group))].map((group) => (
        <details key={group} className="sv-native-tools">
          <summary>{TOOL_GROUP_LABELS[group] ?? group}</summary>
          {app
            .nativeTools!.filter((tool) => tool.group === group)
            .map((tool) => (
              <div className="sv-native-tool" key={tool.name}>
                <code>{tool.name}</code>
                <span className="sv-badge">{tool.risk}</span>
                <p className="sv-field__help">{tool.description}</p>
                <CheckRow
                  label={`Enable ${tool.name}`}
                  checked={!settings.disabledTools.includes(tool.name)}
                  onChange={(enabled) =>
                    change('tools.disabled', settings.disabledTools, tool.name, !enabled)
                  }
                />
                <CheckRow
                  label={`Always review ${tool.name}`}
                  checked={settings.forceAskTools.includes(tool.name)}
                  onChange={(ask) => change('tools.forceAsk', settings.forceAskTools, tool.name, ask)}
                />
                {tool.unavailable ? <p className="sv-field__help">{tool.unavailable}</p> : null}
              </div>
            ))}
        </details>
      ))}
    </section>
  );
}
