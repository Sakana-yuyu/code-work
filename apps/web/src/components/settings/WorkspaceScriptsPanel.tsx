"use client";

import type {
  WorkspaceScriptHealthStatus,
  WorkspaceScriptRun,
  WorkspaceScriptRunResult,
  WorkspaceScriptRunStatus,
} from "@codework/contracts";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@codework/client-runtime/state/runtime";
import {
  ActivityIcon,
  ExternalLinkIcon,
  PlayIcon,
  RefreshCwIcon,
  SquareIcon,
  TerminalIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { t } from "~/i18n";
import { randomUUID } from "~/lib/utils";
import { usePrimaryEnvironment } from "~/state/environments";
import { useProjects, useThreadShells } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsSection } from "./settingsLayout";
import { createWorkspaceScriptStopRequest } from "./workspaceScriptStopRequest";

const EMPTY_RUNS: ReadonlyArray<WorkspaceScriptRun> = [];

const runStatusVariant = (
  status: WorkspaceScriptRunStatus,
): "default" | "success" | "warning" | "error" | "secondary" | "outline" => {
  switch (status) {
    case "running":
      return "success";
    case "starting":
    case "stopping":
      return "warning";
    case "failed":
      return "error";
    case "stopped":
    case "exited":
      return "secondary";
  }
};

const healthVariant = (status: WorkspaceScriptHealthStatus): "success" | "error" | "outline" => {
  switch (status) {
    case "healthy":
      return "success";
    case "unhealthy":
      return "error";
    case "unknown":
      return "outline";
  }
};

const canStopRun = (run: WorkspaceScriptRun): boolean =>
  run.status === "starting" || run.status === "running";

const formatTime = (unixMs: number | null): string =>
  unixMs === null ? t("workspaceScripts.notAvailable") : new Date(unixMs).toLocaleString();

export function WorkspaceScriptsPanel() {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const allProjects = useProjects();
  const allThreads = useThreadShells();
  const projects = useMemo(
    () =>
      environmentId === null
        ? []
        : allProjects.filter((project) => project.environmentId === environmentId),
    [allProjects, environmentId],
  );
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    () => projects[0]?.id ?? null,
  );
  const selectedProject =
    projects.find((project) => project.id === selectedProjectId) ?? projects[0] ?? null;
  const threads = useMemo(
    () =>
      environmentId === null || selectedProject === null
        ? []
        : allThreads.filter(
            (thread) =>
              thread.environmentId === environmentId &&
              thread.projectId === selectedProject.id &&
              thread.archivedAt === null,
          ),
    [allThreads, environmentId, selectedProject],
  );
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(
    () => threads[0]?.id ?? null,
  );
  const selectedThread =
    threads.find((thread) => thread.id === selectedThreadId) ?? threads[0] ?? null;

  useEffect(() => {
    if (selectedProject !== null) {
      if (selectedProject.id !== selectedProjectId) setSelectedProjectId(selectedProject.id);
      return;
    }
    if (selectedProjectId !== null) setSelectedProjectId(null);
  }, [selectedProject, selectedProjectId]);

  useEffect(() => {
    if (selectedThread !== null) {
      if (selectedThread.id !== selectedThreadId) setSelectedThreadId(selectedThread.id);
      return;
    }
    if (selectedThreadId !== null) setSelectedThreadId(null);
  }, [selectedThread, selectedThreadId]);

  const runsQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.workspaceScriptRuns({
          environmentId,
          input: {
            ...(selectedProject === null ? {} : { projectId: selectedProject.id }),
            ...(selectedThread === null ? {} : { threadId: selectedThread.id }),
          },
        }),
  );
  const runs = useMemo(
    () =>
      [...(runsQuery.data?.runs ?? EMPTY_RUNS)].sort(
        (left, right) => right.updatedAtUnixMs - left.updatedAtUnixMs,
      ),
    [runsQuery.data?.runs],
  );
  const startWorkspaceScript = useAtomCommand(serverEnvironment.startWorkspaceScript, {
    reportFailure: false,
  });
  const stopWorkspaceScript = useAtomCommand(serverEnvironment.stopWorkspaceScript, {
    reportFailure: false,
  });
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const isBusy = pendingAction !== null;

  const settle = async (
    action: string,
    execute: () => Promise<AtomCommandResult<WorkspaceScriptRunResult, unknown>>,
  ): Promise<void> => {
    setPendingAction(action);
    setActionError(null);
    const result = await execute();
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      setActionError(error instanceof Error ? error.message : t("workspaceScripts.actionFailed"));
    } else {
      runsQuery.refresh();
    }
    setPendingAction(null);
  };

  const startScript = async (scriptId: string): Promise<void> => {
    if (environmentId === null || selectedProject === null || selectedThread === null || isBusy) {
      return;
    }
    const action = `start:${scriptId}`;
    await settle(action, () =>
      startWorkspaceScript({
        environmentId,
        input: {
          operationId: `workspace-script-start-${randomUUID()}`,
          projectId: selectedProject.id,
          threadId: selectedThread.id,
          scriptId,
          ...(selectedThread.worktreePath === null
            ? {}
            : { worktreePath: selectedThread.worktreePath }),
        },
      }),
    );
  };

  const stopRun = async (run: WorkspaceScriptRun): Promise<void> => {
    if (environmentId === null || isBusy || !canStopRun(run)) return;
    const action = `stop:${run.workspaceScriptRunId}`;
    await settle(action, () =>
      stopWorkspaceScript({
        environmentId,
        input: createWorkspaceScriptStopRequest(run),
      }),
    );
  };

  return (
    <SettingsSection
      id="workspace-scripts"
      title={t("workspaceScripts.title")}
      icon={<TerminalIcon className="size-4 text-muted-foreground" />}
      headerAction={
        <Button
          size="icon-xs"
          variant="ghost-muted"
          disabled={environmentId === null || runsQuery.isPending}
          aria-label={t("workspaceScripts.refresh")}
          onClick={runsQuery.refresh}
        >
          <RefreshCwIcon />
        </Button>
      }
    >
      <div className="space-y-5 rounded-md border border-border/70 bg-background/40 p-3 sm:p-4">
        <p className="max-w-3xl text-xs leading-relaxed text-muted-foreground">
          {t("workspaceScripts.description")}
        </p>

        {environmentId === null ? (
          <p className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
            {t("workspaceScripts.noEnvironment")}
          </p>
        ) : (
          <>
            <div
              className="grid gap-3 md:grid-cols-2"
              data-facilities-guide-target="workspace-project"
            >
              <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-foreground">
                <span>{t("workspaceScripts.project")}</span>
                <Select
                  value={selectedProject?.id ?? ""}
                  disabled={projects.length === 0 || isBusy}
                  onValueChange={(value) => {
                    if (!value) return;
                    setSelectedProjectId(value);
                    setSelectedThreadId(null);
                    setActionError(null);
                  }}
                >
                  <SelectTrigger size="compact" aria-label={t("workspaceScripts.project")}>
                    <SelectValue>
                      {selectedProject?.title ?? t("workspaceScripts.noProjects")}
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
              </label>
              <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-foreground">
                <span>{t("workspaceScripts.thread")}</span>
                <Select
                  value={selectedThread?.id ?? ""}
                  disabled={threads.length === 0 || isBusy}
                  onValueChange={(value) => {
                    if (!value) return;
                    setSelectedThreadId(value);
                    setActionError(null);
                  }}
                >
                  <SelectTrigger size="compact" aria-label={t("workspaceScripts.thread")}>
                    <SelectValue>
                      {selectedThread?.title ?? t("workspaceScripts.noThreads")}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="start" alignItemWithTrigger={false}>
                    {threads.map((thread) => (
                      <SelectItem key={thread.id} value={thread.id}>
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate">{thread.title}</span>
                          <span className="truncate font-mono text-[11px] text-muted-foreground">
                            {thread.worktreePath ?? selectedProject?.workspaceRoot ?? thread.id}
                          </span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </label>
            </div>

            <div
              className="space-y-2 border-t border-border/60 pt-4"
              data-facilities-guide-target="workspace-declared"
            >
              <div data-facilities-guide-target="workspace-start">
                <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
                  <PlayIcon className="size-3.5 text-muted-foreground" />
                  {t("workspaceScripts.declaredScripts")}
                </div>
                {selectedProject === null || selectedProject.scripts.length === 0 ? (
                  <p className="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
                    {t("workspaceScripts.noScripts")}
                  </p>
                ) : (
                  <div className="overflow-hidden rounded-md border border-border/70">
                    {selectedProject.scripts.map((script) => {
                      const action = `start:${script.id}`;
                      return (
                        <div
                          key={script.id}
                          className="flex flex-col gap-3 border-b border-border/60 px-3 py-3 last:border-b-0 sm:flex-row sm:items-center sm:justify-between"
                        >
                          <div className="min-w-0">
                            <div className="flex min-w-0 flex-wrap items-center gap-2">
                              <span className="truncate text-sm font-medium text-foreground">
                                {script.name}
                              </span>
                              <Badge variant="outline" size="sm">
                                {script.id}
                              </Badge>
                              {script.runOnWorktreeCreate ? (
                                <Badge variant="secondary" size="sm">
                                  {t("workspaceScripts.runOnWorktreeCreate")}
                                </Badge>
                              ) : null}
                            </div>
                            <code className="mt-1 block overflow-hidden text-ellipsis text-xs text-muted-foreground">
                              {script.command}
                            </code>
                          </div>
                          <Button
                            data-testid={`workspace-script-start-${script.id}`}
                            size="xs"
                            disabled={selectedThread === null || isBusy}
                            onClick={() => void startScript(script.id)}
                          >
                            <PlayIcon />
                            {pendingAction === action
                              ? t("workspaceScripts.starting")
                              : t("workspaceScripts.start")}
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            <div
              className="space-y-2 border-t border-border/60 pt-4"
              data-facilities-guide-target="workspace-runs"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
                  <ActivityIcon className="size-3.5 text-muted-foreground" />
                  {t("workspaceScripts.history")}
                </div>
                <span className="text-[11px] tabular-nums text-muted-foreground">
                  {t("workspaceScripts.runCount", { count: runs.length })}
                </span>
              </div>
              {runsQuery.isPending && runsQuery.data === null ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  {t("workspaceScripts.loading")}
                </p>
              ) : runsQuery.error !== null ? (
                <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                  {t("workspaceScripts.loadFailed", { message: runsQuery.error })}
                </p>
              ) : runs.length === 0 ? (
                <p className="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
                  {t("workspaceScripts.noRuns")}
                </p>
              ) : (
                <div className="overflow-hidden rounded-md border border-border/70">
                  {runs.map((run) => {
                    const action = `stop:${run.workspaceScriptRunId}`;
                    return (
                      <div
                        key={run.workspaceScriptRunId}
                        className="space-y-3 border-b border-border/60 px-3 py-3 last:border-b-0 sm:px-4"
                      >
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <div className="min-w-0 space-y-1">
                            <div className="flex min-w-0 flex-wrap items-center gap-2">
                              <span className="truncate text-sm font-medium text-foreground">
                                {run.scriptName}
                              </span>
                              <Badge variant={runStatusVariant(run.status)} size="sm">
                                {t(`workspaceScripts.status.${run.status}`)}
                              </Badge>
                              <Badge variant={healthVariant(run.healthStatus)} size="sm">
                                {t(`workspaceScripts.health.${run.healthStatus}`)}
                              </Badge>
                            </div>
                            <p className="truncate font-mono text-[11px] text-muted-foreground">
                              {run.workspaceScriptRunId}
                            </p>
                          </div>
                          {canStopRun(run) ? (
                            <Button
                              data-testid={`workspace-script-stop-${run.workspaceScriptRunId}`}
                              size="xs"
                              variant="outline"
                              disabled={isBusy}
                              onClick={() => void stopRun(run)}
                            >
                              <SquareIcon />
                              {pendingAction === action
                                ? t("workspaceScripts.stopping")
                                : t("workspaceScripts.stop")}
                            </Button>
                          ) : null}
                        </div>
                        <div className="grid gap-x-6 gap-y-2 text-xs text-muted-foreground md:grid-cols-2">
                          <p className="min-w-0 truncate">
                            <span className="font-medium text-foreground">
                              {t("workspaceScripts.terminal")}:
                            </span>
                            <span className="font-mono">{run.terminalId}</span>
                          </p>
                          <p className="min-w-0 truncate">
                            <span className="font-medium text-foreground">
                              {t("workspaceScripts.cwd")}:
                            </span>
                            <span className="font-mono">{run.cwd}</span>
                          </p>
                          <p>
                            <span className="font-medium text-foreground">
                              {t("workspaceScripts.startedAt")}:
                            </span>
                            {formatTime(run.startedAtUnixMs)}
                          </p>
                          <p>
                            <span className="font-medium text-foreground">
                              {t("workspaceScripts.updatedAt")}:
                            </span>
                            {formatTime(run.updatedAtUnixMs)}
                          </p>
                        </div>
                        {run.ports.length === 0 ? (
                          <p className="text-xs text-muted-foreground">
                            {t("workspaceScripts.noPorts")}
                          </p>
                        ) : (
                          <div className="flex flex-wrap items-center gap-2">
                            {run.ports.map((port) => {
                              const label = `${port.protocol.toUpperCase()} ${port.port}`;
                              return port.url === null ? (
                                <Badge
                                  key={`${port.protocol}:${port.port}`}
                                  variant="outline"
                                  size="sm"
                                >
                                  {label}
                                </Badge>
                              ) : (
                                <a
                                  key={`${port.protocol}:${port.port}`}
                                  href={port.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[11px] text-foreground hover:bg-muted"
                                >
                                  {port.url}
                                  <ExternalLinkIcon className="size-3" aria-hidden />
                                </a>
                              );
                            })}
                          </div>
                        )}
                        {run.healthDetail === null ? null : (
                          <p className="text-xs text-destructive">{run.healthDetail}</p>
                        )}
                        {run.errorCode === null ? null : (
                          <p className="rounded bg-destructive/5 px-2 py-1 text-xs text-destructive">
                            <span className="font-mono">{run.errorCode}</span>
                            {run.errorDetail === null ? null : ` · ${run.errorDetail}`}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {actionError === null ? null : (
              <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                {actionError}
              </p>
            )}
          </>
        )}
      </div>
    </SettingsSection>
  );
}
