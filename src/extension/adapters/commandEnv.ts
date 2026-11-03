/**
 * Environment for agent commands. Deliberately free of `vscode` imports so it is unit-testable.
 *
 * The extension host runs with ELECTRON_RUN_AS_NODE=1. Children inherit it, which makes any Electron app they start
 * (VS Code itself, Electron-based test runners such as @vscode/test-electron) run as a bare Node process and fail in
 * confusing ways. The agent's commands should behave like the user's terminal, so it is removed.
 */
export function agentCommandEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, GIT_PAGER: 'cat', PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', CI: base.CI ?? '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}
