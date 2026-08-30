import { PaperclipIcon } from "lucide-react";
import { useMemo, useSyncExternalStore } from "react";

import type { ComposerHandleRef } from "~/composerHandleContext";
import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "~/components/CommandPalette.logic";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { t } from "~/i18n";
import { localPluginRuntime } from "../localPluginRuntime";
import { listEnabledLocalPluginAttachments } from "./localPluginAttachmentAdapter";
import { addFilesToLocalPluginComposer } from "./localPluginAttachmentComposerPort";
import { pickLocalPluginAttachmentFiles } from "./localPluginAttachmentPicker";

export function useLocalPluginAttachmentPaletteItems(input: {
  readonly composerHandleRef: ComposerHandleRef | null;
}): ReadonlyArray<CommandPaletteActionItem> {
  const registrySnapshot = useSyncExternalStore(
    localPluginRuntime.registry.subscribe,
    localPluginRuntime.registry.getSnapshot,
    localPluginRuntime.registry.getSnapshot,
  );

  return useMemo(() => {
    if (input.composerHandleRef === null) return [];
    const composerHandleRef = input.composerHandleRef;
    return listEnabledLocalPluginAttachments({
      runtime: localPluginRuntime,
      ports: {
        pickFiles: pickLocalPluginAttachmentFiles,
        addFiles: (files) => addFilesToLocalPluginComposer(composerHandleRef, files),
        insertPrompt: (text) =>
          composerHandleRef.current?.insertTextAtEnd(text, {
            ensureLeadingBoundary: true,
          }) ?? false,
      },
    }).map((attachment) => ({
      kind: "action",
      value: attachment.id,
      searchTerms: [
        attachment.pluginName,
        attachment.pluginId,
        attachment.contributionId,
        attachment.title,
        attachment.description ?? "",
      ],
      title: attachment.title,
      description: attachment.description ?? attachment.pluginName,
      icon: <PaperclipIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        const result = await attachment.invoke();
        if (!result.ok) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: t("localPlugins.attachmentFailed"),
              description: result.failure.message,
            }),
          );
          return;
        }
        if (result.value.rejectedFiles.length > 0) {
          toastManager.add(
            stackedThreadToast({
              type: "warning",
              title: t("localPlugins.attachmentPartiallyRejected"),
              description: t("localPlugins.attachmentPartiallyRejectedDescription", {
                count: result.value.rejectedFiles.length,
              }),
            }),
          );
        }
      },
    }));
  }, [input.composerHandleRef, registrySnapshot]);
}
