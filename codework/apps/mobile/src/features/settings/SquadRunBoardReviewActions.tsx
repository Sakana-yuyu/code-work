import {
  resolveCompositionSquadReviewActions,
  type CompositionSquadReviewAction,
  type CompositionSquadRunBoardNode,
} from "@codework/client-runtime/composition/squad-run-board";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { t } from "../../i18n";

export interface SquadRunBoardReviewActionsProps {
  readonly node: CompositionSquadRunBoardNode;
  readonly disabled: boolean;
  readonly onReview: (
    node: CompositionSquadRunBoardNode,
    decision: CompositionSquadReviewAction,
  ) => void;
}

/** in_review 节点的人工通过与驳回入口；不直接调用 RPC。 */
export function SquadRunBoardReviewActions(props: SquadRunBoardReviewActionsProps) {
  const actions = resolveCompositionSquadReviewActions(props.node);
  if (actions.length === 0) return null;
  return (
    <View className="flex-row flex-wrap gap-2">
      <ActionButton
        label={t("squadExecutionHistory.approveNode")}
        disabled={props.disabled}
        emphasized
        onPress={() => props.onReview(props.node, "approve")}
      />
      <ActionButton
        label={t("squadExecutionHistory.rejectNode")}
        disabled={props.disabled}
        onPress={() => props.onReview(props.node, "reject")}
      />
    </View>
  );
}

function ActionButton(props: {
  readonly label: string;
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
      <Text className="text-sm font-t3-medium text-foreground">{props.label}</Text>
    </Pressable>
  );
}
