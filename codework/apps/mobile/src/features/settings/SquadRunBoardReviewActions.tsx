import {
  resolveCompositionSquadReviewActions,
  type CompositionSquadReviewAction,
  type CompositionSquadRunBoardNode,
} from "@codework/client-runtime/composition/squad-run-board";
import { View } from "react-native";

import { t } from "../../i18n";
import { SquadRunBoardActionButton } from "./SquadRunBoardActionButton";

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
      <SquadRunBoardActionButton
        label={t("squadExecutionHistory.approveNode")}
        disabled={props.disabled}
        emphasized
        onPress={() => props.onReview(props.node, "approve")}
      />
      <SquadRunBoardActionButton
        label={t("squadExecutionHistory.rejectNode")}
        disabled={props.disabled}
        onPress={() => props.onReview(props.node, "reject")}
      />
    </View>
  );
}
