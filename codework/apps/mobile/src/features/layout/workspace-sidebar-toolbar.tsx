import { NativeHeaderToolbar } from "../../native/StackHeader";
import type { ReactNode } from "react";
import { Platform } from "react-native";

import { useAdaptiveWorkspaceLayout } from "./AdaptiveWorkspaceLayout";
import { t } from "../../i18n";

export function WorkspaceSidebarToolbar(
  props: {
    readonly children?: ReactNode;
    readonly afterSidebarButton?: ReactNode;
  } = {},
) {
  const { layout, panes, togglePrimarySidebar } = useAdaptiveWorkspaceLayout();

  if (Platform.OS === "android" || !layout.usesSplitView) {
    return null;
  }

  return (
    <NativeHeaderToolbar placement="left">
      {props.children}
      <NativeHeaderToolbar.Button
        accessibilityLabel={
          panes.primarySidebarVisible ? t("maximizeContent") : t("showThreadSidebar")
        }
        icon={panes.primarySidebarVisible ? "arrow.up.left.and.arrow.down.right" : "sidebar.left"}
        onPress={togglePrimarySidebar}
      />
      {props.afterSidebarButton}
    </NativeHeaderToolbar>
  );
}
