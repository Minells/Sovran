import * as vscode from 'vscode';
import { z } from 'zod';
import type { AgentSettings } from '../core/agent/agentRunner';
import type { Logger } from '../core/ports';
import type { ProviderConfig } from '../core/providers/types';

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

export interface HostSettings {
  agent: AgentSettings;
  includeActiveEditor: boolean;
  projectInstructions: boolean;
  persistSessions: boolean;
  openDiffOnProposal: boolean;
  mirrorToTerminal: boolean;
  autoCompact: boolean;
}

export function readSettings(): HostSettings {
  const protectedPaths = userSetting<string[]>('security.protectedPaths', []);
  return {
    agent: {
      maxIterations: Math.min(200, Math.max(1, setting('agent.maxIterations', 25))),
      policy: {
        fileEdits: userSetting<'ask' | 'auto'>('approvals.fileEdits', 'ask') === 'auto' ? 'auto' : 'ask',
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
    mirrorToTerminal: setting('terminal.mirrorToTerminal', true),
    autoCompact: setting('context.autoCompact', true),
  };
}

export const affectsSovran = (e: vscode.ConfigurationChangeEvent) => e.affectsConfiguration(SECTION);
