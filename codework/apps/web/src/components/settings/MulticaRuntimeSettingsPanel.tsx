import type { ProviderInstanceConfig } from "@codework/contracts";
import {
  AlertCircleIcon,
  LoaderCircleIcon,
  PlusIcon,
  RefreshCwIcon,
  ServerCogIcon,
  Trash2Icon,
} from "lucide-react";
import { useMemo, useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import {
  emptyMulticaRuntimeDraft,
  formFromMulticaRuntimeInstance,
  nextMulticaRuntimeInstanceId,
  validateMulticaRuntimeDraft,
  type MulticaRuntimeDraft,
  type MulticaRuntimeSave,
} from "./MulticaRuntimeSettings.logic";
import {
  MulticaRuntimeSettingsEditor,
  type MulticaRuntimeSaveState,
} from "./MulticaRuntimeSettingsEditor";
import { MulticaRuntimeInstanceRow } from "./MulticaRuntimeInstanceRow";
import type { MulticaRuntimeSettingsText } from "./MulticaRuntimeSettingsText";

export type { MulticaRuntimeSettingsText } from "./MulticaRuntimeSettingsText";

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

interface MulticaRuntimeEditorSession {
  readonly mode: "create" | "edit";
  readonly originalInstanceId: string | null;
  readonly initialDraft: MulticaRuntimeDraft;
  readonly draft: MulticaRuntimeDraft;
  readonly saveState: MulticaRuntimeSaveState;
}

export interface MulticaRuntimeSettingsPanelProps {
  readonly text: MulticaRuntimeSettingsText;
  readonly state: MulticaRuntimeSettingsState;
  readonly onRetryLoad: () => void;
  readonly onSave: (request: MulticaRuntimeSaveRequest) => Promise<void>;
  readonly onDelete: (instanceId: string) => Promise<void>;
}

export type MulticaRuntimeSaveAttempt = "saved" | "invalid" | "error";

export async function persistMulticaRuntimeDraft(
  draft: MulticaRuntimeDraft,
  originalInstanceId: string | null,
  onSave: MulticaRuntimeSettingsPanelProps["onSave"],
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

export function MulticaRuntimeSettingsPanel({
  text,
  state,
  onRetryLoad,
  onSave,
  onDelete,
}: MulticaRuntimeSettingsPanelProps) {
  const [editor, setEditor] = useState<MulticaRuntimeEditorSession | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteFailedId, setDeleteFailedId] = useState<string | null>(null);

  const instances = state.status === "ready" ? state.instances : null;
  const entries = useMemo(
    () =>
      instances === null
        ? []
        : Object.entries(instances).filter(([, instance]) => instance.driver === "multica"),
    [instances],
  );

  const openCreate = () => {
    if (instances === null || editor !== null) return;
    const draft = emptyMulticaRuntimeDraft(nextMulticaRuntimeInstanceId(instances));
    setEditor({
      mode: "create",
      originalInstanceId: null,
      initialDraft: draft,
      draft,
      saveState: "idle",
    });
  };

  const openEdit = (instanceId: string, instance: ProviderInstanceConfig) => {
    if (editor !== null) return;
    const draft = formFromMulticaRuntimeInstance(instanceId, instance);
    if (draft === null) return;
    setEditor({
      mode: "edit",
      originalInstanceId: instanceId,
      initialDraft: draft,
      draft,
      saveState: "idle",
    });
  };

  const saveEditor = async () => {
    if (editor === null || editor.saveState === "saving") return;
    setEditor({ ...editor, saveState: "saving" });
    const result = await persistMulticaRuntimeDraft(
      editor.draft,
      editor.originalInstanceId,
      onSave,
    );
    if (result === "saved") {
      setEditor(null);
    } else {
      setEditor((current) =>
        current === null ? null : { ...current, saveState: result === "error" ? "error" : "idle" },
      );
    }
  };

  const deleteRuntime = async () => {
    const instanceId = pendingDeleteId;
    if (instanceId === null || deletingId !== null) return;
    setDeletingId(instanceId);
    setDeleteFailedId(null);
    try {
      await onDelete(instanceId);
      setPendingDeleteId(null);
      if (editor?.originalInstanceId === instanceId) setEditor(null);
    } catch {
      setPendingDeleteId(null);
      setDeleteFailedId(instanceId);
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <>
      <SettingsSection
        id="multica-runtimes"
        title={text("title")}
        icon={<ServerCogIcon className="size-4 text-muted-foreground" />}
        headerAction={
          <Button
            type="button"
            size="sm"
            onClick={openCreate}
            disabled={state.status !== "ready" || editor !== null}
            data-testid="multica-runtime-add"
          >
            <PlusIcon />
            {text("add")}
          </Button>
        }
      >
        {state.status === "loading" ? (
          <SettingsRow
            title={text("loadingTitle")}
            description={text("loadingDescription")}
            status={<LoaderCircleIcon className="size-3.5 animate-spin" />}
          />
        ) : null}

        {state.status === "error" ? (
          <SettingsRow
            title={text("loadFailedTitle")}
            description={text("loadFailedDescription")}
            status={<AlertCircleIcon className="size-3.5 text-destructive" />}
            control={
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={onRetryLoad}
                data-testid="multica-runtime-retry-load"
              >
                <RefreshCwIcon />
                {text("retry")}
              </Button>
            }
          />
        ) : null}

        {editor?.mode === "create" ? (
          <MulticaRuntimeSettingsEditor
            text={text}
            mode="create"
            initialDraft={editor.initialDraft}
            draft={editor.draft}
            saveState={editor.saveState}
            onDraftChange={(draft) => setEditor({ ...editor, draft, saveState: "idle" })}
            onCancel={() => setEditor(null)}
            onSave={() => void saveEditor()}
          />
        ) : null}

        {state.status === "ready" && entries.length === 0 && editor?.mode !== "create" ? (
          <SettingsRow title={text("emptyTitle")} description={text("emptyDescription")} />
        ) : null}

        {entries.map(([instanceId, instance]) => {
          const draft = formFromMulticaRuntimeInstance(instanceId, instance);
          const editing = editor?.originalInstanceId === instanceId;
          if (editing && editor !== null) {
            return (
              <MulticaRuntimeSettingsEditor
                key={instanceId}
                text={text}
                mode="edit"
                initialDraft={editor.initialDraft}
                draft={editor.draft}
                saveState={editor.saveState}
                onDraftChange={(nextDraft) =>
                  setEditor({ ...editor, draft: nextDraft, saveState: "idle" })
                }
                onCancel={() => setEditor(null)}
                onSave={() => void saveEditor()}
              />
            );
          }

          return (
            <MulticaRuntimeInstanceRow
              key={instanceId}
              text={text}
              instanceId={instanceId}
              enabled={instance.enabled !== false}
              draft={draft}
              disabled={editor !== null || deletingId !== null}
              deleting={deletingId === instanceId}
              deleteFailed={deleteFailedId === instanceId}
              onEdit={() => openEdit(instanceId, instance)}
              onDelete={() => setPendingDeleteId(instanceId)}
            />
          );
        })}
      </SettingsSection>

      <AlertDialog
        open={pendingDeleteId !== null}
        onOpenChange={(open) => !open && deletingId === null && setPendingDeleteId(null)}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{text("deleteConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{text("deleteConfirmDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button type="button" variant="outline" />}>
              {text("cancel")}
            </AlertDialogClose>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void deleteRuntime()}
              disabled={deletingId !== null}
            >
              {deletingId === null ? <Trash2Icon /> : <LoaderCircleIcon className="animate-spin" />}
              {text("delete")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
