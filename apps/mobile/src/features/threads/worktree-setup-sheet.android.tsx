import { Host, ModalBottomSheet, RNHostView } from "@expo/ui/jetpack-compose";
import { Pressable, View, useWindowDimensions } from "react-native";
import { AndroidSheetHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { useThemeColor } from "../../lib/useThemeColor";
import { t } from "../../i18n";
import type { WorktreeSetupSheetProps } from "./worktree-setup-sheet";

export function WorktreeSetupSheet({ children, height, onClose }: WorktreeSetupSheetProps) {
  const window = useWindowDimensions();
  const sheetColor = useThemeColor("--color-sheet-solid");
  return (
    <Host style={{ position: "absolute", width: 0, height: 0 }}>
      <ModalBottomSheet
        onDismissRequest={onClose}
        skipPartiallyExpanded
        containerColor={sheetColor}
      >
        <RNHostView matchContents>
          <View
            style={{
              width: Math.min(window.width, 640),
              height: Math.min((height || 360) + 64, window.height * 0.85),
            }}
          >
            <AndroidSheetHeader
              title={t("worktreeSetup.ariaLabel")}
              trailing={
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t("worktreeSetup.closeDetails")}
                  onPress={onClose}
                  className="min-h-11 justify-center px-2"
                >
                  <Text className="font-codework-medium text-sm text-foreground">{t("done")}</Text>
                </Pressable>
              }
            />
            {children}
          </View>
        </RNHostView>
      </ModalBottomSheet>
    </Host>
  );
}
