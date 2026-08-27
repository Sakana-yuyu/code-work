import type {
  CompositionControlCenterRedispatchRequest,
  CompositionControlCenterResult,
} from "@codework/contracts";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@codework/client-runtime/state/runtime";
import { RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import { randomUUID } from "~/lib/utils";
import { usePrimaryEnvironment } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { t } from "~/i18n";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsSection } from "./settingsLayout";

const GOAL_LOOP_STATE_LABEL_KEYS: Readonly<Record<string, string>> = {
  not_started: "controlCenter.state.notStarted",
  running: "controlCenter.state.running",
  converged: "controlCenter.state.converged",
  supervisor_settled: "controlCenter.state.supervisorSettled",
  interrupted: "controlCenter.state.interrupted",
};

const goalLoopStateLabel = (state: string): string => {
  const key = GOAL_LOOP_STATE_LABEL_KEYS[state];
  return key === undefined ? state : t(key);
};

const REDISPATCHABLE_GOAL_LOOP_STATES: ReadonlySet<string> = new Set([
  "interrupted",
  "supervisor_settled",
]);

/** 与服务端投影的活跃 Run 状态集一致：仅这些 Run 提供取消入口。 */
const CANCELLABLE_RUN_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "dispatched",
  "resuming",
  "running",
  "waiting_approval",
  "waiting_input",
  "in_review",
]);

/** 控制中心"自动重派"请求输入：capabilityIds 按逗号拆分并去除空白项。 */
export const buildRedispatchInput = (input: {
  readonly taskId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly newRunId: string;
  readonly capabilityIdsText: string;
}): CompositionControlCenterRedispatchRequest => ({
  taskId: input.taskId,
  runId: input.runId,
  agentId: input.agentId,
  newRunId: input.newRunId,
  capabilityIds: input.capabilityIdsText
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
});

export function CompositionControlCenterPanel() {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const projectionQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.controlCenterProjection({ environmentId, input: {} }),
  );
  const redispatchTask = useAtomCommand(serverEnvironment.controlCenterRedispatch, {
    reportFailure: false,
  });
  const cancelCompositionTask = useAtomCommand(serverEnvironment.cancelCompositionTask, {
    reportFailure: false,
  });
  const [capabilityIdsText, setCapabilityIdsText] = useState("");
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const projection: CompositionControlCenterResult | null = projectionQuery.data ?? null;

  const runRowCommand = async (
    taskId: string,
    fallbackErrorKey: string,
    execute: (
      environmentId: NonNullable<typeof environmentId>,
    ) => Promise<AtomCommandResult<unknown, unknown>>,
  ): Promise<void> => {
    if (environmentId === null) return;
    setPendingTaskId(taskId);
    setActionError(null);
    const result = await execute(environmentId);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      setActionError(error instanceof Error ? error.message : t(fallbackErrorKey));
    } else {
      projectionQuery.refresh();
    }
    setPendingTaskId(null);
  };

  const redispatch = (input: {
    readonly taskId: string;
    readonly runId: string;
    readonly agentId: string;
  }): Promise<void> =>
    runRowCommand(input.taskId, "controlCenter.redispatchFailed", (envId) =>
      redispatchTask({
        environmentId: envId,
        input: buildRedispatchInput({
          taskId: input.taskId,
          runId: input.runId,
          agentId: input.agentId,
          newRunId: `t3-redispatch-${randomUUID()}`,
          capabilityIdsText,
        }),
      }),
    );

  const cancel = (input: { readonly taskId: string; readonly runId: string }): Promise<void> =>
    runRowCommand(input.taskId, "controlCenter.cancelFailed", (envId) =>
      cancelCompositionTask({
        environmentId: envId,
        input: {
          taskId: input.taskId,
          runId: input.runId,
          reason: t("controlCenter.cancelReasonDefault"),
        },
      }),
    );

  return (
    <SettingsSection
      id="composition-control-center"
      title={t("controlCenter.title")}
      description={t("controlCenter.subtitle")}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-foreground">{t("controlCenter.tasks")}</h3>
        <Button
          variant="outline"
          size="sm"
          onClick={() => projectionQuery.refresh()}
          aria-label={t("controlCenter.refresh")}
        >
          <RefreshCwIcon className="size-3.5" />
          {t("controlCenter.refresh")}
        </Button>
      </div>
      {environmentId === null ? (
        <p className="text-xs text-muted-foreground">{t("controlCenter.noEnvironment")}</p>
      ) : projectionQuery.isPending ? (
        <p className="text-xs text-muted-foreground">{t("controlCenter.pending")}</p>
      ) : projectionQuery.error !== null ? (
        <p className="text-xs text-destructive">{t("controlCenter.error")}</p>
      ) : projection === null || projection.tasks.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("controlCenter.noTasks")}</p>
      ) : (
        <>
          {projection.tasks.some(
            (task) =>
              task.latestRun !== undefined &&
              task.goalLoop !== undefined &&
              REDISPATCHABLE_GOAL_LOOP_STATES.has(task.goalLoop.state),
          ) ? (
            <div className="space-y-1">
              <label
                className="block text-[11px] text-muted-foreground"
                htmlFor="composition-control-center-capability-ids"
              >
                {t("controlCenter.capabilityIds")}
              </label>
              <Input
                id="composition-control-center-capability-ids"
                value={capabilityIdsText}
                onChange={(event) => setCapabilityIdsText(event.target.value)}
                placeholder={t("controlCenter.capabilityIdsPlaceholder")}
                className="h-7 text-xs"
              />
            </div>
          ) : null}
          <ul className="space-y-2">
            {projection.tasks.map((task) => {
              const redispatchable =
                task.latestRun !== undefined &&
                task.goalLoop !== undefined &&
                REDISPATCHABLE_GOAL_LOOP_STATES.has(task.goalLoop.state);
              const cancellable =
                task.latestRun !== undefined && CANCELLABLE_RUN_STATUSES.has(task.latestRun.status);
              return (
                <li
                  key={task.taskId}
                  className="rounded-md border border-border/60 px-3 py-2 text-xs"
                  data-task-id={task.taskId}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {task.taskId}
                    </span>
                    <Badge variant="outline">{task.status}</Badge>
                    {task.goalLoop === undefined ? null : (
                      <Badge variant="secondary">
                        {`${t("controlCenter.goalLoop")}: ${goalLoopStateLabel(task.goalLoop.state)}`}
                      </Badge>
                    )}
                    {redispatchable ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={pendingTaskId !== null}
                        data-testid={`control-center-redispatch-${task.taskId}`}
                        onClick={() => {
                          void redispatch({
                            taskId: task.taskId,
                            runId: task.latestRun?.runId ?? "",
                            agentId: task.agentId,
                          });
                        }}
                      >
                        {t("controlCenter.redispatch")}
                      </Button>
                    ) : null}
                    {cancellable ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={pendingTaskId !== null}
                        data-testid={`control-center-cancel-${task.taskId}`}
                        onClick={() => {
                          void cancel({
                            taskId: task.taskId,
                            runId: task.latestRun?.runId ?? "",
                          });
                        }}
                      >
                        {t("controlCenter.cancel")}
                      </Button>
                    ) : null}
                  </div>
                  {task.goalLoop === undefined ? null : (
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {`${t("controlCenter.rounds")}: ${task.goalLoop.completedRounds}`}
                      {task.goalLoop.rejectedCompletions > 0
                        ? ` · ${t("controlCenter.rejected")}: ${task.goalLoop.rejectedCompletions}`
                        : ""}
                    </p>
                  )}
                  {task.grants === undefined ? null : (
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {`${t("controlCenter.grants")}: ${task.grants.totalEvents}`}
                      {task.grants.revokedEvents > 0
                        ? ` · ${t("controlCenter.revoked")}: ${task.grants.revokedEvents}`
                        : ""}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
          {actionError === null ? null : (
            <p className="text-xs text-destructive" data-testid="control-center-action-error">
              {actionError}
            </p>
          )}
        </>
      )}
      {projection === null || projection.squads.length === 0 ? null : (
        <div className="space-y-1">
          <h3 className="text-sm font-medium text-foreground">{t("controlCenter.squads")}</h3>
          <ul className="space-y-1">
            {projection.squads.map((squad) => (
              <li
                key={squad.squadId}
                className="text-xs text-muted-foreground"
                data-squad-id={squad.squadId}
              >
                <span className="text-foreground">{squad.name}</span>
                {` · ${t("controlCenter.leader")}: ${squad.leaderAgentId}`}
                {` · ${t("controlCenter.members")}: ${squad.memberAgentIds.length}`}
              </li>
            ))}
          </ul>
        </div>
      )}
    </SettingsSection>
  );
}
