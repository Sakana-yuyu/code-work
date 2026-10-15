import type { EnvironmentId } from "@codework/contracts";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../../components/AppText";
import { EnvironmentMachineSymbol } from "../../../components/EnvironmentMachineSymbol";
import { useThemeColor } from "../../../lib/useThemeColor";
import type { EnvironmentPresentation } from "../../../state/environments";
import { useEnvironmentMachines } from "../../../state/presentation";
import { t } from "../../../i18n";
import { SettingsSection } from "./SettingsSection";

export function SettingsEnvironmentPicker(props: {
  readonly environments: ReadonlyArray<EnvironmentPresentation>;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly disabled?: boolean;
  readonly onSelect: (environmentId: EnvironmentId) => void;
}) {
  const machineByEnvironmentId = useEnvironmentMachines();
  const foregroundColor = useThemeColor("--color-foreground");
  if (props.environments.length <= 1) return null;
  return (
    <SettingsSection title={t("environment")} card>
      <View className="gap-2 p-3">
        {props.environments.map((environment) => {
          const selected = environment.environmentId === props.selectedEnvironmentId;
          return (
            <Pressable
              key={environment.environmentId}
              accessibilityRole="radio"
              accessibilityState={{ checked: selected, disabled: props.disabled }}
              disabled={props.disabled}
              onPress={() => props.onSelect(environment.environmentId)}
              className={
                selected
                  ? "rounded-[16px] bg-subtle-strong px-3 py-3"
                  : "rounded-[16px] bg-subtle px-3 py-3"
              }
            >
              <View className="flex-row items-center gap-1.5">
                <EnvironmentMachineSymbol
                  kind={machineByEnvironmentId.get(environment.environmentId) ?? "server"}
                  size={13}
                  tintColor={foregroundColor}
                />
                <Text className="shrink text-sm text-foreground" numberOfLines={1}>
                  {environment.label}
                </Text>
              </View>
              {environment.displayUrl === null ? null : (
                <Text className="mt-1 text-xs text-foreground-muted" numberOfLines={1}>
                  {environment.displayUrl}
                </Text>
              )}
            </Pressable>
          );
        })}
      </View>
    </SettingsSection>
  );
}
