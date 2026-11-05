import type { ModelInfo, ServerLimits } from './limits';

export type ToolMode = 'auto' | 'native' | 'prompted' | 'none';
export type ResolvedToolMode = Exclude<ToolMode, 'auto'>;

export interface ModelConfig {
  id: string;
  name?: string;
  /** Configured by the user; wins over what the server reports. */
  contextWindow?: number;
  /** Configured by the user: reserved for the reply and sent as max_tokens. */
  maxOutputTokens?: number;
  temperature?: number;
  toolMode?: ToolMode;
  /** Whether the model receives images. Unset: Sovran sends them and stops if the server refuses (see capabilities). */
  vision?: boolean;
  /** What the server reports for this model. Attached at run time only, never written to settings or the file. */
  serverLimits?: ServerLimits;
}

export interface ProviderAuth {
  type: 'none' | 'bearer' | 'header';
  headerName?: string;
}

export interface ProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  auth?: ProviderAuth;
  /** Non-secret extra headers. */
  headers?: Record<string, string>;
  timeoutSeconds?: number;
  models?: ModelConfig[];
}

export interface WireToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** A part of a user message with images. Messages without images keep a plain string, as every server accepts. */
export type WireContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

export type WireMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | WireContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: WireToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ToolSchema {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatRequest {
  model: string;
  messages: WireMessage[];
  tools?: ToolSchema[];
  temperature?: number;
  maxTokens?: number;
}

export type ProviderEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call_delta'; index: number; id?: string; name?: string; argumentsDelta?: string }
  | { type: 'finish'; reason: string | null }
  | { type: 'usage'; promptTokens?: number; completionTokens?: number };

export interface ChatProvider {
  readonly id: string;
  listModels(signal?: AbortSignal): Promise<string[]>;
  /** Models with the limits the server declares, when the provider can read them. */
  listModelInfo?(signal?: AbortSignal): Promise<ModelInfo[]>;
  streamChat(request: ChatRequest, signal: AbortSignal): AsyncIterable<ProviderEvent>;
}

/** The text of a message's content: its string, or its text parts joined (images left out). */
export function wireText(content: string | WireContentPart[] | null): string {
  if (content === null) return '';
  if (typeof content === 'string') return content;
  return content.map((p) => (p.type === 'text' ? p.text : '')).join('');
}

/** Whether a request carries any image (so a refusal can be read as "this model does not take images"). */
export const carriesImages = (messages: readonly WireMessage[]) =>
  messages.some((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'));
