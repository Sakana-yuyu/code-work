import type { CompositionTaskEvent } from "@codework/contracts";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { t } from "../../i18n";
import type { SquadRunBoardHistoryItem } from "./SettingsSquadExecutionHistoryRouteScreen.logic";
import { SquadRunBoardNodeCard } from "./SquadRunBoardNodeCard";

const EXECUTION_CREATED_AT_FORMATTER = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export interface SquadRunBoardExecutionCardProps {
  readonly item: SquadRunBoardHistoryItem;
  readonly selectedTaskId: string | null;
  readonly events: ReadonlyArray<CompositionTaskEvent>;
  readonly eventsPending: boolean;
  readonly eventsError: string | null;
  readonly onToggleEvents: (taskId: string) => void;
}

/** 一个 Squad execution 的摘要和节点列表；命令编排由路由层负责。 */
export function SquadRunBoardExecutionCard(props: SquadRunBoardExecutionCardProps) {
  const { item } = props;
  return (
    <View className="gap-3 rounded-[24px] border-continuous bg-card p-4">
      <View className="gap-1">
        <View className="flex-row flex-wrap items-center gap-2">
          <Text
            className="min-w-0 flex-1 text-base font-t3-medium text-foreground"
            numberOfLines={1}
          >
            {item.squadDisplayName}
          </Text>
          <BadgePill label={t(item.statusLabelKey)} emphasized />
        </View>
        <Text className="font-mono text-xs text-foreground-muted" numberOfLines={1}>
          {item.executionId}
        </Text>
      </View>

      <View className="flex-row flex-wrap gap-2">
        <BadgePill label={t("squadExecutionHistory.revision", { revision: item.revision })} />
        <BadgePill label={t("squadExecutionHistory.nodes", { count: item.nodes.length })} />
        <BadgePill
          label={t("squadExecutionHistory.pendingApprovals", {
            count: item.pendingApprovalCount,
          })}
        />
      </View>

      <View className="gap-1 border-t border-border-subtle pt-3">
        <Text className="text-sm text-foreground" numberOfLines={1}>
          {`${t("squadExecutionHistory.project")}: ${item.projectTitle}`}
        </Text>
        <Text className="text-xs text-foreground-muted">
          {EXECUTION_CREATED_AT_FORMATTER.format(new Date(item.createdAtUnixMs))}
        </Text>
      </View>

      {item.resultSummary === undefined ? null : (
        <View className="gap-1 border-t border-border-subtle pt-3">
          <Text className="text-xs font-t3-medium text-foreground-muted">
            {t("squadExecutionHistory.resultSummary")}
          </Text>
          <Text className="text-sm text-foreground">{item.resultSummary}</Text>
        </View>
      )}

      {item.failureCode === undefined ? null : (
        <View className="gap-1 border-t border-border-subtle pt-3">
          <Text className="text-xs font-t3-medium text-foreground-muted">
            {t("squadExecutionHistory.failureCode")}
          </Text>
          <Text className="font-mono text-sm text-danger-foreground">{item.failureCode}</Text>
          {item.failureDetail === undefined ? null : (
            <Text className="text-sm text-danger-foreground">{item.failureDetail}</Text>
          )}
        </View>
      )}

      <View className="gap-2 border-t border-border-subtle pt-3">
        {item.nodes.map((node) => {
          const selected = props.selectedTaskId === node.taskId;
          return (
            <SquadRunBoardNodeCard
              key={node.taskId}
              node={node}
              eventsExpanded={selected}
              events={selected ? props.events : []}
              eventsPending={selected && props.eventsPending}
              eventsError={selected ? props.eventsError : null}
              onToggleEvents={() => props.onToggleEvents(node.taskId)}
            />
          );
        })}
      </View>
    </View>
  );
}

function BadgePill(props: { readonly label: string; readonly emphasized?: boolean }) {
  return (
    <View
      className={
        props.emphasized
          ? "rounded-full bg-subtle-strong px-2.5 py-0.5"
          : "rounded-full bg-subtle px-2.5 py-0.5"
      }
    >
      <Text className="text-xs text-foreground">{props.label}</Text>
    </View>
  );
}
