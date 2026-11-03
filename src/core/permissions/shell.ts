/**
 * Characters that let a single "command" chain, substitute, redirect or background other commands.
 * Any of them disqualifies a command from allow-list auto-approval.
 *
 * Dependency-free on purpose: the webview imports it to validate allow-list entries as the user types.
 */
// eslint-disable-next-line no-control-regex -- control characters are exactly what this guards against
const SHELL_META = /[;&|`$<>(){}\n\r\\!*?[\]~]|[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/;

export function hasShellMetacharacters(command: string): boolean {
  return SHELL_META.test(command);
}
