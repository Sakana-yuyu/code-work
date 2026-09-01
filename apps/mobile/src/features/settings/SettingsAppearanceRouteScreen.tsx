import { useNavigation } from "@react-navigation/native";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { DEFAULT_LANGUAGE_PREFERENCE, type LanguagePreference } from "@codework/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { t } from "../../i18n";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { SettingsSection } from "./components/SettingsSection";
import { CodeAppearanceSection } from "./appearance/sections/CodeAppearanceSection";
import { TerminalAppearanceSection } from "./appearance/sections/TerminalAppearanceSection";
import { TextAppearanceSection } from "./appearance/sections/TextAppearanceSection";
import { ThemeAppearanceSection } from "./appearance/sections/ThemeAppearanceSection";

export function SettingsAppearanceRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title={t("appearance")} onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 18) + 18,
        }}
      >
        <LanguageSettingsSection />
        <ThemeAppearanceSection />
        <TextAppearanceSection />
        <TerminalAppearanceSection />
        <CodeAppearanceSection />
      </ScrollView>
    </View>
  );
}

const languageOptions: ReadonlyArray<{
  readonly value: LanguagePreference;
  readonly labelKey: string;
}> = [
  { value: "system", labelKey: "language.system" },
  { value: "zh-CN", labelKey: "language.zhCN" },
  { value: "en", labelKey: "language.en" },
];

function LanguageSettingsSection() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const updatePreferences = useAtomSet(updateMobilePreferencesAtom);
  const selected = AsyncResult.isSuccess(preferences)
    ? (preferences.value.language ?? DEFAULT_LANGUAGE_PREFERENCE)
    : DEFAULT_LANGUAGE_PREFERENCE;

  return (
    <SettingsSection title={t("language")} card>
      <View className="flex-row p-1.5">
        {languageOptions.map((option) => {
          const checked = selected === option.value;
          return (
            <Pressable
              key={option.value}
              accessibilityLabel={t(option.labelKey)}
              accessibilityRole="radio"
              accessibilityState={{ checked }}
              className={
                checked
                  ? "min-h-11 flex-1 items-center justify-center rounded-[18px] bg-accent"
                  : "min-h-11 flex-1 items-center justify-center rounded-[18px]"
              }
              onPress={() => updatePreferences({ language: option.value })}
            >
              <Text
                className={
                  checked
                    ? "text-center text-sm font-t3-medium text-foreground"
                    : "text-center text-sm text-foreground-muted"
                }
              >
                {t(option.labelKey)}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </SettingsSection>
  );
}
