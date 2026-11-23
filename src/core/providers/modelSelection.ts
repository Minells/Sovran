import { supportsInfill } from '../../shared/endpoints';
import type { SelectedModel } from '../../shared/protocol';
import type { ProviderConfig } from './types';

export function parseModelReference(ref: string): SelectedModel | null {
  const separator = ref.indexOf('/');
  if (separator <= 0 || separator === ref.length - 1) return null;
  return { providerId: ref.slice(0, separator), modelId: ref.slice(separator + 1) };
}

function configuredModel(providers: readonly ProviderConfig[], selection: SelectedModel | null) {
  if (!selection) return undefined;
  const provider = providers.find((p) => p.id === selection.providerId);
  const model = provider?.models?.find((m) => m.id === selection.modelId);
  if (provider && model) return { provider, model };
}

export function selectActModel(
  providers: readonly ProviderConfig[],
  preferred: SelectedModel | null,
): SelectedModel | null {
  if (preferred && configuredModel(providers, preferred)) return preferred;
  for (const provider of providers) {
    // The default chat selection should skip models configured for completion.
    const model = provider.models?.find((m) => !m.fim);
    if (model) return { providerId: provider.id, modelId: model.id };
  }
  return null;
}

export function resolveInfillModel(
  providers: readonly ProviderConfig[],
  autocompleteRef: string,
  actRef: string,
) {
  const selection = autocompleteRef
    ? parseModelReference(autocompleteRef)
    : selectActModel(providers, parseModelReference(actRef));
  const configured = configuredModel(providers, selection);
  if (configured && supportsInfill(configured.provider.baseUrl, configured.model)) return configured;
}
