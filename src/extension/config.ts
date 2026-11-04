import * as vscode from 'vscode';
import { z } from 'zod';
import type { AgentSettings } from '../core/agent/agentRunner';
import type { ApprovalMode } from '../core/permissions/policy';
import type { Logger } from '../core/ports';
import type { ProviderConfig } from '../core/providers/types';
import type { SettingKey, SettingUpdate, SettingsView } from '../shared/protocol';

const SECTION = 'sovran';

/**
 * Security-relevant settings are read from the *user* (global) scope only. A cloned repository can
 * ship `.vscode/settings.json`; it must not be able to redirect credentials or auto-approve actions.
 */
function userSetting<T>(key: string, fallback: T): T {
  const inspected = vscode.workspace.getConfiguration(SECTION).inspect<T>(key);
  return inspected?.globalValue ?? inspected?.defaultValue ?? fallback;
}

function setting<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration(SECTION).get<T>(key, fallback);
}

const modelSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  toolMode: z.enum(['auto', 'native', 'prompted', 'none']).optional(),
});

const providerSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,47}$/),
  name: z.string().min(1),
  baseUrl: z.string().url(),
  auth: z.object({ type: z.enum(['none', 'bearer', 'header']), headerName: z.string().optional() }).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  timeoutSeconds: z.number().min(5).max(1800).optional(),
  models: z.array(modelSchema).optional(),
});

export function readProviders(logger?: Logger): ProviderConfig[] {
  const raw = userSetting<unknown[]>('providers', []);
  const seen = new Set<string>();
  const out: ProviderConfig[] = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    const parsed = providerSchema.safeParse(entry);
    if (!parsed.success) {
      logger?.warn(`Ignoring invalid provider in settings: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
      continue;
    }
    if (seen.has(parsed.data.id)) continue;
    seen.add(parsed.data.id);
    out.push(parsed.data);
  }
  return out;
}

export async function writeProviders(providers: ProviderConfig[]): Promise<void> {
  await vscode.workspace.getConfiguration(SECTION).update('providers', providers, vscode.ConfigurationTarget.Global);
}

export function readDefaultModel(): string {
  return userSetting('defaultModel', '');
}

export async function writeDefaultModel(value: string): Promise<void> {
  await vscode.workspace.getConfiguration(SECTION).update('defaultModel', value, vscode.ConfigurationTarget.Global);
}

export function readPlanModel(): string {
  return userSetting('planModel', '');
}

export async function writePlanModel(value: string): Promise<void> {
  await vscode.workspace.getConfiguration(SECTION).update('planModel', value, vscode.ConfigurationTarget.Global);
}

/** Whether `~/.sovran/config.yaml` is used (and kept in sync with Settings) when it exists. */
export function readConfigFileEnabled(): boolean {
  return userSetting('configFile.enabled', true);
}

export async function writeConfigFileEnabled(value: boolean): Promise<void> {
  await vscode.workspace.getConfiguration(SECTION).update('configFile.enabled', value ? undefined : false, vscode.ConfigurationTarget.Global);
}

/** The model that names chats, as providerId/modelId. Empty means the chat's own model. */
export function readTitleModel(): string {
  return userSetting('sessions.titleModel', '');
}

export async function writeTitleModel(value: string): Promise<void> {
  await vscode.workspace.getConfiguration(SECTION).update('sessions.titleModel', value || undefined, vscode.ConfigurationTarget.Global);
}

/**
 * The approval mode a window starts in. `sovran.approvals.mode` replaces the older `sovran.approvals.fileEdits`
 * (`auto` there meant "apply edits without asking", which is now the `edits` mode); the old key is still honoured
 * when the new one has not been set.
 */
export function readDefaultApprovalMode(): ApprovalMode {
  const inspected = vscode.workspace.getConfiguration(SECTION).inspect<string>('approvals.mode');
  const value = inspected?.globalValue;
  if (value === 'ask' || value === 'edits' || value === 'auto') return value;
  return userSetting<string>('approvals.fileEdits', 'ask') === 'auto' ? 'edits' : 'ask';
}

export interface HostSettings {
  agent: AgentSettings;
  includeActiveEditor: boolean;
  projectInstructions: boolean;
  persistSessions: boolean;
  openDiffOnProposal: boolean;
  mirrorToTerminal: boolean;
  autoCompact: boolean;
  /** Name new chats with the model (an extra short request) instead of the first words of the first message. */
  generateTitles: boolean;
}

export function readSettings(): HostSettings {
  const protectedPaths = userSetting<string[]>('security.protectedPaths', []).filter((p) => typeof p === 'string');
  return {
    agent: {
      maxIterations: Math.min(200, Math.max(1, setting('agent.maxIterations', 25))),
      policy: {
        approvalMode: readDefaultApprovalMode(),
        allowedCommands: userSetting<string[]>('approvals.allowedCommands', []).filter((c) => typeof c === 'string'),
        protectedPaths,
      },
      tools: {
        terminalTimeoutMs: Math.max(5, userSetting('terminal.timeoutSeconds', 120)) * 1000,
        maxToolResultChars: Math.min(200_000, Math.max(2000, setting('context.maxToolResultChars', 20_000))),
        protectedPaths,
      },
      defaultContextWindow: 32_768,
      defaultMaxOutputTokens: 4096,
    },
    includeActiveEditor: setting('context.includeActiveEditor', true),
    projectInstructions: setting('context.projectInstructions', true),
    persistSessions: setting('sessions.persist', true),
    openDiffOnProposal: setting('diff.openOnProposal', true),
    // Command visibility is a safety property: a workspace must not be able to hide the terminal mirror.
    mirrorToTerminal: userSetting('terminal.mirrorToTerminal', true),
    autoCompact: setting('context.autoCompact', true),
    // User scope only: it decides whether the first message goes out in an extra request.
    generateTitles: userSetting('sessions.generateTitles', true),
  };
}

/** Keys that may be overridden per workspace; the others are user-scope only and ignore workspace values. */
const WORKSPACE_OVERRIDABLE: readonly SettingKey[] = [
  'agent.maxIterations',
  'diff.openOnProposal',
  'context.includeActiveEditor',
  'context.autoCompact',
  'context.projectInstructions',
  'context.maxToolResultChars',
  'sessions.persist',
];

/** Snapshot for the Settings view. Values are the effective ones Sovran uses. */
export function readSettingsView(s: HostSettings = readSettings()): SettingsView {
  const config = vscode.workspace.getConfiguration(SECTION);
  const overridden = WORKSPACE_OVERRIDABLE.filter((key) => {
    const i = config.inspect(key);
    return i?.workspaceValue !== undefined || i?.workspaceFolderValue !== undefined;
  });
  return {
    defaultApprovalMode: s.agent.policy.approvalMode,
    allowedCommands: [...s.agent.policy.allowedCommands],
    protectedPaths: [...s.agent.policy.protectedPaths],
    defaultProtectedPaths: config.inspect<string[]>('security.protectedPaths')?.defaultValue ?? [],
    maxIterations: s.agent.maxIterations,
    terminalTimeoutSeconds: Math.round(s.agent.tools.terminalTimeoutMs / 1000),
    mirrorToTerminal: s.mirrorToTerminal,
    openDiffOnProposal: s.openDiffOnProposal,
    includeActiveEditor: s.includeActiveEditor,
    autoCompact: s.autoCompact,
    projectInstructions: s.projectInstructions,
    maxToolResultChars: s.agent.tools.maxToolResultChars,
    persistSessions: s.persistSessions,
    generateTitles: s.generateTitles,
    overriddenByWorkspace: overridden,
  };
}

/**
 * Writes one validated setting to the user (global) scope. A value equal to the default removes the user entry
 * instead, so settings.json stays minimal and future changes to the defaults (e.g. new protected paths) still apply.
 */
export async function writeSetting(update: SettingUpdate): Promise<void> {
  const config = vscode.workspace.getConfiguration(SECTION);
  const isDefault = JSON.stringify(config.inspect(update.key)?.defaultValue) === JSON.stringify(update.value);
  await config.update(update.key, isDefault ? undefined : update.value, vscode.ConfigurationTarget.Global);
  // The new key supersedes the legacy one; clear it so the two can never disagree.
  if (update.key === 'approvals.mode' && config.inspect('approvals.fileEdits')?.globalValue !== undefined) {
    await config.update('approvals.fileEdits', undefined, vscode.ConfigurationTarget.Global);
  }
}

export async function addAllowedCommand(entry: string): Promise<void> {
  const current = userSetting<string[]>('approvals.allowedCommands', []).filter((c) => typeof c === 'string');
  if (current.includes(entry)) return;
  await vscode.workspace.getConfiguration(SECTION).update('approvals.allowedCommands', [...current, entry], vscode.ConfigurationTarget.Global);
}

export const affectsSovran = (e: vscode.ConfigurationChangeEvent) => e.affectsConfiguration(SECTION);
