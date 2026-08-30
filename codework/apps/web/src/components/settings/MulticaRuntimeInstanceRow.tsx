import { LoaderCircleIcon, PencilIcon, Trash2Icon } from "lucide-react";

import { Button } from "../ui/button";
import type { MulticaRuntimeDraft } from "./MulticaRuntimeSettings.model";
import type { MulticaRuntimeSettingsText } from "./MulticaRuntimeSettingsText";

interface MulticaRuntimeInstanceRowProps {
  readonly text: MulticaRuntimeSettingsText;
  readonly instanceId: string;
  readonly enabled: boolean;
  readonly draft: MulticaRuntimeDraft | null;
  readonly disabled: boolean;
  readonly deleting: boolean;
  readonly deleteFailed: boolean;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
}

export function MulticaRuntimeInstanceRow({
  text,
  instanceId,
  enabled,
  draft,
  disabled,
  deleting,
  deleteFailed,
  onEdit,
  onDelete,
}: MulticaRuntimeInstanceRowProps) {
  return (
    <div
      className="grid gap-3 rounded-lg border border-border/60 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:px-4"
      data-multica-runtime-instance={instanceId}
    >
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <code className="break-all text-xs font-medium text-foreground">{instanceId}</code>
          <span className="text-xs text-muted-foreground">
            {enabled ? text("enabled") : text("disabled")}
          </span>
        </div>
        {draft === null ? (
          <>
            <p className="text-xs font-medium text-destructive">{text("invalidSavedTitle")}</p>
            <p className="text-xs text-muted-foreground">{text("invalidSavedDescription")}</p>
          </>
        ) : (
          <p className="break-all text-xs text-muted-foreground">
            {draft.runtimeId} · {draft.baseUrl}
          </p>
        )}
        {deleteFailed ? (
          <p className="text-xs text-destructive" role="alert">
            {text("deleteFailed")}
          </p>
        ) : null}
      </div>
      <div className="flex items-center justify-end gap-1">
        <Button
          type="button"
          size="icon-sm"
          variant="ghost-muted"
          aria-label={`${text("edit")} ${instanceId}`}
          onClick={onEdit}
          disabled={draft === null || disabled}
        >
          <PencilIcon />
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost-muted"
          aria-label={`${text("delete")} ${instanceId}`}
          onClick={onDelete}
          disabled={disabled}
        >
          {deleting ? <LoaderCircleIcon className="animate-spin" /> : <Trash2Icon />}
        </Button>
      </div>
    </div>
  );
}
