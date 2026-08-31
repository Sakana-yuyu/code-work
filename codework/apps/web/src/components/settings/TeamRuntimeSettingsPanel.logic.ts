import {
  ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type UnifiedSettings,
} from "@codework/contracts";

import type { MulticaRuntimeSave } from "./MulticaRuntimeSettings.model";

export type TeamRuntimeInstance = {
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
};

export function teamRuntimeInstancesFromSettings(
  settings: Pick<UnifiedSettings, "providerInstances">,
): ReadonlyArray<TeamRuntimeInstance> {
  return Object.entries(settings.providerInstances ?? {})
    .filter(([, instance]) => instance.driver === "multica")
    .map(([instanceId, instance]) => ({
      instanceId: instanceId as ProviderInstanceId,
      instance,
    }))
    .toSorted((left, right) => String(left.instanceId).localeCompare(String(right.instanceId)));
}

export function buildTeamRuntimeSettingsPatch(
  settings: Pick<UnifiedSettings, "providerInstances">,
  originalInstanceId: string | null,
  save: MulticaRuntimeSave,
): Pick<UnifiedSettings, "providerInstances"> {
  const providerInstances = { ...settings.providerInstances };
  const original = originalInstanceId
    ? providerInstances[originalInstanceId as ProviderInstanceId]
    : undefined;
  if (originalInstanceId !== null) {
    delete providerInstances[originalInstanceId as ProviderInstanceId];
  }

  providerInstances[save.instanceId] = {
    ...(original?.driver === "multica" ? original : {}),
    driver: ProviderDriverKind.make("multica"),
    enabled: save.config.enabled,
    config: save.config,
    environment: save.environment,
  };

  return { providerInstances };
}
