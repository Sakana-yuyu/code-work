import { useNavigation } from "@react-navigation/native";
import type {
  CompositionControlCenterResult,
  CompositionControlCenterTask,
  CompositionSquadExecutionResult,
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
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { uuidv4 } from "../../lib/uuid";
import { useEnvironments } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { t } from "../../i18n";
import {
  buildByokResumeRedispatchInput,
  buildControlCenterSquadRunRequest,
  buildRedispatchInput,
  buildResumeInput,
  createControlCenterSquadPlanNodeDraft,
  formatByokDelegationMeta,
  formatByokResumeMeta,
  formatGoalLoopMeta,
  formatGrantMeta,
  formatSquadMeta,
  goalLoopStateLabelKey,
  resolveControlCenterEventTarget,
  resolveControlCenterTaskActions,
  sortControlCenterSquads,
  type ControlCenterSquadPlanNodeDraft,
  type ControlCenterSquadRunIssue,
} from "./SettingsControlCenterRouteScreen.logic";
import { squadMemberRoleLabelKey } from "./SettingsSquadBuilderRouteScreen.logic";

const goalLoopStateLabel = (state: string): string => {
  const key = goalLoopStateLabelKey(state);
  return key === null ? state : t(key);
};

const squadRunIssueLabel = (issue: ControlCenterSquadRunIssue): string =>
  t(`controlCenter.squadRunIssue.${issue}`);

export function SettingsControlCenterRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { environments } = useEnvironments();
  const projects = useProjects();
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
  const runCompositionSquad = useAtomCommand(serverEnvironment.runCompositionSquad, {
    reportFailure: false,
  });
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
  const [selectedSquadId, setSelectedSquadId] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [squadGoal, setSquadGoal] = useState("");
  const [squadPlanDrafts, setSquadPlanDrafts] = useState<ControlCenterSquadPlanNodeDraft[]>([]);
  const [squadRunPending, setSquadRunPending] = useState(false);
  const [squadRunError, setSquadRunError] = useState<string | null>(null);
  const [squadRunResult, setSquadRunResult] = useState<CompositionSquadExecutionResult | null>(
    null,
  );

  const projection: CompositionControlCenterResult | null = projectionQuery.data;
  const squads = sortControlCenterSquads(squadsQuery.data?.squads ?? []);
  const environmentProjects = projects.filter((project) => project.environmentId === environmentId);
  const selectedSquad =
    squads.find((squad) => squad.squadId === selectedSquadId) ?? squads[0] ?? null;
  const selectedProject =
    environmentProjects.find((project) => project.id === selectedProjectId) ??
    environmentProjects[0] ??
    null;
  const squadRunBuild = buildControlCenterSquadRunRequest({
    executionId: "mobile-preview",
    squad: selectedSquad,
    project: selectedProject,
    goal: squadGoal,
    planDrafts: squadPlanDrafts,
  });
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
          newRunId: `codework-redispatch-${uuidv4()}`,
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
          newRunId: `codework-byok-resume-${uuidv4()}`,
          note: t("controlCenter.byokResumeReasonDefault"),
        }),
      }),
    );

  const selectSquad = (squadId: string): void => {
    setSelectedSquadId(squadId);
    setSquadPlanDrafts([]);
    setSquadRunError(null);
    setSquadRunResult(null);
  };

  const addSquadPlanNode = (): void => {
    const agentId = selectedSquad?.members?.[0]?.agentId ?? "";
    setSquadPlanDrafts((current) => [
      ...current,
      createControlCenterSquadPlanNodeDraft({
        clientId: uuidv4(),
        agentId,
        current,
      }),
    ]);
  };

  const patchSquadPlanNode = (
    clientId: string,
    patch: Partial<Omit<ControlCenterSquadPlanNodeDraft, "clientId">>,
  ): void => {
    setSquadPlanDrafts((current) =>
      current.map((node) => (node.clientId === clientId ? { ...node, ...patch } : node)),
    );
  };

  const removeSquadPlanNode = (clientId: string): void => {
    setSquadPlanDrafts((current) => current.filter((node) => node.clientId !== clientId));
  };

  const runSelectedSquad = async (): Promise<void> => {
    if (environmentId === null || squadRunPending) return;
    const built = buildControlCenterSquadRunRequest({
      executionId: `mobile-squad-${uuidv4()}`,
      squad: selectedSquad,
      project: selectedProject,
      goal: squadGoal,
      planDrafts: squadPlanDrafts,
    });
    if (built.request === null) {
      setSquadRunError(squadRunIssueLabel(built.issue ?? "squad_missing"));
      return;
    }
    setSquadRunPending(true);
    setSquadRunError(null);
    setSquadRunResult(null);
    const result: AtomCommandResult<CompositionSquadExecutionResult, unknown> =
      await runCompositionSquad({ environmentId, input: built.request });
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      setSquadRunError(error instanceof Error ? error.message : t("controlCenter.squadRunFailed"));
    } else {
      setSquadRunResult(result.value);
      setSquadGoal("");
      setSquadPlanDrafts([]);
      projectionQuery.refresh();
      eventsQuery.refresh();
    }
    setSquadRunPending(false);
  };

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
          <Text className="px-2 text-sm font-codework-medium text-foreground-muted">
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
            <Text className="px-2 text-sm font-codework-medium text-foreground-muted">
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
                {squads.map((squad, index) => {
                  const selected = squad.squadId === selectedSquad?.squadId;
                  return (
                    <Pressable
                      key={squad.squadId}
                      accessibilityRole="radio"
                      accessibilityState={{ selected }}
                      onPress={() => selectSquad(squad.squadId)}
                      className={`${index === 0 ? "" : "border-t border-border-subtle "}${selected ? "bg-subtle " : ""}gap-0.5 p-4`}
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
                      <Text className="text-xs text-foreground-muted">
                        {t("controlCenter.squadRevisionMode", {
                          revision: squad.revision ?? 1,
                          mode: squad.collaborationMode ?? t("controlCenter.squadLegacyMode"),
                        })}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            )}
            <View className="gap-3 rounded-[24px] border-continuous bg-card p-4">
              <Text className="text-base font-codework-medium text-foreground">
                {t("controlCenter.runSquad")}
              </Text>
              <View className="gap-2">
                <Text className="text-sm text-foreground-muted">
                  {t("controlCenter.runSquadProject")}
                </Text>
                <View className="flex-row flex-wrap gap-2">
                  {environmentProjects.map((project) => (
                    <ActionButton
                      key={project.id}
                      label={project.title}
                      disabled={squadRunPending}
                      emphasized={project.id === selectedProject?.id}
                      onPress={() => setSelectedProjectId(project.id)}
                    />
                  ))}
                </View>
              </View>
              <TextInput
                value={squadGoal}
                onChangeText={setSquadGoal}
                editable={!squadRunPending}
                multiline
                textAlignVertical="top"
                className="min-h-28"
                placeholder={t("controlCenter.runSquadGoalPlaceholder")}
              />
              {selectedSquad?.collaborationMode === "dependency_graph" ? (
                <View className="gap-3 border-t border-border-subtle pt-3">
                  <View className="gap-1">
                    <Text className="text-sm font-codework-medium text-foreground">
                      {t("controlCenter.dependencyPlan")}
                    </Text>
                    <Text className="text-sm text-foreground-muted">
                      {t("controlCenter.dependencyPlanHint")}
                    </Text>
                  </View>
                  {squadPlanDrafts.length === 0 ? (
                    <Text className="text-sm text-foreground-muted">
                      {t("controlCenter.dependencyPlanEmpty")}
                    </Text>
                  ) : (
                    squadPlanDrafts.map((node, index) => (
                      <View
                        key={node.clientId}
                        className={`${index === 0 ? "" : "border-t border-border-subtle pt-3 "}gap-3`}
                      >
                        <View className="flex-row items-center justify-between gap-3">
                          <Text className="text-sm font-codework-medium text-foreground">
                            {t("controlCenter.dependencyPlanNode", { index: index + 1 })}
                          </Text>
                          <ActionButton
                            label={t("controlCenter.removeDependencyPlanNode")}
                            disabled={squadRunPending}
                            onPress={() => removeSquadPlanNode(node.clientId)}
                          />
                        </View>
                        <View className="gap-2">
                          <Text className="text-sm text-foreground-muted">
                            {t("controlCenter.dependencyPlanNodeId")}
                          </Text>
                          <TextInput
                            value={node.nodeId}
                            onChangeText={(nodeId) => patchSquadPlanNode(node.clientId, { nodeId })}
                            editable={!squadRunPending}
                            autoCapitalize="none"
                            autoCorrect={false}
                            placeholder={t("controlCenter.dependencyPlanNodeIdPlaceholder")}
                          />
                        </View>
                        <View className="gap-2">
                          <Text className="text-sm text-foreground-muted">
                            {t("controlCenter.dependencyPlanAgent")}
                          </Text>
                          <View className="flex-row flex-wrap gap-2">
                            {(selectedSquad.members ?? []).map((member) => {
                              const roleLabelKey = squadMemberRoleLabelKey(member.role);
                              const roleLabel =
                                roleLabelKey === null ? member.role : t(roleLabelKey);
                              return (
                                <ActionButton
                                  key={member.agentId}
                                  label={`${member.agentId} · ${roleLabel}`}
                                  disabled={squadRunPending}
                                  emphasized={member.agentId === node.agentId}
                                  onPress={() =>
                                    patchSquadPlanNode(node.clientId, { agentId: member.agentId })
                                  }
                                />
                              );
                            })}
                          </View>
                        </View>
                        <View className="gap-2">
                          <Text className="text-sm text-foreground-muted">
                            {t("controlCenter.dependencyPlanPrompt")}
                          </Text>
                          <TextInput
                            value={node.prompt}
                            onChangeText={(prompt) => patchSquadPlanNode(node.clientId, { prompt })}
                            editable={!squadRunPending}
                            multiline
                            textAlignVertical="top"
                            className="min-h-24"
                            placeholder={t("controlCenter.dependencyPlanPromptPlaceholder")}
                          />
                        </View>
                        <View className="gap-2">
                          <Text className="text-sm text-foreground-muted">
                            {t("controlCenter.dependencyPlanDependencies")}
                          </Text>
                          <TextInput
                            value={node.dependsOnNodeIdsText}
                            onChangeText={(dependsOnNodeIdsText) =>
                              patchSquadPlanNode(node.clientId, { dependsOnNodeIdsText })
                            }
                            editable={!squadRunPending}
                            autoCapitalize="none"
                            autoCorrect={false}
                            placeholder={t("controlCenter.dependencyPlanDependenciesPlaceholder")}
                          />
                        </View>
                      </View>
                    ))
                  )}
                  <ActionButton
                    label={t("controlCenter.addDependencyPlanNode")}
                    disabled={squadRunPending}
                    emphasized
                    onPress={addSquadPlanNode}
                  />
                </View>
              ) : null}
              {squadRunBuild.issue === null ? null : (
                <Text className="text-sm text-warning-foreground">
                  {squadRunIssueLabel(squadRunBuild.issue)}
                </Text>
              )}
              {squadRunError === null ? null : (
                <Text className="text-sm text-danger-foreground">{squadRunError}</Text>
              )}
              <ActionButton
                label={
                  squadRunPending ? t("controlCenter.runningSquad") : t("controlCenter.runSquad")
                }
                disabled={squadRunPending || squadRunBuild.request === null}
                emphasized
                onPress={() => void runSelectedSquad()}
              />
              {squadRunResult === null ? null : (
                <View className="gap-1 border-t border-border-subtle pt-3">
                  <Text className="text-sm text-success-foreground">
                    {t("controlCenter.squadRunAccepted")}
                  </Text>
                  <Text className="font-mono text-xs text-foreground-muted">
                    {squadRunResult.executionId}
                  </Text>
                  <Text className="text-sm text-foreground-muted">
                    {t("controlCenter.squadRunSummary", {
                      children: squadRunResult.graph.children.length,
                      failures: squadRunResult.graph.failures?.length ?? 0,
                    })}
                  </Text>
                </View>
              )}
            </View>
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
          <Text className="text-sm font-codework-medium text-foreground">
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
      <Text className="text-sm font-codework-medium text-foreground">{props.label}</Text>
    </Pressable>
  );
}
