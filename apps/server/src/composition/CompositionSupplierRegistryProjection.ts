import type {
  CompositionAgentDriverProfile,
  CompositionSupplierRegistryEntry,
  CompositionSupplierRegistryResult,
} from "@codework/contracts";

/**
 * Supplier/Profile/Account 统一投影的实例输入：调用方从 ProviderInstanceRegistry
 * 适配而来，只保留投影需要的纯数据字段（不含 adapter/textGeneration 等运行时句柄）。
 */
export type CompositionSupplierInstanceInput = {
  readonly instanceId: string;
  readonly driverKind: string;
  readonly displayName?: string | undefined;
  readonly enabled: boolean;
  /** Provider 实例的账号延续身份（driverKind:instance:<id>），即 Supplier 的账号锚点。 */
  readonly continuationKey: string;
  readonly defaultModelId?: string | undefined;
};

/** 与 Provider 实例关联的 Agent Driver 档案按 `provider:<instanceId>` 约定派生。 */
const agentIdForInstance = (instanceId: string): string => `provider:${instanceId}`;

/**
 * Supplier/Profile/Account 统一只读投影：
 * - 每个 Provider 实例输出一个 Supplier 条目（账号锚点 continuationKey、启用态、
 *   默认模型），并按 agentId 约定挂上派生的 Agent Driver 档案摘要；
 * - `provider:` 前缀但找不到实例的档案输出为孤儿档案——通常是实例被移除后
 *   尚未回收的 Driver（多账号回滚/凭据生命周期关注的对象）；
 * - 非 `provider:` 前缀的档案（acp/cli 等非实例派生 Driver）不参与本投影。
 */
export const projectCompositionSupplierRegistry = (input: {
  readonly instances: ReadonlyArray<CompositionSupplierInstanceInput>;
  readonly profiles: ReadonlyArray<CompositionAgentDriverProfile>;
  readonly nowUnixMs: number;
}): CompositionSupplierRegistryResult => {
  const profileByAgentId = new Map(
    input.profiles.map((profile) => [profile.agentId, profile] as const),
  );

  const linkedAgentIds = new Set<string>();
  const suppliers: CompositionSupplierRegistryEntry[] = input.instances.map((instance) => {
    const agentId = agentIdForInstance(instance.instanceId);
    const profile = profileByAgentId.get(agentId);
    if (profile !== undefined) linkedAgentIds.add(agentId);
    return {
      instanceId: instance.instanceId,
      driverKind: instance.driverKind,
      ...(instance.displayName === undefined ? {} : { displayName: instance.displayName }),
      enabled: instance.enabled,
      continuationKey: instance.continuationKey,
      ...(instance.defaultModelId === undefined ? {} : { defaultModelId: instance.defaultModelId }),
      ...(profile === undefined
        ? {}
        : {
            profile: {
              agentId: profile.agentId,
              runtimeId: profile.runtimeId,
              status: profile.status,
              supportsResume: profile.supportsResume,
            },
          }),
    };
  });

  const orphanProfileAgentIds = input.profiles
    .filter(
      (profile) => profile.agentId.startsWith("provider:") && !linkedAgentIds.has(profile.agentId),
    )
    .map((profile) => profile.agentId);

  return {
    generatedAtUnixMs: input.nowUnixMs,
    suppliers,
    orphanProfileAgentIds,
  };
};
