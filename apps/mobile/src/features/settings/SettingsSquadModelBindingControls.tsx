import type { ReactNode } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";

export interface SquadModelOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly disabled?: boolean;
}

export function SquadModelField(props: {
  readonly label: string;
  readonly description?: string;
  readonly children: ReactNode;
}) {
  return (
    <View className="gap-2">
      <Text className="text-sm font-t3-medium text-foreground">{props.label}</Text>
      {props.children}
      {props.description === undefined ? null : (
        <Text className="text-xs leading-5 text-foreground-muted">{props.description}</Text>
      )}
    </View>
  );
}

export function SquadModelOptionGroup<T extends string>(props: {
  readonly label: string;
  readonly options: ReadonlyArray<SquadModelOption<T>>;
  readonly selected: T;
  readonly disabled: boolean;
  readonly onSelect: (value: T) => void;
}) {
  return (
    <View className="gap-2">
      <Text className="text-sm font-t3-medium text-foreground">{props.label}</Text>
      <View className="flex-row flex-wrap gap-2">
        {props.options.map((option) => {
          const disabled = props.disabled || option.disabled === true;
          const selected = option.value === props.selected;
          return (
            <Pressable
              key={option.value}
              accessibilityLabel={option.label}
              accessibilityRole="button"
              accessibilityState={{ selected, disabled }}
              disabled={disabled}
              onPress={() => props.onSelect(option.value)}
              className={
                disabled
                  ? "rounded-full bg-subtle px-3 py-1.5 opacity-[0.45]"
                  : selected
                    ? "rounded-full bg-subtle-strong px-3 py-1.5"
                    : "rounded-full bg-subtle px-3 py-1.5"
              }
            >
              <Text className="text-sm text-foreground">{option.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export function SquadModelActionButton(props: {
  readonly label: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel={props.label}
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      className={
        props.disabled
          ? "self-start rounded-full bg-subtle px-3 py-1.5 opacity-[0.45]"
          : "self-start rounded-full bg-subtle-strong px-3 py-1.5"
      }
    >
      <Text className="text-sm font-t3-medium text-foreground">{props.label}</Text>
    </Pressable>
  );
}
