import type { ScopedThreadRef } from "@codework/contracts";
import { PuzzleIcon } from "lucide-react";
import { useMemo, useSyncExternalStore } from "react";

import type { ComposerHandleRef } from "~/composerHandleContext";
import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "~/components/CommandPalette.logic";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { t } from "~/i18n";
import { useRightPanelStore } from "~/rightPanelStore";
import { localPluginRuntime } from "../localPluginRuntime";
import type { LocalPluginWorkspaceContext } from "../localPluginTemplate";
import { listEnabledLocalPluginCommands } from "./localPluginCommandAdapter";

export function useLocalPluginCommandPaletteItems(input: {
  readonly composerHandleRef: ComposerHandleRef | null;
  readonly threadRef: ScopedThreadRef | null;
  readonly workspace: LocalPluginWorkspaceContext | null;
}): ReadonlyArray<CommandPaletteActionItem> {
  const registrySnapshot = useSyncExternalStore(
    localPluginRuntime.registry.subscribe,
    localPluginRuntime.registry.getSnapshot,
    localPluginRuntime.registry.getSnapshot,
  );

  return useMemo(() => {
    const threadRef = input.threadRef;
    const composerHandleRef = input.composerHandleRef;
    return listEnabledLocalPluginCommands({
      runtime: localPluginRuntime,
      workspace: input.workspace,
      ports: {
        ...(threadRef === null
          ? {}
          : {
              openWorkspacePanel: (pluginId: string, contributionId: string) => {
                useRightPanelStore.getState().openPluginPanel(threadRef, pluginId, contributionId);
              },
            }),
        writeClipboard: async (text: string) => {
          await writeTextToClipboard(text, "local plugin command");
        },
        ...(composerHandleRef === null
          ? {}
          : {
              insertPrompt: (text: string) =>
                composerHandleRef.current?.insertTextAtEnd(text, {
                  ensureLeadingBoundary: true,
                }) ?? false,
            }),
      },
    }).map((command) => ({
      kind: "action",
      value: command.id,
      searchTerms: [
        command.pluginName,
        command.pluginId,
        command.contributionId,
        command.title,
        command.description ?? "",
      ],
      title: command.title,
      description: command.description ?? command.pluginName,
      icon: <PuzzleIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        const result = await command.invoke();
        if (result.ok) return;
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: t("localPlugins.commandFailed"),
            description: result.failure.message,
          }),
        );
      },
    }));
  }, [input.composerHandleRef, input.threadRef, input.workspace, registrySnapshot]);
}
