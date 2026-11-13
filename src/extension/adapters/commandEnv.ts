/**
 * Environment for agent commands. Deliberately free of `vscode` imports so it is unit-testable.
 *
 * The extension host runs with ELECTRON_RUN_AS_NODE=1. Children inherit it, which makes any Electron app they start
 * (VS Code itself, Electron-based test runners such as @vscode/test-electron) run as a bare Node process and fail in
 * confusing ways. The agent's commands should behave like the user's terminal, so it is removed.
 */
/** Variable names that usually hold credentials, as in the command guardrails (`$GITHUB_TOKEN`, `AWS_SECRET_ACCESS_KEY`). */
const SECRET_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?/i;

/**
 * `hideSecrets` (the `sovran.terminal.hideSecretVariables` setting) also removes variables whose name looks like a
 * credential, so a command the agent runs cannot read or print them. Off by default: commands that need such a
 * variable (`gh`, `npm publish`, cloud CLIs) would stop working.
 */
export function agentCommandEnv(base: NodeJS.ProcessEnv, hideSecrets = false): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, GIT_PAGER: 'cat', PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', CI: base.CI ?? '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  if (hideSecrets) for (const name of Object.keys(env)) if (SECRET_NAME.test(name)) delete env[name];
  return env;
}
