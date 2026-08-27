import type { CompositionControlCenterResult } from "@codework/contracts";
import { RefreshCwIcon } from "lucide-react";

import { usePrimaryEnvironment } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { t } from "~/i18n";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
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

export function CompositionControlCenterPanel() {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const projectionQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.controlCenterProjection({ environmentId, input: {} }),
  );

  const projection: CompositionControlCenterResult | null = projectionQuery.data ?? null;

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
        <ul className="space-y-2">
          {projection.tasks.map((task) => (
            <li
              key={task.taskId}
              className="rounded-md border border-border/60 px-3 py-2 text-xs"
              data-task-id={task.taskId}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[11px] text-muted-foreground">{task.taskId}</span>
                <Badge variant="outline">{task.status}</Badge>
                {task.goalLoop === undefined ? null : (
                  <Badge variant="secondary">
                    {`${t("controlCenter.goalLoop")}: ${goalLoopStateLabel(task.goalLoop.state)}`}
                  </Badge>
                )}
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
          ))}
        </ul>
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
