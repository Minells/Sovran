import type { CompactionState, ContextBreakdown, ErrorInfo, SessionMessage } from '../sessions/model';

export type ToolPhase = 'awaiting_approval' | 'running';

/**
 * Why tool units were loaded: they fit the budget, the chat had used them, the request asked for them, the model
 * asked for them or called one of their tools.
 */
export type ToolLoadReason = 'budget' | 'history' | 'router' | 'model' | 'call';

export type AgentEvent =
  | { type: 'iteration'; iteration: number; maxIterations: number }
  | { type: 'message_started'; message: SessionMessage }
  | { type: 'text_delta'; messageId: string; text: string }
  | { type: 'reasoning_delta'; messageId: string; text: string }
  | { type: 'tool_call_streaming'; messageId: string; name: string }
  | { type: 'message_committed'; message: SessionMessage }
  | { type: 'message_removed'; messageId: string }
  | { type: 'tool_phase'; callId: string; toolName: string; label: string; phase: ToolPhase }
  | { type: 'tool_output'; callId: string; chunk: string }
  | { type: 'notice'; level: 'info' | 'warning' | 'error'; message: string }
  | {
      type: 'context';
      estimatedTokens: number;
      budgetTokens: number;
      contextWindow: number;
      breakdown?: ContextBreakdown;
    }
  | { type: 'usage'; promptTokens?: number; completionTokens?: number }
  /** `detail` explains individual units, e.g. `git.changes: "committa"`. */
  | { type: 'tools_loaded'; units: string[]; reason: ToolLoadReason; detail?: string[] }
  | { type: 'compaction_started' }
  | { type: 'compacted'; compaction: CompactionState };

export type RunEndReason = 'completed' | 'cancelled' | 'max_iterations' | 'error';

export interface RunOutcome {
  reason: RunEndReason;
  error?: ErrorInfo;
}
