import { EDITORS, type EditorId } from "@codework/contracts";

import { t } from "~/i18n/runtime";
import { isMacPlatform, isWindowsPlatform } from "~/lib/utils";

const editorLabels = new Map<EditorId, string>(EDITORS.map((editor) => [editor.id, editor.label]));

/** 文件管理器名称走本地化；编辑器品牌名保留原文。 */
function localizedFileManagerName(platform: string): string {
  if (isMacPlatform(platform)) return t("finder");
  if (isWindowsPlatform(platform)) return t("explorer");
  return t("surface.files");
}

export function editorLabelForPlatform(editorId: EditorId, platform: string): string {
  if (editorId === "file-manager") {
    return localizedFileManagerName(platform);
  }

  return editorLabels.get(editorId) ?? t("editor.fallbackLabel");
}

export function openInEditorMenuLabel(editorId: EditorId | null): string {
  return editorId === null || editorId === "file-manager"
    ? t("openInEditor")
    : t("commandPalette.openInManager", {
        manager: editorLabels.get(editorId) ?? t("editor.fallbackLabel"),
      });
}
