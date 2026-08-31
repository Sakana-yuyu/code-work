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

/** 用户手动触发诊断时，以中转显式值优先，再以内置目录收敛窗口。 */
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
    const catalogWindow = matchModelContext(adapter.modelId, CONTEXT_WINDOW_RULES).value;
    const after = probedWindow ?? catalogWindow ?? before;

    if (after === before) {
      details.push({
        adapterId: adapter.id,
        modelId: adapter.modelId,
        source: "unchanged",
        before,
        after,
      });
      continue;
    }

    const source = probedWindow === undefined ? "catalog" : "probe";
    details.push({ adapterId: adapter.id, modelId: adapter.modelId, source, before, after });
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
    unchanged: details.filter((detail) => detail.before === detail.after).length,
    details,
  };
}
