export type ToolMode = 'auto' | 'native' | 'prompted' | 'none';
export type ResolvedToolMode = Exclude<ToolMode, 'auto'>;

export interface ModelConfig {
  id: string;
  name?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  temperature?: number;
  toolMode?: ToolMode;
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

export type WireMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
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
  streamChat(request: ChatRequest, signal: AbortSignal): AsyncIterable<ProviderEvent>;
}
