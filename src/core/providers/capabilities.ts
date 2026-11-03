import type { ResolvedToolMode, ToolMode } from './types';

export interface LearnedCapabilities {
  toolMode?: Extract<ResolvedToolMode, 'native' | 'prompted'>;
  updatedAt: number;
}

/** Persists what SOVRAN learned about a model at runtime (e.g. "rejects native tools"). */
export interface CapabilityStore {
  get(key: string): LearnedCapabilities | undefined;
  set(key: string, value: LearnedCapabilities): void;
  clear(key: string): void;
}

export class MemoryCapabilityStore implements CapabilityStore {
  private readonly map = new Map<string, LearnedCapabilities>();
  get(key: string) {
    return this.map.get(key);
  }
  set(key: string, value: LearnedCapabilities) {
    this.map.set(key, value);
  }
  clear(key: string) {
    this.map.delete(key);
  }
}

export const capabilityKey = (providerId: string, modelId: string) => `${providerId}/${modelId}`;

/** Explicit configuration always wins; `auto` uses what was learned, defaulting to native tools. */
export function resolveToolMode(configured: ToolMode | undefined, learned?: LearnedCapabilities): ResolvedToolMode {
  if (configured && configured !== 'auto') return configured;
  return learned?.toolMode ?? 'native';
}
