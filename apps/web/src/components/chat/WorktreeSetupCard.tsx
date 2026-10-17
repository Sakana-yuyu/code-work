import {
  worktreeSetupStageLabel,
  type WorktreeSetupSnapshot,
  type WorktreeSetupStage,
} from "@codework/contracts";
import { formatDuration } from "@codework/shared/orchestrationTiming";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleIcon,
  LaptopIcon,
  TerminalIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { t } from "~/i18n";
import { cn } from "~/lib/utils";

interface WorktreeSetupCardProps {
  snapshot: WorktreeSetupSnapshot;
  /** Interrupts the server-side bootstrap. Hidden once the setup has settled. */
  onCancel: (() => void) | null;
  /**
   * Abandons the worktree bootstrap and resends the message against the
   * project checkout. Only offered while the setup can still be interrupted.
   */
  onWorkLocally: (() => void) | null;
  /** Reveals the setup script terminal tab. Null when no script ran. */
  onOpenTerminal: (() => void) | null;
  /**
   * The agent's turn is live and owns the "Working" header. The stage list
   * stays exactly where it was so the handoff never moves anything; a failed
   * script that outlives the handoff collapses to a single row.
   */
  embedded?: boolean;
}

function stageElapsedMs(stage: WorktreeSetupStage, nowMs: number): number | null {
  if (!stage.startedAt) return null;
  const start = Date.parse(stage.startedAt);
  const end = stage.endedAt ? Date.parse(stage.endedAt) : nowMs;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

/**
 * Ticks once a second while any stage runs so elapsed labels stay live
 * without pushing a React commit through the timeline for every second.
 */
function useNowWhile(active: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [active]);
  return nowMs;
}

function StageIcon({ status }: { status: WorktreeSetupStage["status"] }) {
  const className = "size-4 shrink-0 stroke-2";
  switch (status) {
    case "done":
      return <CheckIcon aria-hidden className={className} />;
    case "running":
      return <Spinner className="size-4 shrink-0" />;
    case "failed":
      return <XIcon aria-hidden className={className} />;
    case "warning":
      return <CircleAlertIcon aria-hidden className={className} />;
    case "skipped":
      return <CircleIcon aria-hidden className={cn(className, "opacity-50")} />;
    case "pending":
      return <CircleIcon aria-hidden className={className} />;
  }
}

function stageRowClassName(status: WorktreeSetupStage["status"]): string {
  switch (status) {
    case "failed":
      return "text-destructive-foreground";
    case "warning":
      return "text-warning-foreground";
    case "pending":
      return "text-secondary-label opacity-40";
    case "running":
    case "skipped":
    case "done":
      return "text-secondary-label";
  }
}

function headerLabel(snapshot: WorktreeSetupSnapshot): string {
  switch (snapshot.phase) {
    case "running":
      return t("worktreeSetup.settingUp");
    case "done":
      return snapshot.stages.some((stage) => stage.status === "failed")
        ? t("worktreeSetup.readyScriptFailed")
        : t("worktreeSetup.ready");
    case "failed":
      return t("worktreeSetup.failed");
    case "cancelled":
      return t("worktreeSetup.cancelled");
  }
}

/** Header row for a setup that ended without a live turn taking over. */
function SetupHeaderRow({
  snapshot,
  totalElapsed,
}: {
  snapshot: WorktreeSetupSnapshot;
  totalElapsed: number | null;
}) {
  const failed = snapshot.phase === "failed" || snapshot.phase === "cancelled";
  const finishedWithFailedStage =
    snapshot.phase === "done" && snapshot.stages.some((stage) => stage.status === "failed");
  const tone = failed
    ? "text-destructive-foreground"
    : finishedWithFailedStage
      ? "text-warning-foreground"
      : "text-muted-foreground";
  return (
    <div className="border-b border-border/60 pb-2 pt-1">
      <div
        className={cn(
          "flex h-6 min-w-0 items-baseline gap-2 px-1 text-sm leading-relaxed tabular-nums",
          tone,
        )}
      >
        <span className="block min-w-0 shrink truncate">{headerLabel(snapshot)}</span>
        {totalElapsed !== null ? (
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">
            {formatDuration(totalElapsed)}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** One stage, rendered like a live work entry row. */
function StageRow({
  stage,
  nowMs,
  scriptName,
}: {
  stage: WorktreeSetupStage;
  nowMs: number;
  scriptName: string | null;
}) {
  const elapsed = stageElapsedMs(stage, nowMs);
  const label = stage.id === "setup-script" && scriptName ? scriptName : stageLabel(stage.id);
  const trailing =
    stage.status === "pending"
      ? null
      : stage.status === "skipped"
        ? (stage.detail ?? t("worktreeSetup.skipped"))
        : stage.id === "checkout" && stage.status === "running" && stage.percent !== null
          ? `${stage.percent}%`
          : stage.detail;
  return (
    <div
      className="flex h-6 min-w-0 items-center gap-2 px-1 text-sm leading-relaxed"
      data-worktree-setup-stage={stage.id}
      data-worktree-setup-status={stage.status}
    >
      <span className={cn("text-icon-muted", stage.status === "pending" && "opacity-40")}>
        <StageIcon status={stage.status} />
      </span>
      <span className={cn("block min-w-0 shrink truncate", stageRowClassName(stage.status))}>
        {label}
      </span>
      {trailing ? (
        <span className="min-w-0 truncate text-xs text-muted-foreground tabular-nums">
          {trailing}
        </span>
      ) : null}
      {elapsed !== null && stage.status !== "skipped" && stage.status !== "pending" ? (
        <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
          {formatDuration(elapsed)}
        </span>
      ) : null}
    </div>
  );
}

function stageLabel(id: WorktreeSetupStage["id"]): string {
  switch (id) {
    case "fetch":
      return t("worktreeSetup.stage.fetch");
    case "checkout":
      return t("worktreeSetup.stage.checkout");
    case "submodules":
      return t("worktreeSetup.stage.submodules");
    case "setup-script":
      return t("worktreeSetup.stage.setupScript");
    case "agent":
      return t("worktreeSetup.stage.agent");
    default:
      return worktreeSetupStageLabel(id);
  }
}

/** The server keeps this many trailing lines; the box is sized for exactly that. */
const OUTPUT_TAIL_LINES = 4;
const OUTPUT_TAIL_SLOTS = Array.from({ length: OUTPUT_TAIL_LINES }, (_, slot) => slot);

/**
 * Fixed-height window onto the script's last lines. Rows never wrap and the
 * box never grows or shrinks, so streaming output cannot push the timeline
 * around while the script runs.
 */
function OutputTail({ lines, failed }: { lines: ReadonlyArray<string>; failed: boolean }) {
  const rows = OUTPUT_TAIL_SLOTS.map((slot) => ({
    slot,
    line: lines[lines.length - OUTPUT_TAIL_LINES + slot] ?? "",
  }));
  return (
    <pre
      className={cn(
        "mb-1 ml-8 overflow-hidden rounded-md border px-2.5 py-1.5 font-mono text-[11px] leading-relaxed select-text",
        failed
          ? "border-error/20 bg-error-surface text-error-foreground"
          : "border-border bg-muted/40 text-muted-foreground",
      )}
    >
      {rows.map(({ slot, line }) => (
        <div key={slot} className="truncate whitespace-pre">
          {line.length === 0 ? " " : line}
        </div>
      ))}
    </pre>
  );
}

function SetupDetails({ snapshot }: { snapshot: WorktreeSetupSnapshot }) {
  return (
    <dl className="mt-1 mb-1.5 ml-8 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
      {snapshot.branch ? (
        <>
          <dt className="text-foreground/80">{t("worktreeSetup.detail.branch")}</dt>
          <Tooltip>
            <TooltipTrigger render={<dd className="min-w-0 truncate font-mono" />}>
              {snapshot.branch}
            </TooltipTrigger>
            <TooltipPopup side="top">{snapshot.branch}</TooltipPopup>
          </Tooltip>
        </>
      ) : null}
      {snapshot.baseRef ? (
        <>
          <dt className="text-foreground/80">{t("worktreeSetup.detail.base")}</dt>
          <Tooltip>
            <TooltipTrigger render={<dd className="min-w-0 truncate font-mono" />}>
              {snapshot.baseRef}
            </TooltipTrigger>
            <TooltipPopup side="top">{snapshot.baseRef}</TooltipPopup>
          </Tooltip>
        </>
      ) : null}
      {snapshot.worktreePath ? (
        <>
          <dt className="text-foreground/80">{t("worktreeSetup.detail.path")}</dt>
          <Tooltip>
            <TooltipTrigger render={<dd className="min-w-0 truncate font-mono" />}>
              {snapshot.worktreePath}
            </TooltipTrigger>
            <TooltipPopup side="top">{snapshot.worktreePath}</TooltipPopup>
          </Tooltip>
        </>
      ) : null}
      {snapshot.setupScript ? (
        <>
          <dt className="text-foreground/80">{t("worktreeSetup.detail.setup")}</dt>
          <Tooltip>
            <TooltipTrigger render={<dd className="truncate font-mono" />}>
              {snapshot.setupScript.command}
            </TooltipTrigger>
            <TooltipPopup side="top">{snapshot.setupScript.command}</TooltipPopup>
          </Tooltip>
        </>
      ) : null}
    </dl>
  );
}

/**
 * One-line summary of a settled setup under a live turn. A clean finish is
 * removed from the timeline altogether, so this only renders the outcomes
 * worth keeping: a failed script, a failed setup, or a cancelled one.
 */
function CollapsedSummaryRow({
  snapshot,
  totalElapsed,
}: {
  snapshot: WorktreeSetupSnapshot;
  totalElapsed: number | null;
}) {
  const status: WorktreeSetupStage["status"] =
    snapshot.phase === "failed" || snapshot.phase === "cancelled"
      ? "failed"
      : snapshot.stages.some((stage) => stage.id === "setup-script" && stage.status === "failed")
        ? "failed"
        : "done";
  return (
    <div
      className="flex h-6 min-w-0 items-center gap-2 px-1 text-sm leading-relaxed"
      data-worktree-setup-stage="summary"
      data-worktree-setup-status={status}
    >
      <span className="text-icon-muted">
        <StageIcon status={status} />
      </span>
      <span className={cn("block min-w-0 shrink truncate", stageRowClassName(status))}>
        {headerLabel(snapshot)}
      </span>
      {totalElapsed !== null ? (
        <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
          {formatDuration(totalElapsed)}
        </span>
      ) : null}
    </div>
  );
}

export function WorktreeSetupCard({
  snapshot,
  onCancel,
  onWorkLocally,
  onOpenTerminal,
  embedded = false,
}: WorktreeSetupCardProps) {
  const running = snapshot.phase === "running";
  const nowMs = useNowWhile(running);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const totalElapsed = (() => {
    const start = Date.parse(snapshot.startedAt);
    const end = snapshot.endedAt ? Date.parse(snapshot.endedAt) : nowMs;
    return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
  })();
  const setupStage = snapshot.stages.find((stage) => stage.id === "setup-script");
  const showTerminal = onOpenTerminal && setupStage && setupStage.status !== "pending";
  const collapsed = embedded && !running;
  // While running, and after a clean finish until the agent's turn is live,
  // the timeline's working row above the card carries the label (and keeps
  // that slot when the agent takes over). The card only brings its own
  // header for a failed or cancelled setup that has no working row above it.
  const showHeader = !embedded && !running && snapshot.phase !== "done";
  // The tail box is part of the script row's footprint while the script runs
  // (and after it failed, so the last lines explain the failure). It mounts
  // with the first output line at its full fixed height, so the card grows
  // once instead of with each line. A script that ends before printing
  // anything never flashes an empty box.
  const showTail =
    setupStage !== undefined &&
    (setupStage.status === "failed" ||
      (setupStage.status === "running" && setupStage.tail.length > 0));

  return (
    <section aria-label={t("worktreeSetup.ariaLabel")} data-worktree-setup-phase={snapshot.phase}>
      {showHeader ? <SetupHeaderRow snapshot={snapshot} totalElapsed={totalElapsed} /> : null}
      {collapsed ? (
        <CollapsedSummaryRow snapshot={snapshot} totalElapsed={totalElapsed} />
      ) : (
        <div className={showHeader ? "pt-1.5" : undefined}>
          {snapshot.stages.map((stage) => (
            <div key={stage.id}>
              <StageRow
                stage={stage}
                nowMs={nowMs}
                scriptName={snapshot.setupScript?.name ?? null}
              />
              {stage.id === "setup-script" && showTail ? (
                <OutputTail lines={stage.tail} failed={stage.status === "failed"} />
              ) : null}
            </div>
          ))}
        </div>
      )}

      {snapshot.phase === "failed" && snapshot.error ? (
        <p className="mt-1 ml-8 text-xs text-muted-foreground">{snapshot.error}</p>
      ) : null}

      {detailsOpen ? <SetupDetails snapshot={snapshot} /> : null}

      {/* Indented so the first label lines up with the stage labels. */}
      <div className="mt-0.5 ml-8 flex flex-wrap items-center gap-0.5">
        <Button
          type="button"
          size="xs"
          variant="ghost-muted"
          aria-expanded={detailsOpen}
          onClick={() => setDetailsOpen((open) => !open)}
        >
          {detailsOpen ? <ChevronDownIcon aria-hidden /> : <ChevronRightIcon aria-hidden />}
          {t("worktreeSetup.details")}
        </Button>
        {showTerminal ? (
          <Button type="button" size="xs" variant="ghost-muted" onClick={onOpenTerminal}>
            <TerminalIcon aria-hidden />
            {t("worktreeSetup.openTerminal")}
          </Button>
        ) : null}
        {onWorkLocally ? (
          <Button type="button" size="xs" variant="ghost-muted" onClick={onWorkLocally}>
            <LaptopIcon aria-hidden />
            {t("worktreeSetup.workLocally")}
          </Button>
        ) : null}
        {onCancel && running ? (
          <Button type="button" size="xs" variant="ghost-muted" onClick={onCancel}>
            <XIcon aria-hidden />
            {t("worktreeSetup.cancel")}
          </Button>
        ) : null}
      </div>
    </section>
  );
}
