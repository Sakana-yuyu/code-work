import {
  ACP_MODE_OPTION_ID,
  ACP_CONFIG_OPTION_PREFIX,
  SelectProviderOptionDescriptor,
  ServerProviderModel,
  type OrchestrationThreadActivity,
  type ServerProvider,
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

/** 合并同实例会话模型与模式；null 清除覆盖，空数组撤回模型广告，自定义模型保留。 */
export function applySessionModelCatalogs(
  providers: ReadonlyArray<ServerProvider>,
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<ServerProvider> {
  const snapshots = new Map<string, ReadonlyArray<ServerProviderModel> | null>();
  const modes = new Map<string, SelectProviderOptionDescriptor | null>();
  const configs = new Map<string, ReadonlyArray<SelectProviderOptionDescriptor>>();
  for (let index = activities.length - 1; index >= 0; index--) {
    const activity = activities[index];
    if (activity?.kind === "session.config-options.updated") {
      const decoded = decodeConfigOptions(activity.payload);
      if (Option.isSome(decoded) && !configs.has(decoded.value.providerInstanceId)) {
        configs.set(decoded.value.providerInstanceId, decoded.value.configOptions);
      }
      continue;
    }
    if (activity?.kind === "session.mode.updated") {
      const decoded = decodeMode(activity.payload);
      if (Option.isSome(decoded) && !modes.has(decoded.value.providerInstanceId)) {
        modes.set(decoded.value.providerInstanceId, decoded.value.mode);
      }
      continue;
    }
    if (activity?.kind !== "session.models.updated") continue;
    const decoded = decodeModels(activity.payload);
    if (Option.isSome(decoded) && !snapshots.has(decoded.value.providerInstanceId)) {
      snapshots.set(decoded.value.providerInstanceId, decoded.value.models);
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
