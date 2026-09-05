"use client";

import {
  type CompositionAutomation,
  type CompositionAutomationDeleteResult,
  type CompositionAutomationResult,
  type CompositionAutomationRun,
  type CompositionAutomationRunResult,
} from "@codework/contracts";
import {
  buildCompositionAutomationCreateRequest,
  buildCompositionAutomationUpdateRequest,
  createEmptyCompositionAutomationDraft,
  draftFromCompositionAutomation,
  getCompositionAutomationActions,
  type CompositionAutomationAction,
  type CompositionAutomationDraft,
  type CompositionAutomationDraftIssue,
  type CompositionAutomationIntervalUnit,
} from "@codework/client-runtime/composition/automation-builder";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@codework/client-runtime/state/runtime";
import * as DateTime from "effect/DateTime";
import {
  AlarmClockIcon,
  BotIcon,
  Clock3Icon,
  HistoryIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SaveIcon,
  Trash2Icon,
  UsersIcon,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { t } from "~/i18n";
import { cn, randomUUID } from "~/lib/utils";
import { useProjects } from "~/state/entities";
import { usePrimaryEnvironment } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { useCompositionEditorState } from "./compositionEditorState";
import { SettingsSection } from "./settingsLayout";

const EMPTY_AUTOMATIONS: ReadonlyArray<CompositionAutomation> = [];
const EMPTY_RUNS: ReadonlyArray<CompositionAutomationRun> = [];
const INTERVAL_UNITS: ReadonlyArray<CompositionAutomationIntervalUnit> = [
  "millisecond",
  "second",
  "minute",
  "hour",
  "day",
];
const TARGET_TYPES = ["agent", "squad", "goal_loop"] as const;
const EXECUTION_MODES = ["isolated", "existing_thread"] as const;
const getAutomationId = (automation: CompositionAutomation): string => automation.automationId;

const formatTime = (unixMs: number | null): string =>
  unixMs === null
    ? t("automationCenter.never")
    : DateTime.formatLocal(DateTime.makeUnsafe(unixMs), {
        dateStyle: "medium",
        timeStyle: "short",
      });

const automationStatusVariant = (status: CompositionAutomation["status"]) =>
  status === "active" ? "success" : status === "paused" ? "warning" : "secondary";

const runStatusVariant = (status: CompositionAutomationRun["status"]) =>
  status === "succeeded"
    ? "success"
    : status === "failed"
      ? "error"
      : status === "running"
        ? "info"
        : status === "queued"
          ? "warning"
          : "secondary";

const issueLabel = (issue: CompositionAutomationDraftIssue): string =>
  t(`automationCenter.validation.${issue.code}`, { path: issue.path });

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

function EnumSelect<T extends string>({
  value,
  values,
  label,
  disabled,
  renderLabel,
  onChange,
}: {
  readonly value: T;
  readonly values: ReadonlyArray<T>;
  readonly label: string;
  readonly disabled?: boolean;
  readonly renderLabel: (value: T) => string;
  readonly onChange: (value: T) => void;
}) {
  return (
    <Select value={value} disabled={disabled} onValueChange={(next) => next && onChange(next as T)}>
      <SelectTrigger size="compact" aria-label={label}>
        <SelectValue>{renderLabel(value)}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="start" alignItemWithTrigger={false}>
        {values.map((option) => (
          <SelectItem key={option} value={option}>
            {renderLabel(option)}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function actionIcon(action: CompositionAutomationAction): ReactNode {
  if (action === "pause") return <PauseIcon />;
  if (action === "resume") return <PlayIcon />;
  if (action === "run_once") return <AlarmClockIcon />;
  return <Trash2Icon />;
}

function AutomationRunHistory({
  runs,
  pendingAction,
  onRetry,
}: {
  readonly runs: ReadonlyArray<CompositionAutomationRun>;
  readonly pendingAction: string | null;
  readonly onRetry: (run: CompositionAutomationRun) => void;
}) {
  if (runs.length === 0) {
    return (
      <p className="px-3 py-6 text-sm text-muted-foreground">{t("automationCenter.noRuns")}</p>
    );
  }

  return (
    <div className="divide-y divide-border/60 border-y border-border/60">
      {runs.map((run) => (
        <div key={run.automationRunId} className="space-y-2 px-3 py-3 sm:px-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant={runStatusVariant(run.status)} size="sm">
                  {t(`automationCenter.runStatus.${run.status}`)}
                </Badge>
                <Badge variant="outline" size="sm">
                  {t(`automationCenter.trigger.${run.trigger}`)}
                </Badge>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {run.automationRunId}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("automationCenter.runSchedule", {
                  time: formatTime(run.scheduledForUnixMs),
                  attempt: run.attempt,
                })}
              </p>
            </div>
            {run.status === "failed" ? (
              <Button
                size="xs"
                variant="outline"
                disabled={pendingAction !== null}
                onClick={() => onRetry(run)}
              >
                <RotateCcwIcon />
                {t("automationCenter.action.retry")}
              </Button>
            ) : null}
          </div>
          {run.outputSummary ? (
            <p className="text-[13px] leading-relaxed text-foreground">{run.outputSummary}</p>
          ) : null}
          {run.errorCode ? (
            <div className="rounded-md bg-destructive/6 px-2.5 py-2 text-xs text-destructive-foreground">
              <span className="font-mono font-medium">{run.errorCode}</span>
              {run.errorDetail ? <span className="ml-2">{run.errorDetail}</span> : null}
            </div>
          ) : null}
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
            <span>
              {t("automationCenter.startedAt", { time: formatTime(run.startedAtUnixMs) })}
            </span>
            <span>
              {t("automationCenter.finishedAt", { time: formatTime(run.finishedAtUnixMs) })}
            </span>
            {run.compositionTaskId ? <span>{run.compositionTaskId}</span> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

export function CompositionAutomationPanel() {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const allProjects = useProjects();
  const projects = useMemo(
    () =>
      environmentId === null
        ? []
        : allProjects.filter((project) => project.environmentId === environmentId),
    [allProjects, environmentId],
  );
  const automationsQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.compositionAutomations({ environmentId, input: {} }),
  );
  const automations = automationsQuery.data?.automations ?? EMPTY_AUTOMATIONS;
  const firstProject = projects[0] ?? null;
  const makeCreateDraft = (): CompositionAutomationDraft => ({
    ...createEmptyCompositionAutomationDraft(),
    projectId: firstProject?.id ?? "",
    workspaceRoot: firstProject?.workspaceRoot ?? "",
  });
  const editor = useCompositionEditorState({
    environmentId,
    isPending: automationsQuery.isPending,
    items: automations,
    getItemId: getAutomationId,
    createDraft: makeCreateDraft,
    draftFromItem: draftFromCompositionAutomation,
  });
  const {
    draft,
    isCreating,
    isLoading: isEditorLoading,
    selectedItem: selectedAutomation,
    selectedItemId: selectedAutomationId,
    setDraft,
  } = editor;
  const [runCursor, setRunCursor] = useState<string | undefined>();
  const runsQuery = useEnvironmentQuery(
    environmentId === null || selectedAutomation === null
      ? null
      : serverEnvironment.compositionAutomationRuns({
          environmentId,
          input: {
            automationId: selectedAutomation.automationId,
            limit: 50,
            ...(runCursor === undefined ? {} : { cursor: runCursor }),
          },
        }),
  );
  const runs = runsQuery.data?.runs ?? EMPTY_RUNS;
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const buildResult = useMemo(
    () =>
      selectedAutomation === null || isCreating
        ? buildCompositionAutomationCreateRequest(draft)
        : buildCompositionAutomationUpdateRequest(draft, selectedAutomation),
    [draft, isCreating, selectedAutomation],
  );
  const isBusy = pendingAction !== null;
  const isCompleted = selectedAutomation?.status === "completed";

  const createAutomation = useAtomCommand(serverEnvironment.createCompositionAutomation, {
    reportFailure: false,
  });
  const updateAutomation = useAtomCommand(serverEnvironment.updateCompositionAutomation, {
    reportFailure: false,
  });
  const pauseAutomation = useAtomCommand(serverEnvironment.pauseCompositionAutomation, {
    reportFailure: false,
  });
  const resumeAutomation = useAtomCommand(serverEnvironment.resumeCompositionAutomation, {
    reportFailure: false,
  });
  const deleteAutomation = useAtomCommand(serverEnvironment.deleteCompositionAutomation, {
    reportFailure: false,
  });
  const runAutomationOnce = useAtomCommand(serverEnvironment.runCompositionAutomationOnce, {
    reportFailure: false,
  });
  const retryAutomationRun = useAtomCommand(serverEnvironment.retryCompositionAutomationRun, {
    reportFailure: false,
  });

  useEffect(() => {
    if (selectedAutomation !== null || firstProject === null || draft.projectId !== "") return;
    setDraft((current) => ({
      ...current,
      projectId: firstProject.id,
      workspaceRoot: current.workspaceRoot || firstProject.workspaceRoot,
    }));
  }, [draft.projectId, firstProject, selectedAutomation]);

  const patchDraft = (patch: Partial<CompositionAutomationDraft>): void => {
    setDraft((current) => ({ ...current, ...patch }));
  };

  const selectAutomation = (automation: CompositionAutomation): void => {
    editor.selectItem(automation);
    setRunCursor(undefined);
    setActionError(null);
  };

  const startCreate = (): void => {
    editor.startCreate();
    setRunCursor(undefined);
    setActionError(null);
  };

  const settle = async <A,>(
    action: string,
    execute: () => Promise<AtomCommandResult<A, unknown>>,
    onSuccess: (value: A) => void,
  ): Promise<void> => {
    setPendingAction(action);
    setActionError(null);
    const result = await execute();
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      setActionError(error instanceof Error ? error.message : t("automationCenter.actionFailed"));
    } else {
      onSuccess(result.value);
    }
    setPendingAction(null);
  };

  const acceptAutomation = (automation: CompositionAutomation): void => {
    editor.selectItem(automation);
    setRunCursor(undefined);
    automationsQuery.refresh();
    runsQuery.refresh();
  };

  const save = async (): Promise<void> => {
    if (environmentId === null || isBusy || isCompleted) return;
    if (isCreating || selectedAutomation === null) {
      const createResult = buildCompositionAutomationCreateRequest(draft);
      if (createResult.request === null) return;
      await settle<CompositionAutomationResult>(
        "save",
        () => createAutomation({ environmentId, input: createResult.request! }),
        (value) => acceptAutomation(value.automation),
      );
      return;
    }
    const updateResult = buildCompositionAutomationUpdateRequest(draft, selectedAutomation);
    if (updateResult.request === null) return;
    await settle<CompositionAutomationResult>(
      "save",
      () => updateAutomation({ environmentId, input: updateResult.request! }),
      (value) => acceptAutomation(value.automation),
    );
  };

  const runLifecycleAction = async (action: CompositionAutomationAction): Promise<void> => {
    if (environmentId === null || selectedAutomation === null || isBusy) return;
    if (action === "delete") {
      await settle<CompositionAutomationDeleteResult>(
        action,
        () =>
          deleteAutomation({
            environmentId,
            input: {
              automationId: selectedAutomation.automationId,
              expectedRevision: selectedAutomation.revision,
            },
          }),
        () => {
          editor.markItemDeleted(selectedAutomation.automationId);
          automationsQuery.refresh();
        },
      );
      return;
    }
    if (action === "run_once") {
      await settle<CompositionAutomationRunResult>(
        action,
        () =>
          runAutomationOnce({
            environmentId,
            input: {
              automationId: selectedAutomation.automationId,
              expectedRevision: selectedAutomation.revision,
              operationId: `automation-run-once-${randomUUID()}`,
            },
          }),
        () => {
          setRunCursor(undefined);
          automationsQuery.refresh();
          runsQuery.refresh();
        },
      );
      return;
    }
    const command = action === "pause" ? pauseAutomation : resumeAutomation;
    await settle<CompositionAutomationResult>(
      action,
      () =>
        command({
          environmentId,
          input: {
            automationId: selectedAutomation.automationId,
            expectedRevision: selectedAutomation.revision,
          },
        }),
      (value) => acceptAutomation(value.automation),
    );
  };

  const retryRun = async (run: CompositionAutomationRun): Promise<void> => {
    if (
      environmentId === null ||
      selectedAutomation === null ||
      isBusy ||
      run.status !== "failed"
    ) {
      return;
    }
    await settle<CompositionAutomationRunResult>(
      `retry:${run.automationRunId}`,
      () =>
        retryAutomationRun({
          environmentId,
          input: {
            automationId: selectedAutomation.automationId,
            automationRunId: run.automationRunId,
            expectedRevision: selectedAutomation.revision,
            operationId: `automation-retry-${randomUUID()}`,
          },
        }),
      () => {
        setRunCursor(undefined);
        automationsQuery.refresh();
        runsQuery.refresh();
      },
    );
  };

  const selectProject = (projectId: string): void => {
    const project = projects.find((candidate) => candidate.id === projectId);
    patchDraft({
      projectId,
      workspaceRoot: project?.workspaceRoot ?? draft.workspaceRoot,
    });
  };

  return (
    <>
      <SettingsSection
        id="composition-automations"
        title={t("automationCenter.title")}
        hideTitle
        headerAction={
          <div className="flex items-center gap-1.5">
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label={t("automationCenter.refresh")}
              disabled={environmentId === null}
              onClick={() => automationsQuery.refresh()}
            >
              <RefreshCwIcon />
            </Button>
            <Button size="sm" variant="outline" disabled={isBusy} onClick={startCreate}>
              <PlusIcon />
              {t("automationCenter.new")}
            </Button>
          </div>
        }
      >
        {environmentId === null ? (
          <p className="px-3 py-6 text-sm text-muted-foreground sm:px-4">
            {t("automationCenter.noEnvironment")}
          </p>
        ) : automationsQuery.isPending || isEditorLoading ? (
          <p className="px-3 py-6 text-sm text-muted-foreground sm:px-4">
            {t("automationCenter.loading")}
          </p>
        ) : automationsQuery.error ? (
          <p className="px-3 py-6 text-sm text-destructive-foreground sm:px-4">
            {t("automationCenter.loadFailed", { message: String(automationsQuery.error) })}
          </p>
        ) : (
          <div className="grid border-y border-border/60 xl:grid-cols-[minmax(14rem,0.32fr)_minmax(0,1fr)]">
            <aside className="border-b border-border/60 xl:border-r xl:border-b-0">
              <div className="max-h-80 overflow-y-auto p-2 xl:max-h-none">
                {automations.length === 0 ? (
                  <p className="px-2 py-5 text-xs text-muted-foreground">
                    {t("automationCenter.empty")}
                  </p>
                ) : (
                  <div className="space-y-1">
                    {automations.map((automation) => (
                      <button
                        key={automation.automationId}
                        type="button"
                        className={cn(
                          "flex w-full min-w-0 items-start justify-between gap-2 rounded-md px-2.5 py-2 text-left hover:bg-muted/60",
                          !isCreating &&
                            automation.automationId === selectedAutomationId &&
                            "bg-muted",
                        )}
                        onClick={() => selectAutomation(automation)}
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium text-foreground">
                            {automation.name}
                          </span>
                          <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">
                            {automation.automationId}
                          </span>
                          <span className="mt-1 block text-[11px] text-muted-foreground">
                            {t("automationCenter.nextRun", {
                              time: formatTime(automation.nextRunAtUnixMs),
                            })}
                          </span>
                        </span>
                        <Badge variant={automationStatusVariant(automation.status)} size="sm">
                          {t(`automationCenter.status.${automation.status}`)}
                        </Badge>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </aside>

            <div
              className="min-w-0 space-y-5 p-3 sm:p-4"
              data-facilities-guide-target="automation-editor"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-foreground">
                    {isCreating
                      ? t("automationCenter.createTitle")
                      : t("automationCenter.editTitle")}
                  </h3>
                  <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
                    {isCompleted
                      ? t("automationCenter.completedReadonly")
                      : t("automationCenter.description")}
                  </p>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-1.5">
                  {selectedAutomation === null
                    ? null
                    : getCompositionAutomationActions(selectedAutomation).map((action) => (
                        <Button
                          key={action}
                          size="xs"
                          variant={action === "delete" ? "destructive-outline" : "outline"}
                          disabled={isBusy}
                          onClick={() => void runLifecycleAction(action)}
                        >
                          {actionIcon(action)}
                          {t(
                            action === "run_once"
                              ? "automationCenter.action.runOnce"
                              : `automationCenter.action.${action}`,
                          )}
                        </Button>
                      ))}
                  <Button
                    size="xs"
                    disabled={buildResult.request === null || isBusy || isCompleted}
                    onClick={() => void save()}
                  >
                    <SaveIcon />
                    {pendingAction === "save"
                      ? t("automationCenter.saving")
                      : t("automationCenter.save")}
                  </Button>
                </div>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <FormField label={t("automationCenter.automationId")}>
                  <Input
                    size="compact"
                    value={draft.automationId}
                    disabled={!isCreating || isBusy}
                    onChange={(event) => patchDraft({ automationId: event.currentTarget.value })}
                  />
                </FormField>
                <FormField label={t("automationCenter.project")}>
                  <Select
                    value={draft.projectId}
                    disabled={!isCreating || projects.length === 0 || isBusy}
                    onValueChange={(value) => value && selectProject(value)}
                  >
                    <SelectTrigger size="compact" aria-label={t("automationCenter.project")}>
                      <SelectValue>
                        {projects.find((project) => project.id === draft.projectId)?.title ??
                          t("automationCenter.noProjects")}
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
                <FormField label={t("automationCenter.name")}>
                  <Input
                    size="compact"
                    value={draft.name}
                    disabled={isBusy || isCompleted}
                    onChange={(event) => patchDraft({ name: event.currentTarget.value })}
                  />
                </FormField>
                <FormField
                  label={t("automationCenter.maxRuns")}
                  description={t("automationCenter.optional")}
                >
                  <Input
                    nativeInput
                    size="compact"
                    type="number"
                    min={1}
                    step={1}
                    value={draft.maxRunsText}
                    disabled={isBusy || isCompleted}
                    onChange={(event) => patchDraft({ maxRunsText: event.currentTarget.value })}
                  />
                </FormField>
                <div className="md:col-span-2">
                  <FormField label={t("automationCenter.prompt")}>
                    <Textarea
                      value={draft.prompt}
                      disabled={isBusy || isCompleted}
                      rows={4}
                      placeholder={t("automationCenter.promptPlaceholder")}
                      onChange={(event) => patchDraft({ prompt: event.currentTarget.value })}
                    />
                  </FormField>
                </div>
              </div>

              <div
                className="space-y-3 border-t border-border/60 pt-4"
                data-facilities-guide-target="automation-trigger"
              >
                <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
                  <Clock3Icon className="size-3.5 text-muted-foreground" />
                  {t("automationCenter.schedule")}
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <FormField label={t("automationCenter.cadence")}>
                    <EnumSelect
                      value={draft.cadenceType}
                      values={["every", "cron"]}
                      label={t("automationCenter.cadence")}
                      disabled={isBusy || isCompleted}
                      renderLabel={(value) => t(`automationCenter.cadence.${value}`)}
                      onChange={(cadenceType) => patchDraft({ cadenceType })}
                    />
                  </FormField>
                  {draft.cadenceType === "every" ? (
                    <FormField label={t("automationCenter.interval")}>
                      <div className="grid grid-cols-[minmax(0,1fr)_9rem] gap-2">
                        <Input
                          nativeInput
                          size="compact"
                          type="number"
                          min={0.001}
                          step="any"
                          value={draft.intervalValueText}
                          disabled={isBusy || isCompleted}
                          onChange={(event) =>
                            patchDraft({ intervalValueText: event.currentTarget.value })
                          }
                        />
                        <EnumSelect
                          value={draft.intervalUnit}
                          values={INTERVAL_UNITS}
                          label={t("automationCenter.intervalUnit")}
                          disabled={isBusy || isCompleted}
                          renderLabel={(value) => t(`automationCenter.intervalUnit.${value}`)}
                          onChange={(intervalUnit) => patchDraft({ intervalUnit })}
                        />
                      </div>
                    </FormField>
                  ) : (
                    <>
                      <FormField label={t("automationCenter.cronExpression")}>
                        <Input
                          size="compact"
                          value={draft.cronExpression}
                          disabled={isBusy || isCompleted}
                          placeholder="0 9 * * 1-5"
                          onChange={(event) =>
                            patchDraft({ cronExpression: event.currentTarget.value })
                          }
                        />
                      </FormField>
                      <FormField label={t("automationCenter.timezone")}>
                        <Input
                          size="compact"
                          value={draft.timezone}
                          disabled={isBusy || isCompleted}
                          placeholder={t("automationCenter.timezonePlaceholder")}
                          onChange={(event) => patchDraft({ timezone: event.currentTarget.value })}
                        />
                      </FormField>
                    </>
                  )}
                  <FormField
                    label={t("automationCenter.expiresAt")}
                    description={t("automationCenter.optional")}
                  >
                    <Input
                      nativeInput
                      size="compact"
                      type="datetime-local"
                      value={draft.expiresAtText}
                      disabled={isBusy || isCompleted}
                      onChange={(event) => patchDraft({ expiresAtText: event.currentTarget.value })}
                    />
                  </FormField>
                  {isCreating ? (
                    <label className="flex items-center gap-2 self-end pb-1 text-xs text-muted-foreground">
                      <Checkbox
                        checked={draft.runOnCreate}
                        disabled={isBusy}
                        onCheckedChange={(checked) => patchDraft({ runOnCreate: checked === true })}
                      />
                      {t("automationCenter.runOnCreate")}
                    </label>
                  ) : null}
                </div>
              </div>

              <div
                className="space-y-3 border-t border-border/60 pt-4"
                data-facilities-guide-target="automation-context"
              >
                <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
                  {draft.targetType === "squad" ? (
                    <UsersIcon className="size-3.5 text-muted-foreground" />
                  ) : (
                    <BotIcon className="size-3.5 text-muted-foreground" />
                  )}
                  {t("automationCenter.target")}
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <FormField label={t("automationCenter.targetType")}>
                    <EnumSelect
                      value={draft.targetType}
                      values={TARGET_TYPES}
                      label={t("automationCenter.targetType")}
                      disabled={isBusy || isCompleted}
                      renderLabel={(value) => t(`automationCenter.targetType.${value}`)}
                      onChange={(targetType) => patchDraft({ targetType })}
                    />
                  </FormField>
                  <FormField label={t("automationCenter.executionMode")}>
                    <EnumSelect
                      value={draft.executionMode}
                      values={EXECUTION_MODES}
                      label={t("automationCenter.executionMode")}
                      disabled={isBusy || isCompleted}
                      renderLabel={(value) => t(`automationCenter.executionMode.${value}`)}
                      onChange={(executionMode) => patchDraft({ executionMode })}
                    />
                  </FormField>

                  {draft.targetType === "squad" ? (
                    <>
                      <FormField label={t("automationCenter.squadId")}>
                        <Input
                          size="compact"
                          value={draft.squadId}
                          disabled={isBusy || isCompleted}
                          onChange={(event) => patchDraft({ squadId: event.currentTarget.value })}
                        />
                      </FormField>
                      <FormField label={t("automationCenter.squadRevision")}>
                        <Input
                          nativeInput
                          size="compact"
                          type="number"
                          min={1}
                          step={1}
                          value={draft.squadRevisionText}
                          disabled={isBusy || isCompleted}
                          onChange={(event) =>
                            patchDraft({ squadRevisionText: event.currentTarget.value })
                          }
                        />
                      </FormField>
                    </>
                  ) : (
                    <>
                      <FormField label={t("automationCenter.agentId")}>
                        <Input
                          size="compact"
                          value={draft.agentId}
                          disabled={isBusy || isCompleted}
                          onChange={(event) => patchDraft({ agentId: event.currentTarget.value })}
                        />
                      </FormField>
                      <FormField
                        label={t("automationCenter.model")}
                        description={t("automationCenter.optional")}
                      >
                        <Input
                          size="compact"
                          value={draft.model}
                          disabled={isBusy || isCompleted}
                          onChange={(event) => patchDraft({ model: event.currentTarget.value })}
                        />
                      </FormField>
                      <div className="md:col-span-2">
                        <FormField
                          label={t("automationCenter.capabilityIds")}
                          description={t("automationCenter.capabilityIdsDescription")}
                        >
                          <Input
                            size="compact"
                            value={draft.capabilityIdsText}
                            disabled={isBusy || isCompleted}
                            placeholder={t("automationCenter.capabilityIdsPlaceholder")}
                            onChange={(event) =>
                              patchDraft({ capabilityIdsText: event.currentTarget.value })
                            }
                          />
                        </FormField>
                      </div>
                    </>
                  )}

                  {draft.targetType === "goal_loop" ? (
                    <>
                      <FormField
                        label={t("automationCenter.reviewerAgentId")}
                        description={t("automationCenter.optional")}
                      >
                        <Input
                          size="compact"
                          value={draft.reviewerAgentId}
                          disabled={isBusy || isCompleted}
                          onChange={(event) =>
                            patchDraft({ reviewerAgentId: event.currentTarget.value })
                          }
                        />
                      </FormField>
                      <FormField label={t("automationCenter.maxAttempts")}>
                        <Input
                          nativeInput
                          size="compact"
                          type="number"
                          min={1}
                          step={1}
                          value={draft.maxAttemptsText}
                          disabled={isBusy || isCompleted}
                          onChange={(event) =>
                            patchDraft({ maxAttemptsText: event.currentTarget.value })
                          }
                        />
                      </FormField>
                      <FormField
                        label={t("automationCenter.maxCostUnits")}
                        description={t("automationCenter.optional")}
                      >
                        <Input
                          nativeInput
                          size="compact"
                          type="number"
                          min={1}
                          step={1}
                          value={draft.maxCostUnitsText}
                          disabled={isBusy || isCompleted}
                          onChange={(event) =>
                            patchDraft({ maxCostUnitsText: event.currentTarget.value })
                          }
                        />
                      </FormField>
                      <FormField
                        label={t("automationCenter.stalePivotRounds")}
                        description={t("automationCenter.optional")}
                      >
                        <Input
                          nativeInput
                          size="compact"
                          type="number"
                          min={1}
                          step={1}
                          value={draft.stalePivotRoundsText}
                          disabled={isBusy || isCompleted}
                          onChange={(event) =>
                            patchDraft({ stalePivotRoundsText: event.currentTarget.value })
                          }
                        />
                      </FormField>
                      <FormField
                        label={t("automationCenter.deadlineMinutes")}
                        description={t("automationCenter.optional")}
                      >
                        <Input
                          nativeInput
                          size="compact"
                          type="number"
                          min={0.001}
                          step="any"
                          value={draft.deadlineMinutesText}
                          disabled={isBusy || isCompleted}
                          onChange={(event) =>
                            patchDraft({ deadlineMinutesText: event.currentTarget.value })
                          }
                        />
                      </FormField>
                    </>
                  ) : null}

                  {draft.executionMode === "existing_thread" ? (
                    <FormField label={t("automationCenter.threadId")}>
                      <Input
                        size="compact"
                        value={draft.threadId}
                        disabled={isBusy || isCompleted}
                        onChange={(event) => patchDraft({ threadId: event.currentTarget.value })}
                      />
                    </FormField>
                  ) : (
                    <>
                      <div className="md:col-span-2">
                        <FormField label={t("automationCenter.workspaceRoot")}>
                          <Input
                            size="compact"
                            value={draft.workspaceRoot}
                            disabled={isBusy || isCompleted}
                            onChange={(event) =>
                              patchDraft({ workspaceRoot: event.currentTarget.value })
                            }
                          />
                        </FormField>
                      </div>
                      <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Checkbox
                          checked={draft.archiveOnFinish}
                          disabled={isBusy || isCompleted}
                          onCheckedChange={(checked) =>
                            patchDraft({ archiveOnFinish: checked === true })
                          }
                        />
                        {t("automationCenter.archiveOnFinish")}
                      </label>
                    </>
                  )}
                </div>
              </div>

              <div className="border-t border-border/60 pt-4">
                {buildResult.issues.length === 0 ? (
                  <p className="text-xs text-success-foreground">
                    {t("automationCenter.validationReady")}
                  </p>
                ) : (
                  <div className="space-y-1.5">
                    <p className="text-xs font-medium text-destructive-foreground">
                      {t("automationCenter.validationTitle")}
                    </p>
                    <ul className="space-y-1 text-xs text-destructive-foreground">
                      {buildResult.issues.map((issue) => (
                        <li key={`${issue.code}:${issue.path}`}>{issueLabel(issue)}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {actionError ? (
                  <p className="mt-3 text-xs text-destructive-foreground">{actionError}</p>
                ) : null}
              </div>
            </div>
          </div>
        )}
      </SettingsSection>

      <SettingsSection
        id="composition-automation-runs"
        data-facilities-guide-target="automation-history"
        title={t("automationCenter.historyTitle")}
        icon={<HistoryIcon className="size-4 text-muted-foreground" />}
        headerAction={
          <div className="flex items-center gap-1.5">
            {runCursor === undefined ? null : (
              <Button size="xs" variant="ghost-muted" onClick={() => setRunCursor(undefined)}>
                {t("automationCenter.latestRuns")}
              </Button>
            )}
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label={t("automationCenter.refreshRuns")}
              disabled={selectedAutomation === null}
              onClick={() => runsQuery.refresh()}
            >
              <RefreshCwIcon />
            </Button>
          </div>
        }
      >
        {selectedAutomation === null ? (
          <p className="px-3 py-6 text-sm text-muted-foreground sm:px-4">
            {t("automationCenter.selectForHistory")}
          </p>
        ) : runsQuery.isPending ? (
          <p className="px-3 py-6 text-sm text-muted-foreground sm:px-4">
            {t("automationCenter.loadingRuns")}
          </p>
        ) : runsQuery.error ? (
          <p className="px-3 py-6 text-sm text-destructive-foreground sm:px-4">
            {t("automationCenter.runsLoadFailed", { message: String(runsQuery.error) })}
          </p>
        ) : (
          <>
            <AutomationRunHistory
              runs={runs}
              pendingAction={pendingAction}
              onRetry={(run) => void retryRun(run)}
            />
            {runsQuery.data?.nextCursor ? (
              <div className="flex justify-end px-3 pt-3 sm:px-4">
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => setRunCursor(runsQuery.data?.nextCursor ?? undefined)}
                >
                  {t("automationCenter.olderRuns")}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </SettingsSection>
    </>
  );
}
