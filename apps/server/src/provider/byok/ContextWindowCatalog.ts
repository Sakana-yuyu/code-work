import type { ModelContextRule } from "./ModelCatalog.ts";
import rawCatalog from "./contextWindowCatalog.json" with { type: "json" };

type CatalogRule = {
  readonly pattern?: unknown;
  readonly contextWindowTokens?: unknown;
};

const rawRules = (rawCatalog as { readonly rules?: readonly CatalogRule[] }).rules ?? [];

/**
 * 与 cursor-byok 的模型能力目录保持同一规则顺序。这里只取上下文窗口，避免
 * 将价格或额外能力元数据混进 Code Work 的 BYOK 设置行为。
 */
export const CONTEXT_WINDOW_RULES: ReadonlyArray<ModelContextRule<number>> = rawRules.flatMap(
  (rule) => {
    const contextWindowTokens = rule.contextWindowTokens;
    if (
      typeof rule.pattern !== "string" ||
      typeof contextWindowTokens !== "number" ||
      !Number.isSafeInteger(contextWindowTokens) ||
      contextWindowTokens <= 0
    ) {
      return [];
    }
    return [{ pattern: rule.pattern, value: contextWindowTokens }];
  },
);
