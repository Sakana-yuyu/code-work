import type {
  ModelCapabilities,
  ModelSelection,
  ProviderInteractionMode,
  OrchestrationThreadActivity,
  ServerConfig as CodeworkServerConfig,
} from "@codework/contracts";
import { CODEX_COLLABORATION_MODE_OPTION_ID } from "@codework/contracts";
import {
  applySessionModelCatalogs,
  hasSessionModelCatalog,
  resolveProviderInteractionMode,
} from "@codework/client-runtime/providerModels";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionDescriptors,
} from "@codework/shared/model";

export type ModelOption = {
  readonly key: string;
  readonly label: string;
  readonly subtitle: string;
  readonly providerKey: string;
  readonly providerLabel: string;
  readonly providerDriver: string;
  readonly isDefault: boolean;
  readonly isLegacy: boolean;
  readonly isUnavailable?: boolean;
  readonly isHidden?: boolean;
  readonly canHide?: boolean;
  readonly capabilities: ModelCapabilities | null;
  readonly selection: ModelSelection;
  readonly providerUpdateRequired?: ProviderUpdateRequired;
};

type ProviderUpdateRequired = Pick<
  CodeworkServerConfig["providers"][number],
  "driver" | "updateRequiredModels"
>;

export type ProviderGroup = {
  readonly providerKey: string;
  readonly providerLabel: string;
  readonly models: ReadonlyArray<ModelOption>;
  /** The provider fields that name announced models its CLI is too old to run. */
  readonly updateRequired?: ProviderUpdateRequired;
};

function providerDisplayLabel(provider: {
  readonly displayName?: string | undefined;
  readonly driver: string;
  readonly instanceId: string;
}): string {
  if (provider.displayName) return provider.displayName;
  switch (provider.driver) {
    case "codex":
      return "Codex";
    case "claudeAgent":
      return "Claude";
    case "cursor":
      return "Cursor";
    case "grok":
      return "Grok";
    case "kimi":
      return "Kimi";
    case "antigravity":
      return "Antigravity";
    case "opencode":
      return "OpenCode";
    case "byok":
      return "Custom model service";
    case "piAgent":
      return "Pi";
    case "ompAgent":
      return "OhMyPi";
    case "zcodeAgent":
      return "ZCode";
    case "acpAgent":
      return "ACP Agent";
    default:
      return provider.instanceId;
  }
}

function normalizeSelectionOptions(
  selection: ModelSelection,
  capabilities: ModelCapabilities | null,
): ModelSelection {
  if (!capabilities) {
    return selection;
  }
  const options = buildProviderOptionSelectionsFromDescriptors(
    getProviderOptionDescriptors({
      caps: capabilities,
      selections: selection.options,
    }),
  );
  return options
    ? { ...selection, options }
    : {
        instanceId: selection.instanceId,
        model: selection.model,
      };
}

/**
 * A stored model selection is only usable when its provider instance is
 * currently enabled, installed, and authenticated on the server. Returns the
 * selection unchanged when usable, otherwise `null` so callers fall through to
 * the server's default model. A missing config (environment offline) cannot be
 * validated, so stored selections pass through untouched.
 */
export function resolveSelectableModelSelection(
  config: CodeworkServerConfig | null | undefined,
  selection: ModelSelection | null,
): ModelSelection | null {
  if (!selection || !config) {
    return selection;
  }
  const provider = config.providers.find(
    (candidate) => candidate.instanceId === selection.instanceId,
  );
  return provider &&
    provider.enabled &&
    provider.installed &&
    provider.auth.status !== "unauthenticated" &&
    (provider.auth.type !== "byok" ||
      provider.models.some((model) => model.slug === selection.model))
    ? selection
    : null;
}

/**
 * Like resolveSelectableModelSelection, but additionally rejects legacy
 * models. Used for implicit defaults (stored draft, project last-used): a
 * new thread should never quietly start on a legacy model, so those fall
 * through to the provider's default instead. Explicit picks in the settings
 * sheet are unaffected.
 */
export function resolveDefaultableModelSelection(
  config: CodeworkServerConfig | null | undefined,
  selection: ModelSelection | null,
): ModelSelection | null {
  const usable = resolveSelectableModelSelection(config, selection);
  if (!usable || !config) {
    return usable;
  }
  const provider = config.providers.find((candidate) => candidate.instanceId === usable.instanceId);
  const model = provider?.models.find((candidate) => candidate.slug === usable.model);
  return model?.isLegacy === true ? null : usable;
}

export function buildModelOptions(
  config: CodeworkServerConfig | null | undefined,
  fallbackModelSelection: ModelSelection | null,
  activities: ReadonlyArray<OrchestrationThreadActivity> = [],
  includeHidden = false,
): ReadonlyArray<ModelOption> {
  const options = new Map<string, ModelOption>();
  const providers = applySessionModelCatalogs(config?.providers ?? [], activities);
  const selectedProvider = providers.find(
    (provider) => provider.instanceId === fallbackModelSelection?.instanceId,
  );
  const selectionRemoved =
    fallbackModelSelection !== null &&
    hasSessionModelCatalog(activities, fallbackModelSelection.instanceId) &&
    selectedProvider !== undefined &&
    !selectedProvider.models.some((model) => model.slug === fallbackModelSelection?.model);

  for (const provider of providers) {
    if (!provider.enabled || !provider.installed || provider.auth.status === "unauthenticated") {
      continue;
    }

    const providerLabel = providerDisplayLabel(provider);
    const updateRequired = provider.updateRequiredModels?.length
      ? { driver: provider.driver, updateRequiredModels: provider.updateRequiredModels }
      : undefined;
    const preferences = config?.settings?.providerModelPreferences?.[provider.instanceId];
    const hiddenModels = new Set(preferences?.hiddenModels ?? []);
    const order = new Map((preferences?.modelOrder ?? []).map((slug, index) => [slug, index]));
    const models = provider.models.filter(
      (model) => includeHidden || model.isCustom || !hiddenModels.has(model.slug),
    );
    if (order.size > 0)
      models.sort((a, b) => (order.get(a.slug) ?? Infinity) - (order.get(b.slug) ?? Infinity));
    for (const model of models) {
      const key = `${provider.instanceId}:${model.slug}`;
      options.set(key, {
        key,
        label: model.name,
        subtitle: providerLabel,
        providerKey: provider.instanceId,
        providerLabel,
        providerDriver: provider.driver,
        isHidden: !model.isCustom && hiddenModels.has(model.slug),
        canHide: !model.isCustom,
        isDefault: model.isDefault === true,
        isLegacy: model.isLegacy === true,
        ...(updateRequired ? { providerUpdateRequired: updateRequired } : {}),
        capabilities: model.capabilities,
        selection: normalizeSelectionOptions(
          {
            instanceId: provider.instanceId,
            model: model.slug,
          },
          model.capabilities,
        ),
      });
    }
  }

  if (
    !selectionRemoved &&
    fallbackModelSelection &&
    resolveSelectableModelSelection(config, fallbackModelSelection) &&
    (!config?.settings?.providerModelPreferences?.[
      fallbackModelSelection.instanceId
    ]?.hiddenModels.includes(fallbackModelSelection.model) ||
      config?.providers
        .find((provider) => provider.instanceId === fallbackModelSelection.instanceId)
        ?.models.find((model) => model.slug === fallbackModelSelection.model)?.isCustom)
  ) {
    const key = `${fallbackModelSelection.instanceId}:${fallbackModelSelection.model}`;
    const existing = options.get(key);
    if (existing) {
      options.set(key, {
        ...existing,
        selection: normalizeSelectionOptions(fallbackModelSelection, existing.capabilities),
      });
    } else {
      const provider = config?.providers.find(
        (candidate) => candidate.instanceId === fallbackModelSelection.instanceId,
      );
      const providerLabel = fallbackModelSelection.instanceId;
      const providerDriver = provider?.driver ?? fallbackModelSelection.instanceId;
      options.set(key, {
        key,
        label:
          provider?.models.find((model) => model.slug === fallbackModelSelection.model)?.name ??
          fallbackModelSelection.model,
        subtitle: providerLabel,
        providerKey: fallbackModelSelection.instanceId,
        providerLabel,
        providerDriver,
        isDefault: false,
        isLegacy:
          provider?.models.find((model) => model.slug === fallbackModelSelection.model)
            ?.isLegacy === true,
        ...(provider?.updateRequiredModels?.some(
          (gated) => gated.slug === fallbackModelSelection.model,
        )
          ? { isUnavailable: true }
          : {}),
        capabilities:
          provider?.models.find((model) => model.slug === fallbackModelSelection.model)
            ?.capabilities ?? null,
        selection: fallbackModelSelection,
      });
    }
  }

  return [...options.values()];
}

/** 已撤回模型只回落到当前实例目录；未知或离线选择由菜单保留。 */
export function resolveThreadModelOption(
  options: ReadonlyArray<ModelOption>,
  selection: ModelSelection,
): ModelOption | null {
  const current = options.find(
    (option) =>
      option.selection.instanceId === selection.instanceId &&
      option.selection.model === selection.model,
  );
  if (current) return current;
  const candidates = options.filter(
    (option) => option.selection.instanceId === selection.instanceId,
  );
  const fallback = candidates.find((option) => option.isDefault) ?? candidates[0];
  return fallback
    ? {
        ...fallback,
        selection: fallback.capabilities
          ? normalizeSelectionOptions(
              { ...selection, model: fallback.selection.model },
              fallback.capabilities,
            )
          : fallback.selection,
      }
    : null;
}

/** 新任务快照与菜单采用同一目录；原生模式优先于旧版两态偏好。 */
export function resolveModelInteractionSettings(
  config: CodeworkServerConfig | null | undefined,
  selection: ModelSelection,
  interactionMode: ProviderInteractionMode,
): { modelSelection: ModelSelection; interactionMode: ProviderInteractionMode } {
  if (!config) return { modelSelection: selection, interactionMode };
  const option = buildModelOptions(config, selection).find(
    (candidate) =>
      candidate.selection.instanceId === selection.instanceId &&
      candidate.selection.model === selection.model,
  );
  let modelSelection = option?.selection ?? selection;
  const provider = config.providers.find(
    (candidate) => candidate.instanceId === selection.instanceId,
  );
  // 旧模型缺少描述时，也不能向在线Codex发送已经撤回的原生模式。
  if (
    provider?.driver === "codex" &&
    !option?.capabilities?.optionDescriptors?.some(
      (descriptor) => descriptor.id === CODEX_COLLABORATION_MODE_OPTION_ID,
    ) &&
    modelSelection.options?.some((value) => value.id === CODEX_COLLABORATION_MODE_OPTION_ID)
  ) {
    modelSelection = {
      ...modelSelection,
      options: modelSelection.options.filter(
        (value) => value.id !== CODEX_COLLABORATION_MODE_OPTION_ID,
      ),
    };
  }
  return {
    modelSelection,
    interactionMode: resolveProviderInteractionMode({
      providers: config.providers,
      instanceId: modelSelection.instanceId,
      capabilities: option?.capabilities,
      modelSelection,
      interactionMode,
    }),
  };
}

export function groupByProvider(options: ReadonlyArray<ModelOption>): ReadonlyArray<ProviderGroup> {
  const groups = new Map<
    string,
    {
      providerLabel: string;
      models: ModelOption[];
      updateRequired: ProviderUpdateRequired | undefined;
    }
  >();
  for (const option of options) {
    const existing = groups.get(option.providerKey);
    if (existing) {
      existing.models.push(option);
      existing.updateRequired ??= option.providerUpdateRequired;
    } else {
      groups.set(option.providerKey, {
        providerLabel: option.providerLabel,
        models: [option],
        updateRequired: option.providerUpdateRequired,
      });
    }
  }

  return [...groups.entries()].map(([providerKey, group]) => ({
    providerKey,
    providerLabel: group.providerLabel,
    models: group.models,
    ...(group.updateRequired ? { updateRequired: group.updateRequired } : {}),
  }));
}

export function getThreadProviderGroups(
  groups: ReadonlyArray<ProviderGroup>,
  currentInstanceId: string,
  state: { readonly isRunning: boolean; readonly isStarted: boolean },
): ReadonlyArray<ProviderGroup> {
  // 已开始的对话锁定在当前 Agent 实例：各 Agent 的会话上下文互不相通，
  // 中途换 Agent 会丢掉全部进展（运行中同样锁定）。当前实例已不在列表
  // （例如被删除）时退回全部分组，避免选择器被清空。
  if (!state.isRunning && !state.isStarted) {
    return groups;
  }
  const locked = groups.filter((group) => group.providerKey === currentInstanceId);
  return locked.length > 0 ? locked : groups;
}
