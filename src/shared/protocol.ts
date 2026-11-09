/**
 * Host ⇄ webview contract. The host is authoritative; the webview renders `AppState` and sends intents.
 * Every webview → host message is validated with `webviewMessageSchema` before it is handled.
 */
import { z } from 'zod';
import { hasShellMetacharacters } from '../core/permissions/shell';
import type { AgentMode, ApprovalMode } from '../core/permissions/policy';
import type { ToolMode } from '../core/providers/types';
import type { SessionMessage, SessionSummary } from '../core/sessions/model';
import type { DocumentFormat } from '../core/documents/types';
import { IMAGE_LIMITS, type ImageMime } from '../core/images/images';
import {
  MCP_ID_PATTERN,
  MCP_TIMEOUT_SECONDS,
  mcpAuthSchema,
  mcpEnvName,
  mcpHeaderName,
  mcpHttpUrl,
  transportProblems,
  type McpAuth,
  type McpToolPolicy,
  type McpTransportKind,
} from '../core/mcp/config';
import type { McpStatus } from '../core/mcp/status';
import type { GitApprovalDetail, McpToolHint } from '../core/ports';

export type { SessionMessage, SessionSummary, AgentMode, ApprovalMode, ToolMode, McpAuth, McpStatus, McpToolHint, McpToolPolicy, McpTransportKind };

export type View = 'chat' | 'history' | 'providers' | 'settings';

export interface ModelView {
  id: string;
  name?: string;
  /** Set by the user; empty means the server's value or the default. */
  contextWindow?: number;
  /** Set by the user: reserved for the reply and sent as max_tokens. */
  maxOutputTokens?: number;
  /** What the server reports for the model, when it does. */
  serverLimits?: { contextWindow?: number; maxOutputTokens?: number };
  toolMode: ToolMode;
  /** What Sovran learned at runtime (e.g. downgraded to prompted tools). */
  learnedToolMode?: 'native' | 'prompted';
}

export interface ProviderView {
  id: string;
  name: string;
  baseUrl: string;
  authType: 'none' | 'bearer' | 'header';
  headerName?: string;
  timeoutSeconds?: number;
  /** Whether a key is stored. The key itself never reaches the webview. */
  hasKey: boolean;
  models: ModelView[];
}

/** The optional config file (`~/.sovran/config.yaml`), kept in sync with Settings while it is used. */
export interface ConfigFileView {
  /** Where the file lives, for display (`~/.sovran/config.yaml`). */
  path: string;
  /**
   * `ok`: in sync with Settings. `error`: the file has problems and its last valid version stays in use.
   * `ignored`: the file exists but the user stopped using it (`sovran.configFile.enabled` is off).
   */
  state: 'missing' | 'ok' | 'error' | 'ignored';
  /** Providers in the file while it is in sync. */
  providers: number;
  /** The first problems, with one-based line numbers. The editor shows all of them. */
  problems: Array<{ line: number; message: string }>;
}

export interface SelectedModel {
  providerId: string;
  modelId: string;
}

export type ActivityPhase = 'thinking' | 'streaming' | 'awaiting_approval' | 'running' | 'compacting';

export interface RunView {
  sessionId: string;
  iteration: number;
  maxIterations: number;
  startedAt: number;
  activity: { phase: ActivityPhase; label: string; toolName?: string; callId?: string };
}

export type ApprovalDetailView =
  | GitApprovalDetail
  | { kind: 'web'; url: string }
  | { kind: 'edit'; path: string; isNew: boolean; diff: string; added: number; removed: number }
  /** `allowPrefix` is the suggested "always allow" entry, or null when this command can never be allow-listed. */
  | { kind: 'command'; command: string; cwd: string; warnings: string[]; allowPrefix: string | null }
  | { kind: 'read'; path: string; reason: string }
  | { kind: 'mcp'; server: string; tool: string; title?: string; arguments: string; hints: McpToolHint[] };

export interface ApprovalView {
  id: string;
  callId: string;
  toolName: string;
  title: string;
  detail: ApprovalDetailView;
  /** Why the policy asked (shown when the approval mode would otherwise have allowed the action). */
  reason?: string;
}

export interface AttachmentView {
  id: string;
  path: string;
  label: string;
  /** Picked from the computer with the system dialog: the file is outside the workspace. */
  external?: boolean;
  /** A document converted to Markdown for the model, and what Sovran found in it ("12 pages"). */
  format?: DocumentFormat;
  detail?: string;
  /** An image for a vision model (from the workspace, the computer or the clipboard). */
  image?: { mime: ImageMime; width?: number; height?: number; pasted?: boolean };
}

export interface FileSuggestionView {
  path: string;
  label: string;
  /** Why a file is suggested before anything is typed: it is the active editor, or open in a tab. */
  hint?: 'active' | 'open';
}

export interface DirectoryEntryView {
  name: string;
  /** Workspace-relative path with forward slashes (prefixed with the folder name in multi-root workspaces). */
  path: string;
  type: 'file' | 'directory';
  /** Matches `sovran.security.protectedPaths`: attaching it asks for confirmation first. */
  protected?: boolean;
}

export interface DirectoryListingView {
  /** Workspace-relative folder; '' is the workspace root (the list of folders in a multi-root workspace). */
  path: string;
  entries: DirectoryEntryView[];
  /** The folder has more entries than were sent. */
  truncated?: boolean;
  /** Why the folder could not be listed. */
  error?: string;
}

export interface EditorContextView {
  path: string;
  label: string;
  startLine?: number;
  endLine?: number;
  /** Set when the active file is never attached: it is outside the workspace or a protected path. */
  blocked?: 'outside' | 'protected';
}

export interface ComposerContextView {
  editor: EditorContextView | null;
  includeEditor: boolean;
  attachments: AttachmentView[];
}

export interface CurrentSessionView {
  id: string;
  title: string;
  messages: SessionMessage[];
}

export interface ContextUsageView {
  tokens: number;
  contextWindow: number;
  source: 'estimate' | 'server';
}

export interface CompactionView {
  summary: string;
  firstKeptId: string;
  summarizedCount: number;
}

export interface SlashCommandView {
  name: string;
  description: string;
  source: 'builtin' | 'workspace';
}

/** Where a webview runs: the Activity Bar view, or a chat opened as an editor tab. */
export type SurfaceKind = 'sidebar' | 'panel';

/** A chat that is open in an editor tab or has a run in progress, for the chat list. */
export interface LiveSessionView {
  id: string;
  /** Shown in an editor tab (opening it from the list focuses that tab). */
  inEditor: boolean;
  running: boolean;
  /** Waiting for the user to approve or reject an action. */
  needsApproval: boolean;
}

/** User-scope settings edited from the Settings view. Effective values; see `overriddenByWorkspace`. */
export interface SettingsView {
  /** Approval mode a new window starts in (`sovran.approvals.mode`). */
  defaultApprovalMode: ApprovalMode;
  allowedCommands: string[];
  disabledTools: string[];
  forceAskTools: string[];
  protectedPaths: string[];
  defaultProtectedPaths: string[];
  maxIterations: number;
  terminalTimeoutSeconds: number;
  mirrorToTerminal: boolean;
  openDiffOnProposal: boolean;
  includeActiveEditor: boolean;
  autoCompact: boolean;
  projectInstructions: boolean;
  maxToolResultChars: number;
  persistSessions: boolean;
  /** Ask the model for a short chat title instead of using the first words of the first message. */
  generateTitles: boolean;
  /** Keys whose effective value comes from workspace settings, so a change here may not apply in this workspace. */
  overriddenByWorkspace: SettingKey[];
}

export interface McpToolView {
  name: string;
  title?: string;
  description?: string;
  /** The name the model calls it by (and the transcript shows). */
  modelName: string;
  policy: McpToolPolicy;
  hints: McpToolHint[];
}

/** A configured MCP server and how it is doing. Tokens never reach the webview: only `hasToken`. */
export interface McpServerView {
  id: string;
  name: string;
  enabled: boolean;
  transport: McpTransportKind;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  auth: McpAuth;
  hasToken: boolean;
  /** The token travels over plain http to another machine. */
  insecure: boolean;
  timeoutSeconds: number;
  status: McpStatus;
  error?: string;
  server?: { name: string; version: string };
  tools: McpToolView[];
  /** Estimated tokens the definitions of its offered tools add to every request. */
  toolTokens: number;
}

export interface McpView {
  /** False in Restricted Mode: servers do not start, and MCP tools are never offered. */
  active: boolean;
  servers: McpServerView[];
}

export interface AppState {
  /** The webview this state is for. A chat in an editor tab only shows chats; lists and settings live in the view. */
  surface: SurfaceKind;
  view: View;
  workspace: { name: string | null; trusted: boolean; hasFolder: boolean };
  providers: ProviderView[];
  selected: SelectedModel | null;
  /** Model used in Plan mode; null means "same as Act". */
  planModel: SelectedModel | null;
  /** Model that names new chats when titles are generated; null means "the chat's model". */
  titleModel: SelectedModel | null;
  mode: AgentMode;
  /** How much Act mode may do without asking, for this window. */
  approvalMode: ApprovalMode;
  sessions: SessionSummary[];
  /** Chats open in editor tabs or running, in any webview. */
  liveSessions: LiveSessionView[];
  session: CurrentSessionView | null;
  run: RunView | null;
  approvals: ApprovalView[];
  context: ComposerContextView;
  grants: { edits: boolean };
  usage: ContextUsageView | null;
  compaction: CompactionView | null;
  commands: SlashCommandView[];
  settings: SettingsView;
  configFile: ConfigFileView;
  mcp: McpView;
}

export interface ProviderTestResult {
  ok: boolean;
  latencyMs?: number;
  models?: string[];
  message: string;
  hint?: string;
}

export type HostMessage =
  | { type: 'state'; state: AppState }
  | { type: 'patch'; patch: Partial<AppState> }
  | { type: 'messageUpsert'; sessionId: string; message: SessionMessage }
  | { type: 'messageRemoved'; sessionId: string; messageId: string }
  | { type: 'messageDelta'; sessionId: string; messageId: string; field: 'content' | 'reasoning'; text: string }
  | { type: 'toolOutput'; sessionId: string; callId: string; chunk: string }
  | { type: 'notice'; id: string; level: 'info' | 'warning' | 'error'; message: string }
  | { type: 'providerTest'; requestId: string; providerId: string; result: ProviderTestResult }
  /** Answers a `saveProvider` that carried a requestId; a `providerTest` for the same request follows. */
  | { type: 'providerSaved'; requestId: string; providerId: string }
  | { type: 'focusComposer'; text?: string }
  | { type: 'fileSuggestions'; requestId: string; items: FileSuggestionView[] }
  /** Answers `listDirectory`. */
  | { type: 'directoryListing'; requestId: string; listing: DirectoryListingView };

// ---------------------------------------------------------------------------------------------
// Webview → host (validated)
// ---------------------------------------------------------------------------------------------

const id = z.string().min(1).max(200);
const providerId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,47}$/);

const mcpId = z.string().regex(MCP_ID_PATTERN);

/** A server from the Settings form. Only the fields of its transport are sent; the host checks them again. */
export const mcpServerInputSchema = z
  .object({
    /** Absent for a new server: the host derives one from the name. */
    id: mcpId.optional(),
    name: z.string().trim().min(1, 'Give this server a name.').max(80),
    transport: z.enum(['stdio', 'http']),
    command: z.string().trim().min(1).max(1000).optional(),
    args: z.array(z.string().max(4000)).max(100).optional(),
    env: z.record(mcpEnvName, z.string().max(8000)).optional(),
    cwd: z.string().trim().min(1).max(1000).optional(),
    url: mcpHttpUrl.optional(),
    headers: z.record(mcpHeaderName, z.string().max(8000)).optional(),
    auth: mcpAuthSchema,
    timeoutSeconds: z.number().int().min(MCP_TIMEOUT_SECONDS.min).max(MCP_TIMEOUT_SECONDS.max).optional(),
    /** A new token for Secret Storage. It is never sent back to the webview. */
    token: z.string().max(8000).optional(),
  })
  .superRefine((s, ctx) => {
    if (s.transport === 'stdio' && !s.command) ctx.addIssue({ code: 'custom', path: ['command'], message: 'Enter the command that starts the server.' });
    else if (s.transport === 'http' && !s.url) ctx.addIssue({ code: 'custom', path: ['url'], message: 'Enter the URL of the server.' });
    else for (const message of transportProblems(s)) ctx.addIssue({ code: 'custom', message });
  });
export type McpServerInput = z.infer<typeof mcpServerInputSchema>;

export const providerInputSchema = z.object({
  id: providerId.optional(),
  name: z.string().trim().min(1).max(80),
  baseUrl: z
    .string()
    .trim()
    .max(500)
    .refine((u) => {
      try {
        const p = new URL(u).protocol;
        return p === 'http:' || p === 'https:';
      } catch {
        return false;
      }
    }, 'Enter a full http(s) URL, e.g. http://localhost:11434/v1'),
  authType: z.enum(['none', 'bearer', 'header']),
  headerName: z.string().trim().max(100).regex(/^[A-Za-z0-9-]*$/).optional(),
  timeoutSeconds: z.number().int().min(5).max(1800).optional(),
  models: z
    .array(
      z.object({
        id: z.string().trim().min(1).max(200),
        contextWindow: z.number().int().min(1024).max(10_000_000).optional(),
        maxOutputTokens: z.number().int().min(64).max(1_000_000).optional(),
        toolMode: z.enum(['auto', 'native', 'prompted', 'none']).optional(),
      }),
    )
    .max(200),
});
export type ProviderInput = z.infer<typeof providerInputSchema>;

const approvalModeSchema = z.enum(['ask', 'edits', 'auto']);

/** Allow-list entries with shell operators can never match a command, so they are rejected up front. */
const allowEntry = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((v) => !hasShellMetacharacters(v), 'Allowed commands cannot contain shell operators such as ; | & $ > <');

/**
 * The settings the Settings view may change, each with its own value schema. Anything else (providers, headers,
 * models) goes through dedicated messages, so the webview can never write an arbitrary key.
 */
export const settingUpdateSchema = z.discriminatedUnion('key', [
  z.object({
    key: z.literal('tools.disabled'),
    value: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/)).max(200),
  }),
  z.object({
    key: z.literal('tools.forceAsk'),
    value: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/)).max(200),
  }),
  z.object({ key: z.literal('approvals.mode'), value: approvalModeSchema }),
  z.object({ key: z.literal('approvals.allowedCommands'), value: z.array(allowEntry).max(200) }),
  z.object({ key: z.literal('security.protectedPaths'), value: z.array(z.string().trim().min(1).max(300)).max(200) }),
  z.object({ key: z.literal('agent.maxIterations'), value: z.number().int().min(1).max(200) }),
  z.object({ key: z.literal('terminal.timeoutSeconds'), value: z.number().int().min(5).max(3600) }),
  z.object({ key: z.literal('terminal.mirrorToTerminal'), value: z.boolean() }),
  z.object({ key: z.literal('diff.openOnProposal'), value: z.boolean() }),
  z.object({ key: z.literal('context.includeActiveEditor'), value: z.boolean() }),
  z.object({ key: z.literal('context.autoCompact'), value: z.boolean() }),
  z.object({ key: z.literal('context.projectInstructions'), value: z.boolean() }),
  z.object({ key: z.literal('context.maxToolResultChars'), value: z.number().int().min(2000).max(200_000) }),
  z.object({ key: z.literal('sessions.persist'), value: z.boolean() }),
  z.object({ key: z.literal('sessions.generateTitles'), value: z.boolean() }),
]);
export type SettingUpdate = z.infer<typeof settingUpdateSchema>;
export type SettingKey = SettingUpdate['key'];

export const webviewMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }),
  z.object({ type: z.literal('send'), text: z.string().min(1).max(200_000) }),
  z.object({ type: z.literal('cancel') }),
  z.object({
    type: z.literal('approval'),
    id,
    approved: z.boolean(),
    grant: z.literal('session-edits').optional(),
    feedback: z.string().max(4000).optional(),
    /** Adds this prefix to the allowed commands before running (the host checks it matches the command). */
    allowCommand: allowEntry.optional(),
    /** Runs the MCP tool and stops asking for it ("Always allow"). */
    allowTool: z.literal(true).optional(),
  }),
  z.object({ type: z.literal('openApprovalDiff'), id }),
  z.object({ type: z.literal('newSession') }),
  z.object({ type: z.literal('openSession'), id }),
  /** Opens a chat in an editor tab (focusing the tab when it is already open there). */
  z.object({ type: z.literal('openSessionInEditor'), id }),
  /** The webview received keyboard focus: commands such as "Ask Sovran About Selection" target the last one used. */
  z.object({ type: z.literal('focused') }),
  z.object({ type: z.literal('renameSession'), id, title: z.string().trim().min(1).max(120) }),
  z.object({ type: z.literal('deleteSession'), id }),
  z.object({ type: z.literal('setMode'), mode: z.enum(['plan', 'act']) }),
  z.object({ type: z.literal('setApprovalMode'), mode: approvalModeSchema }),
  z.object({ type: z.literal('pickModel') }),
  z.object({ type: z.literal('selectModel'), providerId, modelId: z.string().min(1).max(200) }),
  /** Sets the Act, Plan or title model explicitly; a Plan or title model without ids means "same as the chat's". */
  z.object({
    type: z.literal('setModel'),
    role: z.enum(['act', 'plan', 'title']),
    providerId: providerId.optional(),
    modelId: z.string().min(1).max(200).optional(),
  }),
  z.object({
    type: z.literal('addModels'),
    providerId,
    modelIds: z.array(z.string().trim().min(1).max(200)).min(1).max(200),
    /** Model to select as the Act model once added. */
    select: z.string().min(1).max(200).optional(),
  }),
  z.object({ type: z.literal('discoverModels') }),
  z.object({ type: z.literal('updateSetting'), setting: settingUpdateSchema }),
  z.object({ type: z.literal('showLogs') }),
  z.object({ type: z.literal('attachFiles') }),
  z.object({ type: z.literal('removeAttachment'), id }),
  z.object({ type: z.literal('setIncludeEditor'), value: z.boolean() }),
  z.object({ type: z.literal('openFile'), path: z.string().min(1).max(2000), line: z.number().int().min(1).optional() }),
  z.object({ type: z.literal('openExternal'), url: z.string().max(4000) }),
  z.object({ type: z.literal('insertCode'), code: z.string().max(500_000) }),
  z.object({ type: z.literal('setView'), view: z.enum(['chat', 'history', 'providers', 'settings']) }),
  /** With a requestId the host answers `providerSaved`, then tests the connection and reports `providerTest`. */
  z.object({ type: z.literal('saveProvider'), provider: providerInputSchema, requestId: id.optional() }),
  z.object({ type: z.literal('deleteProvider'), id: providerId }),
  z.object({ type: z.literal('testProvider'), requestId: id, providerId }),
  z.object({ type: z.literal('setApiKey'), providerId }),
  z.object({ type: z.literal('openSettings') }),
  /** Opens `~/.sovran/config.yaml` in an editor, creating it from a commented template when it does not exist. */
  z.object({ type: z.literal('openConfigFile') }),
  /** Reads the config file again (it is also reloaded automatically when saved). */
  z.object({ type: z.literal('reloadConfigFile') }),
  /** Back to Settings only. The host asks whether to keep the file (ignored) or move it to the trash. */
  z.object({ type: z.literal('stopConfigFile') }),
  /** Uses an ignored config file again; Settings win where both define the same provider. */
  z.object({ type: z.literal('useConfigFile') }),
  /** Adds a server (no id) or replaces one, keeping its tool policies. */
  z.object({ type: z.literal('saveMcpServer'), server: mcpServerInputSchema }),
  /** The host confirms first: the server's stored token is deleted too. */
  z.object({ type: z.literal('deleteMcpServer'), id: mcpId }),
  z.object({ type: z.literal('setMcpServerEnabled'), id: mcpId, enabled: z.boolean() }),
  z.object({ type: z.literal('restartMcpServer'), id: mcpId }),
  z.object({ type: z.literal('setMcpToolPolicy'), id: mcpId, tool: z.string().min(1).max(200), policy: z.enum(['off', 'ask', 'allow']) }),
  /** Asks for the server's token in a password box (Secret Storage). */
  z.object({ type: z.literal('setMcpToken'), id: mcpId }),
  z.object({ type: z.literal('restoreCheckpoint'), messageId: id }),
  z.object({ type: z.literal('retry') }),
  z.object({ type: z.literal('editMessage'), messageId: id, text: z.string().min(1).max(200_000) }),
  z.object({ type: z.literal('compact') }),
  z.object({ type: z.literal('suggestFiles'), requestId: id, query: z.string().max(200) }),
  z.object({ type: z.literal('attachPath'), path: z.string().min(1).max(2000) }),
  /** Lists one workspace folder for the attach menu ('' is the root). The host confines it to the workspace. */
  z.object({ type: z.literal('listDirectory'), requestId: id, path: z.string().max(2000) }),
  /** Opens the system file dialog. Only files the user picks there may come from outside the workspace. */
  z.object({ type: z.literal('uploadFiles') }),
  /**
   * An image pasted into the chat input, base64-encoded. The host checks its signature and size itself; the bound here
   * only keeps an oversized message from being decoded at all.
   */
  z.object({
    type: z.literal('attachImage'),
    data: z
      .string()
      .min(16)
      .max(Math.ceil(IMAGE_LIMITS.maxBytes / 3) * 4)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  }),
]);

export type WebviewMessage = z.infer<typeof webviewMessageSchema>;
