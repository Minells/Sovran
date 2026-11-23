import * as vscode from 'vscode';
import type { WorkspaceRoot } from '../core/ports';
import { workspaceGlob } from '../core/security/globs';

export const DEFAULT_EXCLUDES = [
  '**/node_modules/**',
  '**/.git/**',
  '**/.hg/**',
  '**/.svn/**',
  '**/__pycache__/**',
  '**/.venv/**',
  '**/venv/**',
];
const defaultExcluded = workspaceGlob(DEFAULT_EXCLUDES);

export function excludesWorkspaceFile(root: WorkspaceRoot, local: string): boolean {
  if (defaultExcluded(local)) return true;
  const entries =
    vscode.workspace
      .getConfiguration('files', vscode.Uri.file(root.path))
      .get<Record<string, unknown>>('exclude') ?? {};
  const globs = Object.entries(entries)
    .filter(([, on]) => on === true)
    .map(([glob]) => glob);
  return globs.length > 0 && workspaceGlob(globs)(local);
}
