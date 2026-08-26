import { useEffect, useSyncExternalStore } from "react";

import {
  completeConfirmDialogClose,
  readConfirmDialogState,
  registerConfirmDialogHost,
  respondToConfirmDialog,
  subscribeConfirmDialog,
} from "../confirmDialog";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";
import { t } from "~/i18n";

type ConfirmationCopy = {
  readonly title: string;
  readonly description: string | null;
};

/** Question terminator, ASCII or full-width, so localized titles split too. */
const endsWithQuestion = (line: string): boolean =>
  line.trim().endsWith("?") || line.trim().endsWith("？");

const questionTerminatorLength = (message: string): number => {
  const ascii = message.indexOf("?");
  const fullWidth = message.indexOf("？");
  if (ascii < 0) return fullWidth < 0 ? -1 : fullWidth + 1;
  if (fullWidth < 0) return ascii + 1;
  return Math.min(ascii, fullWidth) + 1;
};

export function resolveConfirmDialogCopy(message: string): ConfirmationCopy {
  const normalizedMessage = message.trim();
  const lines = normalizedMessage.split("\n");
  const questionLineIndex = lines.findIndex((line) => endsWithQuestion(line));

  if (questionLineIndex >= 0) {
    const title = lines[questionLineIndex]!.trim();
    const description = lines
      .filter((_, index) => index !== questionLineIndex)
      .join("\n")
      .trim();
    return { title, description: description || null };
  }

  const questionMarkIndex = questionTerminatorLength(normalizedMessage);
  if (questionMarkIndex >= 1) {
    return {
      title: normalizedMessage.slice(0, questionMarkIndex).trim(),
      description: normalizedMessage.slice(questionMarkIndex).trim() || null,
    };
  }

  return {
    title: t("confirmAction"),
    description: normalizedMessage || t("thisActionRequiresYourConfirmation"),
  };
}

export function ConfirmDialogHost() {
  const state = useSyncExternalStore(
    subscribeConfirmDialog,
    readConfirmDialogState,
    readConfirmDialogState,
  );

  useEffect(() => registerConfirmDialogHost(), []);

  const copy = resolveConfirmDialogCopy(state.status === "idle" ? "" : state.message);
  const confirmVariant = state.status === "idle" ? "default" : state.variant;
  const onCancel = () => respondToConfirmDialog(false);
  const onConfirm = () => respondToConfirmDialog(true);

  return (
    <AlertDialog
      open={state.status === "confirming"}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      onOpenChangeComplete={(open) => {
        if (!open) completeConfirmDialogClose();
      }}
    >
      <AlertDialogPopup className="max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>{copy.title}</AlertDialogTitle>
          {copy.description ? (
            <AlertDialogDescription className="whitespace-pre-line">
              {copy.description}
            </AlertDialogDescription>
          ) : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>{t("cancel")}</AlertDialogClose>
          <Button variant={confirmVariant} onClick={onConfirm}>
            {t("confirm")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
