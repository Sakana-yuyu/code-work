import {
  resolveProviderInstanceEnabled,
  type CompositionSquadMemberModelBinding,
  type CompositionSquadModelBinding,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
} from "@codework/contracts";

export type CompositionSquadModelBindingValue =
  | CompositionSquadModelBinding
  | CompositionSquadMemberModelBinding
  | null;

export type CompositionSquadModelBindingMode =
  | "legacy"
  | "team_default"
  | "runtime_native"
  | "byok";

export interface CompositionSquadByokAdapterOption {
  readonly adapterId: string;
  readonly displayName: string;
  readonly modelId: string;
}

export interface CompositionSquadByokProviderOption {
  readonly providerInstanceId: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly adapters: ReadonlyArray<CompositionSquadByokAdapterOption>;
}

export type CompositionSquadByokBindingAvailability =
  | "available"
  | "provider_missing"
  | "provider_disabled"
  | "adapter_missing"
  | "model_changed";

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const trimmedString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const readAdapterOptions = (config: unknown): ReadonlyArray<CompositionSquadByokAdapterOption> => {
  if (!isRecord(config) || !Array.isArray(config["adapters"])) return [];

  const adapters: CompositionSquadByokAdapterOption[] = [];
  const seenAdapterIds = new Set<string>();
  for (const candidate of config["adapters"]) {
    if (!isRecord(candidate)) continue;
    const adapterId = trimmedString(candidate["id"]);
    const modelId = trimmedString(candidate["modelId"]);
    if (adapterId === null || modelId === null || seenAdapterIds.has(adapterId)) continue;
    seenAdapterIds.add(adapterId);
    adapters.push({
      adapterId,
      displayName: trimmedString(candidate["displayName"]) ?? adapterId,
      modelId,
    });
  }
  return adapters;
};

/** 只投影 Squad 选择器需要的非敏感字段，绝不携带 API Key 或余额凭据。 */
export function buildCompositionSquadByokProviderOptions(
  providerInstances: Readonly<Record<ProviderInstanceId, ProviderInstanceConfig>>,
): ReadonlyArray<CompositionSquadByokProviderOption> {
  const providers: CompositionSquadByokProviderOption[] = [];
  for (const [providerInstanceId, instance] of Object.entries(providerInstances)) {
    if (instance.driver !== "byok") continue;
    const adapters = readAdapterOptions(instance.config);
    if (adapters.length === 0) continue;
    providers.push({
      providerInstanceId,
      displayName: instance.displayName?.trim() || providerInstanceId,
      enabled: resolveProviderInstanceEnabled(instance),
      adapters,
    });
  }
  return providers;
}

export const compositionSquadModelBindingMode = (
  binding: CompositionSquadModelBindingValue,
): CompositionSquadModelBindingMode => binding?.kind ?? "legacy";

const bindingFromAdapter = (
  provider: CompositionSquadByokProviderOption,
  adapter: CompositionSquadByokAdapterOption,
): CompositionSquadModelBinding => ({
  kind: "byok",
  providerInstanceId: provider.providerInstanceId,
  adapterId: adapter.adapterId,
  modelId: adapter.modelId,
});

export function firstSelectableCompositionSquadByokBinding(
  providers: ReadonlyArray<CompositionSquadByokProviderOption>,
): CompositionSquadModelBinding | null {
  const provider = providers.find(
    (candidate) => candidate.enabled && candidate.adapters.length > 0,
  );
  const adapter = provider?.adapters[0];
  return provider === undefined || adapter === undefined
    ? null
    : bindingFromAdapter(provider, adapter);
}

export function compositionSquadByokBindingForProvider(
  providers: ReadonlyArray<CompositionSquadByokProviderOption>,
  providerInstanceId: string,
): CompositionSquadModelBinding | null {
  const provider = providers.find(
    (candidate) => candidate.providerInstanceId === providerInstanceId && candidate.enabled,
  );
  const adapter = provider?.adapters[0];
  return provider === undefined || adapter === undefined
    ? null
    : bindingFromAdapter(provider, adapter);
}

export function compositionSquadByokBindingForAdapter(
  providers: ReadonlyArray<CompositionSquadByokProviderOption>,
  providerInstanceId: string,
  adapterId: string,
): CompositionSquadModelBinding | null {
  const provider = providers.find(
    (candidate) => candidate.providerInstanceId === providerInstanceId && candidate.enabled,
  );
  const adapter = provider?.adapters.find((candidate) => candidate.adapterId === adapterId);
  return provider === undefined || adapter === undefined
    ? null
    : bindingFromAdapter(provider, adapter);
}

export function compositionSquadByokBindingAvailability(
  binding: CompositionSquadModelBinding,
  providers: ReadonlyArray<CompositionSquadByokProviderOption>,
): CompositionSquadByokBindingAvailability {
  if (binding.kind !== "byok") return "available";
  const provider = providers.find(
    (candidate) => candidate.providerInstanceId === binding.providerInstanceId,
  );
  if (provider === undefined) return "provider_missing";
  if (!provider.enabled) return "provider_disabled";
  const adapter = provider.adapters.find((candidate) => candidate.adapterId === binding.adapterId);
  if (adapter === undefined) return "adapter_missing";
  return adapter.modelId === binding.modelId ? "available" : "model_changed";
}
