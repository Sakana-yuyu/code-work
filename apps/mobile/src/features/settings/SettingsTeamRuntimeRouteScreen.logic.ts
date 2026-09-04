import {
  multicaProviderInstanceRevision,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@codework/contracts";
import {
  buildTeamRuntimeSettingsPatch,
  type MulticaRuntimeSave,
} from "@codework/shared/multicaRuntimeSettings";

/**
 * 生成移动端团队的局部设置 mutation；除本次涉及的团队外，服务端保留所有实例。
 */
export function buildMobileTeamRuntimeSavePatch(
  settings: Pick<ServerSettings, "providerInstances">,
  originalInstanceId: string | null,
  expectedRevision: string | null,
  save: MulticaRuntimeSave,
): ServerSettingsPatch {
  const nextMap = buildTeamRuntimeSettingsPatch(
    settings,
    originalInstanceId,
    save,
  ).providerInstances;
  const nextInstance = nextMap[save.instanceId];
  if (nextInstance === undefined) {
    throw new Error("Team runtime instance was not materialized.");
  }
  return {
    providerInstances: { [save.instanceId]: nextInstance } as ServerSettings["providerInstances"],
    multicaProviderInstancePreconditions: [
      ...(originalInstanceId === null
        ? []
        : [{ instanceId: ProviderInstanceId.make(originalInstanceId), expectedRevision }]),
      ...(originalInstanceId === save.instanceId
        ? []
        : [{ instanceId: save.instanceId, expectedRevision: null }]),
    ],
  };
}

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
