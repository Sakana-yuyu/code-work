import {
  CODEX_COLLABORATION_MODE_OPTION_ID,
  type ModelSelection,
  type ProviderInteractionMode,
} from "@codework/contracts";
import {
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
} from "@codework/shared/model";

/** 只接受当前原生协议可执行的模式标识，未知值不提升为 Plan。 */
export function getCodexCollaborationModeOptionValue(
  modelSelection: ModelSelection | null | undefined,
): ProviderInteractionMode | undefined {
  const value = getModelSelectionStringOptionValue(
    modelSelection,
    CODEX_COLLABORATION_MODE_OPTION_ID,
  );
  return value === "default" || value === "plan" ? value : undefined;
}

export function getCodexServiceTierOptionValue(
  modelSelection: ModelSelection | null | undefined,
): string | undefined {
  return (
    getModelSelectionStringOptionValue(modelSelection, "serviceTier") ??
    (getModelSelectionBooleanOptionValue(modelSelection, "fastMode") === true ? "fast" : undefined)
  );
}
