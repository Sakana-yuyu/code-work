import { multicaProviderInstanceRevision, type ProviderInstanceConfig } from "@codework/contracts";

import {
  formFromMulticaRuntimeInstance,
  multicaRuntimeDraftFingerprint,
} from "./MulticaRuntimeSettings.logic";
import type { MulticaRuntimeDraft } from "./MulticaRuntimeSettings.model";

export type MulticaRuntimeSaveState = "idle" | "saving" | "error" | "conflict";

export interface MulticaRuntimeEditorSession {
  readonly sessionId: number;
  readonly scopeKey: string;
  readonly mode: "create" | "edit";
  readonly originalInstanceId: string | null;
  readonly initialDraft: MulticaRuntimeDraft;
  readonly draft: MulticaRuntimeDraft;
  readonly initialFingerprint: string;
  /** 打开会话时的服务端版本，保存必须原样带回，不能由最新快照重算。 */
  readonly expectedRevision: string | null;
  readonly conflict: boolean;
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
  if (scope.readyInstances === undefined) return editor;
  if (editor.mode === "create") {
    return scope.readyInstances[editor.draft.instanceId] === undefined
      ? editor
      : { ...editor, conflict: true, saveState: "conflict" };
  }
  const instance =
    editor.originalInstanceId === null
      ? undefined
      : scope.readyInstances[editor.originalInstanceId];
  const liveDraft =
    instance === undefined
      ? null
      : formFromMulticaRuntimeInstance(editor.originalInstanceId!, instance);
  if (liveDraft === null) return { ...editor, conflict: true, saveState: "conflict" };
  return multicaRuntimeDraftFingerprint(liveDraft) === editor.initialFingerprint &&
    multicaProviderInstanceRevision(editor.originalInstanceId!, instance) ===
      editor.expectedRevision
    ? editor
    : { ...editor, conflict: true, saveState: "conflict" };
};
