import picomatch from 'picomatch';

/**
 * Workspace/model-controlled path globs use ordinary glob syntax, not regex groups or Bash extglobs.
 * Keep parentheses literal (e.g. app/(auth)/**), including when preceded by +, *, ?, @ or !.
 * Preserve existing backslash escapes; character classes and brace alternatives remain supported.
 * User-only protected-path settings deliberately retain their existing, broader syntax.
 */
export function workspaceGlob(patterns: string | readonly string[]): (input: string) => boolean {
  const literalGroups = (pattern: string) =>
    pattern.replace(/\\.|[()|]/g, (token) => (token.length === 2 ? token : `\\${token}`));
  const globs = typeof patterns === 'string' ? literalGroups(patterns) : patterns.map(literalGroups);
  return picomatch(globs, { dot: true, noext: true, nonegate: true, regex: false });
}
