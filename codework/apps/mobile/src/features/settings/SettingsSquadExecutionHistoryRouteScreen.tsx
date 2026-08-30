import {
  projectCompositionSquadRunBoard,
  resolveCompositionSquadNodeEventTarget,
  type CompositionSquadReviewAction,
  type CompositionSquadRunBoardNode,
} from "@codework/client-runtime/composition/squad-run-board";
import type { CompositionSquad, CompositionTaskEvent } from "@codework/contracts";
import { useNavigation } from "@react-navigation/native";
import { useMemo, useState } from "react";
import { Platform, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { t } from "../../i18n";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useEnvironments } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import {
  projectSquadRunBoardHistory,
  type SquadRunBoardHistoryItem,
} from "./SettingsSquadExecutionHistoryRouteScreen.logic";
import { SquadRunBoardExecutionCard } from "./SquadRunBoardExecutionCard";
import { useSquadRunBoardNodeCommands } from "./useSquadRunBoardNodeCommands";

/** 最近 Squad execution 的移动端控制看板，节点身份和事件均来自持久化服务端投影。 */
export function SettingsSquadExecutionHistoryRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { environments } = useEnvironments();
  const projects = useProjects();
  const environmentId = environments[0]?.environmentId ?? null;
  const executionsQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.compositionSquadExecutions({
          environmentId,
          input: { limit: 20 },
        }),
  );
  const tasksQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.listCompositionTasks({ environmentId, input: {} }),
  );
  const squadsQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.compositionSquads({
          environmentId,
          input: { includeArchived: true },
        }),
  );
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const environmentProjects = useMemo(
    () => projects.filter((project) => project.environmentId === environmentId),
    [environmentId, projects],
  );
  const runBoards = useMemo(
    () =>
      projectCompositionSquadRunBoard(
        executionsQuery.data?.executions ?? [],
        tasksQuery.data?.tasks ?? [],
      ),
    [executionsQuery.data?.executions, tasksQuery.data?.tasks],
  );
  const history = useMemo(() => {
    const squadTitlesById = new Map(
      (squadsQuery.data?.squads ?? []).map((squad) => [squad.squadId, squad.name]),
    );
    const projectTitlesById = new Map(
      environmentProjects.map((project) => [project.id, project.title]),
    );
    return projectSquadRunBoardHistory(runBoards, squadTitlesById, projectTitlesById);
  }, [environmentProjects, runBoards, squadsQuery.data?.squads]);
  const selectedNode = useMemo(
    () =>
      history
        .flatMap((execution) => execution.nodes)
        .find((node) => node.taskId === selectedTaskId) ?? null,
    [history, selectedTaskId],
  );
  const eventTarget = resolveCompositionSquadNodeEventTarget(selectedNode);
  const eventsQuery = useEnvironmentQuery(
    environmentId === null || eventTarget === null
      ? null
      : serverEnvironment.listCompositionTaskEvents({
          environmentId,
          input: eventTarget,
        }),
  );
  const nodeCommands = useSquadRunBoardNodeCommands({
    environmentId,
    refreshers: {
      refreshExecutions: executionsQuery.refresh,
      refreshTasks: tasksQuery.refresh,
      refreshEvents: eventsQuery.refresh,
    },
  });
  const queries = [executionsQuery, tasksQuery, squadsQuery] as const;
  const refreshing = queries.some((query) => query.isPending && query.data !== null);
  const initialPending = queries.some((query) => query.isPending && query.data === null);
  const initialError = queries.some((query) => query.error !== null && query.data === null);
  const staleError = queries.some((query) => query.error !== null);

  const refresh = (): void => {
    executionsQuery.refresh();
    tasksQuery.refresh();
    squadsQuery.refresh();
    if (eventTarget !== null) eventsQuery.refresh();
  };

  const toggleEvents = (taskId: string): void => {
    setSelectedTaskId((current) => (current === taskId ? null : taskId));
  };

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader
            title={t("squadExecutionHistory.title")}
            onBack={() => navigation.goBack()}
          />
        </>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-3 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
      >
        {environmentId === null ? (
          <StatusMessage text={t("squadExecutionHistory.noEnvironment")} />
        ) : initialPending ? (
          <StatusMessage text={t("squadExecutionHistory.pending")} />
        ) : initialError ? (
          <StatusMessage text={t("squadExecutionHistory.error")} tone="danger" />
        ) : history.length === 0 ? (
          <StatusMessage
            text={t(staleError ? "squadExecutionHistory.error" : "squadExecutionHistory.empty")}
            tone={staleError ? "danger" : undefined}
          />
        ) : (
          <SquadRunBoardHistory
            history={history}
            staleError={staleError}
            squads={squadsQuery.data?.squads ?? []}
            selectedTaskId={selectedTaskId}
            pendingActionTaskId={nodeCommands.pendingTaskId}
            actionError={nodeCommands.error}
            events={eventsQuery.data?.events ?? []}
            eventsPending={eventsQuery.isPending}
            eventsError={eventsQuery.error}
            onToggleEvents={toggleEvents}
            onRetry={(node, capabilityIds, reassignAgentId) =>
              void nodeCommands.retryNode(node, capabilityIds, reassignAgentId)
            }
            onReview={(node, decision) => void nodeCommands.reviewNode(node, decision)}
          />
        )}
      </ScrollView>
    </View>
  );
}

function SquadRunBoardHistory(props: {
  readonly history: ReadonlyArray<SquadRunBoardHistoryItem>;
  readonly staleError: boolean;
  readonly squads: ReadonlyArray<CompositionSquad>;
  readonly selectedTaskId: string | null;
  readonly pendingActionTaskId: string | null;
  readonly actionError: { readonly taskId: string; readonly message: string } | null;
  readonly events: ReadonlyArray<CompositionTaskEvent>;
  readonly eventsPending: boolean;
  readonly eventsError: string | null;
  readonly onToggleEvents: (taskId: string) => void;
  readonly onRetry: (
    node: CompositionSquadRunBoardNode,
    capabilityIds: ReadonlyArray<string>,
    reassignAgentId?: string,
  ) => void;
  readonly onReview: (
    node: CompositionSquadRunBoardNode,
    decision: CompositionSquadReviewAction,
  ) => void;
}) {
  return (
    <View className="gap-3">
      {props.staleError ? (
        <StatusMessage text={t("squadExecutionHistory.error")} tone="danger" />
      ) : null}
      {props.history.map((item) => {
        const squad = props.squads.find((candidate) => candidate.squadId === item.squadId) ?? null;
        return (
          <SquadRunBoardExecutionCard
            key={item.executionId}
            item={item}
            squad={squad}
            selectedTaskId={props.selectedTaskId}
            pendingActionTaskId={props.pendingActionTaskId}
            actionError={props.actionError}
            events={props.events}
            eventsPending={props.eventsPending}
            eventsError={props.eventsError}
            onToggleEvents={props.onToggleEvents}
            onRetry={props.onRetry}
            onReview={props.onReview}
          />
        );
      })}
    </View>
  );
}

function StatusMessage(props: { readonly text: string; readonly tone?: "danger" }) {
  return (
    <View className="rounded-[24px] border-continuous bg-card px-4 py-6">
      <Text
        className={
          props.tone === "danger"
            ? "text-center text-sm text-danger-foreground"
            : "text-center text-sm text-foreground-muted"
        }
      >
        {props.text}
      </Text>
    </View>
  );
}
