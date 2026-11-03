/** Keyboard labels for the platform the webview runs on (VS Code webviews report the host OS in navigator). */
export const isMac = () => typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);

/** Prefix for Alt shortcuts: "⌥" on macOS, "Alt+" elsewhere. */
export const altLabel = () => (isMac() ? '⌥' : 'Alt+');

/** Label for a VS Code keybinding declared as ctrl+alt+<key> (cmd+alt+<key> on macOS). */
export const globalShortcut = (key: string) => (isMac() ? `⌘⌥${key}` : `Ctrl+Alt+${key}`);

export interface Shortcut {
  keys: string;
  label: string;
}

/** Everything the composer and Sovran's global keybindings can do, for the shortcuts popover. */
export function shortcutList(opts: { approvals: boolean }): Shortcut[] {
  const alt = altLabel();
  return [
    { keys: '↵', label: 'Send the message' },
    { keys: '⇧↵', label: 'New line' },
    { keys: '@', label: 'Add a workspace file' },
    { keys: '/', label: 'Run a command' },
    { keys: `${alt}M`, label: 'Switch Plan / Act' },
    ...(opts.approvals ? [{ keys: `${alt}A`, label: 'Change approvals' }] : []),
    { keys: 'Esc', label: 'Stop Sovran while it works' },
    { keys: globalShortcut('Y'), label: 'Focus Sovran from anywhere' },
    { keys: globalShortcut('U'), label: 'Ask about the editor selection' },
  ];
}
