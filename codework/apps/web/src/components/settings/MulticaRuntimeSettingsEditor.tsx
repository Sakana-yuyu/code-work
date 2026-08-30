import { AlertCircleIcon, LoaderCircleIcon, SaveIcon, XIcon } from "lucide-react";

import { Button } from "../ui/button";
import { MulticaRuntimeCapabilityFields } from "./MulticaRuntimeCapabilityFields";
import { MulticaRuntimeConnectionFields } from "./MulticaRuntimeConnectionFields";
import { MulticaRuntimeCredentialFields } from "./MulticaRuntimeCredentialFields";
import { MulticaRuntimeRoutingFields } from "./MulticaRuntimeRoutingFields";
import {
  multicaRuntimeDraftEquals,
  validateMulticaRuntimeDraft,
  type MulticaRuntimeDraft,
} from "./MulticaRuntimeSettings.logic";
import type { MulticaRuntimeSaveState } from "./MulticaRuntimeSettings.session";
import type { MulticaRuntimeSettingsText } from "./MulticaRuntimeSettingsText";

export type { MulticaRuntimeSaveState } from "./MulticaRuntimeSettings.session";

export interface MulticaRuntimeSettingsEditorProps {
  readonly text: MulticaRuntimeSettingsText;
  readonly mode: "create" | "edit";
  readonly initialDraft: MulticaRuntimeDraft;
  readonly draft: MulticaRuntimeDraft;
  readonly saveState: MulticaRuntimeSaveState;
  readonly onDraftChange: (draft: MulticaRuntimeDraft) => void;
  readonly onCancel: () => void;
  readonly onSave: () => void;
}

export function MulticaRuntimeSettingsEditor({
  text,
  mode,
  initialDraft,
  draft,
  saveState,
  onDraftChange,
  onCancel,
  onSave,
}: MulticaRuntimeSettingsEditorProps) {
  const validation = validateMulticaRuntimeDraft(draft);
  const dirty = !multicaRuntimeDraftEquals(initialDraft, draft);
  const saving = saveState === "saving";
  const issue = validation.ok ? null : validation.issue;
  const saveDisabled = saving || saveState === "conflict" || !dirty || !validation.ok;

  return (
    <div
      className="grid gap-4 border-y border-border/60 py-4"
      data-testid="multica-runtime-editor"
      aria-busy={saving}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">
            {text(mode === "create" ? "createTitle" : "editTitle")}
          </h3>
          {dirty ? (
            <p className="text-xs text-warning" data-testid="multica-runtime-dirty-state">
              {text("unsavedChanges")}
            </p>
          ) : null}
        </div>
      </div>

      <MulticaRuntimeConnectionFields
        text={text}
        mode={mode}
        draft={draft}
        disabled={saving}
        issuePath={issue?.path ?? null}
        onChange={onDraftChange}
      />
      <MulticaRuntimeCredentialFields
        text={text}
        draft={draft}
        disabled={saving}
        issuePath={issue?.path ?? null}
        onChange={onDraftChange}
      />
      <MulticaRuntimeRoutingFields
        text={text}
        draft={draft}
        disabled={saving}
        issuePath={issue?.path ?? null}
        onChange={onDraftChange}
      />
      <MulticaRuntimeCapabilityFields
        text={text}
        draft={draft}
        disabled={saving}
        issuePath={issue?.path ?? null}
        onChange={onDraftChange}
      />

      {issue ? (
        <p className="flex items-center gap-1.5 text-xs text-destructive" role="alert">
          <AlertCircleIcon className="size-3.5" />
          {text(`issue.${issue.code}`)}
        </p>
      ) : null}
      {saveState === "error" ? (
        <p className="flex items-center gap-1.5 text-xs text-destructive" role="alert">
          <AlertCircleIcon className="size-3.5" />
          {text("saveFailed")}
        </p>
      ) : null}
      {saveState === "conflict" ? (
        <p className="flex items-center gap-1.5 text-xs text-destructive" role="alert">
          <AlertCircleIcon className="size-3.5" />
          {text("saveConflict")}
        </p>
      ) : null}

      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" size="sm" variant="outline" onClick={onCancel} disabled={saving}>
          <XIcon />
          {text("cancel")}
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={onSave}
          disabled={saveDisabled}
          data-testid="multica-runtime-save"
        >
          {saving ? <LoaderCircleIcon className="animate-spin" /> : <SaveIcon />}
          {text(saving ? "saving" : "save")}
        </Button>
      </div>
    </div>
  );
}
