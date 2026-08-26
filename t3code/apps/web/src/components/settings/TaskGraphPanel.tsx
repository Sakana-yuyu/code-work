import type {
  CompositionAgentDriverProfile,
  CompositionTaskEvent,
  CompositionTaskGraphExecutionRequest,
  CompositionTaskSnapshot,
  CompositionTaskStatus,
  EnvironmentId,
} from "@codework/contracts";
import { sha256 } from "@noble/hashes/sha2";
import {
  CheckIcon,
  GitBranchIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  ShieldAlertIcon,
  SquareIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import * as Encoding from "effect/Encoding";

import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@codework/client-runtime/state/runtime";
import { usePrimaryEnvironment } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { randomUUID } from "~/lib/utils";
import { t } from "~/i18n";

import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { Input } from "../ui/input";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const TASK_GRAPH_PROJECT_ID = "t3-settings-task-graph";
const TERMINAL_STATUSES: ReadonlySet<CompositionTaskStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);

type GraphSchedule = "serial" | "parallel";

type ChildDraft = {
  readonly nodeId: string;
  readonly driverId: string;
  readonly prompt: string;
  readonly dependsOnPrevious: boolean;
};

const STATUS_KEYS: Readonly<Record<CompositionTaskStatus, string>> = {
  queued: "Queued",
  dispatched: "Dispatched",
  running: "Running",
  waiting_approval: "Waiting for approval",
  waiting_input: "Waiting for input",
  blocked: "Blocked",
  in_review: "In review",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  timed_out: "Timed out",
};

const statusVariant = (
  status: CompositionTaskStatus,
): "default" | "success" | "warning" | "error" | "secondary" | "outline" => {
  switch (status) {
    case "completed":
      return "success";
    case "failed":
    case "timed_out":
      return "error";
    case "cancelled":
      return "secondary";
    case "in_review":
    case "waiting_approval":
      return "warning";
    case "running":
      return "default";
    default:
      return "outline";
  }
};

const statusLabel = (status: CompositionTaskStatus): string => t(STATUS_KEYS[status]);

const promptDigest = (prompt: string): string =>
  `sha256:${Encoding.encodeHex(sha256(new TextEncoder().encode(prompt)))}`;

const makeChildDraft = (index: number, driverId: string): ChildDraft => ({
  nodeId: `child-${index + 1}`,
  driverId,
  prompt: "",
  dependsOnPrevious: index > 0,
});

const displayId = (value: string): string =>
  value.length > 18 ? `${value.slice(0, 18)}...` : value;

function ProfileSelect({
  value,
  profiles,
  onChange,
  label,
}: {
  readonly value: string;
  readonly profiles: ReadonlyArray<CompositionAgentDriverProfile>;
  readonly onChange: (value: string) => void;
  readonly label: string;
}) {
  return (
    <Select value={value} onValueChange={(next) => next && onChange(next)}>
      <SelectTrigger className="w-full" aria-label={label}>
        <SelectValue>
          {profiles.find((profile) => profile.agentId === value)?.displayName ?? value}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="start" alignItemWithTrigger={false} className="min-w-72">
        {profiles.map((profile) => (
          <SelectItem key={profile.agentId} value={profile.agentId}>
            <span className="flex min-w-0 items-center justify-between gap-4">
              <span className="min-w-0 truncate">{profile.displayName ?? profile.agentId}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {profile.driverKind}
              </span>
            </span>
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function DriverBoundaryNotice({ profile }: { readonly profile: CompositionAgentDriverProfile }) {
  const hasToolBridge = profile.supportsToolBroker && profile.supportsCapabilityHandshake;
  const message = hasToolBridge
    ? t("This Driver reports a verified T3 ToolBroker handshake surface.")
    : t(
        "This Driver does not report a verified T3 ToolBroker handshake; the graph can run, but T3 tools are not granted automatically.",
      );

  return (
    <div className="flex items-start gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
      <ShieldAlertIcon className="mt-0.5 size-3.5 shrink-0 text-warning" />
      <span className="min-w-0">{message}</span>
    </div>
  );
}

function TaskSnapshotRow({
  snapshot,
  selected,
  onSelect,
}: {
  readonly snapshot: CompositionTaskSnapshot;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const { task, latestRun } = snapshot;
  return (
    <button
      type="button"
      className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
        selected ? "border-ring bg-accent/60" : "border-border/60 hover:bg-accent/40"
      }`}
      onClick={onSelect}
    >
      <span className="flex min-w-0 items-center justify-between gap-3">
        <span className="min-w-0 truncate text-xs font-medium">{displayId(task.taskId)}</span>
        <Badge variant={statusVariant(task.status)} size="sm">
          {statusLabel(task.status)}
        </Badge>
      </span>
      <span className="mt-1 flex min-w-0 items-center justify-between gap-3 text-[11px] text-muted-foreground">
        <span className="min-w-0 truncate">{task.assigneeId}</span>
        <span className="shrink-0 tabular-nums">
          {latestRun === undefined ? t("No Run") : `#${latestRun.attempt}`}
        </span>
      </span>
    </button>
  );
}

function TaskEvents({ events }: { readonly events: ReadonlyArray<CompositionTaskEvent> }) {
  if (events.length === 0) {
    return <p className="text-xs text-muted-foreground">{t("No events yet")}</p>;
  }
  return (
    <ol className="space-y-2">
      {events.map((event) => (
        <li key={`${event.runId}:${event.sequence}`} className="flex gap-2 text-xs">
          <span className="w-7 shrink-0 font-mono text-[11px] text-muted-foreground">
            #{event.sequence}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-foreground">{event.summary}</span>
            <span className="text-[11px] text-muted-foreground">
              {event.eventType} · {statusLabel(event.status)}
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}

export function TaskGraphPanel() {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const driverQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.compositionAgentDrivers({ environmentId, input: {} }),
  );
  const profiles = driverQuery.data ?? [];
  const availableProfiles = useMemo(
    () => profiles.filter((profile) => profile.status !== "unavailable"),
    [profiles],
  );
  const [leaderDriverId, setLeaderDriverId] = useState("");
  const [projectId, setProjectId] = useState(TASK_GRAPH_PROJECT_ID);
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [leaderPrompt, setLeaderPrompt] = useState("");
  const [schedule, setSchedule] = useState<GraphSchedule>("parallel");
  const [children, setChildren] = useState<ReadonlyArray<ChildDraft>>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [actionReason, setActionReason] = useState("");
  const [retryCapabilityIds, setRetryCapabilityIds] = useState("");
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const defaultChildren = useMemo(
    () =>
      availableProfiles.length === 0
        ? []
        : [
            makeChildDraft(0, availableProfiles[0]!.agentId),
            makeChildDraft(1, availableProfiles[0]!.agentId),
          ],
    [availableProfiles],
  );
  const effectiveLeaderDriverId = leaderDriverId || availableProfiles[0]?.agentId || "";
  const effectiveChildren = children.length > 0 ? children : defaultChildren;

  const tasksQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.listCompositionTasks({ environmentId, input: { projectId } }),
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
  const reviewTask = useAtomCommand(serverEnvironment.reviewCompositionTask, {
    reportFailure: false,
  });
  const retryTask = useAtomCommand(serverEnvironment.retryCompositionTask, {
    reportFailure: false,
  });

  const leaderProfile = profiles.find((profile) => profile.agentId === effectiveLeaderDriverId);

  const refreshTaskState = useCallback(() => {
    tasksQuery.refresh();
    eventsQuery.refresh();
  }, [eventsQuery, tasksQuery]);

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
            makeChildDraft(0, availableProfiles[0]?.agentId ?? ""),
            makeChildDraft(1, availableProfiles[0]?.agentId ?? ""),
          ]
        : current.map((child) =>
            availableProfiles.some((profile) => profile.agentId === child.driverId)
              ? child
              : { ...child, driverId: availableProfiles[0]?.agentId ?? "" },
          ),
    );
  }, [availableProfiles]);

  useEffect(() => {
    if (selectedTaskId !== null && snapshots.some(({ task }) => task.taskId === selectedTaskId)) {
      return;
    }
    setSelectedTaskId(snapshots[0]?.task.taskId ?? null);
  }, [selectedTaskId, snapshots]);

  useEffect(() => {
    if (environmentId === null) return;
    const timer = window.setInterval(refreshTaskState, 2_500);
    return () => window.clearInterval(timer);
  }, [environmentId, refreshTaskState]);

  const updateChild = (nodeId: string, patch: Partial<ChildDraft>) => {
    setChildren((current) =>
      (current.length > 0 ? current : defaultChildren).map((child) =>
        child.nodeId === nodeId ? { ...child, ...patch } : child,
      ),
    );
  };

  const runCommand = async <A, B, C>(
    label: string,
    command: (value: {
      environmentId: EnvironmentId;
      input: A;
    }) => Promise<AtomCommandResult<B, C>>,
    input: A,
  ) => {
    if (environmentId === null) return;
    setPendingAction(label);
    setActionError(null);
    const result = await command({ environmentId, input });
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      setActionError(error instanceof Error ? error.message : t("Task Graph operation failed"));
    } else {
      refreshTaskState();
    }
    setPendingAction(null);
  };

  const submitGraph = async () => {
    if (
      environmentId === null ||
      effectiveLeaderDriverId.trim() === "" ||
      workspaceRoot.trim() === "" ||
      leaderPrompt.trim() === "" ||
      projectId.trim() === "" ||
      effectiveChildren.length === 0 ||
      effectiveChildren.some((child) => child.prompt.trim() === "" || child.driverId.trim() === "")
    ) {
      setActionError(t("Complete the project, workspace, leader, and child task fields first."));
      return;
    }

    const graphId = randomUUID();
    const leaderTaskId = `t3-leader-${graphId}`;
    const leaderRunId = `t3-run-${graphId}`;
    const request: CompositionTaskGraphExecutionRequest = {
      leader: {
        taskId: leaderTaskId,
        runId: leaderRunId,
        projectId: projectId.trim(),
        assigneeKind: "agent",
        assigneeId: effectiveLeaderDriverId,
        promptDigest: promptDigest(leaderPrompt),
        prompt: leaderPrompt,
        workspaceRoot: workspaceRoot.trim(),
      },
      children: effectiveChildren.map((child, index) => ({
        nodeId: child.nodeId,
        taskId: `t3-child-${graphId}-${index + 1}`,
        runId: `t3-child-run-${graphId}-${index + 1}`,
        projectId: projectId.trim(),
        assigneeKind: "agent",
        assigneeId: child.driverId,
        mode: schedule,
        promptDigest: promptDigest(child.prompt),
        prompt: child.prompt,
        workspaceRoot: workspaceRoot.trim(),
        dependsOnNodeIds:
          child.dependsOnPrevious && index > 0 ? [effectiveChildren[index - 1]!.nodeId] : [],
      })),
      schedule,
    };
    await runCommand("execute", executeGraph, request);
  };

  const selectedTaskIsTerminal =
    selectedSnapshot === null || TERMINAL_STATUSES.has(selectedSnapshot.task.status);
  const selectedTaskNeedsReview = selectedSnapshot?.task.status === "in_review";
  const canRetry =
    selectedSnapshot !== null &&
    selectedRunId !== undefined &&
    (selectedSnapshot.task.status === "failed" || selectedSnapshot.task.status === "timed_out") &&
    retryCapabilityIds.split(",").some((value) => value.trim() !== "");

  const runSelectedAction = async (action: "cancel" | "approve" | "reject" | "retry") => {
    if (environmentId === null || selectedSnapshot === null || selectedRunId === undefined) return;
    const reason = actionReason.trim() || t("Action requested from Task Graph settings.");
    if (action === "cancel") {
      await runCommand("cancel", cancelTask, {
        taskId: selectedSnapshot.task.taskId,
        runId: selectedRunId,
        reason,
      });
      return;
    }
    if (action === "approve" || action === "reject") {
      await runCommand("review", reviewTask, {
        taskId: selectedSnapshot.task.taskId,
        runId: selectedRunId,
        decision: action === "approve" ? "approve" : "reject",
        reason,
      });
      return;
    }
    await runCommand("retry", retryTask, {
      taskId: selectedSnapshot.task.taskId,
      previousRunId: selectedRunId,
      runId: `t3-retry-${randomUUID()}`,
      reason,
      capabilityIds: retryCapabilityIds
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    });
  };

  return (
    <SettingsSection
      id="task-graph"
      title={t("Task Graph")}
      icon={<GitBranchIcon className="size-4 text-muted-foreground" />}
      headerAction={
        <Button
          size="icon-sm"
          variant="ghost-muted"
          aria-label={t("Refresh Task Graph")}
          onClick={refreshTaskState}
          disabled={tasksQuery.isPending || pendingAction !== null}
        >
          <RefreshCwIcon className={tasksQuery.isPending ? "animate-spin" : undefined} />
        </Button>
      }
    >
      <SettingsRow
        title={t("T3 multi-agent task control")}
        description={t(
          "Create a Leader review task with child Agent Driver nodes, then inspect persisted runs and events.",
        )}
        status={
          driverQuery.error ??
          tasksQuery.error ??
          (driverQuery.isPending || tasksQuery.isPending ? t("Loading...") : actionError)
        }
      />

      <div className="grid gap-4 px-3 pb-3 sm:px-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(18rem,0.75fr)]">
        <div className="min-w-0 space-y-3">
          <div className="rounded-xl border border-border/60 px-3 py-3 sm:px-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="min-w-0 space-y-1 text-xs">
                <span className="text-muted-foreground">{t("Project ID")}</span>
                <Input value={projectId} onValueChange={setProjectId} size="sm" />
              </label>
              <label className="min-w-0 space-y-1 text-xs">
                <span className="text-muted-foreground">{t("Workspace root")}</span>
                <Input value={workspaceRoot} onValueChange={setWorkspaceRoot} size="sm" />
              </label>
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="min-w-0 space-y-1 text-xs">
                <span className="text-muted-foreground">{t("Leader Driver")}</span>
                {availableProfiles.length === 0 ? (
                  <p className="rounded-lg border border-border/60 px-3 py-2 text-muted-foreground">
                    {t("No available Driver")}
                  </p>
                ) : (
                  <ProfileSelect
                    value={effectiveLeaderDriverId}
                    profiles={availableProfiles}
                    onChange={setLeaderDriverId}
                    label={t("Leader Driver")}
                  />
                )}
              </label>
              <label className="min-w-0 space-y-1 text-xs">
                <span className="text-muted-foreground">{t("Child schedule")}</span>
                <Select
                  value={schedule}
                  onValueChange={(value) => value && setSchedule(value as GraphSchedule)}
                >
                  <SelectTrigger className="w-full" aria-label={t("Child schedule")}>
                    <SelectValue>
                      {schedule === "parallel" ? t("Parallel") : t("Serial")}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="start" alignItemWithTrigger={false}>
                    <SelectItem value="parallel">{t("Parallel")}</SelectItem>
                    <SelectItem value="serial">{t("Serial")}</SelectItem>
                  </SelectPopup>
                </Select>
              </label>
            </div>
            {leaderProfile ? (
              <div className="mt-3">
                <DriverBoundaryNotice profile={leaderProfile} />
              </div>
            ) : null}
            <label className="mt-3 block space-y-1 text-xs">
              <span className="text-muted-foreground">{t("Leader prompt")}</span>
              <Textarea
                value={leaderPrompt}
                onChange={(event) => setLeaderPrompt(event.target.value)}
                placeholder={t("Describe the final task for the Leader.")}
                size="sm"
              />
            </label>
          </div>

          <div className="rounded-xl border border-border/60 px-3 py-3 sm:px-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-medium">{t("Child tasks")}</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("Each child runs through its selected Agent Driver.")}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  setChildren((current) => {
                    const currentChildren = current.length > 0 ? current : defaultChildren;
                    return [
                      ...currentChildren,
                      makeChildDraft(currentChildren.length, availableProfiles[0]?.agentId ?? ""),
                    ];
                  })
                }
                disabled={availableProfiles.length === 0 || effectiveChildren.length >= 4}
              >
                <PlusIcon />
                {t("Add child")}
              </Button>
            </div>
            <div className="mt-3 space-y-3">
              {effectiveChildren.map((child, index) => (
                <div key={child.nodeId} className="rounded-lg border border-border/60 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-mono text-xs text-muted-foreground">{child.nodeId}</span>
                    <Button
                      size="icon-sm"
                      variant="ghost-muted"
                      aria-label={t("Remove child")}
                      onClick={() =>
                        setChildren((current) =>
                          (current.length > 0 ? current : defaultChildren).filter(
                            (item) => item.nodeId !== child.nodeId,
                          ),
                        )
                      }
                      disabled={effectiveChildren.length <= 1}
                    >
                      <Trash2Icon />
                    </Button>
                  </div>
                  <div className="mt-2 grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(10rem,0.7fr)]">
                    <label className="min-w-0 space-y-1 text-xs">
                      <span className="text-muted-foreground">{t("Child Driver")}</span>
                      <ProfileSelect
                        value={child.driverId}
                        profiles={availableProfiles}
                        onChange={(value) => updateChild(child.nodeId, { driverId: value })}
                        label={t("Child Driver")}
                      />
                    </label>
                    <label className="flex items-end gap-2 pb-1 text-xs text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={child.dependsOnPrevious}
                        disabled={index === 0}
                        onChange={(event) =>
                          updateChild(child.nodeId, { dependsOnPrevious: event.target.checked })
                        }
                      />
                      {t("Depends on previous child")}
                    </label>
                  </div>
                  <Textarea
                    className="mt-3"
                    value={child.prompt}
                    onChange={(event) => updateChild(child.nodeId, { prompt: event.target.value })}
                    placeholder={t("Describe this child task.")}
                    size="sm"
                  />
                </div>
              ))}
            </div>
            <Button
              className="mt-3 w-full sm:w-auto"
              onClick={() => void submitGraph()}
              disabled={pendingAction !== null || availableProfiles.length === 0}
            >
              <PlayIcon />
              {pendingAction === "execute" ? t("Starting...") : t("Run Task Graph")}
            </Button>
          </div>
        </div>

        <div className="min-w-0 space-y-3">
          <div className="rounded-xl border border-border/60 px-3 py-3 sm:px-4">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-medium">{t("Recent tasks")}</h3>
              <span className="text-[11px] text-muted-foreground">{snapshots.length}</span>
            </div>
            <div className="mt-3 space-y-2">
              {snapshots.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("No Task Graph tasks yet")}</p>
              ) : (
                snapshots.map((snapshot) => (
                  <TaskSnapshotRow
                    key={snapshot.task.taskId}
                    snapshot={snapshot}
                    selected={
                      snapshot.task.taskId === (selectedTaskId ?? snapshots[0]?.task.taskId)
                    }
                    onSelect={() => setSelectedTaskId(snapshot.task.taskId)}
                  />
                ))
              )}
            </div>
          </div>

          {selectedSnapshot ? (
            <div className="rounded-xl border border-border/60 px-3 py-3 sm:px-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-medium">{selectedSnapshot.task.taskId}</h3>
                  <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
                    {selectedRunId ?? t("No Run")}
                  </p>
                </div>
                <Badge variant={statusVariant(selectedSnapshot.task.status)} size="sm">
                  {statusLabel(selectedSnapshot.task.status)}
                </Badge>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
                <Badge variant="outline" size="sm">
                  {selectedSnapshot.task.assigneeId}
                </Badge>
                {selectedSnapshot.latestRun ? (
                  <Badge
                    variant="outline"
                    size="sm"
                  >{`runtime:${selectedSnapshot.latestRun.runtimeId}`}</Badge>
                ) : null}
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void runSelectedAction("cancel")}
                  disabled={selectedTaskIsTerminal || pendingAction !== null}
                >
                  <SquareIcon />
                  {t("Cancel task")}
                </Button>
                {selectedTaskNeedsReview ? (
                  <>
                    <Button
                      size="sm"
                      onClick={() => void runSelectedAction("approve")}
                      disabled={pendingAction !== null}
                    >
                      <CheckIcon />
                      {t("Approve")}
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive-outline"
                      onClick={() => void runSelectedAction("reject")}
                      disabled={pendingAction !== null}
                    >
                      <XIcon />
                      {t("Reject")}
                    </Button>
                  </>
                ) : null}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void runSelectedAction("retry")}
                  disabled={!canRetry || pendingAction !== null}
                >
                  <RotateCcwIcon />
                  {t("Retry task")}
                </Button>
              </div>
              <label className="mt-3 block space-y-1 text-xs">
                <span className="text-muted-foreground">{t("Action reason")}</span>
                <Input value={actionReason} onValueChange={setActionReason} size="sm" />
              </label>
              <label className="mt-3 block space-y-1 text-xs">
                <span className="text-muted-foreground">{t("Retry capability IDs")}</span>
                <Input
                  value={retryCapabilityIds}
                  onValueChange={setRetryCapabilityIds}
                  placeholder={t("Comma-separated capability IDs")}
                  size="sm"
                />
              </label>
              <div className="mt-4 border-t border-border/60 pt-3">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <h4 className="text-xs font-medium">{t("Task events")}</h4>
                  <Button
                    size="icon-sm"
                    variant="ghost-muted"
                    aria-label={t("Refresh events")}
                    onClick={() => eventsQuery.refresh()}
                    disabled={eventsQuery.isPending}
                  >
                    <RefreshCwIcon className={eventsQuery.isPending ? "animate-spin" : undefined} />
                  </Button>
                </div>
                {eventsQuery.error ? (
                  <p className="text-xs text-destructive">{eventsQuery.error}</p>
                ) : (
                  <TaskEvents events={eventsQuery.data?.events ?? []} />
                )}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </SettingsSection>
  );
}
