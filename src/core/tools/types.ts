import type { z } from 'zod';
import type { DocumentReader } from '../documents/reader';
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
  /** Runtime-owned live permission check for a tool about to perform a delayed effect. */
  revalidate?: () => void;
  /** Converts documents for `read_file`. Without it (or without `workspace.readBytes`), documents read as binary. */
  documents?: DocumentReader;
}

export interface PreparedAction {
  /** Workspace-relative paths the action touches (for the permission policy). */
  paths: string[];
  command?: string;
  /** Context-dependent reasons the action must be confirmed even when the approval mode would allow it. */
  risks?: string[];
  /** Set for a tool of an MCP server: it asks unless the user allowed it (see `PolicyInput.mcp`). */
  mcp?: { server: string; allowed: boolean };
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
  /**
   * The JSON Schema offered to the model, when it does not come from `schema`: an MCP server describes its tools in
   * JSON Schema, and the server validates the arguments itself.
   */
  parameters?: Record<string, unknown>;
  risk: ToolRisk;
  /** Provenance and deterministic context grouping; absent metadata means a native tool. */
  source?: { kind: 'native' } | { kind: 'mcp'; serverId: string };
  group?: string;
  /** Some read tools also require a trusted extension host (e.g. Git or network access). */
  requiresTrust?: boolean;
  /** Synchronous, side-effect-free live availability check. Returns a reason when unavailable. */
  unavailable?(): string | undefined;
  /** Current MCP permission, read again after approval rather than trusting prepared state. */
  mcpPolicy?(): { server: string; allowed: boolean };
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
