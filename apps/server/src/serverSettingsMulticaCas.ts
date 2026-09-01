import * as NodeCrypto from "node:crypto";

import {
  CompositionMulticaRuntimeConfig,
  isMulticaSecretName,
  isSafeMulticaRuntimeBaseUrl,
  isSafeMulticaTaskMcpEndpoint,
  multicaProviderInstanceFingerprint,
  multicaProviderInstanceRevision,
  type ProviderInstanceConfig,
  ProviderInstanceId,
  type ServerSettings,
  ServerSettingsConflictError,
  ServerSettingsError,
  type ServerSettingsPatch,
} from "@codework/contracts";
import { applyServerSettingsPatch } from "@codework/shared/serverSettings";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const decodeMulticaConfig = Schema.decodeUnknownEffect(CompositionMulticaRuntimeConfig);

export function multicaSecretEnvironmentNames(
  instance: ProviderInstanceConfig,
): ReadonlySet<string> {
  if (
    instance.driver !== "multica" ||
    instance.config === null ||
    typeof instance.config !== "object"
  ) {
    return new Set();
  }
  const headers = (instance.config as Record<string, unknown>)["headers"];
  if (!Array.isArray(headers)) return new Set();
  return new Set(
    headers.flatMap((entry): ReadonlyArray<string> => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return [];
      const binding = entry as Record<string, unknown>;
      const headerName = binding["headerName"];
      const environmentVariable = binding["environmentVariable"];
      return typeof headerName === "string" &&
        typeof environmentVariable === "string" &&
        isMulticaSecretName(headerName)
        ? [environmentVariable]
        : [];
    }),
  );
}

const foldLegacyEnabledFlag = (instance: ProviderInstanceConfig): ProviderInstanceConfig => {
  const config = instance.config;
  if (
    config === null ||
    typeof config !== "object" ||
    Array.isArray(config) ||
    typeof (config as { readonly enabled?: unknown }).enabled !== "boolean"
  ) {
    return instance;
  }
  const { enabled: configEnabled, ...restConfig } = config as Record<string, unknown> & {
    readonly enabled: boolean;
  };
  return {
    ...instance,
    enabled:
      instance.enabled === false || configEnabled === false
        ? false
        : (instance.enabled ?? configEnabled),
    config: restConfig,
  };
};

/**
 * 保留所有 Provider 的旧 enabled 折叠合同，并完整解码已知 Multica 配置。
 * CAS、revision 与持久化都必须使用这里产出的同一份最终语义。
 */
export const normalizeMulticaProviderInstances = (
  settingsPath: string,
  settings: ServerSettings,
): Effect.Effect<ServerSettings, ServerSettingsError> =>
  Effect.gen(function* () {
    const providerInstances: Record<string, ProviderInstanceConfig> = {};
    for (const [instanceId, instance] of Object.entries(settings.providerInstances)) {
      if (instance.driver !== "multica") {
        providerInstances[instanceId] = foldLegacyEnabledFlag(instance);
        continue;
      }

      const config = yield* decodeMulticaConfig(instance.config).pipe(
        Effect.mapError(
          (cause) =>
            new ServerSettingsError({
              settingsPath,
              operation: "normalize",
              providerInstanceId: instanceId,
              cause,
            }),
        ),
      );
      if (
        !isSafeMulticaRuntimeBaseUrl(config.baseUrl) ||
        (config.taskMcpEndpoint !== undefined &&
          !isSafeMulticaTaskMcpEndpoint(config.taskMcpEndpoint))
      ) {
        return yield* Effect.fail(
          new ServerSettingsError({
            settingsPath,
            operation: "normalize",
            providerInstanceId: instanceId,
            cause: new Error("Multica Runtime URL 配置不安全或无效。"),
          }),
        );
      }

      const { enabled: configEnabled, ...canonicalConfig } = config;
      const enabled =
        instance.enabled === false || configEnabled === false
          ? false
          : (instance.enabled ?? configEnabled);
      providerInstances[instanceId] = {
        ...instance,
        enabled,
        config: canonicalConfig,
      } satisfies ProviderInstanceConfig;
    }

    return {
      ...settings,
      providerInstances: providerInstances as ServerSettings["providerInstances"],
    };
  });

function changedMulticaProviderInstanceIds(
  current: ServerSettings,
  next: ServerSettings,
): ReadonlyArray<string> {
  const instanceIds = new Set([
    ...Object.keys(current.providerInstances),
    ...Object.keys(next.providerInstances),
  ]);
  return [...instanceIds].filter((instanceId) => {
    const providerInstanceId = ProviderInstanceId.make(instanceId);
    const currentInstance = current.providerInstances[providerInstanceId];
    const nextInstance = next.providerInstances[providerInstanceId];
    if (currentInstance?.driver !== "multica" && nextInstance?.driver !== "multica") {
      return false;
    }
    if (
      multicaProviderInstanceFingerprint(instanceId, currentInstance) !==
      multicaProviderInstanceFingerprint(instanceId, nextInstance)
    ) {
      return true;
    }
    if (nextInstance?.driver !== "multica") return false;
    const secretNames = multicaSecretEnvironmentNames(nextInstance);
    return (nextInstance.environment ?? []).some(
      (variable) =>
        (variable.sensitive || secretNames.has(variable.name)) &&
        variable.valueRedacted !== true &&
        variable.value.length > 0,
    );
  });
}

/** 非空 precondition 表示局部 Multica mutation，而不是整张实例图替换。 */
export function applyMulticaProviderInstanceMutation(
  current: ServerSettings,
  patch: ServerSettingsPatch,
): Effect.Effect<ServerSettings, ServerSettingsConflictError> {
  const preconditions = patch.multicaProviderInstancePreconditions ?? [];
  if (preconditions.length === 0) {
    return Effect.succeed(applyServerSettingsPatch(current, patch));
  }
  const partialProviderInstances = patch.providerInstances;
  if (partialProviderInstances === undefined) {
    return Effect.fail(
      new ServerSettingsConflictError({ providerInstanceId: preconditions[0]!.instanceId }),
    );
  }
  const unexpectedTopLevelKey = Object.keys(patch).find(
    (key) => key !== "providerInstances" && key !== "multicaProviderInstancePreconditions",
  );
  if (unexpectedTopLevelKey !== undefined) {
    return Effect.fail(
      new ServerSettingsConflictError({ providerInstanceId: preconditions[0]!.instanceId }),
    );
  }

  const listedIds = new Set<string>();
  for (const precondition of preconditions) {
    if (listedIds.has(precondition.instanceId)) {
      return Effect.fail(
        new ServerSettingsConflictError({ providerInstanceId: precondition.instanceId }),
      );
    }
    listedIds.add(precondition.instanceId);
  }
  for (const instanceId of Object.keys(partialProviderInstances)) {
    if (!listedIds.has(instanceId)) {
      return Effect.fail(new ServerSettingsConflictError({ providerInstanceId: instanceId }));
    }
  }

  const providerInstances: Record<string, ProviderInstanceConfig> = {
    ...current.providerInstances,
  };
  for (const instanceId of listedIds) {
    const providerInstanceId = ProviderInstanceId.make(instanceId);
    const currentInstance = current.providerInstances[providerInstanceId];
    const nextInstance = partialProviderInstances[providerInstanceId];
    if (
      (currentInstance !== undefined && currentInstance.driver !== "multica") ||
      (nextInstance !== undefined && nextInstance.driver !== "multica")
    ) {
      return Effect.fail(new ServerSettingsConflictError({ providerInstanceId: instanceId }));
    }
    if (nextInstance === undefined) {
      delete providerInstances[instanceId];
    } else {
      providerInstances[instanceId] = nextInstance;
    }
  }

  return Effect.succeed(
    applyServerSettingsPatch(current, {
      ...patch,
      providerInstances: providerInstances as ServerSettings["providerInstances"],
    }),
  );
}

export function validateMulticaProviderInstancePreconditions(
  current: ServerSettings,
  next: ServerSettings,
  patch: ServerSettingsPatch,
): Effect.Effect<ReadonlyArray<string>, ServerSettingsConflictError> {
  const preconditions = new Map<string, string | null>();
  for (const precondition of patch.multicaProviderInstancePreconditions ?? []) {
    if (preconditions.has(precondition.instanceId)) {
      return Effect.fail(
        new ServerSettingsConflictError({ providerInstanceId: precondition.instanceId }),
      );
    }
    preconditions.set(precondition.instanceId, precondition.expectedRevision);
  }

  for (const [instanceId, expectedRevision] of preconditions) {
    const currentInstance = current.providerInstances[ProviderInstanceId.make(instanceId)];
    const actualRevision = multicaProviderInstanceRevision(instanceId, currentInstance);
    if (
      expectedRevision === null
        ? currentInstance !== undefined
        : expectedRevision !== actualRevision
    ) {
      return Effect.fail(new ServerSettingsConflictError({ providerInstanceId: instanceId }));
    }
  }

  const changedInstanceIds = changedMulticaProviderInstanceIds(current, next);
  for (const instanceId of changedInstanceIds) {
    if (!preconditions.has(instanceId)) {
      return Effect.fail(new ServerSettingsConflictError({ providerInstanceId: instanceId }));
    }
  }
  return Effect.succeed(changedInstanceIds);
}

export function assignMulticaProviderInstanceRevisions(
  current: ServerSettings,
  next: ServerSettings,
  changedInstanceIds: ReadonlyArray<string>,
): ServerSettings {
  const providerInstances: Record<string, ProviderInstanceConfig> = { ...next.providerInstances };
  const changed = new Set(changedInstanceIds);
  for (const [instanceId, instance] of Object.entries(providerInstances)) {
    if (instance.driver !== "multica") continue;
    const { settingsRevision: _clientRevision, ...unversionedInstance } = instance;
    const currentInstance = current.providerInstances[ProviderInstanceId.make(instanceId)];
    providerInstances[instanceId] = {
      ...unversionedInstance,
      ...(changed.has(instanceId)
        ? { settingsRevision: NodeCrypto.randomUUID() }
        : currentInstance?.driver === "multica" && currentInstance.settingsRevision !== undefined
          ? { settingsRevision: currentInstance.settingsRevision }
          : {}),
    } satisfies ProviderInstanceConfig;
  }
  return { ...next, providerInstances: providerInstances as ServerSettings["providerInstances"] };
}
