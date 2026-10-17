/**
 * ByokProvider — snapshot / health-check layer for the built-in BYOK engine.
 *
 * The engine is fully in-process TypeScript calling user-configured model
 * adapters (OpenAI- or Anthropic-compatible endpoints) directly, so there is
 * no gateway to probe and no binary to launch. The snapshot reflects the
 * configured adapters:
 *
 *   - disabled → warning "disabled in settings".
 *   - enabled with no adapters → warning prompting the user to add one.
 *   - enabled with adapters → available ("N model adapters configured").
 *
 * 状态检查与设置页共用目录服务；目录失败不代表已配置模型不可调用。
 *
 * @module provider/Layers/ByokProvider
 */
import type { ByokSettings, ModelCapabilities, ServerProviderModel } from "@codework/contracts";
import { createModelCapabilities } from "@codework/shared/model";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { catalogCapabilitiesForModel } from "../byok/ContextWindowCatalog.ts";
import {
  ByokCatalog,
  byokCatalogIdentity,
  byokCatalogTargetFromAdapter,
} from "../byok/ByokCatalog.ts";
import { BYOK_HTTP_TIMEOUT_MS } from "../byok/byokHttp.ts";
import { BYOK_SLASH_COMMANDS } from "../byok/ByokSlashCommands.ts";
import { buildServerProvider, type ServerProviderDraft } from "../providerSnapshot.ts";

const BYOK_PRESENTATION = {
  displayName: "Custom model service",
  showInteractionModeToggle: false,
} as const;

/**
 * 思考强度档位保守兜底：openai 协议透传 `reasoning_effort`（none 表示显式
 * 关闭思考），anthropic 协议映射 thinking:adaptive + output_config.effort。
 */
const FALLBACK_REASONING_EFFORTS = ["none", "low", "medium", "high"] as const;

/**
 * BYOK 渠道模型始终暴露思考强度选项：内置目录收录了档位时用目录档位，未
 * 收录的模型用兜底档位。选项不设默认值——用户不点选时请求不带该字段，
 * 保持端点原生默认。
 */
export const byokModelCapabilities = (
  modelId: string,
  descriptorId: "reasoningEffort" | "effort" = "reasoningEffort",
): ModelCapabilities => {
  const catalogEfforts = catalogCapabilitiesForModel(modelId)?.reasoningEfforts;
  const efforts =
    catalogEfforts !== undefined && catalogEfforts.length > 0
      ? catalogEfforts
      : FALLBACK_REASONING_EFFORTS;
  return createModelCapabilities({
    optionDescriptors: [
      {
        id: descriptorId,
        label: "Reasoning",
        type: "select",
        options: efforts.map((effort) => ({ id: effort, label: effort })),
      },
    ],
  });
};

const normalizedRelayURL = (baseURL: string): string => baseURL.trim().replace(/\/+$/u, "");

const relayKey = (adapter: ByokSettings["adapters"][number]): string =>
  `${adapter.protocol}\u0000${normalizedRelayURL(adapter.baseURL)}`;

// ── model snapshots ────────────────────────────────────────────────

/** Map configured model adapters to provider model entries (slug = adapter id). */
export function byokModelsFromSettings(
  byokSettings: ByokSettings,
  discoveredModels: ReadonlyArray<ServerProviderModel> = [],
): ReadonlyArray<ServerProviderModel> {
  const adapterModels = byokSettings.adapters.map((adapter) => {
    // The picker labels a model `instance · subProvider`. Prefer the
    // adapter's group (the vendor/relay it points at) so same-named models
    // from different vendors stay distinguishable; fall back to the raw
    // model id as before.
    const subProvider = adapter.groupName?.trim() || adapter.modelId.trim();
    return {
      slug: adapter.id,
      name: adapter.displayName.trim().length > 0 ? adapter.displayName : adapter.modelId,
      ...(subProvider.length > 0 ? { subProvider } : {}),
      isCustom: false,
      capabilities: byokModelCapabilities(adapter.modelId),
    };
  });
  return [...adapterModels, ...discoveredModels];
}

export function buildInitialByokProviderSnapshot(
  byokSettings: ByokSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = byokModelsFromSettings(byokSettings);

    if (!byokSettings.enabled) {
      return buildServerProvider({
        presentation: BYOK_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        slashCommands: BYOK_SLASH_COMMANDS,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Custom model service is disabled in Code Work settings.",
        },
      });
    }

    if (byokSettings.adapters.length === 0) {
      return buildServerProvider({
        presentation: BYOK_PRESENTATION,
        enabled: true,
        checkedAt,
        models,
        slashCommands: BYOK_SLASH_COMMANDS,
        probe: {
          installed: true,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "No model adapters are configured yet. Add one in Settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: BYOK_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      slashCommands: BYOK_SLASH_COMMANDS,
      probe: {
        installed: true,
        version: null,
        status: "ready",
        auth: { status: "authenticated", type: "byok" },
        message: `${byokSettings.adapters.length} model adapter${
          byokSettings.adapters.length === 1 ? "" : "s"
        } configured.`,
      },
    });
  });
}

// ── health check ───────────────────────────────────────────────────

export const checkByokProviderStatus = Effect.fn("checkByokProviderStatus")(function* (
  suppliedSettings: ByokSettings,
  options?: {
    /** 完整刷新超时前保留各目标已完成的模型，不向客户端单独发布半轮快照。 */
    readonly onModels?: (models: ReadonlyArray<ServerProviderModel>) => void;
  },
): Effect.fn.Return<ServerProviderDraft, never, ByokCatalog> {
  const onModels = options?.onModels;
  // 多目标检查只使用开始时的配置，后续编辑应由下一次刷新读取。
  const byokSettings = {
    ...suppliedSettings,
    adapters: suppliedSettings.adapters.map((adapter) => ({
      ...adapter,
      ...(adapter.modelCatalogURLs === undefined
        ? {}
        : { modelCatalogURLs: [...adapter.modelCatalogURLs] }),
    })),
  };
  const catalog = yield* ByokCatalog;

  if (!byokSettings.enabled) {
    return yield* buildInitialByokProviderSnapshot(byokSettings);
  }
  if (byokSettings.adapters.length === 0) {
    return yield* buildInitialByokProviderSnapshot(byokSettings);
  }

  // 同一中转的模型通道共用一次目录探测，避免重复请求和重复模型快照。
  const discoveredModels: ServerProviderModel[] = [];
  const configuredModelsByRelay = new Set(
    byokSettings.adapters.map((adapter) => `${relayKey(adapter)}\u0000${adapter.modelId.trim()}`),
  );
  const discoveredModelsByRelay = new Set<string>();
  const probedRelays = new Set<string>();
  const deadline = (yield* Clock.currentTimeMillis) + BYOK_HTTP_TIMEOUT_MS;
  // 预算限制当前等待者；其他客户端仍在使用的目录加载不受此处超时影响。
  for (const adapter of byokSettings.adapters) {
    if (adapter.baseURL.trim().length === 0) {
      continue;
    }
    const target = byokCatalogTargetFromAdapter(adapter);
    const connectionKey = byokCatalogIdentity(target);
    if (probedRelays.has(connectionKey)) continue;
    probedRelays.add(connectionKey);

    const result = yield* catalog.fetchCatalog(target, {
      timeoutMs: Math.max(0, deadline - (yield* Clock.currentTimeMillis)),
    });
    const discovered = result.value.status === "failed" ? result.previous : result.value;
    if (discovered !== undefined) {
      for (const model of discovered.models) {
        const normalizedModelId = model.id.trim();
        if (normalizedModelId.length === 0) continue;
        const modelRelayKey = `${relayKey(adapter)}\u0000${normalizedModelId}`;
        if (
          configuredModelsByRelay.has(modelRelayKey) ||
          discoveredModelsByRelay.has(modelRelayKey)
        ) {
          continue;
        }
        discoveredModelsByRelay.add(modelRelayKey);
        discoveredModels.push({
          slug: `${adapter.id}/${normalizedModelId}`,
          name: normalizedModelId,
          // Group first (vendor/relay), adapter display name as fallback.
          subProvider: adapter.groupName?.trim() || adapter.displayName,
          isCustom: false,
          // 发现的模型同样过目录匹配：命中给目录档位，未命中给兜底档位。
          capabilities: byokModelCapabilities(normalizedModelId),
        });
      }
    }
    if (onModels !== undefined) {
      yield* Effect.sync(() => onModels(byokModelsFromSettings(byokSettings, discoveredModels)));
    }
  }
  const models = byokModelsFromSettings(byokSettings, discoveredModels);
  return buildServerProvider({
    presentation: BYOK_PRESENTATION,
    enabled: true,
    checkedAt: DateTime.formatIso(yield* DateTime.now),
    models,
    slashCommands: BYOK_SLASH_COMMANDS,
    probe: {
      installed: true,
      version: null,
      // 模型列表接口不是所有兼容网关都开放；不要把 /models 检查失败误报成全局不可用。
      status: "ready",
      auth: { status: "authenticated", type: "byok" },
      message: `${byokSettings.adapters.length} model adapter${
        byokSettings.adapters.length === 1 ? "" : "s"
      } configured.`,
    },
  });
});
