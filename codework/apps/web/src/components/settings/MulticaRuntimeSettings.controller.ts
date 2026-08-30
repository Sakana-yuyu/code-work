import type { ProviderInstanceConfig } from "@codework/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  emptyMulticaRuntimeDraft,
  formFromMulticaRuntimeInstance,
  nextMulticaRuntimeInstanceId,
  validateMulticaRuntimeDraft,
  type MulticaRuntimeDraft,
  type MulticaRuntimeSave,
} from "./MulticaRuntimeSettings.logic";
import {
  reconcileMulticaRuntimeEditorSession,
  type MulticaRuntimeEditorSession,
} from "./MulticaRuntimeSettings.session";

export type MulticaRuntimeSettingsState =
  | { readonly status: "loading" }
  | { readonly status: "error" }
  | {
      readonly status: "ready";
      readonly instances: Readonly<Record<string, ProviderInstanceConfig>>;
    };

export type MulticaRuntimeSaveRequest = MulticaRuntimeSave & {
  readonly originalInstanceId: string | null;
};

export type MulticaRuntimeSaveAttempt = "saved" | "invalid" | "error";

interface ScopedRuntimeAction {
  readonly requestId: number;
  readonly scopeKey: string;
  readonly instanceId: string;
}

export const isMulticaRuntimeActionCurrent = (
  action: Pick<ScopedRuntimeAction, "requestId" | "scopeKey">,
  currentRequestId: number | null,
  currentScopeKey: string | null,
): boolean => action.requestId === currentRequestId && action.scopeKey === currentScopeKey;

interface MulticaRuntimeSettingsControllerOptions {
  readonly scopeKey: string | null;
  readonly state: MulticaRuntimeSettingsState;
  readonly onSave: (request: MulticaRuntimeSaveRequest) => Promise<void>;
  readonly onDelete: (instanceId: string) => Promise<void>;
}

const reconcileScopedRuntimeAction = (
  action: ScopedRuntimeAction | null,
  scopeKey: string | null,
  readyInstances: Readonly<Record<string, ProviderInstanceConfig>> | undefined,
): ScopedRuntimeAction | null => {
  if (action === null || scopeKey === null || action.scopeKey !== scopeKey) return null;
  if (readyInstances === undefined) return action;
  return readyInstances[action.instanceId]?.driver === "multica" ? action : null;
};

export async function persistMulticaRuntimeDraft(
  draft: MulticaRuntimeDraft,
  originalInstanceId: string | null,
  onSave: MulticaRuntimeSettingsControllerOptions["onSave"],
): Promise<MulticaRuntimeSaveAttempt> {
  const validation = validateMulticaRuntimeDraft(draft);
  if (!validation.ok) return "invalid";
  try {
    await onSave({ originalInstanceId, ...validation.value });
    return "saved";
  } catch {
    return "error";
  }
}

export function useMulticaRuntimeSettingsController({
  scopeKey,
  state,
  onSave,
  onDelete,
}: MulticaRuntimeSettingsControllerOptions) {
  const [editor, setEditor] = useState<MulticaRuntimeEditorSession | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ScopedRuntimeAction | null>(null);
  const [deleting, setDeleting] = useState<ScopedRuntimeAction | null>(null);
  const [deleteFailure, setDeleteFailure] = useState<ScopedRuntimeAction | null>(null);
  const nextEditorSessionIdRef = useRef(0);
  const nextDeleteRequestIdRef = useRef(0);
  const activeDeleteRequestIdRef = useRef<number | null>(null);
  const scopeKeyRef = useRef(scopeKey);
  scopeKeyRef.current = scopeKey;

  const readyInstances = state.status === "ready" ? state.instances : undefined;
  const instances = readyInstances ?? null;
  const activeEditor = reconcileMulticaRuntimeEditorSession(editor, {
    scopeKey,
    readyInstances,
  });
  const activePendingDelete = reconcileScopedRuntimeAction(pendingDelete, scopeKey, readyInstances);
  const activeDeleting = reconcileScopedRuntimeAction(deleting, scopeKey, readyInstances);
  const activeDeleteFailure = reconcileScopedRuntimeAction(deleteFailure, scopeKey, readyInstances);

  useEffect(() => {
    activeDeleteRequestIdRef.current = null;
  }, [scopeKey]);

  useEffect(() => {
    setEditor((current) =>
      reconcileMulticaRuntimeEditorSession(current, { scopeKey, readyInstances }),
    );
    setPendingDelete((current) => reconcileScopedRuntimeAction(current, scopeKey, readyInstances));
    setDeleting((current) => reconcileScopedRuntimeAction(current, scopeKey, readyInstances));
    setDeleteFailure((current) => reconcileScopedRuntimeAction(current, scopeKey, readyInstances));
  }, [readyInstances, scopeKey]);

  const entries = useMemo(
    () =>
      instances === null
        ? []
        : Object.entries(instances).filter(([, instance]) => instance.driver === "multica"),
    [instances],
  );

  const openCreate = () => {
    if (
      instances === null ||
      scopeKey === null ||
      activeEditor !== null ||
      activeDeleting !== null
    ) {
      return;
    }
    const draft = emptyMulticaRuntimeDraft(nextMulticaRuntimeInstanceId(instances));
    setEditor({
      sessionId: ++nextEditorSessionIdRef.current,
      scopeKey,
      mode: "create",
      originalInstanceId: null,
      initialDraft: draft,
      draft,
      saveState: "idle",
    });
  };

  const openEdit = (instanceId: string, instance: ProviderInstanceConfig) => {
    if (scopeKey === null || activeEditor !== null || activeDeleting !== null) return;
    const draft = formFromMulticaRuntimeInstance(instanceId, instance);
    if (draft === null) return;
    setEditor({
      sessionId: ++nextEditorSessionIdRef.current,
      scopeKey,
      mode: "edit",
      originalInstanceId: instanceId,
      initialDraft: draft,
      draft,
      saveState: "idle",
    });
  };

  const updateEditorDraft = (sessionId: number, draft: MulticaRuntimeDraft) => {
    setEditor((current) =>
      current?.sessionId === sessionId ? { ...current, draft, saveState: "idle" } : current,
    );
  };

  const closeEditor = (sessionId: number) => {
    setEditor((current) => (current?.sessionId === sessionId ? null : current));
  };

  const saveEditor = async () => {
    const session = activeEditor;
    if (session === null || session.saveState === "saving") return;
    setEditor((current) =>
      current?.sessionId === session.sessionId ? { ...current, saveState: "saving" } : current,
    );
    const result = await persistMulticaRuntimeDraft(
      session.draft,
      session.originalInstanceId,
      onSave,
    );
    setEditor((current) => {
      if (current?.sessionId !== session.sessionId) return current;
      return result === "saved"
        ? null
        : { ...current, saveState: result === "error" ? "error" : "idle" };
    });
  };

  const requestDelete = (instanceId: string) => {
    if (scopeKey === null) return;
    setPendingDelete({
      requestId: ++nextDeleteRequestIdRef.current,
      scopeKey,
      instanceId,
    });
  };

  const dismissDelete = () => {
    if (activeDeleting !== null) return;
    setPendingDelete((current) =>
      current?.requestId === activePendingDelete?.requestId ? null : current,
    );
  };

  const confirmDelete = async () => {
    const request = activePendingDelete;
    if (request === null || activeDeleting !== null) return;
    activeDeleteRequestIdRef.current = request.requestId;
    setDeleting(request);
    setDeleteFailure(null);
    try {
      await onDelete(request.instanceId);
      if (
        !isMulticaRuntimeActionCurrent(
          request,
          activeDeleteRequestIdRef.current,
          scopeKeyRef.current,
        )
      ) {
        return;
      }
      setPendingDelete((current) => (current?.requestId === request.requestId ? null : current));
      setEditor((current) =>
        current?.scopeKey === request.scopeKey && current.originalInstanceId === request.instanceId
          ? null
          : current,
      );
    } catch {
      if (
        isMulticaRuntimeActionCurrent(
          request,
          activeDeleteRequestIdRef.current,
          scopeKeyRef.current,
        )
      ) {
        setPendingDelete((current) => (current?.requestId === request.requestId ? null : current));
        setDeleteFailure(request);
      }
    } finally {
      if (activeDeleteRequestIdRef.current === request.requestId) {
        activeDeleteRequestIdRef.current = null;
      }
      setDeleting((current) => (current?.requestId === request.requestId ? null : current));
    }
  };

  return {
    activeEditor,
    canAdd:
      state.status === "ready" &&
      scopeKey !== null &&
      activeEditor === null &&
      activeDeleting === null,
    closeEditor,
    confirmDelete,
    deleteFailedId: activeDeleteFailure?.instanceId ?? null,
    deleteInProgress: activeDeleting !== null,
    deletingId: activeDeleting?.instanceId ?? null,
    dismissDelete,
    entries,
    openCreate,
    openEdit,
    pendingDeleteOpen: activePendingDelete !== null,
    requestDelete,
    saveEditor,
    updateEditorDraft,
    writesDisabled: scopeKey === null || activeEditor !== null || activeDeleting !== null,
  };
}
