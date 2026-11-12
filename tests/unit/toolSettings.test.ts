import { beforeEach, describe, expect, it, vi } from 'vitest';

const config = vi.hoisted(() => ({
  user: {} as Record<string, unknown>,
  workspace: {} as Record<string, unknown>,
}));

vi.mock('vscode', () => ({
  ConfigurationTarget: { Global: 1 },
  workspace: {
    getConfiguration: () => ({
      inspect: (key: string) => ({ globalValue: config.user[key], workspaceValue: config.workspace[key] }),
      get: (_key: string, fallback: unknown) => fallback,
      update: async (key: string, value: unknown, target: number) => {
        expect(target).toBe(1);
        await Promise.resolve();
        config.user[key] = value;
      },
    }),
  },
}));

const { readSettings, readSettingsView, writeNativeToolOverride, writeSetting } =
  await import('../../src/extension/config');

beforeEach(() => {
  config.user = {};
  config.workspace = {};
});

describe('native tool settings', () => {
  it('preserves default tool behavior and ignores workspace overrides', () => {
    config.workspace = { 'tools.disabled': ['read_file'], 'tools.forceAsk': ['execute_terminal'] };
    expect(readSettings().agent.policy).toMatchObject({ disabledTools: [], forceAskTools: [] });
  });

  it('validates and projects only user values into Settings', () => {
    config.user = {
      'tools.disabled': ['read_file', 'read_file', 42, '../escape'],
      'tools.forceAsk': ['execute_terminal'],
    };
    config.workspace = { 'tools.disabled': [], 'tools.forceAsk': [] };
    expect(readSettingsView()).toMatchObject({
      disabledTools: ['read_file'],
      forceAskTools: ['execute_terminal'],
      overriddenByWorkspace: [],
    });
  });

  it('handles malformed non-array values without crashing', () => {
    config.user = { 'tools.disabled': false, 'tools.forceAsk': 'read_file' };
    expect(readSettings().agent.policy).toMatchObject({ disabledTools: [], forceAskTools: [] });
  });

  it('applies rapid tool edits to the latest user list and preserves independent ask overrides', async () => {
    config.user = { 'tools.disabled': ['old_tool'], 'tools.forceAsk': ['read_file'] };
    config.workspace = { 'tools.disabled': ['workspace_tool'] };
    await Promise.all([
      writeNativeToolOverride('tools.disabled', 'read_file', true),
      writeNativeToolOverride('tools.disabled', 'execute_terminal', true),
      writeNativeToolOverride('tools.disabled', 'read_file', false),
    ]);
    expect(readSettingsView()).toMatchObject({
      disabledTools: ['old_tool', 'execute_terminal'],
      forceAskTools: ['read_file'],
    });
  });

  it('orders legacy list writes with name-based edits and keeps the queue usable after an error', async () => {
    const names = Array.from({ length: 200 }, (_, index) => `tool_${index}`);
    const results = await Promise.allSettled([
      writeSetting({ key: 'tools.disabled', value: names }),
      writeNativeToolOverride('tools.disabled', 'extra', true),
      writeNativeToolOverride('tools.disabled', 'tool_0', false),
    ]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect(readSettingsView().disabledTools).toEqual(names.slice(1));
  });
});
