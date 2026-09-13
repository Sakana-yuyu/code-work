import type { ModelContextRule } from "./ModelCatalog.ts";
import { matchModelContext } from "./ModelCatalog.ts";
import rawCatalog from "./contextWindowCatalog.json" with { type: "json" };

type CatalogRule = {
  readonly pattern?: unknown;
  readonly displayName?: unknown;
  readonly contextWindowTokens?: unknown;
  readonly maxOutputTokens?: unknown;
  readonly supportsVision?: unknown;
  readonly reasoningEfforts?: unknown;
};

const rawRules = (rawCatalog as { readonly rules?: readonly CatalogRule[] }).rules ?? [];

export interface ModelContextCapabilities {
  readonly contextWindowTokens: number;
  /** 模型官方公布的最大输出 token 数；目录未收录时为 undefined。 */
  readonly maxOutputTokens?: number;
  /** 目录核实的图片输入能力；目录未收录时为 undefined（交给启发式兜底）。 */
  readonly supportsVision?: boolean;
  /** 模型支持的思考强度档位（如 GPT-6 的 low..max、Gemini 的 thinking_level）；未收录时为 undefined。 */
  readonly reasoningEfforts?: readonly string[];
}

/**
 * 与 cursor-byok 的模型能力目录保持同一规则顺序。目录携带上下文窗口、
 * 最大输出与视觉能力，避免将价格或其余能力元数据混进 BYOK 设置行为。
 */
export const CONTEXT_WINDOW_RULES: ReadonlyArray<ModelContextRule<ModelContextCapabilities>> =
  rawRules.flatMap((rule) => {
    const contextWindowTokens = rule.contextWindowTokens;
    if (
      typeof rule.pattern !== "string" ||
      typeof contextWindowTokens !== "number" ||
      !Number.isSafeInteger(contextWindowTokens) ||
      contextWindowTokens <= 0
    ) {
      return [];
    }
    const maxOutputTokens = rule.maxOutputTokens;
    const supportsVision = rule.supportsVision;
    const reasoningEfforts = rule.reasoningEfforts;
    return [
      {
        pattern: rule.pattern,
        value: {
          contextWindowTokens,
          ...(typeof maxOutputTokens === "number" &&
          Number.isSafeInteger(maxOutputTokens) &&
          maxOutputTokens > 0
            ? { maxOutputTokens }
            : {}),
          ...(typeof supportsVision === "boolean" ? { supportsVision } : {}),
          ...(Array.isArray(reasoningEfforts) &&
          reasoningEfforts.every((effort) => typeof effort === "string" && effort.trim() !== "")
            ? { reasoningEfforts: reasoningEfforts.map((effort) => effort.trim()) }
            : {}),
        },
      },
    ];
  });

/** 按模型 ID 查内置目录，返回上下文窗口、最大输出与视觉能力；未收录返回 undefined。 */
export const catalogCapabilitiesForModel = (
  modelId: string,
): ModelContextCapabilities | undefined => matchModelContext(modelId, CONTEXT_WINDOW_RULES).value;
