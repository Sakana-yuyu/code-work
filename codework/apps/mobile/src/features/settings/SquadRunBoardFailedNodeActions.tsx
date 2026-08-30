import {
  resolveCompositionSquadFailedNodeActions,
  type CompositionSquadNodeActionContext,
  type CompositionSquadRunBoardNode,
} from "@codework/client-runtime/composition/squad-run-board";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { t } from "../../i18n";

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
        <ActionButton
          label={t("squadExecutionHistory.retryNode")}
          disabled={props.disabled}
          onPress={() => props.onRetry(props.node, props.context.retryCapabilityIds)}
        />
      ) : null}
      {actions.includes("reassign")
        ? props.context.reassignTargets.map((target) => (
            <ActionButton
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

function ActionButton(props: {
  readonly label: string;
  readonly detail?: string;
  readonly disabled: boolean;
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
          : "rounded-full bg-subtle-strong px-3 py-1.5"
      }
    >
      <Text className="text-sm font-t3-medium text-foreground">
        {props.label}
        {props.detail === undefined ? null : ` · ${props.detail}`}
      </Text>
    </Pressable>
  );
}
