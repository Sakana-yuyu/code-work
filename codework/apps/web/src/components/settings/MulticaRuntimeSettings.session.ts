import type { ProviderInstanceConfig } from "@codework/contracts";

import type { MulticaRuntimeDraft } from "./MulticaRuntimeSettings.model";

export type MulticaRuntimeSaveState = "idle" | "saving" | "error";

export interface MulticaRuntimeEditorSession {
  readonly sessionId: number;
  readonly scopeKey: string;
  readonly mode: "create" | "edit";
  readonly originalInstanceId: string | null;
  readonly initialDraft: MulticaRuntimeDraft;
  readonly draft: MulticaRuntimeDraft;
  readonly saveState: MulticaRuntimeSaveState;
}

export interface MulticaRuntimeEditorScope {
  readonly scopeKey: string | null;
  readonly readyInstances: Readonly<Record<string, ProviderInstanceConfig>> | undefined;
}

export const reconcileMulticaRuntimeEditorSession = (
  editor: MulticaRuntimeEditorSession | null,
  scope: MulticaRuntimeEditorScope,
): MulticaRuntimeEditorSession | null => {
  if (editor === null) return null;
  if (scope.scopeKey === null || editor.scopeKey !== scope.scopeKey) return null;
  if (editor.mode !== "edit" || scope.readyInstances === undefined) return editor;
  const instance =
    editor.originalInstanceId === null
      ? undefined
      : scope.readyInstances[editor.originalInstanceId];
  return instance?.driver === "multica" ? editor : null;
};
