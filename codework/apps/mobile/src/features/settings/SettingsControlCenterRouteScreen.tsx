import { useNavigation } from "@react-navigation/native";
import type {
  CompositionControlCenterResult,
  CompositionControlCenterTask,
  CompositionTaskEvent,
  EnvironmentId,
} from "@codework/contracts";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@codework/client-runtime/state/runtime";
import { useState } from "react";
import { Platform, Pressable, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { uuidv4 } from "../../lib/uuid";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { t } from "../../i18n";
import {
  buildByokResumeRedispatchInput,
  buildRedispatchInput,
  buildResumeInput,
  formatByokDelegationMeta,
  formatByokResumeMeta,
  formatGoalLoopMeta,
  formatGrantMeta,
  formatSquadMeta,
  goalLoopStateLabelKey,
  resolveControlCenterEventTarget,
  resolveControlCenterTaskActions,
  sortControlCenterSquads,
} from "./SettingsControlCenterRouteScreen.logic";

const goalLoopStateLabel = (state: string): string => {
  const key = goalLoopStateLabelKey(state);
  return key === null ? state : t(key);
};

export function SettingsControlCenterRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { environments } = useEnvironments();
  const environmentId = environments[0]?.environmentId ?? null;
  const projectionQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.controlCenterProjection({ environmentId, input: {} }),
  );
  const squadsQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.compositionSquads({ environmentId, input: {} }),
  );
  const redispatchTask = useAtomCommand(serverEnvironment.controlCenterRedispatch, {
    reportFailure: false,
  });
  const cancelCompositionTask = useAtomCommand(serverEnvironment.cancelCompositionTask, {
    reportFailure: false,
  });
  const resumeCompositionTask = useAtomCommand(serverEnvironment.resumeCompositionTask, {
    reportFailure: false,
  });
  const reviewCompositionTask = useAtomCommand(serverEnvironment.reviewCompositionTask, {
    reportFailure: false,
  });
  const abandonControlCenterTask = useAtomCommand(serverEnvironment.controlCenterAbandon, {
    reportFailure: false,
  });
  const byokResumeRedispatchTask = useAtomCommand(
    serverEnvironment.controlCenterByokResumeRedispatch,
    { reportFailure: false },
  );
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [selectedEventTaskId, setSelectedEventTaskId] = useState<string | null>(null);

  const projection: CompositionControlCenterResult | null = projectionQuery.data;
  const squads = sortControlCenterSquads(squadsQuery.data?.squads ?? []);
  const eventTarget = resolveControlCenterEventTarget(projection?.tasks ?? [], selectedEventTaskId);
  const eventsQuery = useEnvironmentQuery(
    environmentId === null || eventTarget === null
      ? null
      : serverEnvironment.listCompositionTaskEvents({
          environmentId,
          input: eventTarget,
        }),
  );

  const runRowCommand = async (
    taskId: string,
    fallbackErrorKey: string,
    execute: (environmentId: EnvironmentId) => Promise<AtomCommandResult<unknown, unknown>>,
  ): Promise<void> => {
    if (environmentId === null || pendingTaskId !== null) return;
    setPendingTaskId(taskId);
    setActionError(null);
    const result = await execute(environmentId);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      setActionError(error instanceof Error ? error.message : t(fallbackErrorKey));
    } else {
      projectionQuery.refresh();
      if (selectedEventTaskId === taskId) eventsQuery.refresh();
    }
    setPendingTaskId(null);
  };

  const redispatch = (task: CompositionControlCenterTask): Promise<void> =>
    runRowCommand(task.taskId, "controlCenter.redispatchFailed", (envId) =>
      redispatchTask({
        environmentId: envId,
        input: buildRedispatchInput({
          taskId: task.taskId,
          runId: task.latestRun?.runId ?? "",
          agentId: task.agentId,
          newRunId: `t3-redispatch-${uuidv4()}`,
          // 移动端不提供能力 ID 输入：重派不重发 capability grant。
          capabilityIdsText: "",
        }),
      }),
    );

  const cancel = (task: CompositionControlCenterTask): Promise<void> =>
    runRowCommand(task.taskId, "controlCenter.cancelFailed", (envId) =>
      cancelCompositionTask({
        environmentId: envId,
        input: {
          taskId: task.taskId,
          runId: task.latestRun?.runId ?? "",
          reason: t("controlCenter.cancelReasonDefault"),
        },
      }),
    );

  const resume = (task: CompositionControlCenterTask): Promise<void> =>
    runRowCommand(task.taskId, "controlCenter.resumeFailed", (envId) =>
      resumeCompositionTask({
        environmentId: envId,
        input: buildResumeInput({
          taskId: task.taskId,
          runId: task.latestRun?.runId ?? "",
          reason: t("controlCenter.resumeReasonDefault"),
        }),
      }),
    );

  const review = (
    task: CompositionControlCenterTask,
    decision: "approve" | "reject",
  ): Promise<void> =>
    runRowCommand(task.taskId, "controlCenter.reviewFailed", (envId) =>
      reviewCompositionTask({
        environmentId: envId,
        input: {
          taskId: task.taskId,
          runId: task.latestRun?.runId ?? "",
          decision,
          reason: t(
            decision === "approve"
              ? "controlCenter.approveReasonDefault"
              : "controlCenter.rejectReasonDefault",
          ),
        },
      }),
    );

  const abandon = (task: CompositionControlCenterTask): Promise<void> =>
    runRowCommand(task.taskId, "controlCenter.abandonFailed", (envId) =>
      abandonControlCenterTask({
        environmentId: envId,
        input: {
          taskId: task.taskId,
          runId: task.latestRun?.runId ?? "",
          agentId: task.agentId,
          note: t("controlCenter.abandonReasonDefault"),
        },
      }),
    );

  const byokResumeRedispatch = (task: CompositionControlCenterTask): Promise<void> =>
    runRowCommand(task.taskId, "controlCenter.byokResumeRedispatchFailed", (envId) =>
      byokResumeRedispatchTask({
        environmentId: envId,
        input: buildByokResumeRedispatchInput({
          taskId: task.taskId,
          runId: task.latestRun?.runId ?? "",
          agentId: task.agentId,
          newRunId: `t3-byok-resume-${uuidv4()}`,
          note: t("controlCenter.byokResumeReasonDefault"),
        }),
      }),
    );

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          {/* Android renders its own in-screen header instead of the native bar. */}
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader
            title={t("controlCenter.title")}
            onBack={() => navigation.goBack()}
          />
        </>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        refreshControl={
          <RefreshControl
            refreshing={projectionQuery.isPending && projection !== null}
            onRefresh={() => {
              projectionQuery.refresh();
              eventsQuery.refresh();
              squadsQuery.refresh();
            }}
          />
        }
      >
        <View className="gap-3">
          <Text className="px-2 text-sm font-t3-medium text-foreground-muted">
            {t("controlCenter.tasks")}
          </Text>
          {environmentId === null ? (
            <StatusMessage text={t("controlCenter.noEnvironment")} />
          ) : projection === null && projectionQuery.isPending ? (
            <StatusMessage text={t("controlCenter.pending")} />
          ) : projection === null && projectionQuery.error !== null ? (
            <StatusMessage text={t("controlCenter.error")} tone="danger" />
          ) : projection === null || projection.tasks.length === 0 ? (
            <StatusMessage text={t("controlCenter.noTasks")} />
          ) : (
            <View className="gap-3">
              {projection.tasks.map((task) => (
                <ControlCenterTaskCard
                  key={task.taskId}
                  task={task}
                  actionsDisabled={pendingTaskId !== null}
                  eventLogSelected={selectedEventTaskId === task.taskId}
                  eventLogPending={eventsQuery.isPending}
                  eventLogError={eventsQuery.error === null ? null : String(eventsQuery.error)}
                  events={
                    selectedEventTaskId === task.taskId ? (eventsQuery.data?.events ?? []) : []
                  }
                  onRedispatch={() => void redispatch(task)}
                  onCancel={() => void cancel(task)}
                  onResume={() => void resume(task)}
                  onApprove={() => void review(task, "approve")}
                  onReject={() => void review(task, "reject")}
                  onAbandon={() => void abandon(task)}
                  onByokResumeRedispatch={() => void byokResumeRedispatch(task)}
                  onToggleEvents={() =>
                    setSelectedEventTaskId((current) =>
                      current === task.taskId ? null : task.taskId,
                    )
                  }
                />
              ))}
              {actionError === null ? null : (
                <Text className="px-2 text-sm text-danger-foreground">{actionError}</Text>
              )}
            </View>
          )}
        </View>
        {environmentId === null ? null : (
          <View className="gap-3">
            <Text className="px-2 text-sm font-t3-medium text-foreground-muted">
              {t("controlCenter.squads")}
            </Text>
            {squadsQuery.data === null && squadsQuery.isPending ? (
              <StatusMessage text={t("controlCenter.squadsPending")} />
            ) : squadsQuery.error !== null ? (
              <StatusMessage text={t("controlCenter.squadsError")} tone="danger" />
            ) : squads.length === 0 ? (
              <StatusMessage text={t("controlCenter.squadsEmpty")} />
            ) : (
              <View className="overflow-hidden rounded-[24px] border-continuous bg-card">
                {squads.map((squad, index) => (
                  <View
                    key={squad.squadId}
                    className={
                      index === 0 ? "gap-0.5 p-4" : "gap-0.5 border-t border-border-subtle p-4"
                    }
                  >
                    <Text className="text-base text-foreground">{squad.name}</Text>
                    <Text className="text-sm text-foreground-muted">
                      {formatSquadMeta(
                        {
                          leader: t("controlCenter.leader"),
                          members: t("controlCenter.members"),
                        },
                        squad,
                      )}
                    </Text>
                  </View>
                ))}
              </View>
            )}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function ControlCenterTaskCard(props: {
  readonly task: CompositionControlCenterTask;
  readonly actionsDisabled: boolean;
  readonly eventLogSelected: boolean;
  readonly eventLogPending: boolean;
  readonly eventLogError: string | null;
  readonly events: ReadonlyArray<CompositionTaskEvent>;
  readonly onRedispatch: () => void;
  readonly onCancel: () => void;
  readonly onResume: () => void;
  readonly onApprove: () => void;
  readonly onReject: () => void;
  readonly onAbandon: () => void;
  readonly onByokResumeRedispatch: () => void;
  readonly onToggleEvents: () => void;
}) {
  const { task } = props;
  const actions = resolveControlCenterTaskActions(task);
  const hasTaskActions =
    actions.redispatchable ||
    actions.cancellable ||
    actions.resumable ||
    actions.reviewable ||
    actions.abandonable ||
    actions.byokResumable;
  const hasActions = hasTaskActions || task.latestRun !== undefined;

  return (
    <View className="gap-2 rounded-[24px] border-continuous bg-card p-4">
      <Text className="font-mono text-xs text-foreground-muted" numberOfLines={1}>
        {task.taskId}
      </Text>
      <View className="flex-row flex-wrap items-center gap-2">
        <BadgePill label={task.status} />
        {task.goalLoop === undefined ? null : (
          <BadgePill
            label={`${t("controlCenter.goalLoop")}: ${goalLoopStateLabel(task.goalLoop.state)}`}
            emphasized
          />
        )}
        {task.byokDelegation === undefined ? null : (
          <BadgePill label={t("controlCenter.byokDelegation")} emphasized />
        )}
      </View>
      {task.goalLoop === undefined ? null : (
        <Text className="text-sm text-foreground-muted">
          {formatGoalLoopMeta(
            { rounds: t("controlCenter.rounds"), rejected: t("controlCenter.rejected") },
            task.goalLoop,
          )}
        </Text>
      )}
      {task.byokDelegation === undefined ? null : (
        <Text className="text-sm text-foreground-muted">
          {formatByokDelegationMeta(
            { rounds: t("controlCenter.rounds"), errorCode: t("controlCenter.errorCode") },
            {
              agentId: task.agentId,
              attempt: task.byokDelegation.attempt,
              ...(task.byokDelegation.failureCode === undefined
                ? {}
                : { failureCode: task.byokDelegation.failureCode }),
            },
          )}
        </Text>
      )}
      {task.byokResume === undefined ? null : (
        <Text className="text-sm text-foreground-muted">
          {formatByokResumeMeta(
            {
              checkpoints: t("controlCenter.byokCheckpoints"),
              recoveredBytes: t("controlCenter.byokRecoveredBytes"),
              unrecoverable: t("controlCenter.byokUnrecoverable"),
            },
            task.byokResume,
          )}
        </Text>
      )}
      {task.grants === undefined ? null : (
        <Text className="text-sm text-foreground-muted">
          {formatGrantMeta(
            { grants: t("controlCenter.grants"), revoked: t("controlCenter.revoked") },
            task.grants,
          )}
        </Text>
      )}
      {task.humanAction === undefined ? null : (
        <View className="gap-1 rounded-[16px] bg-subtle px-3 py-2.5">
          <Text className="text-sm text-foreground">{task.humanAction.summary}</Text>
          {task.humanAction.blockerCode === undefined ? null : (
            <Text className="font-mono text-xs text-foreground-muted">
              {task.humanAction.blockerCode}
            </Text>
          )}
        </View>
      )}
      {hasActions ? (
        <View className="flex-row flex-wrap gap-2 pt-1">
          {task.latestRun === undefined ? null : (
            <ActionButton
              label={t(
                props.eventLogSelected
                  ? "controlCenter.hideTaskEvents"
                  : "controlCenter.viewTaskEvents",
              )}
              disabled={false}
              onPress={props.onToggleEvents}
            />
          )}
          {actions.redispatchable ? (
            <ActionButton
              label={t("controlCenter.redispatch")}
              disabled={props.actionsDisabled}
              onPress={props.onRedispatch}
            />
          ) : null}
          {actions.byokResumable ? (
            <ActionButton
              label={t("controlCenter.byokResumeRedispatch")}
              disabled={props.actionsDisabled}
              onPress={props.onByokResumeRedispatch}
            />
          ) : null}
          {actions.abandonable ? (
            <ActionButton
              label={t("controlCenter.abandon")}
              disabled={props.actionsDisabled}
              onPress={props.onAbandon}
            />
          ) : null}
          {actions.cancellable ? (
            <ActionButton
              label={t("controlCenter.cancel")}
              disabled={props.actionsDisabled}
              onPress={props.onCancel}
            />
          ) : null}
          {actions.resumable ? (
            <ActionButton
              label={t("controlCenter.resume")}
              disabled={props.actionsDisabled}
              onPress={props.onResume}
              emphasized
            />
          ) : null}
          {actions.reviewable ? (
            <>
              <ActionButton
                label={t("controlCenter.approve")}
                disabled={props.actionsDisabled}
                onPress={props.onApprove}
                emphasized
              />
              <ActionButton
                label={t("controlCenter.reject")}
                disabled={props.actionsDisabled}
                onPress={props.onReject}
              />
            </>
          ) : null}
        </View>
      ) : null}
      {props.eventLogSelected ? (
        <View className="gap-2 border-t border-border-subtle pt-3">
          <Text className="text-sm font-t3-medium text-foreground">
            {t("controlCenter.taskEvents")}
          </Text>
          {props.eventLogError !== null ? (
            <Text className="text-sm text-danger-foreground">
              {t("controlCenter.taskEventsFailed", { message: props.eventLogError })}
            </Text>
          ) : props.eventLogPending ? (
            <Text className="text-sm text-foreground-muted">
              {t("controlCenter.taskEventsLoading")}
            </Text>
          ) : props.events.length === 0 ? (
            <Text className="text-sm text-foreground-muted">
              {t("controlCenter.taskEventsEmpty")}
            </Text>
          ) : (
            props.events.map((event) => (
              <ControlCenterEventRow key={`${event.runId}:${event.sequence}`} event={event} />
            ))
          )}
        </View>
      ) : null}
    </View>
  );
}

function ControlCenterEventRow(props: { readonly event: CompositionTaskEvent }) {
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

function ActionButton(props: {
  readonly label: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
  readonly emphasized?: boolean;
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
