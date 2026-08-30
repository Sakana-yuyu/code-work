import { Pressable } from "react-native";

import { AppText as Text } from "../../components/AppText";

export function SquadRunBoardActionButton(props: {
  readonly label: string;
  readonly detail?: string;
  readonly disabled: boolean;
  readonly emphasized?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel={props.label}
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      className={
        props.disabled
          ? "rounded-full bg-subtle px-3 py-1.5 opacity-[0.45]"
          : props.emphasized
            ? "rounded-full bg-subtle-strong px-3 py-1.5"
            : "rounded-full bg-subtle px-3 py-1.5"
      }
    >
      <Text className="text-sm font-t3-medium text-foreground">
        {props.label}
        {props.detail === undefined ? null : ` · ${props.detail}`}
      </Text>
    </Pressable>
  );
}
