import {
  resolveCompositionSquadFailedNodeActions,
  type CompositionSquadNodeActionContext,
  type CompositionSquadRunBoardNode,
} from "@codework/client-runtime/composition/squad-run-board";
import { View } from "react-native";

import { t } from "../../i18n";
import { SquadRunBoardActionButton } from "./SquadRunBoardActionButton";

export interface SquadRunBoardFailedNodeActionsProps {
  readonly node: CompositionSquadRunBoardNode;
  readonly context: CompositionSquadNodeActionContext;
  readonly disabled: boolean;
  readonly onRetry: (
    node: CompositionSquadRunBoardNode,
    capabilityIds: ReadonlyArray<string>,
    reassignAgentId?: string,
  ) => void;
}

/** 失败节点的重试与指定成员重派入口；不直接调用 RPC。 */
export function SquadRunBoardFailedNodeActions(props: SquadRunBoardFailedNodeActionsProps) {
  const actions = resolveCompositionSquadFailedNodeActions(props.node, props.context);
  if (actions.length === 0) return null;
  return (
    <View className="flex-row flex-wrap gap-2">
      {actions.includes("retry") ? (
        <SquadRunBoardActionButton
          label={t("squadExecutionHistory.retryNode")}
          disabled={props.disabled}
          onPress={() => props.onRetry(props.node, props.context.retryCapabilityIds)}
        />
      ) : null}
      {actions.includes("reassign")
        ? props.context.reassignTargets.map((target) => (
            <SquadRunBoardActionButton
              key={target.agentId}
              label={t("squadExecutionHistory.reassignNode")}
              detail={target.agentId}
              disabled={props.disabled}
              onPress={() => props.onRetry(props.node, target.capabilityIds, target.agentId)}
            />
          ))
        : null}
    </View>
  );
}
