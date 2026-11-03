/**
 * Characters that let a single "command" chain, substitute, redirect or background other commands.
 * Any of them disqualifies a command from allow-list auto-approval.
 */
const SHELL_META = /[;&|`$<>(){}\n\r\\!*?[\]~]/;

export function hasShellMetacharacters(command: string): boolean {
  return SHELL_META.test(command);
}

function normalize(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}

/** True when the command equals an allow-list entry or extends it with plain arguments. */
export function matchesAllowList(command: string, allowList: readonly string[]): boolean {
  const cmd = normalize(command);
  if (!cmd || hasShellMetacharacters(cmd)) return false;
  return allowList.some((entry) => {
    const e = normalize(entry);
    return e.length > 0 && !hasShellMetacharacters(e) && (cmd === e || cmd.startsWith(`${e} `));
  });
}

const RISK_HINTS: Array<[RegExp, string]> = [
  [/\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i, 'Recursively force-deletes files.'],
  [/\b(sudo|doas)\b/, 'Runs with elevated privileges.'],
  [/\b(curl|wget)\b[^|]*\|\s*(ba|z)?sh\b/, 'Pipes a downloaded script into a shell.'],
  [/\bgit\s+push\b.*(--force|-f\b)/, 'Force-pushes and may overwrite remote history.'],
  [/\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f)/, 'Discards local changes irreversibly.'],
  [/\b(mkfs|dd\s+if=|shutdown|reboot)\b/, 'Can damage the system or stop the machine.'],
  [/\b(npm|pnpm|yarn)\s+publish\b/, 'Publishes a package to a registry.'],
  [/\bchmod\s+(-R\s+)?777\b/, 'Makes files world-writable.'],
  [/(>|>>)\s*\/(etc|usr|bin|System)\b/, 'Writes outside the workspace.'],
];

/** Human-readable warnings shown on the approval card. Advisory only; approval is always required. */
export function commandRiskHints(command: string): string[] {
  const hints = RISK_HINTS.filter(([re]) => re.test(command)).map(([, hint]) => hint);
  if (hasShellMetacharacters(command)) hints.push('Uses shell operators (chaining, pipes, redirection or substitution).');
  return hints;
}
