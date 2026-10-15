import {
  isProviderDriverKind,
  isProviderAvailable,
  resolveProviderInstanceEnabled,
  type ModelPreferences,
  type ModelSelection,
  type ProviderDriverKind,
  type ServerProvider,
  ServerSettings,
  type ServerSettingsPatch,
} from "@codework/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { deepMerge } from "./Struct.ts";
import { fromLenientJson } from "./schemaJson.ts";
import { createModelSelection } from "./model.ts";
import {
  getBackgroundActivityBaseProfile,
  normalizeBackgroundActivitySettings,
  normalizeServerBackgroundActivitySettings,
  resolveBackgroundActivitySettings,
} from "./backgroundActivitySettings.ts";

const ServerSettingsJson = fromLenientJson(ServerSettings);
const decodeServerSettingsJson = Schema.decodeUnknownOption(ServerSettingsJson);

type LegacyProviderSettings = ServerSettings["providers"][keyof ServerSettings["providers"]];

const getLegacyProviderSettings = (
  settings: ServerSettings,
  provider: ProviderDriverKind,
): LegacyProviderSettings | undefined =>
  (settings.providers as Record<string, LegacyProviderSettings | undefined>)[provider];

export function isModelSelectionProviderEnabled(
  settings: ServerSettings,
  selection: ModelSelection,
): boolean {
  const instanceConfig = settings.providerInstances[selection.instanceId];
  if (instanceConfig !== undefined) {
    return resolveProviderInstanceEnabled(instanceConfig);
  }

  return (
    isProviderDriverKind(selection.instanceId) &&
    getLegacyProviderSettings(settings, selection.instanceId)?.enabled === true
  );
}

export function resolveSourceControlWriterModelSelection(
  settings: ServerSettings,
  providers?: ReadonlyArray<ServerProvider>,
): ModelSelection {
  const selection = settings.sourceControlWriterModelSelection;
  if (!selection || !isModelSelectionProviderEnabled(settings, selection)) {
    return settings.textGenerationModelSelection;
  }
  if (providers === undefined) {
    return selection;
  }

  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  return provider?.enabled === true && isProviderAvailable(provider)
    ? selection
    : settings.textGenerationModelSelection;
}

export interface PersistedServerObservabilitySettings {
  readonly otlpTracesUrl: string | undefined;
  readonly otlpMetricsUrl: string | undefined;
}

export function normalizePersistedServerSettingString(
  value: string | null | undefined,
): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function extractPersistedServerObservabilitySettings(input: {
  readonly observability?: {
    readonly otlpTracesUrl?: string;
    readonly otlpMetricsUrl?: string;
  };
}): PersistedServerObservabilitySettings {
  return {
    otlpTracesUrl: normalizePersistedServerSettingString(input.observability?.otlpTracesUrl),
    otlpMetricsUrl: normalizePersistedServerSettingString(input.observability?.otlpMetricsUrl),
  };
}

export function parsePersistedServerObservabilitySettings(
  raw: string,
): PersistedServerObservabilitySettings {
  const decoded = decodeServerSettingsJson(raw);
  if (Option.isSome(decoded)) {
    return extractPersistedServerObservabilitySettings(decoded.value);
  }
  return { otlpTracesUrl: undefined, otlpMetricsUrl: undefined };
}

function shouldReplaceTextGenerationModelSelection(
  patch: ServerSettingsPatch["textGenerationModelSelection"] | undefined,
): boolean {
  return Boolean(patch && (patch.instanceId !== undefined || patch.model !== undefined));
}

function mergeModelSelectionOptionsById(input: {
  current: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }> | undefined;
  patch: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }> | undefined;
}): Array<{ id: string; value: string | boolean }> | undefined {
  if (input.patch === undefined) {
    return input.current ? [...input.current] : undefined;
  }
  if (input.patch.length === 0) {
    return undefined;
  }

  const merged = new Map((input.current ?? []).map((selection) => [selection.id, selection.value]));
  for (const selection of input.patch) {
    merged.set(selection.id, selection.value);
  }
  return [...merged.entries()].map(([id, value]) => ({ id, value }));
}

export function applyServerSettingsPatch(
  current: ServerSettings,
  patch: ServerSettingsPatch,
): ServerSettings {
  const selectionPatch = patch.textGenerationModelSelection;
  const {
    migrateModelPreferences,
    setModelFavorites,
    setModelsHidden,
    setProviderModelOrder,
    favorites: patchFavorites,
    providerModelPreferences,
    automaticGitFetchInterval,
    providerHealthRefreshInterval,
    backgroundActivityProfile,
    backgroundActivity,
    multicaProviderInstancePreconditions: _multicaProviderInstancePreconditions,
    // `null` entries are delete markers, not partial overrides — keep them
    // out of deepMerge; the explicit merge below owns this key.
    projectSettingsOverrides,
    ...patchForMerge
  } = patch;
  const currentBackgroundActivity = normalizeServerBackgroundActivitySettings(current);
  const backgroundActivityPatch =
    backgroundActivityProfile !== undefined
      ? {
          schemaVersion: 1 as const,
          profile:
            automaticGitFetchInterval !== undefined || providerHealthRefreshInterval !== undefined
              ? ("custom" as const)
              : backgroundActivityProfile,
          ...(automaticGitFetchInterval !== undefined || providerHealthRefreshInterval !== undefined
            ? { baseProfile: backgroundActivityProfile }
            : {}),
          overrides: {
            ...(automaticGitFetchInterval !== undefined ? { automaticGitFetchInterval } : {}),
            ...(providerHealthRefreshInterval !== undefined
              ? { providerHealthRefreshInterval }
              : {}),
          },
        }
      : automaticGitFetchInterval !== undefined || providerHealthRefreshInterval !== undefined
        ? {
            schemaVersion: 1 as const,
            profile: "custom" as const,
            baseProfile: getBackgroundActivityBaseProfile(currentBackgroundActivity),
            overrides: {
              ...(currentBackgroundActivity.profile === "custom"
                ? currentBackgroundActivity.overrides
                : {}),
              ...(automaticGitFetchInterval !== undefined ? { automaticGitFetchInterval } : {}),
              ...(providerHealthRefreshInterval !== undefined
                ? { providerHealthRefreshInterval }
                : {}),
            },
          }
        : undefined;
  const initialFavorites =
    patchFavorites ?? current.favorites ?? migrateModelPreferences?.favorites ?? null;
  const favorites =
    setModelFavorites?.reduce((current, change) => {
      const exists = current.some(
        (favorite) => favorite.provider === change.provider && favorite.model === change.model,
      );
      return change.favorite
        ? exists
          ? current
          : [...current, { provider: change.provider, model: change.model }]
        : current.filter(
            (favorite) => favorite.provider !== change.provider || favorite.model !== change.model,
          );
    }, initialFavorites ?? []) ?? initialFavorites;
  const initialModelPreferences =
    providerModelPreferences ??
    current.providerModelPreferences ??
    migrateModelPreferences?.providerModelPreferences ??
    null;
  let nextModelPreferences = initialModelPreferences;
  for (const change of setModelsHidden ?? []) {
    const preferences = nextModelPreferences?.[change.provider] ?? {
      hiddenModels: [],
      modelOrder: [],
    };
    const hiddenModels = preferences.hiddenModels.filter((model) => model !== change.model);
    if (change.hidden) hiddenModels.push(change.model);
    nextModelPreferences = {
      ...nextModelPreferences,
      [change.provider]: { ...preferences, hiddenModels },
    };
  }
  if (setProviderModelOrder) {
    const preferences = nextModelPreferences?.[setProviderModelOrder.provider] ?? {
      hiddenModels: [],
      modelOrder: [],
    };
    nextModelPreferences = {
      ...nextModelPreferences,
      [setProviderModelOrder.provider]: {
        ...preferences,
        modelOrder: [...setProviderModelOrder.modelOrder],
      },
    };
  }
  // 新旧客户端可交替修改；旧开关的明确写入也必须覆盖已经保存的三态选择。
  const streamingMode =
    patch.responseStreamingMode ??
    (patch.enableLegacyTokenStreaming === undefined
      ? undefined
      : patch.enableLegacyTokenStreaming
        ? "token"
        : "turn");
  const next = deepMerge(current, {
    ...patchForMerge,
    ...(streamingMode === undefined
      ? {}
      : {
          responseStreamingMode: streamingMode,
          enableLegacyTokenStreaming: streamingMode === "token",
        }),
  });
  // settings RPC 回传的本地账号 credentialRef 已脱敏为空串；客户端提交其它设置时，
  // 不能让这份回传快照覆盖服务端仍在使用的 SecretStore 索引。
  // localAccountPool 在契约中是完整替换，不能深合并，否则删除的账号会被当前快照重新带回。
  const localAccountPoolPatch = patch.localAccountPool;
  const localAccountPoolSource = localAccountPoolPatch ?? next.localAccountPool;
  const localAccountPool = {
    ...localAccountPoolSource,
    accounts: Object.fromEntries(
      Object.entries(localAccountPoolSource.accounts).flatMap(([id, account]) => {
        const currentAccount =
          current.localAccountPool.accounts[id as keyof typeof current.localAccountPool.accounts];
        const restored =
          account.credentialRef.length > 0 || currentAccount === undefined
            ? account
            : { ...account, credentialRef: currentAccount.credentialRef };
        return restored.credentialRef.length > 0 ? [[id, restored] as const] : [];
      }),
    ),
  };
  const nextWithReplacementsBase = {
    ...next,
    favorites,
    providerModelPreferences: nextModelPreferences,
    localAccountPool,
    ...(backgroundActivity !== undefined
      ? {
          backgroundActivity: {
            ...deepMerge(currentBackgroundActivity, backgroundActivity),
            ...(backgroundActivity.overrides !== undefined
              ? { overrides: backgroundActivity.overrides }
              : {}),
          },
        }
      : { backgroundActivity: currentBackgroundActivity }),
    ...(backgroundActivity === undefined && backgroundActivityPatch !== undefined
      ? { backgroundActivity: backgroundActivityPatch }
      : {}),
    ...(patch.providerInstances !== undefined
      ? { providerInstances: patch.providerInstances }
      : {}),
    ...(patch.worktreesDirectory !== undefined &&
    patch.worktreesDirectory !== current.worktreesDirectory
      ? {
          previousWorktreesDirectories: [
            ...current.previousWorktreesDirectories.filter(
              (directory) => directory !== patch.worktreesDirectory,
            ),
            ...(current.worktreesDirectory !== "" &&
            !current.previousWorktreesDirectories.includes(current.worktreesDirectory)
              ? [current.worktreesDirectory]
              : []),
          ],
        }
      : {}),
    ...(projectSettingsOverrides !== undefined
      ? {
          // Per-project entries replace wholesale; `null` removes a project's
          // overrides entirely. deepMerge would resurrect keys a client meant
          // to drop, so this cannot ride the generic merge.
          projectSettingsOverrides: Object.fromEntries(
            (() => {
              const merged = new Map(Object.entries(current.projectSettingsOverrides));
              for (const [projectId, entry] of Object.entries(projectSettingsOverrides)) {
                if (entry === null) {
                  merged.delete(projectId);
                } else {
                  merged.set(projectId, entry);
                }
              }
              return merged;
            })(),
          ),
        }
      : {}),
    ...(patch.mcpServers !== undefined ? { mcpServers: patch.mcpServers } : {}),
    ...(patch.sourceControlWriterModelSelection !== undefined
      ? { sourceControlWriterModelSelection: patch.sourceControlWriterModelSelection }
      : {}),
    ...(automaticGitFetchInterval !== undefined ? { automaticGitFetchInterval } : {}),
    ...(providerHealthRefreshInterval !== undefined ? { providerHealthRefreshInterval } : {}),
  };
  const normalizedBackgroundActivity = normalizeBackgroundActivitySettings(
    nextWithReplacementsBase.backgroundActivity,
  );
  const resolvedBackgroundActivity = resolveBackgroundActivitySettings(
    normalizedBackgroundActivity,
  );
  const nextWithReplacements = {
    ...nextWithReplacementsBase,
    backgroundActivity: normalizedBackgroundActivity,
    automaticGitFetchInterval: resolvedBackgroundActivity.automaticGitFetchInterval,
    providerHealthRefreshInterval: resolvedBackgroundActivity.providerHealthRefreshInterval,
    backgroundActivityProfile: resolvedBackgroundActivity.profile,
  };
  if (!selectionPatch) {
    return nextWithReplacements;
  }

  const instanceId = selectionPatch.instanceId ?? current.textGenerationModelSelection.instanceId;
  const model = selectionPatch.model ?? current.textGenerationModelSelection.model;
  const options = shouldReplaceTextGenerationModelSelection(selectionPatch)
    ? selectionPatch.options
    : mergeModelSelectionOptionsById({
        current: current.textGenerationModelSelection.options,
        patch: selectionPatch.options,
      });

  return {
    ...nextWithReplacements,
    textGenerationModelSelection: createModelSelection(instanceId, model, options),
  };
}

/** Resolve legacy local preferences only until the environment has a saved value. */
export function resolveModelPreferences(
  settings: Pick<ServerSettings, "favorites" | "providerModelPreferences">,
  legacy: Partial<ModelPreferences> = {},
): ModelPreferences {
  return {
    favorites: settings.favorites ?? legacy.favorites ?? [],
    providerModelPreferences:
      settings.providerModelPreferences ?? legacy.providerModelPreferences ?? {},
  };
}

/** Empty legacy values do not claim ownership before another client can migrate its saved list. */
export function modelPreferencesMigrationPatch(
  settings: Pick<ServerSettings, "favorites" | "providerModelPreferences">,
  legacy: Partial<ModelPreferences>,
): ServerSettingsPatch | null {
  const favorites =
    settings.favorites === null && (legacy.favorites?.length ?? 0) > 0
      ? legacy.favorites
      : undefined;
  const providerModelPreferences =
    settings.providerModelPreferences === null &&
    Object.keys(legacy.providerModelPreferences ?? {}).length > 0
      ? legacy.providerModelPreferences
      : undefined;
  return favorites === undefined && providerModelPreferences === undefined
    ? null
    : {
        migrateModelPreferences: {
          ...(favorites === undefined ? {} : { favorites }),
          ...(providerModelPreferences === undefined ? {} : { providerModelPreferences }),
        },
      };
}
