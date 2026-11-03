/**
 * Host ⇄ webview contract. The host is authoritative; the webview renders `AppState` and sends intents.
 * Every webview → host message is validated with `webviewMessageSchema` before it is handled.
 */
import { z } from 'zod';
import type { AgentMode } from '../core/permissions/policy';
import type { ToolMode } from '../core/providers/types';
import type { SessionMessage, SessionSummary } from '../core/sessions/model';

export type { SessionMessage, SessionSummary, AgentMode, ToolMode };

export type View = 'chat' | 'history' | 'providers';

export interface ModelView {
  id: string;
  name?: string;
  contextWindow?: number;
  toolMode: ToolMode;
  /** What SOVRAN learned at runtime (e.g. downgraded to prompted tools). */
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

export interface SelectedModel {
  providerId: string;
  modelId: string;
}

export type ActivityPhase = 'thinking' | 'streaming' | 'awaiting_approval' | 'running';

export interface RunView {
  sessionId: string;
  iteration: number;
  maxIterations: number;
  startedAt: number;
  activity: { phase: ActivityPhase; label: string; toolName?: string; callId?: string };
}

export type ApprovalDetailView =
  | { kind: 'edit'; path: string; isNew: boolean; diff: string; added: number; removed: number }
  | { kind: 'command'; command: string; cwd: string; warnings: string[] }
  | { kind: 'read'; path: string; reason: string };

export interface ApprovalView {
  id: string;
  callId: string;
  toolName: string;
  title: string;
  detail: ApprovalDetailView;
}

export interface AttachmentView {
  id: string;
  path: string;
  label: string;
}

export interface EditorContextView {
  path: string;
  label: string;
  startLine?: number;
  endLine?: number;
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

export interface AppState {
  view: View;
  workspace: { name: string | null; trusted: boolean; hasFolder: boolean };
  providers: ProviderView[];
  selected: SelectedModel | null;
  mode: AgentMode;
  sessions: SessionSummary[];
  session: CurrentSessionView | null;
  run: RunView | null;
  approvals: ApprovalView[];
  context: ComposerContextView;
  grants: { edits: boolean };
  fileEdits: 'ask' | 'auto';
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
  | { type: 'focusComposer'; text?: string };

// ---------------------------------------------------------------------------------------------
// Webview → host (validated)
// ---------------------------------------------------------------------------------------------

const id = z.string().min(1).max(200);
const providerId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,47}$/);

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
        toolMode: z.enum(['auto', 'native', 'prompted', 'none']).optional(),
      }),
    )
    .max(200),
});
export type ProviderInput = z.infer<typeof providerInputSchema>;

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
  }),
  z.object({ type: z.literal('openApprovalDiff'), id }),
  z.object({ type: z.literal('newSession') }),
  z.object({ type: z.literal('openSession'), id }),
  z.object({ type: z.literal('renameSession'), id, title: z.string().trim().min(1).max(120) }),
  z.object({ type: z.literal('deleteSession'), id }),
  z.object({ type: z.literal('setMode'), mode: z.enum(['plan', 'act']) }),
  z.object({ type: z.literal('pickModel') }),
  z.object({ type: z.literal('selectModel'), providerId, modelId: z.string().min(1).max(200) }),
  z.object({ type: z.literal('attachFiles') }),
  z.object({ type: z.literal('removeAttachment'), id }),
  z.object({ type: z.literal('setIncludeEditor'), value: z.boolean() }),
  z.object({ type: z.literal('openFile'), path: z.string().min(1).max(2000), line: z.number().int().min(1).optional() }),
  z.object({ type: z.literal('openExternal'), url: z.string().max(4000) }),
  z.object({ type: z.literal('insertCode'), code: z.string().max(500_000) }),
  z.object({ type: z.literal('setView'), view: z.enum(['chat', 'history', 'providers']) }),
  z.object({ type: z.literal('saveProvider'), provider: providerInputSchema }),
  z.object({ type: z.literal('deleteProvider'), id: providerId }),
  z.object({ type: z.literal('testProvider'), requestId: id, providerId }),
  z.object({ type: z.literal('setApiKey'), providerId }),
  z.object({ type: z.literal('openSettings') }),
]);

export type WebviewMessage = z.infer<typeof webviewMessageSchema>;
