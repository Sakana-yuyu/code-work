import type { ReactElement } from "react";
import { Modal, View } from "react-native";
import { Screen, ScreenStack, ScreenStackHeaderConfig } from "react-native-screens";
import { useThemeColor } from "../../lib/useThemeColor";
import { t } from "../../i18n";

export interface WorktreeSetupSheetProps {
  children: ReactElement;
  /** Android sizes the sheet through its layout; iOS uses the page-sheet detent. */
  height: number;
  onClose: () => void;
}

export function WorktreeSetupSheet({ children, onClose }: WorktreeSetupSheetProps) {
  const sheetColor = String(useThemeColor("--color-sheet-solid"));
  const foregroundColor = String(useThemeColor("--color-foreground"));
  return (
    <Modal
      animationType="slide"
      presentationStyle="pageSheet"
      allowSwipeDismissal
      onRequestClose={onClose}
    >
      <View collapsable={false} className="flex-1 bg-sheet-solid">
        {/* The nested stack supplies UIKit's navigation bar inside the sheet. */}
        <ScreenStack style={{ flex: 1 }}>
          <Screen
            activityState={2}
            enabled
            isNativeStack
            screenId="worktree-setup-details"
            style={{ backgroundColor: sheetColor, flex: 1 }}
          >
            {children}
            <ScreenStackHeaderConfig
              title={t("worktreeSetup.ariaLabel")}
              titleColor={foregroundColor}
              color={foregroundColor}
              backgroundColor={sheetColor}
              hideBackButton
              hideShadow
              translucent={false}
              headerRightBarButtonItems={[
                {
                  type: "button",
                  title: t("done"),
                  variant: "done",
                  accessibilityLabel: t("worktreeSetup.closeDetails"),
                  identifier: "worktree-setup-done",
                  onPress: onClose,
                },
              ]}
            />
          </Screen>
        </ScreenStack>
      </View>
    </Modal>
  );
}
