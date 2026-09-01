import type { ThreadGoal, ThreadGoalStatus } from "@codework/contracts";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CircleAlertIcon,
  FlagIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  SaveIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { t } from "~/i18n";
import { cn } from "~/lib/utils";
import { ComposerControl, ComposerControlIcon } from "./ComposerControl";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface ThreadGoalStatusBarProps {
  readonly goal: ThreadGoal | null;
  readonly isPending: boolean;
  readonly errorMessage: string | null;
  readonly initialEditing?: boolean;
  readonly presentation?: "bar" | "menu";
  readonly className?: string;
  readonly onEmptyEditorClose?: () => void;
  readonly onSetGoal: (objective: string) => Promise<boolean>;
  readonly onPause: () => Promise<boolean>;
  readonly onResume: () => Promise<boolean>;
  readonly onClear: () => Promise<boolean>;
}

export function ThreadGoalComposerControl({
  disabled,
  onClick,
}: {
  readonly disabled: boolean;
  readonly onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ComposerControl
            type="button"
            disabled={disabled}
            aria-label={t("threadGoal.set")}
            data-thread-goal-composer-control="true"
            onClick={onClick}
          />
        }
      >
        <ComposerControlIcon icon={FlagIcon} />
        <span className="sr-only sm:not-sr-only">{t("threadGoal.set")}</span>
      </TooltipTrigger>
      <TooltipPopup side="top">{t("threadGoal.set")}</TooltipPopup>
    </Tooltip>
  );
}

const statusVariant: Record<
  ThreadGoalStatus,
  "default" | "info" | "success" | "warning" | "error"
> = {
  active: "success",
  paused: "warning",
  blocked: "error",
  usageLimited: "warning",
  budgetLimited: "warning",
  complete: "info",
};

const statusLabelKey: Record<ThreadGoalStatus, string> = {
  active: "threadGoal.status.active",
  paused: "threadGoal.status.paused",
  blocked: "threadGoal.status.blocked",
  usageLimited: "threadGoal.status.usageLimited",
  budgetLimited: "threadGoal.status.budgetLimited",
  complete: "threadGoal.status.complete",
};

export function formatThreadGoalDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  return `${minutes}m ${String(remainder).padStart(2, "0")}s`;
}

export function ThreadGoalStatusBar({
  goal,
  isPending,
  errorMessage,
  initialEditing = false,
  presentation = "bar",
  className,
  onEmptyEditorClose,
  onSetGoal,
  onPause,
  onResume,
  onClear,
}: ThreadGoalStatusBarProps) {
  const [editing, setEditing] = useState(initialEditing);
  const [objective, setObjective] = useState(goal?.objective ?? "");
  const [isSaving, setIsSaving] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const disabled = isPending || isSaving;

  useEffect(() => {
    if (!editing) {
      setObjective(goal?.objective ?? "");
    }
  }, [editing, goal?.objective]);

  const saveGoal = async () => {
    const nextObjective = objective.trim();
    if (nextObjective.length === 0 || disabled) return;
    setIsSaving(true);
    setLocalError(null);
    try {
      if (await onSetGoal(nextObjective)) {
        setEditing(false);
        if (goal === null) onEmptyEditorClose?.();
      } else {
        setLocalError(t("threadGoal.error.failed"));
      }
    } finally {
      setIsSaving(false);
    }
  };

  const runAction = async (action: () => Promise<boolean>) => {
    if (disabled) return;
    setIsSaving(true);
    setLocalError(null);
    try {
      if (!(await action())) {
        setLocalError(t("threadGoal.error.failed"));
      }
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div
      className={cn(
        presentation === "menu"
          ? "flex min-w-0 flex-wrap items-center gap-2 rounded-xl border border-border/55 bg-background/45 px-2.5 py-2 text-xs"
          : "mb-2 flex min-w-0 flex-wrap items-center gap-2 rounded-[var(--control-radius)] border border-border/70 bg-background/92 px-3 py-2 text-xs shadow-sm backdrop-blur-sm sm:px-3.5",
        className,
      )}
      data-thread-goal-bar="true"
      data-thread-goal-status={goal?.status ?? "empty"}
    >
      <FlagIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      {editing ? (
        <div
          className="flex min-w-0 flex-1 items-center gap-2"
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void saveGoal();
            }
          }}
        >
          <Input
            autoFocus
            size="compact"
            value={objective}
            onChange={(event) => setObjective(event.target.value)}
            placeholder={t("threadGoal.objectivePlaceholder")}
            aria-label={t("threadGoal.objective")}
            disabled={disabled}
          />
          <Button
            type="button"
            size="icon-xs"
            variant="default"
            aria-label={t("threadGoal.save")}
            disabled={disabled || objective.trim().length === 0}
            onClick={() => void saveGoal()}
          >
            <SaveIcon />
          </Button>
          {goal !== null && goal.status !== "complete" ? (
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label={t("threadGoal.cancel")}
              disabled={disabled}
              onClick={() => {
                setEditing(false);
                if (goal === null) onEmptyEditorClose?.();
              }}
            >
              <XIcon />
            </Button>
          ) : null}
        </div>
      ) : (
        <>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 font-medium text-muted-foreground">
                {t("threadGoal.title")}
              </span>
              {goal ? (
                <Badge variant={statusVariant[goal.status]} size="sm">
                  {t(statusLabelKey[goal.status])}
                </Badge>
              ) : null}
            </div>
            {goal ? (
              <Tooltip>
                <TooltipTrigger
                  render={<div className="truncate text-foreground">{goal.objective}</div>}
                />
                <TooltipPopup>{goal.objective}</TooltipPopup>
              </Tooltip>
            ) : (
              <div className="text-muted-foreground">{t("threadGoal.empty")}</div>
            )}
          </div>
          {goal ? (
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {formatThreadGoalDuration(goal.timeUsedSeconds)}
            </span>
          ) : null}
          {goal ? (
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label={t("threadGoal.details")}
              disabled={disabled}
              onClick={() => setDetailsOpen((open) => !open)}
            >
              {detailsOpen ? <ChevronUpIcon /> : <ChevronDownIcon />}
            </Button>
          ) : null}
          {goal?.status === "active" ? (
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label={t("threadGoal.pause")}
              disabled={disabled}
              onClick={() => void runAction(onPause)}
            >
              <PauseIcon />
            </Button>
          ) : null}
          {goal?.status === "paused" ? (
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label={t("threadGoal.resume")}
              disabled={disabled}
              onClick={() => void runAction(onResume)}
            >
              <PlayIcon />
            </Button>
          ) : null}
          {goal !== null && goal.status !== "complete" ? (
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label={t("threadGoal.edit")}
              disabled={disabled}
              onClick={() => {
                setLocalError(null);
                setEditing(true);
              }}
            >
              <PencilIcon />
            </Button>
          ) : goal === null ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-label={t("threadGoal.set")}
              disabled={disabled}
              onClick={() => setEditing(true)}
            >
              <CheckIcon />
              {t("threadGoal.set")}
            </Button>
          ) : null}
          {goal !== null ? (
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label={t("threadGoal.clear")}
              disabled={disabled}
              onClick={() => void runAction(onClear)}
            >
              <XIcon />
            </Button>
          ) : null}
        </>
      )}
      {goal && detailsOpen ? (
        <div className="basis-full border-t border-border/55 pt-2 text-[11px] text-muted-foreground">
          <span>
            {t("threadGoal.duration")}: {formatThreadGoalDuration(goal.timeUsedSeconds)}
          </span>
          <span className="ms-3">
            {t("threadGoal.usage")}: {goal.tokensUsed}
          </span>
          {goal.tokenBudget !== null ? (
            <span className="ms-3">
              {t("threadGoal.budget")}: {goal.tokenBudget}
            </span>
          ) : null}
        </div>
      ) : null}
      {(errorMessage ?? localError) !== null ? (
        <span className={cn("flex shrink-0 items-center gap-1 text-destructive")} role="alert">
          <CircleAlertIcon className="size-3.5" aria-hidden="true" />
          {errorMessage ?? localError}
        </span>
      ) : null}
    </div>
  );
}
