import { useAtomValue } from "@effect/atom-react";

import { undoLatestThreadAction, useThreadUndoNotice } from "../../hooks/showThreadUndoNotice";
import { t } from "~/i18n";
import { shortcutLabelForCommand } from "../../keybindings";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { Alert, AlertDescription } from "../ui/alert";
import { InlineButton } from "../ui/button";

export function SidebarThreadUndoNotice() {
  const notice = useThreadUndoNotice((state) => state.notice);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);

  if (!notice) return null;
  const shortcut = shortcutLabelForCommand(keybindings, "thread.undo");

  return (
    <Alert role="status" variant="sidebar">
      <AlertDescription>
        {t(`threadUndo.${notice.action}`, { count: notice.count })},{" "}
        <InlineButton onClick={undoLatestThreadAction}>
          {shortcut ? t("threadUndo.undoWithShortcut", { shortcut }) : t("threadUndo.undo")}
        </InlineButton>
      </AlertDescription>
    </Alert>
  );
}
