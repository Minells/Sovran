import type { WebviewMessage } from '../../src/shared/protocol';

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
}

declare global {
  interface Window {
    acquireVsCodeApi?: () => VsCodeApi;
  }
}

let api: VsCodeApi | undefined;
const listeners = new Set<(m: WebviewMessage) => void>();

function getApi(): VsCodeApi {
  if (api) return api;
  if (typeof window !== 'undefined' && window.acquireVsCodeApi) {
    api = window.acquireVsCodeApi();
  } else {
    // Outside VS Code (tests, dev harness): keep state in memory and expose posts to listeners.
    let state: unknown;
    api = {
      postMessage: (m) => listeners.forEach((l) => l(m as WebviewMessage)),
      getState: <T,>() => state as T,
      setState: (s) => {
        state = s;
      },
    };
  }
  return api;
}

export function post(message: WebviewMessage) {
  getApi().postMessage(message);
}

/** Dev/test hook: observe messages the UI sends to the host. */
export function onPost(listener: (m: WebviewMessage) => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export interface UiPersistedState {
  draft?: string;
}

export function getUiState(): UiPersistedState {
  return getApi().getState<UiPersistedState>() ?? {};
}

export function setUiState(patch: UiPersistedState) {
  getApi().setState({ ...getUiState(), ...patch });
}
