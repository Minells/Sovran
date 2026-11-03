import type { ApprovalView, RunView, SessionMessage } from '../../../src/shared/protocol';

export type AssistantMessageView = Extract<SessionMessage, { role: 'assistant' }>;
export type ToolMessageView = Extract<SessionMessage, { role: 'tool' }>;
export type ToolCallView = NonNullable<AssistantMessageView['toolCalls']>[number];
export type RunViewT = RunView;
export type { ApprovalView };
