import {
  ACP_MODE_OPTION_ID,
  CODEX_COLLABORATION_MODE_OPTION_ID,
  ACP_CONFIG_OPTION_PREFIX,
  SelectProviderOptionDescriptor,
  ServerProviderModel,
  type OrchestrationThreadActivity,
  type ServerProvider,
  type ProviderInstanceId,
  type ModelCapabilities,
  type ProviderInteractionMode,
  type ModelSelection,
} from "@codework/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

const decodeModels = Schema.decodeUnknownOption(
  Schema.Struct({
    providerInstanceId: Schema.String,
    models: Schema.NullOr(Schema.Array(ServerProviderModel)),
  }),
);

const decodeMode = Schema.decodeUnknownOption(
  Schema.Struct({
    providerInstanceId: Schema.String,
    mode: Schema.NullOr(SelectProviderOptionDescriptor),
  }),
);

const decodeConfigOptions = Schema.decodeUnknownOption(
  Schema.Struct({
    providerInstanceId: Schema.String,
    configOptions: Schema.Array(SelectProviderOptionDescriptor),
  }),
);

/** 两态控制只采用当前实例的声明；会话原生模式由模型选项独立控制。 */
export function canUseProviderInteractionModes(
  providers: ReadonlyArray<ServerProvider>,
  instanceId: ProviderInstanceId,
  capabilities?: ModelCapabilities | null,
): boolean {
  const provider = providers.find((candidate) => candidate.instanceId === instanceId);
  return (
    provider !== undefined &&
    provider.showInteractionModeToggle !== false &&
    !capabilities?.optionDescriptors?.some(
      (option) =>
        option.id === ACP_MODE_OPTION_ID ||
        (provider.driver === "opencode" && option.id === "agent"),
    )
  );
}

/** 切换到无两态能力的实例后，旧草稿不能继续携带上一实例的 plan 参数。 */
export function resolveProviderInteractionMode(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly instanceId: ProviderInstanceId;
  readonly capabilities?: ModelCapabilities | null | undefined;
  readonly interactionMode: ProviderInteractionMode;
  readonly modelSelection?: ModelSelection;
}): ProviderInteractionMode {
  const nativeMode = input.capabilities?.optionDescriptors?.find(
    (option) => option.id === CODEX_COLLABORATION_MODE_OPTION_ID && option.type === "select",
  );
  if (
    nativeMode?.type === "select" &&
    input.providers.some(
      (provider) => provider.instanceId === input.instanceId && provider.driver === "codex",
    )
  ) {
    const selected =
      input.modelSelection?.instanceId === input.instanceId
        ? input.modelSelection.options?.find((option) => option.id === nativeMode.id)?.value
        : undefined;
    const mode = nativeMode.options.some((option) => option.id === selected)
      ? selected
      : nativeMode.currentValue;
    return mode === "plan" ? "plan" : "default";
  }
  // 离线队列没有当前能力证据时保留用户草稿，不能把未知误当成明确不支持。
  if (!input.providers.some((provider) => provider.instanceId === input.instanceId)) {
    return input.interactionMode;
  }
  return canUseProviderInteractionModes(input.providers, input.instanceId, input.capabilities)
    ? input.interactionMode
    : "default";
}

/** 计划续接显式选择原生模式，避免“实施计划”仍携带旧 Plan 选项。 */
export function resolveCodexPlanFollowUpSelection(
  selection: ModelSelection,
  capabilities: ModelCapabilities | null | undefined,
  mode: ProviderInteractionMode,
): ModelSelection | null {
  const descriptor = capabilities?.optionDescriptors?.find(
    (option) => option.id === CODEX_COLLABORATION_MODE_OPTION_ID,
  );
  if (descriptor?.type !== "select") {
    if (mode === "plan") return null;
    return selection.options?.some((option) => option.id === CODEX_COLLABORATION_MODE_OPTION_ID)
      ? {
          ...selection,
          options: selection.options.filter(
            (option) => option.id !== CODEX_COLLABORATION_MODE_OPTION_ID,
          ),
        }
      : selection;
  }
  if (!descriptor.options.some((option) => option.id === mode)) return null;
  return {
    ...selection,
    options: [
      ...(selection.options ?? []).filter((option) => option.id !== descriptor.id),
      { id: descriptor.id, value: mode },
    ],
  };
}

/** 只有有效模型快照能撤回旧选择；模式更新不是模型目录，null 恢复全局目录。 */
export function hasSessionModelCatalog(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  instanceId: ProviderInstanceId,
): boolean {
  for (let index = activities.length - 1; index >= 0; index--) {
    const activity = activities[index];
    if (activity?.kind !== "session.models.updated") continue;
    const decoded = decodeModels(activity.payload);
    if (Option.isSome(decoded) && decoded.value.providerInstanceId === instanceId) {
      return decoded.value.models !== null;
    }
  }
  return false;
}

/** 合并同实例会话模型与模式；null 清除覆盖，空数组撤回模型广告，自定义模型保留。 */
export function applySessionModelCatalogs(
  providers: ReadonlyArray<ServerProvider>,
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<ServerProvider> {
  const snapshots = new Map<string, ReadonlyArray<ServerProviderModel> | null>();
  const modes = new Map<string, SelectProviderOptionDescriptor | null>();
  const configs = new Map<string, ReadonlyArray<SelectProviderOptionDescriptor>>();
  const instanceIds = new Set(providers.map((provider) => provider.instanceId));
  const allInstancesResolved = (values: ReadonlyMap<string, unknown>): boolean =>
    [...instanceIds].every((instanceId) => values.has(instanceId));
  for (let index = activities.length - 1; index >= 0; index--) {
    const activity = activities[index];
    if (activity?.kind === "session.config-options.updated") {
      const decoded = decodeConfigOptions(activity.payload);
      if (Option.isSome(decoded) && !configs.has(decoded.value.providerInstanceId)) {
        configs.set(decoded.value.providerInstanceId, decoded.value.configOptions);
      }
      if (
        allInstancesResolved(snapshots) &&
        allInstancesResolved(modes) &&
        allInstancesResolved(configs)
      ) {
        break;
      }
      continue;
    }
    if (activity?.kind === "session.mode.updated") {
      const decoded = decodeMode(activity.payload);
      if (Option.isSome(decoded) && !modes.has(decoded.value.providerInstanceId)) {
        modes.set(decoded.value.providerInstanceId, decoded.value.mode);
      }
      if (
        allInstancesResolved(snapshots) &&
        allInstancesResolved(modes) &&
        allInstancesResolved(configs)
      ) {
        break;
      }
      continue;
    }
    if (activity?.kind !== "session.models.updated") continue;
    const decoded = decodeModels(activity.payload);
    if (Option.isSome(decoded) && !snapshots.has(decoded.value.providerInstanceId)) {
      snapshots.set(decoded.value.providerInstanceId, decoded.value.models);
    }
    if (
      allInstancesResolved(snapshots) &&
      allInstancesResolved(modes) &&
      allInstancesResolved(configs)
    ) {
      break;
    }
  }
  if (snapshots.size === 0 && modes.size === 0 && configs.size === 0) return providers;
  return providers.map((provider) => {
    const models = snapshots.get(provider.instanceId);
    const mode = modes.get(provider.instanceId);
    const configOptions = configs.get(provider.instanceId);
    if (
      (models === undefined || models === null) &&
      mode === undefined &&
      configOptions === undefined
    )
      return provider;
    const resolvedModels =
      models === undefined || models === null
        ? provider.models
        : [
            ...models.map((model) => {
              const existing = provider.models.find((candidate) => candidate.slug === model.slug);
              return {
                ...existing,
                ...model,
                capabilities: model.capabilities ?? existing?.capabilities ?? null,
              };
            }),
            ...provider.models.filter(
              (model) =>
                model.isCustom && !models.some((candidate) => candidate.slug === model.slug),
            ),
          ];
    if (mode === undefined && configOptions === undefined) {
      return resolvedModels === provider.models
        ? provider
        : { ...provider, models: resolvedModels };
    }
    return {
      ...provider,
      models: resolvedModels.map((model) => {
        return {
          ...model,
          capabilities: {
            ...model.capabilities,
            optionDescriptors: [
              ...(model.capabilities?.optionDescriptors ?? []).filter(
                (option) =>
                  (mode === undefined || option.id !== ACP_MODE_OPTION_ID) &&
                  (configOptions === undefined || !option.id.startsWith(ACP_CONFIG_OPTION_PREFIX)),
              ),
              ...(mode ? [mode] : []),
              ...(configOptions ?? []),
            ],
          },
        };
      }),
    };
  });
}
