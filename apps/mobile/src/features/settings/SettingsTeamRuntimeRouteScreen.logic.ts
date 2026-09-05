import {
  multicaProviderInstanceRevision,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@codework/contracts";
export { buildTeamRuntimeSavePatch as buildMobileTeamRuntimeSavePatch } from "@codework/shared/multicaRuntimeSettings";

export function buildMobileTeamRuntimeDeletePatch(
  instanceId: string,
  instance: ProviderInstanceConfig,
): ServerSettingsPatch {
  return {
    providerInstances: {} as ServerSettings["providerInstances"],
    multicaProviderInstancePreconditions: [
      {
        instanceId: ProviderInstanceId.make(instanceId),
        expectedRevision: multicaProviderInstanceRevision(instanceId, instance),
      },
    ],
  };
}
