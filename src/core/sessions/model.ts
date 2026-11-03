import type { AgentMode } from '../permissions/policy';

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON arguments as produced by the model. */
  arguments: string;
}

export interface ContextAttachment {
  kind: 'file' | 'selection';
  /** Workspace-relative path. */
  path: string;
  startLine?: number;
  endLine?: number;
  content: string;
  truncated?: boolean;
}

export type ToolDisplay =
  | { kind: 'diff'; path: string; diff: string; added: number; removed: number; isNew: boolean }
  | { kind: 'command'; command: string; cwd: string; output: string; exitCode: number | null; timedOut: boolean }
  | { kind: 'list'; items: string[]; total: number }
  | { kind: 'text'; text: string };

export interface ErrorInfo {
  kind: string;
  message: string;
  hint?: string;
}

export interface UserMessage {
  role: 'user';
  id: string;
  content: string;
  attachments?: ContextAttachment[];
  createdAt: number;
}

export interface AssistantMessage {
  role: 'assistant';
  id: string;
  content: string;
  reasoning?: string;
  toolCalls?: ToolCall[];
  model?: { providerId: string; modelId: string };
  error?: ErrorInfo;
  /** Set while streaming; cleared on commit. */
  streaming?: boolean;
  createdAt: number;
}

export type ToolStatus = 'success' | 'error' | 'denied' | 'cancelled';

export interface ToolMessage {
  role: 'tool';
  id: string;
  toolCallId: string;
  toolName: string;
  /** Exactly what is sent back to the model. */
  content: string;
  status: ToolStatus;
  summary?: string;
  display?: ToolDisplay;
  durationMs?: number;
  createdAt: number;
}

export type SessionMessage = UserMessage | AssistantMessage | ToolMessage;

export interface Session {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  mode: AgentMode;
  providerId?: string;
  modelId?: string;
  messages: SessionMessage[];
}

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export interface SessionRepository {
  list(): Promise<SessionSummary[]>;
  load(id: string): Promise<Session | undefined>;
  save(session: Session): Promise<void>;
  delete(id: string): Promise<void>;
}

export const DEFAULT_TITLE = 'New chat';

export function deriveTitle(text: string): string {
  const line = text
    .replace(/```[\s\S]*?```/g, ' ')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return DEFAULT_TITLE;
  const clean = line.replace(/\s+/g, ' ');
  return clean.length > 60 ? `${clean.slice(0, 57).trimEnd()}…` : clean;
}

export function summarize(session: Session): SessionSummary {
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messages.filter((m) => m.role !== 'tool').length,
  };
}

/**
 * After a restart, a session may contain a message that was streaming or tool calls that never
 * got a result. Normalize them so the transcript and the wire protocol stay consistent.
 */
export function repairInterruptedSession(session: Session, now: number): Session {
  const answered = new Set(session.messages.filter((m): m is ToolMessage => m.role === 'tool').map((m) => m.toolCallId));
  const messages: SessionMessage[] = [];
  for (const m of session.messages) {
    if (m.role === 'assistant' && m.streaming) messages.push({ ...m, streaming: undefined });
    else messages.push(m);
    if (m.role === 'assistant' && m.toolCalls) {
      for (const call of m.toolCalls) {
        if (!answered.has(call.id)) {
          messages.push({
            role: 'tool',
            id: `${call.id}-interrupted`,
            toolCallId: call.id,
            toolName: call.name,
            content: 'This action was interrupted before it completed.',
            status: 'cancelled',
            createdAt: now,
          });
          answered.add(call.id);
        }
      }
    }
  }
  return { ...session, messages };
}
