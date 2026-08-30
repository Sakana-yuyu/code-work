import {
  AlertCircleIcon,
  LoaderCircleIcon,
  PlusIcon,
  RefreshCwIcon,
  ServerCogIcon,
  Trash2Icon,
} from "lucide-react";

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
import { formFromMulticaRuntimeInstance } from "./MulticaRuntimeSettings.logic";
import { MulticaRuntimeSettingsEditor } from "./MulticaRuntimeSettingsEditor";
import { MulticaRuntimeInstanceRow } from "./MulticaRuntimeInstanceRow";
import {
  useMulticaRuntimeSettingsController,
  type MulticaRuntimeSaveRequest,
  type MulticaRuntimeSettingsState,
} from "./MulticaRuntimeSettings.controller";
import type { MulticaRuntimeSettingsText } from "./MulticaRuntimeSettingsText";

export {
  persistMulticaRuntimeDraft,
  type MulticaRuntimeSaveAttempt,
  type MulticaRuntimeSaveRequest,
  type MulticaRuntimeSettingsState,
} from "./MulticaRuntimeSettings.controller";
export type { MulticaRuntimeSettingsText } from "./MulticaRuntimeSettingsText";

export interface MulticaRuntimeSettingsPanelProps {
  /** 隔离编辑与删除会话的环境身份；没有环境时禁止产生写操作。 */
  readonly scopeKey: string | null;
  readonly text: MulticaRuntimeSettingsText;
  readonly state: MulticaRuntimeSettingsState;
  readonly onRetryLoad: () => void;
  readonly onSave: (request: MulticaRuntimeSaveRequest) => Promise<void>;
  readonly onDelete: (instanceId: string) => Promise<void>;
}

export function MulticaRuntimeSettingsPanel({
  scopeKey,
  text,
  state,
  onRetryLoad,
  onSave,
  onDelete,
}: MulticaRuntimeSettingsPanelProps) {
  const controller = useMulticaRuntimeSettingsController({ scopeKey, state, onSave, onDelete });
  const editor = controller.activeEditor;

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
            onClick={controller.openCreate}
            disabled={!controller.canAdd}
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
            onDraftChange={(draft) => controller.updateEditorDraft(editor.sessionId, draft)}
            onCancel={() => controller.closeEditor(editor.sessionId)}
            onSave={() => void controller.saveEditor()}
          />
        ) : null}

        {state.status === "ready" &&
        controller.entries.length === 0 &&
        editor?.mode !== "create" ? (
          <SettingsRow title={text("emptyTitle")} description={text("emptyDescription")} />
        ) : null}

        {controller.entries.map(([instanceId, instance]) => {
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
                  controller.updateEditorDraft(editor.sessionId, nextDraft)
                }
                onCancel={() => controller.closeEditor(editor.sessionId)}
                onSave={() => void controller.saveEditor()}
              />
            );
          }

          return (
            <MulticaRuntimeInstanceRow
              key={instanceId}
              text={text}
              instanceId={instanceId}
              enabled={draft?.enabled ?? instance.enabled !== false}
              draft={draft}
              disabled={controller.writesDisabled}
              deleting={controller.deletingId === instanceId}
              deleteFailed={controller.deleteFailedId === instanceId}
              onEdit={() => controller.openEdit(instanceId, instance)}
               onDelete={() => controller.requestDelete(instanceId, instance)}
            />
          );
        })}
      </SettingsSection>

      <AlertDialog
        open={controller.pendingDeleteOpen}
        onOpenChange={(open) => !open && controller.dismissDelete()}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{text("deleteConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{text("deleteConfirmDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose
              render={
                <Button type="button" variant="outline" disabled={controller.deleteInProgress} />
              }
            >
              {text("cancel")}
            </AlertDialogClose>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void controller.confirmDelete()}
              disabled={controller.deleteInProgress}
            >
              {!controller.deleteInProgress ? (
                <Trash2Icon />
              ) : (
                <LoaderCircleIcon className="animate-spin" />
              )}
              {text("delete")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
