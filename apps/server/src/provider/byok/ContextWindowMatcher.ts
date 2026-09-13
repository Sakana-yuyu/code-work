import type {
  ByokContextWindowMatchDetail,
  ByokDiscoveredModel,
  ByokModelAdapter,
} from "@codework/contracts";

import { CONTEXT_WINDOW_RULES } from "./ContextWindowCatalog.ts";
import { matchModelContext, normalizeModelID } from "./ModelCatalog.ts";

export interface ContextWindowMatchSummary {
  readonly total: number;
  readonly fromCatalog: number;
  readonly fromProbe: number;
  readonly unchanged: number;
  readonly details: ReadonlyArray<ByokContextWindowMatchDetail>;
}

/** 判断模型是否可由内置目录提供上下文窗口。 */
export const hasCatalogContextWindow = (modelId: string): boolean =>
  matchModelContext(modelId, CONTEXT_WINDOW_RULES).covered;

/**
 * 用户手动触发诊断时，以中转显式值优先，再以内置目录收敛窗口；
 * 最大输出 token 只在适配器未显式设置时由目录回填（fill-if-missing）。
 */
export function matchContextWindows(
  adapters: ReadonlyArray<ByokModelAdapter>,
  probeModels: ReadonlyArray<ByokDiscoveredModel> = [],
): ContextWindowMatchSummary {
  const details: ByokContextWindowMatchDetail[] = [];
  let fromCatalog = 0;
  let fromProbe = 0;

  const windowsByModelId = new Map<string, number>();
  for (const model of probeModels) {
    const modelId = normalizeModelID(model.id);
    if (
      modelId &&
      model.contextWindowTokens !== undefined &&
      model.contextWindowTokens > 0 &&
      !windowsByModelId.has(modelId)
    ) {
      windowsByModelId.set(modelId, model.contextWindowTokens);
    }
  }

  for (const adapter of adapters) {
    const before = adapter.contextWindowTokens;
    const probedWindow = windowsByModelId.get(normalizeModelID(adapter.modelId));
    const catalogCapabilities = matchModelContext(adapter.modelId, CONTEXT_WINDOW_RULES).value;
    const catalogWindow = catalogCapabilities?.contextWindowTokens;
    // 中转 /models 返回的是当前渠道的显式能力，优先采用；内置目录只负责
    // 收敛明显过大的值，不能覆盖用户主动设置的更小窗口。
    const after =
      probedWindow ??
      (catalogWindow !== undefined && (before <= 0 || catalogWindow < before)
        ? catalogWindow
        : before);

    // 最大输出：目录值仅在适配器未设置时回填，用户显式值永远优先。
    const maxOutputBefore = adapter.maxOutputTokens;
    const maxOutputAfter =
      maxOutputBefore === undefined ? catalogCapabilities?.maxOutputTokens : undefined;
    const maxOutputChanged = maxOutputAfter !== undefined;

    if (after === before && !maxOutputChanged) {
      details.push({
        adapterId: adapter.id,
        modelId: adapter.modelId,
        source: "unchanged",
        before,
        after,
      });
      continue;
    }

    const source = after === before ? "catalog" : probedWindow === undefined ? "catalog" : "probe";
    details.push({
      adapterId: adapter.id,
      modelId: adapter.modelId,
      source,
      before,
      after,
      ...(maxOutputBefore !== undefined ? { maxOutputBefore } : {}),
      ...(maxOutputAfter !== undefined ? { maxOutputAfter } : {}),
    });
    if (source === "probe") {
      fromProbe += 1;
    } else {
      fromCatalog += 1;
    }
  }

  return {
    total: adapters.length,
    fromCatalog,
    fromProbe,
    unchanged: details.filter(
      (detail) => detail.before === detail.after && detail.maxOutputAfter === undefined,
    ).length,
    details,
  };
}
