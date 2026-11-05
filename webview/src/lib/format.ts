import { FORMAT_LABELS, type DocumentFormat } from '../../../src/core/documents/types';
import { dimensions, IMAGE_LABELS, type ImageMime } from '../../../src/core/images/images';

export interface ToolInfo {
  icon: string;
  done: string;
  doing: string;
}

const TOOLS: Record<string, ToolInfo> = {
  read_file: { icon: 'file', done: 'Read', doing: 'Reading' },
  list_directory: { icon: 'folder', done: 'Listed', doing: 'Listing' },
  find_files: { icon: 'search', done: 'Found', doing: 'Finding' },
  search_files: { icon: 'search', done: 'Searched', doing: 'Searching' },
  get_workspace_info: { icon: 'info', done: 'Inspected', doing: 'Inspecting' },
  get_active_editor_context: { icon: 'eye', done: 'Checked', doing: 'Checking' },
  write_file: { icon: 'new-file', done: 'Wrote', doing: 'Writing' },
  edit_file: { icon: 'edit', done: 'Edited', doing: 'Editing' },
  apply_diff: { icon: 'diff', done: 'Edited', doing: 'Editing' },
  execute_terminal: { icon: 'terminal', done: 'Ran', doing: 'Running' },
};

export const toolInfo = (name: string): ToolInfo => TOOLS[name] ?? { icon: 'tools', done: name.replace(/_/g, ' '), doing: name.replace(/_/g, ' ') };

/** Human target of a tool call (path, pattern, query, command) from its raw JSON arguments. */
export function toolTarget(name: string, rawArgs: string): string {
  let a: Record<string, unknown> = {};
  try {
    a = JSON.parse(rawArgs || '{}') as Record<string, unknown>;
  } catch {
    return '';
  }
  const pick = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : '');
  switch (name) {
    case 'find_files':
      return pick('pattern');
    case 'search_files':
      return pick('query');
    case 'execute_terminal':
      return pick('command');
    case 'get_workspace_info':
      return 'workspace';
    case 'get_active_editor_context':
      return 'active editor';
    case 'list_directory':
      return pick('path') || '.';
    default:
      return pick('path');
  }
}

export function relativeTime(ts: number, now = Date.now()): string {
  const s = Math.round((now - ts) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function dayGroup(ts: number, now = new Date()): string {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ts >= start) return 'Today';
  if (ts >= start - 86_400_000) return 'Yesterday';
  if (ts >= start - 7 * 86_400_000) return 'Previous 7 days';
  return 'Older';
}

export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

const DOCUMENT_ICONS: Record<DocumentFormat, string> = {
  pdf: 'file-pdf',
  docx: 'file-text',
  odt: 'file-text',
  xlsx: 'table',
  ods: 'table',
  pptx: 'preview',
  odp: 'preview',
  zip: 'file-zip',
};

/**
 * The icon and description of an attachment converted from a document ("PDF document, 12 pages"), or undefined for a
 * text file. Saved chats may name a format this version does not know, which counts as text.
 */
export function documentInfo(format: string | undefined, detail?: string): { icon: string; description: string } | undefined {
  if (!format || !Object.hasOwn(FORMAT_LABELS, format)) return undefined;
  const label = FORMAT_LABELS[format as DocumentFormat];
  return { icon: DOCUMENT_ICONS[format as DocumentFormat], description: detail ? `${label}, ${detail}` : label };
}

/** The icon and description of an image attachment ("PNG image, 1280×720"). */
export function imageDescription(image: { mime: ImageMime; width?: number; height?: number }): { icon: string; description: string } {
  const label = IMAGE_LABELS[image.mime] ?? 'Image';
  const size = dimensions(image);
  return { icon: 'file-media', description: size ? `${label}, ${size}` : label };
}
