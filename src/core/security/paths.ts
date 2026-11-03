import * as path from 'node:path';
import type { WorkspacePort, WorkspaceRoot } from '../ports';

export class PathError extends Error {
  override name = 'PathError';
}

export interface ResolvedPath {
  absolute: string;
  /** Workspace-relative path with forward slashes (prefixed with the root name in multi-root workspaces). */
  relative: string;
  root: WorkspaceRoot;
}

export function isInside(parent: string, child: string, p: path.PlatformPath = path): boolean {
  const rel = p.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${p.sep}`) && !p.isAbsolute(rel));
}

function toRelative(root: WorkspaceRoot, absolute: string, multiRoot: boolean, p: path.PlatformPath): string {
  const rel = p.relative(root.path, absolute).split(p.sep).join('/') || '.';
  return multiRoot ? (rel === '.' ? root.name : `${root.name}/${rel}`) : rel;
}

/**
 * Lexically resolves a model-supplied path inside the workspace.
 * Accepts workspace-relative paths, `rootName/…` in multi-root workspaces, and absolute paths inside a root.
 */
export function resolveWorkspacePath(
  input: string,
  roots: readonly WorkspaceRoot[],
  p: path.PlatformPath = path,
): ResolvedPath {
  const raw = input.trim();
  if (roots.length === 0) throw new PathError('No workspace folder is open.');
  if (!raw) throw new PathError('Path must not be empty.');
  if (raw.includes('\0')) throw new PathError('Path contains a NUL character.');
  const multiRoot = roots.length > 1;

  if (p.isAbsolute(raw)) {
    const absolute = p.resolve(raw);
    const root = roots.find((r) => isInside(r.path, absolute, p));
    if (!root) throw new PathError(`"${input}" is outside the workspace.`);
    return { absolute, relative: toRelative(root, absolute, multiRoot, p), root };
  }

  let root = roots[0] as WorkspaceRoot;
  let rest = raw;
  if (multiRoot) {
    const [first, ...others] = raw.split(/[\\/]/);
    const named = roots.find((r) => r.name === first);
    if (named) {
      root = named;
      rest = others.join('/') || '.';
    }
  }
  const absolute = p.resolve(root.path, rest);
  if (!isInside(root.path, absolute, p)) throw new PathError(`"${input}" escapes the workspace folder.`);
  return { absolute, relative: toRelative(root, absolute, multiRoot, p), root };
}

/**
 * Resolves and then verifies with realpath that symlinks do not lead outside the root.
 * For paths that do not exist yet, the nearest existing ancestor is checked.
 */
export async function resolveAndVerify(input: string, workspace: WorkspacePort): Promise<ResolvedPath> {
  const resolved = resolveWorkspacePath(input, workspace.roots());
  const realRoot = await workspace.realpath(resolved.root.path).catch(() => resolved.root.path);
  let probe = resolved.absolute;
  for (;;) {
    const stat = await workspace.stat(probe);
    if (stat) break;
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const realProbe = await workspace.realpath(probe).catch(() => probe);
  if (!isInside(realRoot, realProbe)) {
    throw new PathError(`"${input}" resolves through a symbolic link to a location outside the workspace.`);
  }
  return resolved;
}
