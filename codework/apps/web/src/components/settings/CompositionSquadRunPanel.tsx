"use client";

import type {
  CompositionSquad,
  CompositionSquadExecutionResult,
  CompositionTaskStatus,
  EnvironmentId,
} from "@codework/contracts";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@codework/client-runtime/state/runtime";
import { GitBranchIcon, HistoryIcon, PlayIcon, RefreshCwIcon, UsersIcon } from "lucide-react";
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
  buildCompositionSquadExecutionRequest,
  compositionSquadRunEnvironmentKey,
  type CompositionSquadRunDraft,
  type CompositionSquadRunIssue,
} from "./CompositionSquadRunPanel.logic";
import { SettingsSection } from "./settingsLayout";

const EMPTY_SQUADS: ReadonlyArray<CompositionSquad> = [];

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

const statusLabel = (status: CompositionTaskStatus): string => t(`squadRun.status.${status}`);

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
  summary,
  failureCode,
  detail,
}: {
  readonly nodeId: string;
  readonly label: string;
  readonly status: CompositionTaskStatus | "skipped";
  readonly attempts?: number;
  readonly summary?: string;
  readonly failureCode?: string;
  readonly detail?: string;
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
        </div>
        {summary ? (
          <p className="text-xs leading-relaxed text-muted-foreground">{summary}</p>
        ) : null}
        {detail ? <p className="text-xs leading-relaxed text-destructive">{detail}</p> : null}
      </div>
      {failureCode ? (
        <code className="max-w-full overflow-hidden text-ellipsis rounded bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
          {failureCode}
        </code>
      ) : null}
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
  const firstProject = projects[0] ?? null;
  const [draft, setDraft] = useState<CompositionSquadRunDraft>(() => ({
    executionId: randomUUID(),
    projectId: firstProject?.id ?? "",
    threadId: "",
    goal: "",
    workspaceRoot: firstProject?.workspaceRoot ?? "",
    planText: buildPlanTemplate(firstSquad ?? null),
  }));
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
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
    setExecutionResult(null);
  };

  const selectProject = (projectId: string): void => {
    const project = projects.find((candidate) => candidate.id === projectId);
    setDraft((current) => ({
      ...current,
      projectId,
      workspaceRoot: project?.workspaceRoot ?? current.workspaceRoot,
    }));
  };

  const run = async (): Promise<void> => {
    if (environmentId === null || buildResult.request === null || pending) return;
    setPending(true);
    setActionError(null);
    setExecutionResult(null);
    const result: AtomCommandResult<CompositionSquadExecutionResult, unknown> = await runSquad({
      environmentId,
      input: buildResult.request,
    });
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      setActionError(error instanceof Error ? error.message : t("squadRun.actionFailed"));
    } else {
      setExecutionResult(result.value);
      setDraft((current) => advanceCompositionSquadRunDraft(current, randomUUID()));
    }
    setPending(false);
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
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      workspaceRoot: event.currentTarget.value,
                    }))
                  }
                />
              </FormField>
              <FormField label={t("squadRun.threadId")} description={t("squadRun.optional")}>
                <Input
                  size="compact"
                  value={draft.threadId}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, threadId: event.currentTarget.value }))
                  }
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
                onChange={(event) =>
                  setDraft((current) => ({ ...current, goal: event.currentTarget.value }))
                }
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
                onChange={(event) =>
                  setDraft((current) => ({ ...current, planText: event.currentTarget.value }))
                }
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
