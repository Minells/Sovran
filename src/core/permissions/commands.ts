import * as path from 'node:path';
import picomatch from 'picomatch';
import { hasShellMetacharacters } from './shell';

export { hasShellMetacharacters };

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

/**
 * Matches one of `words` in command position: at the start, after an operator (`; & | ( $(` or a backtick), or after
 * a launcher such as `xargs` or `env VAR=1`. A plain argument (`grep -r sudo docs`) does not match. Commands hidden
 * inside quotes are covered by the nested-shell guardrail instead.
 */
const COMMAND_POSITION = String.raw`(?:^|[;&|(\x60]|\$\()\s*(?:(?:xargs|nohup|time|exec|command|env(?:\s+\w+=\S*)*|timeout\s+\S+)\s+)*`;
const asCommand = (words: string) => new RegExp(`${COMMAND_POSITION}(?:${words})(?=\\s|$|[;&|)])`);

/**
 * High-risk command patterns. A match always requires approval, even in Auto mode and even when the command is in
 * the allow-list. These are heuristics that catch the common dangerous shapes; they are not a sandbox.
 */
const HIGH_RISK: Array<[RegExp, string]> = [
  [/\brm\s+(?:[^\n;&|]*\s)?(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b/, 'Deletes files and folders recursively.'],
  [/\bfind\b[^\n;&|]*\s(?:-delete|-exec\s+rm)\b/, 'Deletes the files a search finds.'],
  [asCommand('sudo|doas|pkexec'), 'Runs with elevated privileges.'],
  [
    /\b(?:curl|wget)\b[^|\n]*\|\s*(?:sudo\s+)?(?:\w*sh|python\d*(?:\.\d+)?|node|perl|ruby|php|pwsh|powershell|iex)\b|(?:<\(|\$\()\s*(?:curl|wget)\b/i,
    'Runs a downloaded script.',
  ],
  [/\bbase64\s+(?:-d|--decode|-D)\b[^\n]*\|\s*\w*sh\b/, 'Runs dynamically built or hidden commands.'],
  [asCommand('eval'), 'Runs dynamically built or hidden commands.'],
  [
    /\b(?:ba|z|da|k|fi)?sh\s+(?:-\w+\s+)*-\w*c\b|\b(?:pwsh|powershell)(?:\.exe)?\b[^\n]*\s-(?:c|command|encodedcommand|e)\b|\bcmd(?:\.exe)?\s+\/[ck]\b/i,
    'Runs a nested shell command, which hides what actually runs.',
  ],
  [/\bgit\s+push\b[^\n;&|]*(?:\s--force\b|\s-f\b|\s\+\S)/, 'Force-pushes and may overwrite remote history.'],
  [/\bgit\s+push\b(?![^\n;&|]*(?:\s--force\b|\s-f\b|\s\+\S))/, 'Pushes commits to a remote repository.'],
  [
    /\bgit\s+(?:reset\s+--hard|clean\s+-[a-zA-Z]*f|checkout\s+--\s|restore\s|stash\s+(?:drop|clear)\b|branch\s+-D\b)/,
    'Discards local changes irreversibly.',
  ],
  [/\bdd\s+if=|\bformat\s+[a-zA-Z]:/, 'Can damage the system or stop the machine.'],
  [asCommand('mkfs(?:\\.\\w+)?|shutdown|reboot|halt|poweroff|diskpart'), 'Can damage the system or stop the machine.'],
  [
    /\b(?:npm|pnpm|yarn|bun|cargo|gem|poetry|vsce|ovsx)\s+publish\b|\btwine\s+upload\b|\bdocker\s+push\b/,
    'Publishes a package or image to a registry.',
  ],
  [/\b(?:kubectl|helm|terraform|pulumi)\s+(?:apply|delete|destroy|install|upgrade|uninstall|replace|drain|up)\b/, 'Changes deployed infrastructure.'],
  [/\bchmod\s+(?:-R\s+)?777\b/, 'Makes files world-writable.'],
  [/(?:>|>>)\s*\/(?:etc|usr|bin|sbin|boot|System|Library)\b/, 'Writes outside the workspace.'],
  [
    /\bcurl\b[^\n;&|]*\s(?:-d|--data(?:-\w+)?|-F|--form|-T|--upload-file)(?=[\s=]|$)|\bwget\b[^\n;&|]*--post-(?:data|file)\b/,
    'Sends data to a remote server.',
  ],
  [asCommand('nc|ncat|netcat|socat|telnet'), 'Opens a raw network connection.'],
  [asCommand('scp|sftp'), 'Copies files to or from another machine.'],
  [/\brsync\b[^\n;&|]*\s[\w.-]+@?[\w.-]*:/, 'Copies files to or from another machine.'],
  [
    /\b(?:security\s+find-(?:generic|internet)-password|gh\s+auth\s+token|git\s+credential\s+fill|aws\s+configure\s+get|gcloud\s+auth\s+print-\w+-token|az\s+account\s+get-access-token)\b/,
    'Reads stored credentials.',
  ],
  [
    /\$\{?(?:env:)?\w*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?)\w*\}?|%\w*(?:TOKEN|SECRET|PASSWORD|API_?KEY)\w*%/i,
    'Reads a secret from an environment variable.',
  ],
  [
    // `git -c core.fsmonitor=./x status` or `--upload-pack=./x` run arbitrary programs, even when `git` is allowed.
    /\bgit\s+(?:[^\n;&|]*\s)?(?:-c\s*\S+=|--config-env\b|--exec-path\b|--upload-pack\b|--receive-pack\b)|\b(?:npm|pnpm|yarn)\b[^\n;&|]*\s--script-shell\b/,
    'Overrides tool settings in a way that can run other programs.',
  ],
  [/(?:^|[;&|(]\s*)(?:env|set)\s*(?:$|[|;&)])/, 'Prints environment variables, which may contain secrets.'],
  [asCommand('printenv'), 'Prints environment variables, which may contain secrets.'],
  [asCommand('crontab|systemctl|launchctl|schtasks'), 'Changes system services or scheduled tasks.'],
  [
    /\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add)\b[^\n;&|]*\s(?:-g|--global)\b|\byarn\s+global\s+add\b|\b(?:apt|apt-get|yum|dnf|brew|choco|winget|snap|pacman)\s+(?:install|remove|upgrade|uninstall)\b/,
    'Installs or removes software on this machine.',
  ],
];

/**
 * Invisible, control and bidirectional-override characters can make a command look different from
 * what actually runs ("Trojan Source"-style spoofing of the approval card).
 */
// eslint-disable-next-line no-control-regex
export const DECEPTIVE_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;
const DECEPTIVE_HINT = 'Contains invisible or text-direction characters that can disguise what runs. Inspect it carefully.';

/** Reasons a command must always be confirmed by the user, whatever the approval mode or allow-list says. */
export function commandGuardrails(command: string): string[] {
  const reasons = [...new Set(HIGH_RISK.filter(([re]) => re.test(command)).map(([, reason]) => reason))];
  if (DECEPTIVE_CHARS.test(command)) reasons.unshift(DECEPTIVE_HINT);
  return reasons;
}

/** Human-readable warnings shown on the approval card: the guardrails plus advisory notes. */
export function commandRiskHints(command: string): string[] {
  const hints = commandGuardrails(command);
  if (hasShellMetacharacters(command)) hints.push('Uses shell operators (chaining, pipes, redirection or substitution).');
  return hints;
}

const HOME_REF = /^~(?:[\\/]|$)|\$\{?HOME\}?|%USERPROFILE%|\$env:USERPROFILE/i;
const PARENT_SEGMENT = /(?:^|[\\/])\.\.(?:[\\/]|$)/;
const ABSOLUTE = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/;
/** Absolute paths that commands commonly use and that never hold user data. */
const HARMLESS_ABSOLUTE = /^\/(?:dev\/(?:null|stdout|stderr)|usr\/bin\/env)$/;

function pathTokens(command: string): string[] {
  return command
    .split(/[\s;&|<>()`]+/)
    .flatMap((t) => t.split('='))
    .map((t) => t.replace(/^['"]+|['"]+$/g, ''))
    .filter((t) => t.length > 0 && !t.startsWith('-'));
}

/**
 * Context-dependent reasons to confirm a command: it names a protected file, or reaches outside the workspace
 * (home directory, `..`, absolute paths). Commands bypass the read-tool protections, so Auto mode must not run
 * them silently. Heuristic by nature: it inspects the words of the command, it does not interpret the shell.
 */
export function commandPathRisks(
  command: string,
  o: { protectedPaths: readonly string[]; roots?: readonly string[]; platformPath?: path.PlatformPath },
): string[] {
  const p = o.platformPath ?? path;
  const reasons = new Set<string>();
  const isProtected = o.protectedPaths.length ? picomatch(o.protectedPaths as string[], { dot: true, nocase: true }) : () => false;
  for (const token of pathTokens(command)) {
    const slashed = token.replace(/\\/g, '/');
    if (isProtected(slashed) || isProtected(slashed.replace(/^(?:\.\/)+/, ''))) {
      reasons.add(`Refers to a protected file (${token}).`);
    } else if (HOME_REF.test(token)) {
      reasons.add('Refers to files in your home directory.');
    } else if (PARENT_SEGMENT.test(token)) {
      reasons.add('Refers to files outside the workspace (..).');
    } else if (ABSOLUTE.test(token) && !HARMLESS_ABSOLUTE.test(token)) {
      const inside = (o.roots ?? []).some((root) => {
        const rel = p.relative(root, token);
        return rel === '' || (!rel.startsWith('..') && !p.isAbsolute(rel));
      });
      if (!inside) reasons.add('Uses an absolute path outside the workspace.');
    }
  }
  return [...reasons];
}

/** Interpreters and launchers: allow-listing them alone would allow any script, so the full command is suggested. */
const LAUNCHERS = new Set([
  'bash', 'sh', 'zsh', 'fish', 'pwsh', 'powershell', 'cmd', 'python', 'python3', 'py', 'node', 'deno', 'bun', 'npx',
  'pnpx', 'bunx', 'ruby', 'perl', 'php', 'java', 'env', 'xargs', 'nohup', 'time', 'watch', 'uv', 'uvx',
]);

/**
 * Suggests the allow-list entry for "always allow" on an approval card: the command name plus its sub-commands
 * (`npm test`, `git status`, `npm run build`), stopping at the first option or path-like argument. Returns null
 * when the command can never be allow-listed (shell operators) or must always ask (guardrails).
 */
export function suggestAllowPrefix(command: string): string | null {
  const cmd = normalize(command);
  if (!cmd || hasShellMetacharacters(cmd) || commandGuardrails(cmd).length) return null;
  const tokens = cmd.split(' ');
  const out: string[] = [];
  for (const t of tokens) {
    if (out.length >= 3) break;
    if (out.length > 0 && /^-|[/\\.=:@]/.test(t)) break;
    out.push(t);
  }
  if (out.length === 1 && LAUNCHERS.has(out[0]!.toLowerCase())) return cmd;
  return out.join(' ') || null;
}
