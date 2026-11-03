import type { z } from 'zod';
import type { ApprovalDetail, ProcessPort, WorkspacePort } from '../ports';
import type { ToolRisk } from '../permissions/policy';
import type { ToolDisplay } from '../sessions/model';

export interface ToolSettings {
  terminalTimeoutMs: number;
  maxToolResultChars: number;
  /** Globs whose contents must never be returned by bulk-read tools such as search_files. */
  protectedPaths: readonly string[];
}

export interface ToolContext {
  workspace: WorkspacePort;
  process: ProcessPort;
  signal: AbortSignal;
  settings: ToolSettings;
  onOutput?: (chunk: string) => void;
}

export interface PreparedAction {
  /** Workspace-relative paths the action touches (for the permission policy). */
  paths: string[];
  command?: string;
  approval?: ApprovalDetail;
  /** Tool-private state carried from prepare() to execute(). */
  state?: unknown;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
  summary?: string;
  display?: ToolDisplay;
}

export interface ToolDefinition<A = unknown> {
  name: string;
  description: string;
  schema: z.ZodType<A>;
  risk: ToolRisk;
  /** Short human label for the UI, e.g. "src/app.ts" or "npm test". */
  label(args: A): string;
  prepare?(args: A, ctx: ToolContext): Promise<PreparedAction>;
  execute(args: A, ctx: ToolContext, prepared: PreparedAction): Promise<ToolResult>;
}

/** An expected, user-explainable tool failure. Its message is returned to the model verbatim. */
export class ToolError extends Error {
  override name = 'ToolError';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool = ToolDefinition<any>;

export function defineTool<A>(tool: ToolDefinition<A>): ToolDefinition<A> {
  return tool;
}
