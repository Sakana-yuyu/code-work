/**
 * SupplierAdminCore — pure mutations for supplier management operations.
 *
 * Operates on the `ServerSettings.providerInstances` envelope map and returns
 * a fresh map for the whole-map settings patch (the map's write contract).
 * The registry hot-reloads from settings, so no registry surgery happens
 * here.
 *
 * Sensitivity contract: outcomes and error details only ever name credential
 * *locations* (instance id, adapter id, variable name) — never values. The
 * incoming secret is written into the returned map and nowhere else.
 *
 * @module provider/SupplierAdminCore
 */
import type {
  ProviderInstanceConfig,
  ProviderInstanceConfigMap,
  ProviderInstanceId,
  ServerSettingsPatch,
  SupplierAdminErrorCode,
  SupplierCredentialUpdate,
} from "@codework/contracts";
import { multicaProviderInstanceRevision } from "@codework/contracts";

export type SupplierAdminOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: SupplierAdminErrorCode; readonly detail: string };

/**
 * Supplier 的 Multica 修改走局部 CAS mutation，避免 materialized 全图快照覆盖其它实例。
 * 非 Multica 保持既有整图写入合同，兼容旧设置调用方。
 */
export const buildSupplierProviderInstancePatch = (
  current: ProviderInstanceConfigMap,
  next: ProviderInstanceConfigMap,
  instanceId: ProviderInstanceId,
): Pick<ServerSettingsPatch, "providerInstances" | "multicaProviderInstancePreconditions"> => {
  const currentInstance = current[instanceId];
  const nextInstance = next[instanceId];
  if (currentInstance?.driver !== "multica" && nextInstance?.driver !== "multica") {
    return { providerInstances: next };
  }
  return {
    providerInstances: nextInstance === undefined ? {} : { [instanceId]: nextInstance },
    multicaProviderInstancePreconditions: [
      {
        instanceId,
        expectedRevision: multicaProviderInstanceRevision(instanceId, currentInstance),
      },
    ],
  };
};

const instanceNotFound = (instanceId: string) =>
  ({
    ok: false,
    code: "supplier_instance_not_found",
    detail: `Provider 实例不存在：${instanceId}`,
  }) as const;

const configRecord = (config: unknown): Record<string, unknown> | undefined =>
  config !== null && typeof config === "object" && !Array.isArray(config)
    ? (config as Record<string, unknown>)
    : undefined;

/**
 * 启用/禁用一个 Provider 实例。
 *
 * `resolveProviderInstanceEnabled` 规定 envelope 与 config 内旧 `enabled`
 * 标志任一为 false 即禁用（最严格优先），因此这里在 envelope 之外同步翻转
 * config 内已存在的布尔标志，保证切换后的生效状态与请求一致。
 */
export const setSupplierInstanceEnabled = (
  map: ProviderInstanceConfigMap,
  instanceId: ProviderInstanceId,
  enabled: boolean,
): SupplierAdminOutcome<{ readonly providerInstances: ProviderInstanceConfigMap }> => {
  const instance = map[instanceId];
  if (instance === undefined) return instanceNotFound(instanceId);
  const config = configRecord(instance.config);
  const nextInstance: ProviderInstanceConfig = {
    ...instance,
    enabled,
    ...(config !== undefined && typeof config["enabled"] === "boolean"
      ? { config: { ...config, enabled } }
      : {}),
  };
  return { ok: true, value: { providerInstances: { ...map, [instanceId]: nextInstance } } };
};

export interface SupplierCredentialUpdateOutcome {
  readonly providerInstances: ProviderInstanceConfigMap;
  /** adapterId 或环境变量名——凭据定位信息，绝无凭据值。 */
  readonly target: string;
  readonly updatedFields: ReadonlyArray<string>;
}

const rotateByokAdapterCredential = (
  map: ProviderInstanceConfigMap,
  instanceId: ProviderInstanceId,
  instance: ProviderInstanceConfig,
  update: Extract<SupplierCredentialUpdate, { readonly kind: "byok_adapter" }>,
): SupplierAdminOutcome<SupplierCredentialUpdateOutcome> => {
  if (instance.driver !== "byok") {
    return {
      ok: false,
      code: "supplier_credential_not_supported",
      detail: `实例 ${instanceId}（driver=${instance.driver}）不支持 BYOK 适配器凭据更新`,
    };
  }
  const apiKey = update.apiKey?.trim() ?? "";
  const balanceAccessToken = update.balanceAccessToken?.trim() ?? "";
  if (apiKey === "" && balanceAccessToken === "") {
    return {
      ok: false,
      code: "supplier_credential_empty",
      detail: `实例 ${instanceId} 适配器 ${update.adapterId} 的凭据更新未携带任何新值`,
    };
  }
  const config = configRecord(instance.config);
  const adapters = config?.["adapters"];
  if (config === undefined || !Array.isArray(adapters)) {
    return {
      ok: false,
      code: "supplier_adapter_not_found",
      detail: `实例 ${instanceId} 没有可更新的适配器 ${update.adapterId}`,
    };
  }
  const index = adapters.findIndex(
    (entry) =>
      entry !== null &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      (entry as Record<string, unknown>)["id"] === update.adapterId,
  );
  if (index < 0) {
    return {
      ok: false,
      code: "supplier_adapter_not_found",
      detail: `实例 ${instanceId} 没有可更新的适配器 ${update.adapterId}`,
    };
  }
  const updatedFields: string[] = [];
  const nextAdapter: Record<string, unknown> = { ...(adapters[index] as Record<string, unknown>) };
  // 新值取代旧 secret，同时清掉对应 redacted 标志，避免持久层把新值当占位符丢弃。
  if (apiKey !== "") {
    nextAdapter["apiKey"] = apiKey;
    delete nextAdapter["apiKeyRedacted"];
    updatedFields.push("apiKey");
  }
  if (balanceAccessToken !== "") {
    nextAdapter["balanceAccessToken"] = balanceAccessToken;
    delete nextAdapter["balanceAccessTokenRedacted"];
    updatedFields.push("balanceAccessToken");
  }
  const nextAdapters = [...adapters];
  nextAdapters[index] = nextAdapter;
  const nextInstance: ProviderInstanceConfig = {
    ...instance,
    config: { ...config, adapters: nextAdapters },
  };
  return {
    ok: true,
    value: {
      providerInstances: { ...map, [instanceId]: nextInstance },
      target: update.adapterId,
      updatedFields,
    },
  };
};

const rotateEnvironmentVariable = (
  map: ProviderInstanceConfigMap,
  instanceId: ProviderInstanceId,
  instance: ProviderInstanceConfig,
  update: Extract<SupplierCredentialUpdate, { readonly kind: "environment_variable" }>,
): SupplierAdminOutcome<SupplierCredentialUpdateOutcome> => {
  if (update.value.trim() === "") {
    return {
      ok: false,
      code: "supplier_credential_empty",
      detail: `实例 ${instanceId} 环境变量 ${update.name} 的凭据更新未携带新值`,
    };
  }
  const environment = instance.environment;
  const current = environment?.find((variable) => variable.name === update.name);
  if (environment === undefined || current === undefined) {
    return {
      ok: false,
      code: "supplier_environment_variable_not_found",
      detail: `实例 ${instanceId} 没有环境变量 ${update.name}`,
    };
  }
  const { valueRedacted: _omitValueRedacted, ...variableRest } = current;
  const nextEnvironment = environment.map((variable) =>
    variable.name === update.name ? { ...variableRest, value: update.value } : variable,
  );
  const nextInstance: ProviderInstanceConfig = { ...instance, environment: nextEnvironment };
  return {
    ok: true,
    value: {
      providerInstances: { ...map, [instanceId]: nextInstance },
      target: update.name,
      updatedFields: ["value"],
    },
  };
};

/** 凭据更新入口：按目标类型路由到 BYOK 适配器或实例环境变量。 */
export const applySupplierCredentialUpdate = (
  map: ProviderInstanceConfigMap,
  instanceId: ProviderInstanceId,
  update: SupplierCredentialUpdate,
): SupplierAdminOutcome<SupplierCredentialUpdateOutcome> => {
  const instance = map[instanceId];
  if (instance === undefined) return instanceNotFound(instanceId);
  return update.kind === "byok_adapter"
    ? rotateByokAdapterCredential(map, instanceId, instance, update)
    : rotateEnvironmentVariable(map, instanceId, instance, update);
};
