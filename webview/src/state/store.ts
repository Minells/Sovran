import { createContext, useContext } from 'react';
import type { AppState, HostMessage, ProviderTestResult, SessionMessage } from '../../../src/shared/protocol';

export interface Notice {
  id: string;
  level: 'info' | 'warning' | 'error';
  message: string;
}

export interface UiState {
  app: AppState | null;
  notices: Notice[];
  toolOutputs: Record<string, string>;
  providerTests: Record<string, ProviderTestResult & { requestId: string }>;
  focusToken: number;
  focusText?: string;
  fileSuggestions: { requestId: string; items: Array<{ path: string; label: string }> } | null;
}

export type UiAction = HostMessage | { type: 'dismissNotice'; id: string };

export const initialUiState: UiState = { app: null, notices: [], toolOutputs: {}, providerTests: {}, focusToken: 0, fileSuggestions: null };

const MAX_OUTPUT = 60_000;

function updateMessages(state: UiState, sessionId: string, fn: (messages: SessionMessage[]) => SessionMessage[]): UiState {
  const app = state.app;
  if (!app?.session || app.session.id !== sessionId) return state;
  return { ...state, app: { ...app, session: { ...app.session, messages: fn(app.session.messages) } } };
}

export function reducer(state: UiState, action: UiAction): UiState {
  switch (action.type) {
    case 'state':
      return {
        ...state,
        app: action.state,
        toolOutputs: state.app?.session?.id === action.state.session?.id ? state.toolOutputs : {},
      };
    case 'patch': {
      if (!state.app) return state;
      const sessionChanged = action.patch.session && action.patch.session.id !== state.app.session?.id;
      return { ...state, app: { ...state.app, ...action.patch }, toolOutputs: sessionChanged ? {} : state.toolOutputs };
    }
    case 'messageUpsert':
      return updateMessages(state, action.sessionId, (msgs) => {
        const i = msgs.findIndex((m) => m.id === action.message.id);
        if (i === -1) return [...msgs, action.message];
        const next = msgs.slice();
        next[i] = action.message;
        return next;
      });
    case 'messageRemoved':
      return updateMessages(state, action.sessionId, (msgs) => msgs.filter((m) => m.id !== action.messageId));
    case 'messageDelta':
      return updateMessages(state, action.sessionId, (msgs) =>
        msgs.map((m) => {
          if (m.id !== action.messageId || m.role !== 'assistant') return m;
          return action.field === 'content' ? { ...m, content: m.content + action.text } : { ...m, reasoning: (m.reasoning ?? '') + action.text };
        }),
      );
    case 'toolOutput': {
      if (state.app?.session?.id !== action.sessionId) return state;
      const prev = state.toolOutputs[action.callId] ?? '';
      const next = (prev + action.chunk).slice(-MAX_OUTPUT);
      return { ...state, toolOutputs: { ...state.toolOutputs, [action.callId]: next } };
    }
    case 'notice': {
      const notices = [...state.notices.filter((n) => n.message !== action.message), { id: action.id, level: action.level, message: action.message }];
      return { ...state, notices: notices.slice(-3) };
    }
    case 'dismissNotice':
      return { ...state, notices: state.notices.filter((n) => n.id !== action.id) };
    case 'providerTest':
      return { ...state, providerTests: { ...state.providerTests, [action.providerId]: { ...action.result, requestId: action.requestId } } };
    case 'focusComposer':
      return { ...state, focusToken: state.focusToken + 1, focusText: action.text };
    case 'fileSuggestions':
      return { ...state, fileSuggestions: { requestId: action.requestId, items: action.items } };
    default:
      return state;
  }
}

export interface StoreValue {
  state: UiState;
  app: AppState;
  dispatch: (a: UiAction) => void;
}

export const StoreContext = createContext<StoreValue | null>(null);

export function useStore(): StoreValue {
  const v = useContext(StoreContext);
  if (!v) throw new Error('StoreContext missing');
  return v;
}
