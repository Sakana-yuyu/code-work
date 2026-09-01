import type { ThreadGoal, ThreadGoalStatus } from "@codework/contracts";
import {
  CheckIcon,
  CircleAlertIcon,
  GoalIcon,
  Maximize2Icon,
  PauseIcon,
  PlayIcon,
  SaveIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { t } from "~/i18n";
import { cn } from "~/lib/utils";
import { ComposerControl, ComposerControlIcon } from "./ComposerControl";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface ThreadGoalStatusBarProps {
  readonly goal: ThreadGoal | null;
  readonly draftObjective?: string | null | undefined;
  readonly isPending: boolean;
  readonly errorMessage: string | null;
  readonly initialEditing?: boolean;
  readonly presentation?: "bar" | "menu" | "top-drawer";
  readonly className?: string;
  readonly onEmptyEditorClose?: () => void;
  /** 将编辑交给外层主题框，避免在目标状态栏内再创建输入框。 */
  readonly onEditInComposer?: () => void;
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
        <ComposerControlIcon icon={GoalIcon} />
        <span className="sr-only sm:not-sr-only">{t("threadGoal.set")}</span>
      </TooltipTrigger>
      <TooltipPopup side="top">{t("threadGoal.set")}</TooltipPopup>
    </Tooltip>
  );
}

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

export function displayedThreadGoalSeconds(
  goal: Pick<ThreadGoal, "status" | "timeUsedSeconds">,
  now: number,
  snapshotAt: number,
): number {
  return (
    goal.timeUsedSeconds +
    (goal.status === "active" ? Math.floor(Math.max(0, now - snapshotAt) / 1_000) : 0)
  );
}

export function ThreadGoalStatusBar({
  goal,
  draftObjective = null,
  isPending,
  errorMessage,
  initialEditing = false,
  presentation = "bar",
  className,
  onEmptyEditorClose,
  onEditInComposer,
  onSetGoal,
  onPause,
  onResume,
  onClear,
}: ThreadGoalStatusBarProps) {
  const [editing, setEditing] = useState(initialEditing);
  const normalizedDraftObjective = draftObjective?.trim() || null;
  const hasDraftObjective = goal === null && normalizedDraftObjective !== null;
  const [objective, setObjective] = useState(goal?.objective ?? normalizedDraftObjective ?? "");
  const [isSaving, setIsSaving] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const goalSnapshotKey = goal
    ? `${goal.goalId}:${goal.status}:${goal.updatedAt}:${goal.timeUsedSeconds}`
    : "empty";
  const goalSnapshotAnchorRef = useRef<{ key: string; receivedAt: number }>({
    key: goalSnapshotKey,
    receivedAt: Date.now(),
  });
  if (goalSnapshotAnchorRef.current.key !== goalSnapshotKey) {
    goalSnapshotAnchorRef.current = { key: goalSnapshotKey, receivedAt: Date.now() };
  }
  const disabled = isPending || isSaving;

  useEffect(() => {
    if (goal?.status !== "active") return;
    const tick = () => setClockNow(Date.now());
    tick();
    const interval = window.setInterval(tick, 1_000);
    return () => window.clearInterval(interval);
  }, [goal?.status, goalSnapshotKey]);

  const displayedTimeUsedSeconds = goal
    ? displayedThreadGoalSeconds(goal, clockNow, goalSnapshotAnchorRef.current.receivedAt)
    : 0;
  const canEditObjective = goal === null || goal.status !== "complete";

  const beginEditing = () => {
    if (onEditInComposer) {
      onEditInComposer();
      return;
    }
    setLocalError(null);
    setEditing(true);
  };

  useEffect(() => {
    if (!editing) {
      setObjective(goal?.objective ?? normalizedDraftObjective ?? "");
    }
  }, [editing, goal?.objective, normalizedDraftObjective]);

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
          ? cn(
              "flex min-w-0 items-center gap-1.5 rounded-xl border border-border/55 bg-background/45 px-2 py-1.5 text-xs",
              detailsOpen ? "flex-wrap" : "flex-nowrap",
            )
          : presentation === "top-drawer"
            ? cn(
                "flex min-w-0 items-center gap-1.5 rounded-none border-0 bg-transparent px-3 py-1.5 text-xs shadow-none backdrop-blur-none",
                detailsOpen ? "flex-wrap" : "flex-nowrap",
              )
            : cn(
                "relative flex min-h-10 min-w-0 items-center gap-1.5 overflow-hidden rounded-[16px] border border-border/65 bg-background/95 px-2.5 py-1.5 text-xs shadow-sm backdrop-blur-sm",
                detailsOpen ? "flex-wrap" : "flex-nowrap",
              ),
        className,
      )}
      data-thread-goal-bar="true"
      data-thread-goal-status={goal?.status ?? "empty"}
    >
      <GoalIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
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
          <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
            <span className="shrink-0 font-medium text-foreground">
              {goal ? t(statusLabelKey[goal.status]) : t("threadGoal.title")}
            </span>
            {goal || hasDraftObjective ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    canEditObjective ? (
                      <button
                        type="button"
                        className="min-w-0 truncate bg-transparent p-0 text-left text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground"
                        aria-label={t("threadGoal.edit")}
                        onClick={beginEditing}
                      >
                        {goal?.objective ?? normalizedDraftObjective}
                      </button>
                    ) : (
                      <span className="min-w-0 truncate text-muted-foreground">
                        {goal?.objective ?? normalizedDraftObjective}
                      </span>
                    )
                  }
                />
                <TooltipPopup>{goal?.objective ?? normalizedDraftObjective}</TooltipPopup>
              </Tooltip>
            ) : (
              <span className="text-muted-foreground">{t("threadGoal.empty")}</span>
            )}
            {goal ? (
              <>
                <span className="shrink-0 text-muted-foreground/70" aria-hidden="true">
                  •
                </span>
                <span className="shrink-0 tabular-nums text-muted-foreground/80">
                  {formatThreadGoalDuration(displayedTimeUsedSeconds)}
                </span>
              </>
            ) : null}
          </div>
          {goal !== null ? (
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label={t("threadGoal.clear")}
              disabled={disabled}
              onClick={() => void runAction(onClear)}
            >
              <Trash2Icon />
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
          {goal ? (
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label={t("threadGoal.details")}
              disabled={disabled}
              onClick={() => setDetailsOpen((open) => !open)}
            >
              <Maximize2Icon />
            </Button>
          ) : goal === null && !hasDraftObjective ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-label={t("threadGoal.set")}
              disabled={disabled}
              onClick={beginEditing}
            >
              <CheckIcon />
              {t("threadGoal.set")}
            </Button>
          ) : goal === null ? (
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
            {t("threadGoal.duration")}: {formatThreadGoalDuration(displayedTimeUsedSeconds)}
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
