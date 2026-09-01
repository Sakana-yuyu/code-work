"use client";

import type {
  CompositionSquad,
  CompositionSquadExecutionStatus,
  CompositionSquadExecutionResult,
  CompositionTaskEvent,
  CompositionTaskSnapshot,
  CompositionTaskStatus,
  EnvironmentId,
} from "@codework/contracts";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@codework/client-runtime/state/runtime";
import {
  CheckIcon,
  FileTextIcon,
  GitBranchIcon,
  HistoryIcon,
  PlayIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SquareIcon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { t } from "~/i18n";
import { randomUUID } from "~/lib/utils";
import { usePrimaryEnvironment } from "~/state/environments";
import { useProjects } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import {
  advanceCompositionSquadRunDraft,
  buildCompositionSquadNodeActionRequest,
  buildCompositionSquadExecutionRequest,
  compositionSquadRunEnvironmentKey,
  executeCompositionSquadNodeActionWithHistoryRefresh,
  executeCompositionSquadRunWithHistoryRefresh,
  getCompositionSquadNodeActions,
  projectCompositionSquadExecutionHistory,
  type CompositionSquadExecutionHistoryItem,
  type CompositionSquadNodeAction,
  type CompositionSquadRunDraft,
  type CompositionSquadRunIssue,
} from "./CompositionSquadRunPanel.logic";
import { SettingsSection } from "./settingsLayout";

const EMPTY_SQUADS: ReadonlyArray<CompositionSquad> = [];

type CompositionSquadRunStatus = CompositionTaskStatus | CompositionSquadExecutionStatus;

const statusVariant = (
  status: CompositionSquadRunStatus,
): "default" | "success" | "warning" | "error" | "secondary" | "outline" => {
  switch (status) {
    case "completed":
      return "success";
    case "failed":
    case "timed_out":
      return "error";
    case "cancelled":
    case "paused":
      return "secondary";
    case "awaiting_approval":
    case "in_review":
    case "waiting_approval":
      return "warning";
    case "planning":
    case "cancelling":
    case "running":
      return "default";
    default:
      return "outline";
  }
};

const statusLabel = (status: CompositionSquadRunStatus): string => t(`squadRun.status.${status}`);

const issueLabel = (issue: CompositionSquadRunIssue): string =>
  t(`squadRun.validation.${issue.code}`, { path: issue.path });

const buildPlanTemplate = (squad: CompositionSquad | null): string => {
  if (squad?.collaborationMode !== "dependency_graph" || squad.members === undefined) return "";
  return JSON.stringify(
    [...squad.members]
      .sort((left, right) => left.order - right.order)
      .filter((member) => member.role !== "leader")
      .map((member, index) => ({
        nodeId: `node-${index + 1}`,
        agentId: member.agentId,
        prompt: "",
        dependsOnNodeIds: [],
      })),
    null,
    2,
  );
};

function FormField({
  label,
  description,
  children,
}: {
  readonly label: string;
  readonly description?: string;
  readonly children: ReactNode;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-foreground">
      <span>{label}</span>
      {children}
      {description ? (
        <span className="font-normal leading-snug text-muted-foreground">{description}</span>
      ) : null}
    </label>
  );
}

function ResultRow({
  nodeId,
  label,
  status,
  attempts,
  agentId,
  summary,
  failureCode,
  detail,
  actions,
}: {
  readonly nodeId: string;
  readonly label: string;
  readonly status: CompositionSquadRunStatus | "skipped";
  readonly attempts?: number;
  readonly agentId?: string;
  readonly summary?: string;
  readonly failureCode?: string;
  readonly detail?: string;
  readonly actions?: ReactNode;
}) {
  const badge =
    status === "skipped" ? (
      <Badge variant="secondary" size="sm">
        {t("squadRun.status.skipped")}
      </Badge>
    ) : (
      <Badge variant={statusVariant(status)} size="sm">
        {statusLabel(status)}
      </Badge>
    );

  return (
    <div
      data-squad-result-node={nodeId}
      className="grid gap-2 border-b border-border/60 px-3 py-3 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start sm:px-4"
    >
      <div className="min-w-0 space-y-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{label}</span>
          {badge}
          {attempts === undefined ? null : (
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {t("squadRun.attempts", { count: attempts })}
            </span>
          )}
          {agentId === undefined ? null : (
            <Badge variant="outline" size="sm">
              {agentId}
            </Badge>
          )}
        </div>
        {summary ? (
          <p className="text-xs leading-relaxed text-muted-foreground">{summary}</p>
        ) : null}
        {detail ? <p className="text-xs leading-relaxed text-destructive">{detail}</p> : null}
      </div>
      {failureCode === undefined && actions === undefined ? null : (
        <div className="flex max-w-full flex-wrap items-center justify-end gap-1.5">
          {failureCode ? (
            <code className="max-w-full overflow-hidden text-ellipsis rounded bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
              {failureCode}
            </code>
          ) : null}
          {actions}
        </div>
      )}
    </div>
  );
}

export function CompositionSquadExecutionResultView({
  result,
}: {
  readonly result: CompositionSquadExecutionResult;
}) {
  return (
    <div className="overflow-hidden rounded-md border border-border/70 bg-background/40">
      <div className="flex flex-col gap-1 border-b border-border/70 px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{t("squadRun.resultTitle")}</p>
          <p className="truncate font-mono text-[11px] text-muted-foreground">
            {result.executionId}
          </p>
        </div>
        <Badge variant="outline" size="sm">
          {t("squadRun.revision", { revision: result.squadRevision })}
        </Badge>
      </div>
      <ResultRow
        nodeId="leader"
        label={t("squadRun.leader")}
        status={result.graph.leader.run.status}
        attempts={result.graph.leader.run.attempt}
        agentId={result.graph.leader.run.agentId}
        {...(result.graph.leader.run.resultSummary === undefined
          ? {}
          : { summary: result.graph.leader.run.resultSummary })}
        {...(result.graph.leader.run.failureCode === undefined
          ? {}
          : { failureCode: result.graph.leader.run.failureCode })}
      />
      {result.graph.children.map((child) => (
        <ResultRow
          key={child.nodeId}
          nodeId={child.nodeId}
          label={child.nodeId}
          status={child.run.status}
          attempts={child.attempts}
          agentId={child.run.agentId}
          {...(child.run.resultSummary === undefined ? {} : { summary: child.run.resultSummary })}
          {...(child.run.failureCode === undefined ? {} : { failureCode: child.run.failureCode })}
        />
      ))}
      {(result.graph.failures ?? []).map((failure) => (
        <ResultRow
          key={`failure:${failure.nodeId}`}
          nodeId={failure.nodeId}
          label={failure.nodeId}
          status={failure.run?.status ?? (failure.kind === "skipped" ? "skipped" : "failed")}
          {...(failure.run === undefined ? {} : { attempts: failure.run.attempt })}
          {...(failure.run === undefined ? {} : { agentId: failure.run.agentId })}
          {...(failure.run?.resultSummary === undefined
            ? {}
            : { summary: failure.run.resultSummary })}
          failureCode={failure.failureCode}
          detail={failure.detail}
        />
      ))}
    </div>
  );
}

function historyNodeLabel(nodeId: string): string {
  if (nodeId === "leader-plan") return t("squadRun.leaderPlanning");
  if (nodeId === "leader-finalize") return t("squadRun.leader");
  return nodeId;
}

function nodeActionLabel(action: CompositionSquadNodeAction): string {
  switch (action) {
    case "cancel":
      return t("squadRun.cancelNode");
    case "resume":
      return t("squadRun.resumeNode");
    case "approve":
      return t("squadRun.approveNode");
    case "reject":
      return t("squadRun.rejectNode");
    case "retry":
      return t("squadRun.retryNode");
    case "reassign":
      return t("controlCenter.redispatch");
  }
}

function nodeActionIcon(action: CompositionSquadNodeAction): ReactNode {
  switch (action) {
    case "cancel":
      return <SquareIcon />;
    case "resume":
      return <PlayIcon />;
    case "approve":
      return <CheckIcon />;
    case "reject":
      return <XIcon />;
    case "retry":
      return <RotateCcwIcon />;
    case "reassign":
      return <UsersIcon />;
  }
}

function CompositionSquadEventLog({
  events,
}: {
  readonly events: ReadonlyArray<CompositionTaskEvent>;
}) {
  if (events.length === 0) {
    return <p className="text-xs text-muted-foreground">{t("squadRun.eventLogEmpty")}</p>;
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
            <span className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
              <span>
                {event.eventType} · {statusLabel(event.status)}
              </span>
              {event.blockerCode === undefined ? null : (
                <code className="rounded bg-warning/10 px-1.5 py-0.5 text-warning-foreground">
                  {event.blockerCode}
                </code>
              )}
              {event.progress === undefined ? null : (
                <span>{t("squadRun.eventProgress", { progress: event.progress })}</span>
              )}
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}

function CompositionSquadExecutionHistoryView({
  executions,
  squad,
  selectedTaskId,
  pendingAction,
  onSelectLogs,
  onAction,
}: {
  readonly executions: ReadonlyArray<CompositionSquadExecutionHistoryItem>;
  readonly squad: CompositionSquad;
  readonly selectedTaskId: string | null;
  readonly pendingAction: string | null;
  readonly onSelectLogs: (snapshot: CompositionTaskSnapshot) => void;
  readonly onAction: (
    action: CompositionSquadNodeAction,
    snapshot: CompositionTaskSnapshot,
    capabilityIds: ReadonlyArray<string>,
    reassignAgentId?: string,
  ) => void;
}) {
  const [reassignAgentIds, setReassignAgentIds] = useState<Readonly<Record<string, string>>>({});
  return (
    <div className="overflow-hidden rounded-md border border-border/70 bg-background/40">
      {executions.map((execution, index) => (
        <details
          key={`${execution.executionId}:${execution.squadRevision}`}
          data-squad-history-execution={execution.executionId}
          open={index === 0}
          className="group border-b border-border/60 last:border-b-0"
        >
          <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2 px-3 py-3 sm:px-4">
            <div className="min-w-0">
              <p className="truncate font-mono text-xs text-foreground">{execution.executionId}</p>
              <p className="mt-1 text-[11px] tabular-nums text-muted-foreground">
                {new Date(execution.updatedAtUnixMs).toLocaleString()}
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-1.5">
              <Badge variant={statusVariant(execution.status)} size="sm">
                {statusLabel(execution.status)}
              </Badge>
              <Badge variant="outline" size="sm">
                {t("squadRun.revision", { revision: execution.squadRevision })}
              </Badge>
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {t("squadRun.historyNodes", { count: execution.nodes.length })}
              </span>
            </div>
          </summary>
          {execution.failureCode === undefined && execution.failureDetail === undefined ? null : (
            <div className="flex flex-col gap-1 border-t border-border/60 bg-destructive/5 px-3 py-2 sm:flex-row sm:items-start sm:justify-between sm:px-4">
              {execution.failureDetail === undefined ? null : (
                <p className="min-w-0 text-xs leading-relaxed text-destructive">
                  {execution.failureDetail}
                </p>
              )}
              {execution.failureCode === undefined ? null : (
                <code className="max-w-full shrink-0 overflow-hidden text-ellipsis rounded bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
                  {execution.failureCode}
                </code>
              )}
            </div>
          )}
          <div className="border-t border-border/60">
            {execution.nodes.map((node) => {
              const { nodeId, snapshot } = node;
              if (snapshot === undefined) {
                return (
                  <div key={`${nodeId}:${node.taskId}`} data-squad-history-node={nodeId}>
                    <ResultRow
                      nodeId={nodeId}
                      label={historyNodeLabel(nodeId)}
                      status={execution.status}
                      {...(node.agentId === undefined ? {} : { agentId: node.agentId })}
                      summary={node.taskId}
                    />
                  </div>
                );
              }
              const latestRun = snapshot.latestRun;
              const agentId = latestRun?.agentId ?? snapshot.task.assigneeId;
              const capabilityIds =
                squad.members?.find((member) => member.agentId === agentId)?.capabilityIds ?? [];
              const reassignMembers =
                latestRun?.status === "failed" || latestRun?.status === "timed_out"
                  ? (squad.members ?? []).filter(
                      (member) =>
                        member.agentId !== agentId &&
                        member.maxConcurrentTasks > 0 &&
                        member.capabilityIds.some((capabilityId) => capabilityId.trim().length > 0),
                    )
                  : [];
              const selectedReassignAgentId = reassignAgentIds[snapshot.task.taskId];
              const reassignMember =
                reassignMembers.find((member) => member.agentId === selectedReassignAgentId) ??
                reassignMembers[0];
              const actions = getCompositionSquadNodeActions(
                snapshot,
                capabilityIds,
                reassignMember === undefined
                  ? undefined
                  : {
                      agentId: reassignMember.agentId,
                      capabilityIds: reassignMember.capabilityIds,
                    },
              );
              const selected = selectedTaskId === snapshot.task.taskId;
              return (
                <div
                  key={snapshot.task.taskId}
                  data-squad-history-node={nodeId}
                  data-selected={selected ? "true" : undefined}
                  className={selected ? "bg-accent/20" : undefined}
                >
                  <ResultRow
                    nodeId={nodeId}
                    label={historyNodeLabel(nodeId)}
                    status={latestRun?.status ?? snapshot.task.status}
                    {...(latestRun === undefined ? {} : { attempts: latestRun.attempt })}
                    agentId={latestRun?.agentId ?? snapshot.task.assigneeId}
                    {...(latestRun?.resultSummary === undefined
                      ? {}
                      : { summary: latestRun.resultSummary })}
                    {...(latestRun?.failureCode === undefined
                      ? {}
                      : { failureCode: latestRun.failureCode })}
                    actions={
                      <div className="flex flex-wrap items-center gap-1">
                        {reassignMember === undefined ? null : (
                          <Select
                            value={reassignMember.agentId}
                            onValueChange={(value) => {
                              if (!value) return;
                              setReassignAgentIds((current) => ({
                                ...current,
                                [snapshot.task.taskId]: value,
                              }));
                            }}
                          >
                            <SelectTrigger
                              data-squad-node-reassign-target={snapshot.task.taskId}
                              size="compact"
                              className="w-36 min-w-36"
                              aria-label={t("squadBuilder.agentId")}
                              title={t("squadBuilder.agentId")}
                            >
                              <SelectValue>{reassignMember.agentId}</SelectValue>
                            </SelectTrigger>
                            <SelectPopup align="end" alignItemWithTrigger={false}>
                              {reassignMembers.map((member) => (
                                <SelectItem key={member.agentId} value={member.agentId}>
                                  {member.agentId}
                                </SelectItem>
                              ))}
                            </SelectPopup>
                          </Select>
                        )}
                        <Button
                          data-squad-node-action="logs"
                          data-squad-node-task={snapshot.task.taskId}
                          size="icon-sm"
                          variant={selected ? "secondary" : "outline"}
                          aria-label={t("squadRun.viewNodeLogs")}
                          title={t("squadRun.viewNodeLogs")}
                          onClick={() => onSelectLogs(snapshot)}
                        >
                          <FileTextIcon />
                        </Button>
                        {actions.map((action) => {
                          const actionKey = `${action}:${snapshot.task.taskId}`;
                          const label = nodeActionLabel(action);
                          return (
                            <Button
                              key={action}
                              data-squad-node-action={action}
                              data-squad-node-task={snapshot.task.taskId}
                              size="icon-sm"
                              variant={action === "reject" ? "destructive-outline" : "outline"}
                              aria-label={label}
                              title={label}
                              disabled={pendingAction !== null}
                              onClick={() =>
                                onAction(
                                  action,
                                  snapshot,
                                  action === "reassign"
                                    ? (reassignMember?.capabilityIds ?? [])
                                    : capabilityIds,
                                  action === "reassign" ? reassignMember?.agentId : undefined,
                                )
                              }
                            >
                              {pendingAction === actionKey ? (
                                <RefreshCwIcon className="animate-spin" />
                              ) : (
                                nodeActionIcon(action)
                              )}
                            </Button>
                          );
                        })}
                      </div>
                    }
                  />
                </div>
              );
            })}
          </div>
        </details>
      ))}
    </div>
  );
}

function CompositionSquadRunEnvironmentPanel({
  environmentId,
}: {
  readonly environmentId: EnvironmentId | null;
}) {
  const allProjects = useProjects();
  const projects = useMemo(
    () =>
      environmentId === null
        ? []
        : allProjects.filter((project) => project.environmentId === environmentId),
    [allProjects, environmentId],
  );
  const squadsQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.compositionSquads({
          environmentId,
          input: { includeArchived: true },
        }),
  );
  const squads = squadsQuery.data?.squads ?? EMPTY_SQUADS;
  const firstSquad = squads.find((squad) => squad.archivedAtUnixMs === undefined) ?? squads[0];
  const [selectedSquadId, setSelectedSquadId] = useState<string>(() => firstSquad?.squadId ?? "");
  const selectedSquad = squads.find((squad) => squad.squadId === selectedSquadId) ?? null;
  const revisionsQuery = useEnvironmentQuery(
    environmentId === null || selectedSquadId.length === 0
      ? null
      : serverEnvironment.compositionSquadRevisions({
          environmentId,
          input: { squadId: selectedSquadId },
        }),
  );
  const runSquad = useAtomCommand(serverEnvironment.runCompositionSquad, {
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
  const firstProject = projects[0] ?? null;
  const [draft, setDraft] = useState<CompositionSquadRunDraft>(() => ({
    executionId: randomUUID(),
    projectId: firstProject?.id ?? "",
    threadId: "",
    goal: "",
    workspaceRoot: firstProject?.workspaceRoot ?? "",
    planText: buildPlanTemplate(firstSquad ?? null),
  }));
  const tasksQuery = useEnvironmentQuery(
    environmentId === null || draft.projectId.trim().length === 0
      ? null
      : serverEnvironment.listCompositionTasks({
          environmentId,
          input: { projectId: draft.projectId },
        }),
  );
  const executionsQuery = useEnvironmentQuery(
    environmentId === null || draft.projectId.trim().length === 0 || selectedSquadId.length === 0
      ? null
      : serverEnvironment.compositionSquadExecutions({
          environmentId,
          input: {
            projectId: draft.projectId,
            squadId: selectedSquadId,
            limit: 50,
          },
        }),
  );
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [nodeActionReason, setNodeActionReason] = useState("");
  const [pendingNodeAction, setPendingNodeAction] = useState<string | null>(null);
  const [nodeActionError, setNodeActionError] = useState<string | null>(null);
  const [selectedHistoryTaskId, setSelectedHistoryTaskId] = useState<string | null>(null);
  const [executionResult, setExecutionResult] = useState<CompositionSquadExecutionResult | null>(
    null,
  );
  const buildResult = useMemo(
    () =>
      selectedSquad === null
        ? { request: null, issues: [] }
        : buildCompositionSquadExecutionRequest(draft, selectedSquad),
    [draft, selectedSquad],
  );
  const executionHistory = useMemo(
    () =>
      selectedSquad === null
        ? []
        : projectCompositionSquadExecutionHistory(
            selectedSquad.squadId,
            executionsQuery.data?.executions ?? [],
            tasksQuery.data?.tasks ?? [],
          ),
    [executionsQuery.data?.executions, selectedSquad, tasksQuery.data?.tasks],
  );
  const selectedHistoryNode = useMemo(() => {
    const nodes = executionHistory.flatMap((execution) => execution.nodes);
    return (
      nodes.find((node) => node.snapshot?.task.taskId === selectedHistoryTaskId) ??
      executionHistory[0]?.nodes.find(
        (node) => node.nodeId === "leader-finalize" && node.snapshot !== undefined,
      ) ??
      executionHistory[0]?.nodes.find((node) => node.snapshot !== undefined) ??
      null
    );
  }, [executionHistory, selectedHistoryTaskId]);
  const selectedHistorySnapshot = selectedHistoryNode?.snapshot;
  const selectedHistoryRun = selectedHistorySnapshot?.latestRun;
  const eventsQuery = useEnvironmentQuery(
    environmentId === null ||
      selectedHistorySnapshot === undefined ||
      selectedHistoryRun === undefined
      ? null
      : serverEnvironment.listCompositionTaskEvents({
          environmentId,
          input: {
            taskId: selectedHistorySnapshot.task.taskId,
            runId: selectedHistoryRun.runId,
          },
        }),
  );

  useEffect(() => {
    if (selectedSquad !== null || firstSquad === undefined) return;
    setSelectedSquadId(firstSquad.squadId);
    setDraft((current) => ({ ...current, planText: buildPlanTemplate(firstSquad) }));
  }, [firstSquad, selectedSquad]);

  useEffect(() => {
    if (projects.some((project) => project.id === draft.projectId) || firstProject === null) return;
    setDraft((current) => ({
      ...current,
      projectId: firstProject.id,
      workspaceRoot: firstProject.workspaceRoot,
    }));
  }, [draft.projectId, firstProject, projects]);

  const selectSquad = (squadId: string): void => {
    const squad = squads.find((candidate) => candidate.squadId === squadId) ?? null;
    setSelectedSquadId(squadId);
    setDraft((current) => ({ ...current, planText: buildPlanTemplate(squad) }));
    setActionError(null);
    setNodeActionError(null);
    setSelectedHistoryTaskId(null);
    setExecutionResult(null);
  };

  const selectProject = (projectId: string): void => {
    const project = projects.find((candidate) => candidate.id === projectId);
    setDraft((current) => ({
      ...current,
      projectId,
      workspaceRoot: project?.workspaceRoot ?? current.workspaceRoot,
    }));
    setSelectedHistoryTaskId(null);
  };

  const run = async (): Promise<void> => {
    const request = buildResult.request;
    if (environmentId === null || request === null || pending) return;
    setPending(true);
    setActionError(null);
    setExecutionResult(null);
    const result: AtomCommandResult<CompositionSquadExecutionResult, unknown> =
      await executeCompositionSquadRunWithHistoryRefresh(
        () =>
          runSquad({
            environmentId,
            input: request,
          }),
        {
          refreshExecutions: executionsQuery.refresh,
          refreshTasks: tasksQuery.refresh,
        },
      );
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      setActionError(error instanceof Error ? error.message : t("squadRun.actionFailed"));
    } else {
      setExecutionResult(result.value);
      setDraft((current) => advanceCompositionSquadRunDraft(current, randomUUID()));
    }
    setPending(false);
  };

  const runNodeAction = async (
    action: CompositionSquadNodeAction,
    snapshot: CompositionTaskSnapshot,
    capabilityIds: ReadonlyArray<string>,
    reassignAgentId?: string,
  ): Promise<void> => {
    if (environmentId === null || pendingNodeAction !== null) return;
    const defaultReason =
      action === "cancel"
        ? t("squadRun.cancelReasonDefault")
        : action === "resume"
          ? t("squadRun.resumeReasonDefault")
          : action === "approve"
            ? t("squadRun.approveReasonDefault")
            : action === "reject"
              ? t("squadRun.rejectReasonDefault")
              : t("squadRun.retryReasonDefault");
    const request = buildCompositionSquadNodeActionRequest(
      action,
      snapshot,
      capabilityIds,
      `squad-${action === "reassign" ? "reassign" : "retry"}-${randomUUID()}`,
      nodeActionReason.trim() || defaultReason,
      reassignAgentId,
    );
    if (request === null) return;

    const actionKey = `${action}:${snapshot.task.taskId}`;
    setPendingNodeAction(actionKey);
    setNodeActionError(null);
    const result = await executeCompositionSquadNodeActionWithHistoryRefresh(
      () =>
        request.kind === "cancel"
          ? cancelTask({ environmentId, input: request.input })
          : request.kind === "resume"
            ? resumeTask({ environmentId, input: request.input })
            : request.kind === "review"
              ? reviewTask({ environmentId, input: request.input })
              : retryTask({ environmentId, input: request.input }),
      {
        refreshExecutions: executionsQuery.refresh,
        refreshTasks: tasksQuery.refresh,
        refreshEvents: eventsQuery.refresh,
      },
    );
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      setNodeActionError(error instanceof Error ? error.message : t("squadRun.nodeActionFailed"));
    }
    setPendingNodeAction(null);
  };

  const isArchived = selectedSquad?.archivedAtUnixMs !== undefined;
  const revisions = revisionsQuery.data?.revisions ?? [];

  return (
    <SettingsSection
      data-squad-run-environment={environmentId ?? "disconnected"}
      title={t("squadRun.title")}
      icon={<GitBranchIcon className="size-4 text-muted-foreground" />}
      headerAction={
        <Button
          size="icon-sm"
          variant="ghost-muted"
          aria-label={t("squadRun.refresh")}
          disabled={environmentId === null}
          onClick={() => {
            squadsQuery.refresh();
            revisionsQuery.refresh();
            executionsQuery.refresh();
            tasksQuery.refresh();
            eventsQuery.refresh();
          }}
        >
          <RefreshCwIcon />
        </Button>
      }
    >
      <div className="space-y-4 rounded-md border border-border/70 bg-muted/10 p-3 sm:p-4">
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          {t("squadRun.description")}
        </p>
        {environmentId === null ? (
          <p className="text-sm text-muted-foreground">{t("squadRun.noEnvironment")}</p>
        ) : squadsQuery.isPending ? (
          <p className="text-sm text-muted-foreground">{t("squadRun.loading")}</p>
        ) : squadsQuery.error ? (
          <p className="text-sm text-destructive">
            {t("squadRun.loadFailed", { message: String(squadsQuery.error) })}
          </p>
        ) : selectedSquad === null ? (
          <p className="text-sm text-muted-foreground">{t("squadRun.noSquads")}</p>
        ) : (
          <div data-squad-run-id={selectedSquad.squadId} className="space-y-5">
            <div className="grid gap-3 md:grid-cols-2">
              <FormField label={t("squadRun.squad")}>
                <Select
                  value={selectedSquadId}
                  onValueChange={(value) => value && selectSquad(value)}
                >
                  <SelectTrigger size="compact" aria-label={t("squadRun.squad")}>
                    <SelectValue>{selectedSquad.name}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="start" alignItemWithTrigger={false}>
                    {squads.map((squad) => (
                      <SelectItem key={squad.squadId} value={squad.squadId}>
                        <span className="flex min-w-0 items-center gap-2">
                          <UsersIcon className="size-3.5 shrink-0 text-muted-foreground" />
                          <span className="truncate">{squad.name}</span>
                          {squad.archivedAtUnixMs === undefined ? null : (
                            <span className="shrink-0 text-[11px] text-muted-foreground">
                              {t("squadRun.archived")}
                            </span>
                          )}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </FormField>
              <FormField label={t("squadRun.project")}>
                <Select
                  value={draft.projectId}
                  disabled={projects.length === 0}
                  onValueChange={(value) => value && selectProject(value)}
                >
                  <SelectTrigger size="compact" aria-label={t("squadRun.project")}>
                    <SelectValue>
                      {projects.find((project) => project.id === draft.projectId)?.title ??
                        t("squadRun.noProjects")}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="start" alignItemWithTrigger={false}>
                    {projects.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate">{project.title}</span>
                          <span className="truncate text-[11px] text-muted-foreground">
                            {project.workspaceRoot}
                          </span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </FormField>
              <FormField label={t("squadRun.workspaceRoot")}>
                <Input
                  size="compact"
                  value={draft.workspaceRoot}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setDraft((current) => ({
                      ...current,
                      workspaceRoot: value,
                    }));
                  }}
                />
              </FormField>
              <FormField label={t("squadRun.threadId")} description={t("squadRun.optional")}>
                <Input
                  size="compact"
                  value={draft.threadId}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setDraft((current) => ({ ...current, threadId: value }));
                  }}
                />
              </FormField>
              <FormField label={t("squadRun.executionId")}>
                <div className="flex min-w-0 gap-2">
                  <Input size="compact" value={draft.executionId} readOnly className="font-mono" />
                  <Button
                    size="icon-sm"
                    variant="outline"
                    aria-label={t("squadRun.newExecutionId")}
                    onClick={() =>
                      setDraft((current) => ({ ...current, executionId: randomUUID() }))
                    }
                  >
                    <RefreshCwIcon />
                  </Button>
                </div>
              </FormField>
              <div className="flex min-w-0 items-end pb-1 text-xs text-muted-foreground">
                {t("squadRun.boundRevision", { revision: selectedSquad.revision ?? 1 })}
              </div>
            </div>

            <FormField label={t("squadRun.goal")}>
              <Textarea
                value={draft.goal}
                placeholder={t("squadRun.goalPlaceholder")}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setDraft((current) => ({ ...current, goal: value }));
                }}
              />
            </FormField>

            <FormField
              label={t("squadRun.plan")}
              description={
                selectedSquad.collaborationMode === "dependency_graph"
                  ? t("squadRun.planRequiredDescription")
                  : t("squadRun.planOptionalDescription")
              }
            >
              <Textarea
                className="min-h-52 font-mono text-xs"
                value={draft.planText}
                placeholder={t("squadRun.planPlaceholder")}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setDraft((current) => ({ ...current, planText: value }));
                }}
              />
            </FormField>

            {revisionsQuery.isPending ? (
              <p className="text-xs text-muted-foreground">{t("squadRun.revisionsLoading")}</p>
            ) : revisionsQuery.error ? (
              <p className="text-xs text-destructive">
                {t("squadRun.revisionsFailed", { message: String(revisionsQuery.error) })}
              </p>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-xs font-medium text-foreground">
                  <HistoryIcon className="size-3.5 text-muted-foreground" />
                  {t("squadRun.revisions")}
                </div>
                {revisions.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t("squadRun.noRevisions")}</p>
                ) : (
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {revisions.map((revision) => (
                      <div
                        key={revision.revision}
                        data-squad-revision={revision.revision}
                        className="min-w-0 rounded-md border border-border/60 bg-background/50 px-3 py-2"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-medium">
                            {t("squadRun.revision", { revision: revision.revision })}
                          </span>
                          <Badge
                            variant={revision.configuration === null ? "outline" : "secondary"}
                            size="sm"
                          >
                            {revision.configuration === null
                              ? t("squadRun.legacySnapshot")
                              : t("squadRun.snapshotAvailable")}
                          </Badge>
                        </div>
                        <p className="mt-1 text-[11px] tabular-nums text-muted-foreground">
                          {new Date(revision.createdAtUnixMs).toLocaleString()}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {isArchived ? (
              <p className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-warning">
                {t("squadRun.archivedReadonly")}
              </p>
            ) : (
              <div className="flex flex-col gap-3 border-t border-border/60 pt-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 space-y-1">
                  {buildResult.issues.length === 0 ? (
                    <p className="text-xs text-success">{t("squadRun.validationReady")}</p>
                  ) : (
                    <>
                      <p className="text-xs font-medium text-destructive">
                        {t("squadRun.validationTitle")}
                      </p>
                      <ul className="space-y-0.5 text-xs text-destructive">
                        {buildResult.issues.map((issue) => (
                          <li key={`${issue.code}:${issue.path}`}>{issueLabel(issue)}</li>
                        ))}
                      </ul>
                    </>
                  )}
                  {actionError ? <p className="text-xs text-destructive">{actionError}</p> : null}
                </div>
                <Button
                  data-testid="squad-run"
                  size="sm"
                  disabled={pending || buildResult.request === null || projects.length === 0}
                  onClick={() => void run()}
                >
                  {pending ? <RefreshCwIcon className="animate-spin" /> : <PlayIcon />}
                  {pending ? t("squadRun.running") : t("squadRun.run")}
                </Button>
              </div>
            )}

            {executionResult ? (
              <CompositionSquadExecutionResultView result={executionResult} />
            ) : null}

            <div className="space-y-2 border-t border-border/60 pt-4">
              <div className="flex items-center gap-2 text-xs font-medium text-foreground">
                <HistoryIcon className="size-3.5 text-muted-foreground" />
                {t("squadRun.executionHistory")}
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t("squadRun.executionHistoryDescription")}
              </p>
              <FormField
                label={t("squadRun.actionReason")}
                description={t("squadRun.actionReasonDescription")}
              >
                <Input
                  size="compact"
                  value={nodeActionReason}
                  placeholder={t("squadRun.actionReasonPlaceholder")}
                  onChange={(event) => setNodeActionReason(event.currentTarget.value)}
                />
              </FormField>
              {nodeActionError ? (
                <p className="text-xs text-destructive">{nodeActionError}</p>
              ) : null}
              {executionsQuery.error ? (
                <p className="text-xs text-destructive">
                  {t("squadRun.historyFailed", { message: String(executionsQuery.error) })}
                </p>
              ) : null}
              {tasksQuery.error ? (
                <p className="text-xs text-destructive">
                  {t("squadRun.historyEnrichmentFailed", { message: String(tasksQuery.error) })}
                </p>
              ) : null}
              {executionsQuery.isPending && executionHistory.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("squadRun.historyLoading")}</p>
              ) : executionsQuery.error !== null &&
                executionHistory.length === 0 ? null : executionHistory.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("squadRun.noExecutionHistory")}</p>
              ) : (
                <CompositionSquadExecutionHistoryView
                  executions={executionHistory}
                  squad={selectedSquad}
                  selectedTaskId={selectedHistorySnapshot?.task.taskId ?? null}
                  pendingAction={pendingNodeAction}
                  onSelectLogs={(snapshot) => setSelectedHistoryTaskId(snapshot.task.taskId)}
                  onAction={(action, snapshot, capabilityIds, reassignAgentId) =>
                    void runNodeAction(action, snapshot, capabilityIds, reassignAgentId)
                  }
                />
              )}
              {selectedHistorySnapshot === undefined || selectedHistoryRun === undefined ? null : (
                <div
                  data-squad-event-task={selectedHistorySnapshot.task.taskId}
                  className="rounded-md border border-border/70 bg-background/40 p-3 sm:p-4"
                >
                  <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-foreground">
                        {t("squadRun.eventLog")}
                      </p>
                      <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
                        {selectedHistorySnapshot.task.taskId}
                      </p>
                      <p className="break-all font-mono text-[11px] text-muted-foreground">
                        {selectedHistoryRun.runId}
                      </p>
                    </div>
                    <Button
                      size="icon-sm"
                      variant="ghost-muted"
                      aria-label={t("squadRun.refreshEventLog")}
                      title={t("squadRun.refreshEventLog")}
                      disabled={eventsQuery.isPending}
                      onClick={() => eventsQuery.refresh()}
                    >
                      <RefreshCwIcon
                        className={eventsQuery.isPending ? "animate-spin" : undefined}
                      />
                    </Button>
                  </div>
                  {eventsQuery.error ? (
                    <p className="text-xs text-destructive">
                      {t("squadRun.eventLogFailed", { message: String(eventsQuery.error) })}
                    </p>
                  ) : eventsQuery.isPending ? (
                    <p className="text-xs text-muted-foreground">{t("squadRun.eventLogLoading")}</p>
                  ) : (
                    <CompositionSquadEventLog events={eventsQuery.data?.events ?? []} />
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </SettingsSection>
  );
}

export function CompositionSquadRunPanel() {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  return (
    <CompositionSquadRunEnvironmentPanel
      key={compositionSquadRunEnvironmentKey(environmentId)}
      environmentId={environmentId}
    />
  );
}
