import { beforeEach, describe, expect, it, vi } from 'vitest';

const config = vi.hoisted(() => ({ user: {} as Record<string, unknown>, workspace: {} as Record<string, unknown> }));

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({
      inspect: (key: string) => ({ globalValue: config.user[key], workspaceValue: config.workspace[key] }),
      get: (_key: string, fallback: unknown) => fallback,
    }),
  },
}));

const { readSettings, readSettingsView } = await import('../../src/extension/config');

beforeEach(() => { config.user = {}; config.workspace = {}; });

describe('native tool settings', () => {
  it('preserves default tool behavior and ignores workspace overrides', () => {
    config.workspace = { 'tools.disabled': ['read_file'], 'tools.forceAsk': ['execute_terminal'] };
    expect(readSettings().agent.policy).toMatchObject({ disabledTools: [], forceAskTools: [] });
  });

  it('validates and projects only user values into Settings', () => {
    config.user = { 'tools.disabled': ['read_file', 'read_file', 42, '../escape'], 'tools.forceAsk': ['execute_terminal'] };
    config.workspace = { 'tools.disabled': [], 'tools.forceAsk': [] };
    expect(readSettingsView()).toMatchObject({ disabledTools: ['read_file'], forceAskTools: ['execute_terminal'], overriddenByWorkspace: [] });
  });

  it('handles malformed non-array values without crashing', () => {
    config.user = { 'tools.disabled': false, 'tools.forceAsk': 'read_file' };
    expect(readSettings().agent.policy).toMatchObject({ disabledTools: [], forceAskTools: [] });
  });
});
