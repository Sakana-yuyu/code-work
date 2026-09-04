import { useNavigation } from "@react-navigation/native";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type {
  CompositionAgentDriverProfile,
  CompositionTaskEvent,
  CompositionTaskGraphExecutionRequest,
  CompositionTaskSnapshot,
  CompositionTaskStatus,
  EnvironmentId,
} from "@codework/contracts";
import { sha256 } from "@noble/hashes/sha2";
import * as Encoding from "effect/Encoding";
import { Platform, Pressable, RefreshControl, ScrollView, Switch, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@codework/client-runtime/state/runtime";
import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { t } from "../../i18n";
import { uuidv4 } from "../../lib/uuid";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useEnvironments } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsEnvironmentPicker } from "./components/SettingsEnvironmentPicker";
import { SettingsSection } from "./components/SettingsSection";

type GraphSchedule = "serial" | "parallel";

type ChildDraft = {
  readonly nodeId: string;
  readonly driverId: string;
  readonly prompt: string;
  readonly dependsOnPrevious: boolean;
};

const TERMINAL_STATUSES: ReadonlySet<CompositionTaskStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);

const STATUS_KEYS: Readonly<Record<CompositionTaskStatus, string>> = {
  queued: "taskGraphMobile.status.queued",
  dispatched: "taskGraphMobile.status.dispatched",
  resuming: "taskGraphMobile.status.resuming",
  running: "taskGraphMobile.status.running",
  waiting_approval: "taskGraphMobile.status.waiting_approval",
  waiting_input: "taskGraphMobile.status.waiting_input",
  blocked: "taskGraphMobile.status.blocked",
  in_review: "taskGraphMobile.status.in_review",
  completed: "taskGraphMobile.status.completed",
  failed: "taskGraphMobile.status.failed",
  cancelled: "taskGraphMobile.status.cancelled",
  timed_out: "taskGraphMobile.status.timed_out",
};

const promptDigest = (prompt: string): string =>
  `sha256:${Encoding.encodeHex(sha256(new TextEncoder().encode(prompt)))}`;

const makeChildDraft = (index: number, driverId: string): ChildDraft => ({
  nodeId: `child-${index + 1}`,
  driverId,
  prompt: "",
  dependsOnPrevious: index > 0,
});

export function SettingsTaskGraphRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { environments } = useEnvironments();
  const projects = useProjects();
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(
    () => environments[0]?.environmentId ?? null,
  );
  const [projectId, setProjectId] = useState("");
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [leaderDriverId, setLeaderDriverId] = useState("");
  const [leaderPrompt, setLeaderPrompt] = useState("");
  const [schedule, setSchedule] = useState<GraphSchedule>("parallel");
  const [children, setChildren] = useState<ReadonlyArray<ChildDraft>>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [actionReason, setActionReason] = useState("");
  const [retryCapabilityIds, setRetryCapabilityIds] = useState("");
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const environmentId = selectedEnvironmentId;
  const environmentProjects = useMemo(
    () => projects.filter((project) => project.environmentId === environmentId),
    [environmentId, projects],
  );
  const firstProject = environmentProjects[0];
  const driverQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.compositionAgentDrivers({ environmentId, input: {} }),
  );
  const availableProfiles = useMemo(
    () =>
      (driverQuery.data ?? []).filter(
        (profile) => profile.status !== "unavailable" && profile.supportsTaskGraph,
      ),
    [driverQuery.data],
  );
  const effectiveLeaderDriverId = leaderDriverId || availableProfiles[0]?.agentId || "";
  const tasksQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.listCompositionTasks({
          environmentId,
          input: projectId.trim().length === 0 ? {} : { projectId: projectId.trim() },
        }),
  );
  const snapshots = useMemo(
    () =>
      [...(tasksQuery.data?.tasks ?? [])].sort(
        (left, right) => right.task.updatedAtUnixMs - left.task.updatedAtUnixMs,
      ),
    [tasksQuery.data?.tasks],
  );
  const selectedSnapshot =
    snapshots.find(({ task }) => task.taskId === selectedTaskId) ?? snapshots[0] ?? null;
  const selectedRunId = selectedSnapshot?.latestRun?.runId;
  const eventsQuery = useEnvironmentQuery(
    environmentId === null || selectedSnapshot === null || selectedRunId === undefined
      ? null
      : serverEnvironment.listCompositionTaskEvents({
          environmentId,
          input: { taskId: selectedSnapshot.task.taskId, runId: selectedRunId },
        }),
  );
  const executeGraph = useAtomCommand(serverEnvironment.executeCompositionTaskGraph, {
    reportFailure: false,
  });
  const cancelTask = useAtomCommand(serverEnvironment.cancelCompositionTask, {
    reportFailure: false,
  });
  const resumeTask = useAtomCommand(serverEnvironment.resumeCompositionTask, {
    reportFailure: false,
  });
  const reviewTask = useAtomCommand(serverEnvironment.reviewCompositionTask, {
    reportFailure: false,
  });
  const retryTask = useAtomCommand(serverEnvironment.retryCompositionTask, {
    reportFailure: false,
  });

  useEffect(() => {
    if (
      selectedEnvironmentId !== null &&
      environments.some((item) => item.environmentId === selectedEnvironmentId)
    ) {
      return;
    }
    setSelectedEnvironmentId(environments[0]?.environmentId ?? null);
  }, [environments, selectedEnvironmentId]);

  useEffect(() => {
    setProjectId(firstProject?.id ?? "");
    setWorkspaceRoot(firstProject?.workspaceRoot ?? "");
    setSelectedTaskId(null);
    setChildren([]);
  }, [environmentId]);

  useEffect(() => {
    if (environmentId === null || firstProject === undefined) return;
    setProjectId((current) =>
      environmentProjects.some((project) => project.id === current) ? current : firstProject.id,
    );
    setWorkspaceRoot((current) =>
      current.trim().length === 0 ? firstProject.workspaceRoot : current,
    );
  }, [environmentId, environmentProjects, firstProject]);

  useEffect(() => {
    if (availableProfiles.length === 0) return;
    setLeaderDriverId((current) =>
      availableProfiles.some((profile) => profile.agentId === current)
        ? current
        : (availableProfiles[0]?.agentId ?? ""),
    );
    setChildren((current) =>
      current.length === 0
        ? [
            makeChildDraft(0, availableProfiles[0]!.agentId),
            makeChildDraft(1, availableProfiles[0]!.agentId),
          ]
        : current.map((child) =>
            availableProfiles.some((profile) => profile.agentId === child.driverId)
              ? child
              : { ...child, driverId: availableProfiles[0]?.agentId ?? "" },
          ),
    );
  }, [availableProfiles]);

  const refresh = (): void => {
    driverQuery.refresh();
    tasksQuery.refresh();
    eventsQuery.refresh();
  };

  const updateChild = (nodeId: string, patch: Partial<ChildDraft>): void => {
    setChildren((current) =>
      current.map((child) => (child.nodeId === nodeId ? { ...child, ...patch } : child)),
    );
  };

  const submitGraph = async (): Promise<void> => {
    if (
      environmentId === null ||
      effectiveLeaderDriverId.trim() === "" ||
      projectId.trim() === "" ||
      workspaceRoot.trim() === "" ||
      leaderPrompt.trim() === "" ||
      children.length === 0 ||
      children.some((child) => child.driverId.trim() === "" || child.prompt.trim() === "")
    ) {
      setActionError(t("taskGraphMobile.completeFields"));
      return;
    }
    const graphId = uuidv4();
    const request: CompositionTaskGraphExecutionRequest = {
      leader: {
        taskId: `codework-leader-${graphId}`,
        runId: `codework-run-${graphId}`,
        projectId: projectId.trim(),
        assigneeKind: "agent",
        assigneeId: effectiveLeaderDriverId,
        promptDigest: promptDigest(leaderPrompt),
        prompt: leaderPrompt,
        workspaceRoot: workspaceRoot.trim(),
      },
      children: children.map((child, index) => ({
        nodeId: child.nodeId,
        taskId: `codework-child-${graphId}-${index + 1}`,
        runId: `codework-child-run-${graphId}-${index + 1}`,
        projectId: projectId.trim(),
        assigneeKind: "agent",
        assigneeId: child.driverId,
        mode: schedule,
        promptDigest: promptDigest(child.prompt),
        prompt: child.prompt,
        workspaceRoot: workspaceRoot.trim(),
        dependsOnNodeIds: child.dependsOnPrevious && index > 0 ? [children[index - 1]!.nodeId] : [],
      })),
      schedule,
    };
    setPendingAction("execute");
    setActionError(null);
    const result = await executeGraph({ environmentId, input: request });
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      setActionError(error instanceof Error ? error.message : t("taskGraphMobile.operationFailed"));
    } else {
      tasksQuery.refresh();
      setLeaderPrompt("");
      setChildren((current) => current.map((child) => ({ ...child, prompt: "" })));
    }
    setPendingAction(null);
  };

  const runTaskCommand = async <A, B, E>(
    name: string,
    command: (value: {
      environmentId: EnvironmentId;
      input: A;
    }) => Promise<AtomCommandResult<B, E>>,
    input: A,
  ): Promise<void> => {
    if (environmentId === null || selectedSnapshot === null || selectedRunId === undefined) return;
    setPendingAction(name);
    setActionError(null);
    const result = await command({ environmentId, input });
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      setActionError(error instanceof Error ? error.message : t("taskGraphMobile.operationFailed"));
    } else {
      tasksQuery.refresh();
      eventsQuery.refresh();
    }
    setPendingAction(null);
  };

  const runSelectedAction = async (
    action: "cancel" | "resume" | "approve" | "reject" | "retry",
  ): Promise<void> => {
    if (selectedSnapshot === null || selectedRunId === undefined) return;
    const reason = actionReason.trim() || t("taskGraphMobile.actionReasonDefault");
    if (action === "cancel") {
      await runTaskCommand("cancel", cancelTask, {
        taskId: selectedSnapshot.task.taskId,
        runId: selectedRunId,
        reason,
      });
    } else if (action === "resume") {
      await runTaskCommand("resume", resumeTask, {
        taskId: selectedSnapshot.task.taskId,
        runId: selectedRunId,
        reason,
      });
    } else if (action === "approve" || action === "reject") {
      await runTaskCommand("review", reviewTask, {
        taskId: selectedSnapshot.task.taskId,
        runId: selectedRunId,
        decision: action === "approve" ? "approve" : "reject",
        reason,
      });
    } else {
      await runTaskCommand("retry", retryTask, {
        taskId: selectedSnapshot.task.taskId,
        previousRunId: selectedRunId,
        runId: `codework-retry-${uuidv4()}`,
        reason,
        capabilityIds: retryCapabilityIds
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
      });
    }
  };

  const selectedTaskIsTerminal =
    selectedSnapshot === null || TERMINAL_STATUSES.has(selectedSnapshot.task.status);
  const selectedTaskCanResume =
    selectedSnapshot?.task.status === "waiting_approval" ||
    selectedSnapshot?.task.status === "waiting_input";
  const selectedTaskNeedsReview = selectedSnapshot?.task.status === "in_review";
  const canRetry =
    selectedSnapshot !== null &&
    selectedRunId !== undefined &&
    (selectedSnapshot.task.status === "failed" || selectedSnapshot.task.status === "timed_out") &&
    retryCapabilityIds.split(",").some((value) => value.trim() !== "");

  return (
    <View className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader
            title={t("taskGraphMobile.title")}
            onBack={() => navigation.goBack()}
          />
        </>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        refreshControl={
          <RefreshControl
            refreshing={tasksQuery.isPending && tasksQuery.data !== null}
            onRefresh={refresh}
          />
        }
      >
        <Text className="px-2 text-sm leading-5 text-foreground-muted">
          {t("taskGraphMobile.description")}
        </Text>
        <SettingsEnvironmentPicker
          environments={environments}
          selectedEnvironmentId={environmentId}
          disabled={pendingAction !== null}
          onSelect={(next) => {
            setSelectedEnvironmentId(next);
            setActionError(null);
          }}
        />
        {environmentId === null ? (
          <StatusMessage text={t("taskGraphMobile.noEnvironment")} />
        ) : null}
        {driverQuery.error ? <StatusMessage text={driverQuery.error} tone="danger" /> : null}
        {actionError ? <StatusMessage text={actionError} tone="danger" /> : null}
        <SettingsSection title={t("taskGraphMobile.createTitle")} card>
          <View className="gap-3 p-4">
            <Field label={t("taskGraphMobile.projectId")}>
              <TextInput
                value={projectId}
                onChangeText={setProjectId}
                placeholder={t("taskGraphMobile.projectIdPlaceholder")}
                autoCapitalize="none"
                autoCorrect={false}
                editable={pendingAction === null}
              />
            </Field>
            {environmentProjects.length > 0 ? (
              <View className="flex-row flex-wrap gap-2">
                {environmentProjects.map((project) => (
                  <ChoiceButton
                    key={project.id}
                    label={project.title}
                    selected={project.id === projectId}
                    disabled={pendingAction !== null}
                    onPress={() => {
                      setProjectId(project.id);
                      setWorkspaceRoot(project.workspaceRoot);
                    }}
                  />
                ))}
              </View>
            ) : null}
            <Field label={t("taskGraphMobile.workspaceRoot")}>
              <TextInput
                value={workspaceRoot}
                onChangeText={setWorkspaceRoot}
                placeholder={t("taskGraphMobile.workspaceRootPlaceholder")}
                autoCapitalize="none"
                autoCorrect={false}
                editable={pendingAction === null}
              />
            </Field>
            <Field label={t("taskGraphMobile.leaderDriver")}>
              <ProfileChoices
                profiles={availableProfiles}
                selected={effectiveLeaderDriverId}
                disabled={pendingAction !== null}
                onSelect={setLeaderDriverId}
              />
            </Field>
            <Field label={t("taskGraphMobile.schedule")}>
              <View className="flex-row flex-wrap gap-2">
                <ChoiceButton
                  label={t("taskGraphMobile.parallel")}
                  selected={schedule === "parallel"}
                  disabled={pendingAction !== null}
                  onPress={() => setSchedule("parallel")}
                />
                <ChoiceButton
                  label={t("taskGraphMobile.serial")}
                  selected={schedule === "serial"}
                  disabled={pendingAction !== null}
                  onPress={() => setSchedule("serial")}
                />
              </View>
            </Field>
            <Field label={t("taskGraphMobile.leaderPrompt")}>
              <TextInput
                value={leaderPrompt}
                onChangeText={setLeaderPrompt}
                placeholder={t("taskGraphMobile.promptPlaceholder")}
                multiline
                numberOfLines={4}
                textAlignVertical="top"
                editable={pendingAction === null}
              />
            </Field>
            <View className="gap-2 border-t border-border-subtle pt-3">
              <Text className="text-sm font-codework-medium text-foreground">
                {t("taskGraphMobile.children")}
              </Text>
              {children.map((child, index) => (
                <View key={child.nodeId} className="gap-2 rounded-[18px] bg-subtle p-3">
                  <Text className="text-xs font-codework-medium text-foreground-muted">
                    {t("taskGraphMobile.childNumber", { index: index + 1 })}
                  </Text>
                  <ProfileChoices
                    profiles={availableProfiles}
                    selected={child.driverId}
                    disabled={pendingAction !== null}
                    onSelect={(driverId) => updateChild(child.nodeId, { driverId })}
                  />
                  <TextInput
                    value={child.prompt}
                    onChangeText={(prompt) => updateChild(child.nodeId, { prompt })}
                    placeholder={t("taskGraphMobile.promptPlaceholder")}
                    multiline
                    numberOfLines={3}
                    textAlignVertical="top"
                    editable={pendingAction === null}
                  />
                  {index > 0 ? (
                    <View className="flex-row items-center justify-between gap-3">
                      <Text className="flex-1 text-sm text-foreground">
                        {t("taskGraphMobile.dependsOnPrevious")}
                      </Text>
                      <Switch
                        value={child.dependsOnPrevious}
                        disabled={pendingAction !== null}
                        onValueChange={(dependsOnPrevious) =>
                          updateChild(child.nodeId, { dependsOnPrevious })
                        }
                      />
                    </View>
                  ) : null}
                  {children.length > 1 ? (
                    <ActionButton
                      label={t("taskGraphMobile.removeChild")}
                      disabled={pendingAction !== null}
                      onPress={() =>
                        setChildren((current) =>
                          current.filter((item) => item.nodeId !== child.nodeId),
                        )
                      }
                    />
                  ) : null}
                </View>
              ))}
              <ActionButton
                label={t("taskGraphMobile.addChild")}
                disabled={
                  pendingAction !== null || children.length >= 64 || availableProfiles.length === 0
                }
                onPress={() =>
                  setChildren((current) => [
                    ...current,
                    makeChildDraft(current.length, effectiveLeaderDriverId),
                  ])
                }
              />
            </View>
            {availableProfiles.length === 0 && !driverQuery.isPending ? (
              <Text className="text-sm text-warning-foreground">
                {t("taskGraphMobile.noDriver")}
              </Text>
            ) : null}
            <ActionButton
              label={
                pendingAction === "execute"
                  ? t("taskGraphMobile.submitting")
                  : t("taskGraphMobile.execute")
              }
              emphasized
              disabled={pendingAction !== null || availableProfiles.length === 0}
              onPress={() => void submitGraph()}
            />
          </View>
        </SettingsSection>
        <SettingsSection title={t("taskGraphMobile.tasksTitle")} card>
          {tasksQuery.data === null && tasksQuery.isPending ? (
            <StatusMessage text={t("taskGraphMobile.loading")} />
          ) : tasksQuery.error ? (
            <StatusMessage text={tasksQuery.error} tone="danger" />
          ) : snapshots.length === 0 ? (
            <StatusMessage text={t("taskGraphMobile.noTasks")} />
          ) : (
            snapshots.map((snapshot) => (
              <TaskRow
                key={snapshot.task.taskId}
                snapshot={snapshot}
                selected={snapshot.task.taskId === selectedSnapshot?.task.taskId}
                onSelect={() => setSelectedTaskId(snapshot.task.taskId)}
              />
            ))
          )}
        </SettingsSection>
        {selectedSnapshot !== null ? (
          <SettingsSection title={t("taskGraphMobile.controlTitle")} card>
            <View className="gap-3 p-4">
              <Text className="font-mono text-xs text-foreground-muted">
                {selectedSnapshot.task.taskId}
              </Text>
              <TextInput
                value={actionReason}
                onChangeText={setActionReason}
                placeholder={t("taskGraphMobile.reasonPlaceholder")}
                editable={pendingAction === null}
              />
              <TextInput
                value={retryCapabilityIds}
                onChangeText={setRetryCapabilityIds}
                placeholder={t("taskGraphMobile.capabilitiesPlaceholder")}
                autoCapitalize="none"
                autoCorrect={false}
                editable={pendingAction === null}
              />
              <View className="flex-row flex-wrap gap-2">
                {!selectedTaskIsTerminal ? (
                  <ActionButton
                    label={t("taskGraphMobile.cancel")}
                    disabled={pendingAction !== null}
                    onPress={() => void runSelectedAction("cancel")}
                  />
                ) : null}
                {selectedTaskCanResume ? (
                  <ActionButton
                    label={t("taskGraphMobile.resume")}
                    disabled={pendingAction !== null}
                    emphasized
                    onPress={() => void runSelectedAction("resume")}
                  />
                ) : null}
                {selectedTaskNeedsReview ? (
                  <>
                    <ActionButton
                      label={t("taskGraphMobile.approve")}
                      disabled={pendingAction !== null}
                      emphasized
                      onPress={() => void runSelectedAction("approve")}
                    />
                    <ActionButton
                      label={t("taskGraphMobile.reject")}
                      disabled={pendingAction !== null}
                      onPress={() => void runSelectedAction("reject")}
                    />
                  </>
                ) : null}
                {canRetry ? (
                  <ActionButton
                    label={t("taskGraphMobile.retry")}
                    disabled={pendingAction !== null}
                    onPress={() => void runSelectedAction("retry")}
                  />
                ) : null}
              </View>
              <TaskEvents
                events={eventsQuery.data?.events ?? []}
                loading={eventsQuery.isPending}
                error={eventsQuery.error}
              />
            </View>
          </SettingsSection>
        ) : null}
      </ScrollView>
    </View>
  );
}

function ProfileChoices(props: {
  readonly profiles: ReadonlyArray<CompositionAgentDriverProfile>;
  readonly selected: string;
  readonly disabled: boolean;
  readonly onSelect: (agentId: string) => void;
}) {
  return (
    <View className="flex-row flex-wrap gap-2">
      {props.profiles.map((profile) => (
        <ChoiceButton
          key={profile.agentId}
          label={profile.displayName ?? profile.agentId}
          selected={props.selected === profile.agentId}
          disabled={props.disabled}
          onPress={() => props.onSelect(profile.agentId)}
        />
      ))}
    </View>
  );
}

function TaskRow(props: {
  readonly snapshot: CompositionTaskSnapshot;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const { task, latestRun } = props.snapshot;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: props.selected }}
      onPress={props.onSelect}
      className={
        props.selected
          ? "gap-1 border-b border-border-subtle bg-subtle p-4"
          : "gap-1 border-b border-border-subtle p-4"
      }
    >
      <View className="flex-row items-center justify-between gap-3">
        <Text
          className="min-w-0 flex-1 text-sm font-codework-medium text-foreground"
          numberOfLines={1}
        >
          {task.taskId}
        </Text>
        <Text className="text-xs text-foreground-muted">{t(STATUS_KEYS[task.status])}</Text>
      </View>
      <Text className="font-mono text-xs text-foreground-muted" numberOfLines={1}>
        {`${task.assigneeId}${latestRun ? ` · #${latestRun.attempt}` : ""}`}
      </Text>
    </Pressable>
  );
}

function TaskEvents(props: {
  readonly events: ReadonlyArray<CompositionTaskEvent>;
  readonly loading: boolean;
  readonly error: string | null;
}) {
  return (
    <View className="gap-2 border-t border-border-subtle pt-3">
      <Text className="text-sm font-codework-medium text-foreground">
        {t("taskGraphMobile.events")}
      </Text>
      {props.error ? (
        <Text className="text-sm text-danger-foreground">{props.error}</Text>
      ) : props.loading ? (
        <Text className="text-sm text-foreground-muted">{t("taskGraphMobile.loading")}</Text>
      ) : props.events.length === 0 ? (
        <Text className="text-sm text-foreground-muted">{t("taskGraphMobile.noEvents")}</Text>
      ) : (
        props.events.map((event) => (
          <View
            key={`${event.runId}:${event.sequence}`}
            className="gap-1 border-t border-border-subtle pt-2 first:border-t-0 first:pt-0"
          >
            <Text className="text-sm text-foreground">{event.summary}</Text>
            <Text className="font-mono text-xs text-foreground-muted">
              {`#${event.sequence} · ${event.eventType} · ${t(STATUS_KEYS[event.status])}`}
            </Text>
          </View>
        ))
      )}
    </View>
  );
}

function Field(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <View className="gap-1.5">
      <Text className="text-sm font-codework-medium text-foreground">{props.label}</Text>
      {props.children}
    </View>
  );
}

function ChoiceButton(props: {
  readonly label: string;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: props.selected, disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      className={
        props.selected
          ? "rounded-full bg-accent px-3 py-2"
          : "rounded-full border border-input-border px-3 py-2"
      }
    >
      <Text
        className={
          props.selected
            ? "text-xs font-codework-medium text-accent-foreground"
            : "text-xs text-foreground"
        }
      >
        {props.label}
      </Text>
    </Pressable>
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
      accessibilityRole="button"
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      className={
        props.emphasized
          ? "self-start rounded-full bg-accent px-3.5 py-2 opacity-100 disabled:opacity-40"
          : "self-start rounded-full bg-subtle-strong px-3.5 py-2 opacity-100 disabled:opacity-40"
      }
    >
      <Text
        className={
          props.emphasized
            ? "text-sm font-codework-medium text-accent-foreground"
            : "text-sm text-foreground"
        }
      >
        {props.label}
      </Text>
    </Pressable>
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
