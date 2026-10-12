import { memo, useCallback, useState } from "react";
import { Modal, Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText } from "../../components/AppText";
import { CopyTextButton } from "../../components/CopyTextButton";
import { t } from "../../i18n";
import { useThemeColor } from "../../lib/useThemeColor";

/** 选区使用打开时收到的完整正文；列表更新和回合终态不替换正在选择的文字。 */
export function useMessageTextSelection(threadKey: string) {
  const [snapshot, setSnapshot] = useState<{
    readonly threadKey: string;
    readonly text: string | null;
  }>({ threadKey, text: null });
  if (snapshot.threadKey !== threadKey) {
    setSnapshot({ threadKey, text: null });
  }
  const selectText = useCallback((text: string) => setSnapshot({ threadKey, text }), [threadKey]);
  const close = useCallback(() => setSnapshot((current) => ({ ...current, text: null })), []);
  return { text: snapshot.threadKey === threadKey ? snapshot.text : null, selectText, close };
}

export const MessageTextSelectionButton = memo(function MessageTextSelectionButton(props: {
  readonly text: string;
  readonly onSelect: (text: string) => void;
}) {
  const iconColor = useThemeColor("--color-icon-subtle");
  if (Platform.OS !== "android" || props.text.length === 0) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("messageTextSelection.action")}
      hitSlop={8}
      onPress={() => props.onSelect(props.text)}
      className="size-7 items-center justify-center rounded-lg"
    >
      <SymbolView
        name={{ android: "select_all", ios: "text.cursor" }}
        size={14}
        tintColor={iconColor}
      />
    </Pressable>
  );
});

/** 独立于虚拟列表的原生 TextView，避免行回收或流式追加重置 Android 选区。 */
export const MessageTextSelection = memo(function MessageTextSelection(props: {
  readonly text: string | null;
  readonly onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const iconColor = useThemeColor("--color-icon-subtle");
  return (
    <Modal
      visible={props.text !== null}
      onRequestClose={props.onClose}
      statusBarTranslucent
      navigationBarTranslucent
    >
      {props.text === null ? null : (
        <View
          className="flex-1 bg-background px-4"
          style={{ paddingTop: insets.top + 12, paddingBottom: insets.bottom + 12 }}
        >
          <View className="flex-row items-center justify-between gap-3">
            <AppText accessibilityRole="header" className="flex-1 text-lg font-codework-medium">
              {t("messageTextSelection.action")}
            </AppText>
            <CopyTextButton
              accessibilityLabel={t("copyMessage")}
              text={props.text}
              tintColor={iconColor}
              buttonSize={44}
              iconSize={18}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("messageTextSelection.close")}
              onPress={props.onClose}
              className="min-h-11 items-center justify-center px-3"
            >
              <AppText className="text-base font-codework-medium">{t("done")}</AppText>
            </Pressable>
          </View>
          <AppText className="mb-4 mt-2 text-sm text-foreground-secondary">
            {t("messageTextSelection.hint")}
          </AppText>
          <ScrollView className="flex-1" contentContainerStyle={{ paddingBottom: 24 }}>
            <AppText selectable className="text-base leading-relaxed">
              {props.text}
            </AppText>
          </ScrollView>
        </View>
      )}
    </Modal>
  );
});
