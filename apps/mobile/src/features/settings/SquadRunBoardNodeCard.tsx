import type { CompositionSquadRunBoardNode } from "@codework/client-runtime/composition/squad-run-board";
import type { CompositionTaskEvent } from "@codework/contracts";
import type { ReactNode } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { t } from "../../i18n";

export interface SquadRunBoardNodeCardProps {
  readonly node: CompositionSquadRunBoardNode;
  readonly eventsExpanded: boolean;
  readonly events: ReadonlyArray<CompositionTaskEvent>;
  readonly eventsPending: boolean;
  readonly eventsError: string | null;
  readonly actions?: ReactNode;
  readonly actionError?: string | null;
  readonly onToggleEvents: () => void;
}

/** 单个 Squad 节点的持久化身份、最新 Run 状态和事件日志。 */
export function SquadRunBoardNodeCard(props: SquadRunBoardNodeCardProps) {
  const { node } = props;
  const run = node.snapshot?.latestRun;
  const status = run?.status ?? node.snapshot?.task.status;
  const agentId = run?.agentId ?? node.agentId ?? node.snapshot?.task.assigneeId;
  const runId = run?.runId ?? node.runId;

  return (
    <View className="gap-2 rounded-[16px] bg-subtle px-3 py-3">
      <View className="flex-row flex-wrap items-center gap-2">
        <Text className="min-w-0 flex-1 text-sm font-codework-medium text-foreground">
          {node.nodeId}
        </Text>
        {status === undefined ? null : <BadgePill label={status} />}
      </View>
      <Text className="font-mono text-xs text-foreground-muted" numberOfLines={1}>
        {node.taskId}
      </Text>
      {runId === undefined ? null : (
        <Text className="font-mono text-xs text-foreground-muted" numberOfLines={1}>
          {runId}
        </Text>
      )}
      {agentId === undefined ? null : (
        <Text className="text-xs text-foreground-muted" numberOfLines={1}>
          {agentId}
        </Text>
      )}
      {run?.resultSummary === undefined ? null : (
        <Text className="text-sm text-foreground">{run.resultSummary}</Text>
      )}
      {run?.failureCode === undefined ? null : (
        <Text className="font-mono text-xs text-danger-foreground">{run.failureCode}</Text>
      )}
      {props.actions}
      {props.actionError === undefined || props.actionError === null ? null : (
        <Text className="text-sm text-danger-foreground">{props.actionError}</Text>
      )}
      {run === undefined ? null : (
        <View className="items-start pt-1">
          <Pressable
            accessibilityLabel={t(
              props.eventsExpanded
                ? "controlCenter.hideTaskEvents"
                : "controlCenter.viewTaskEvents",
            )}
            accessibilityRole="button"
            onPress={props.onToggleEvents}
            className="rounded-full bg-subtle-strong px-3 py-1.5"
          >
            <Text className="text-sm font-codework-medium text-foreground">
              {t(
                props.eventsExpanded
                  ? "controlCenter.hideTaskEvents"
                  : "controlCenter.viewTaskEvents",
              )}
            </Text>
          </Pressable>
        </View>
      )}
      {props.eventsExpanded ? (
        <View className="gap-2 border-t border-border-subtle pt-3">
          <Text className="text-sm font-codework-medium text-foreground">
            {t("controlCenter.taskEvents")}
          </Text>
          {props.eventsError !== null ? (
            <Text className="text-sm text-danger-foreground">
              {t("controlCenter.taskEventsFailed", { message: props.eventsError })}
            </Text>
          ) : props.eventsPending ? (
            <Text className="text-sm text-foreground-muted">
              {t("controlCenter.taskEventsLoading")}
            </Text>
          ) : props.events.length === 0 ? (
            <Text className="text-sm text-foreground-muted">
              {t("controlCenter.taskEventsEmpty")}
            </Text>
          ) : (
            props.events.map((event) => (
              <SquadRunBoardEventRow key={`${event.runId}:${event.sequence}`} event={event} />
            ))
          )}
        </View>
      ) : null}
    </View>
  );
}

function SquadRunBoardEventRow(props: { readonly event: CompositionTaskEvent }) {
  const { event } = props;
  return (
    <View className="gap-1 border-t border-border-subtle pt-2 first:border-t-0 first:pt-0">
      <Text className="text-sm text-foreground">{event.summary}</Text>
      <Text className="font-mono text-xs text-foreground-muted">
        #{event.sequence} · {event.eventType} · {event.status}
      </Text>
      {event.blockerCode === undefined ? null : (
        <Text className="font-mono text-xs text-warning-foreground">{event.blockerCode}</Text>
      )}
      {event.progress === undefined ? null : (
        <Text className="text-xs text-foreground-muted">
          {t("controlCenter.taskEventProgress", { progress: event.progress })}
        </Text>
      )}
    </View>
  );
}

function BadgePill(props: { readonly label: string }) {
  return (
    <View className="rounded-full bg-subtle-strong px-2.5 py-0.5">
      <Text className="text-xs text-foreground">{props.label}</Text>
    </View>
  );
}
