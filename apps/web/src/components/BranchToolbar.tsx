import { scopeProjectRef, scopeThreadRef } from "@codework/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@codework/contracts";
import {
  ChevronDownIcon,
  CloudIcon,
  DatabaseIcon,
  FolderGit2Icon,
  FolderGitIcon,
  FolderIcon,
  GaugeIcon,
  HistoryIcon,
  MonitorIcon,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { useComposerDraftStore, type DraftId } from "../composerDraftStore";
import { useProject, useThread, useThreadShellsForProjectRefs } from "../state/entities";
import { useIsMobile } from "../hooks/useMediaQuery";
import { formatDuration } from "../session-logic";
import { formatContextWindowTokens } from "../lib/contextWindow";
import {
  type EnvMode,
  type EnvironmentOption,
  resolveCurrentWorkspaceLabel,
  resolveEnvModeLabel,
  resolveEffectiveEnvMode,
  resolveLockedWorkspaceLabel,
  resolvePreviousWorktreeLabel,
  resolvePreviousWorktreeSeed,
  shouldShowEnvironmentIndicator,
} from "./BranchToolbar.logic";
import { t } from "~/i18n";
import { BranchToolbarBranchSelector } from "./BranchToolbarBranchSelector";
import { BranchToolbarEnvironmentSelector } from "./BranchToolbarEnvironmentSelector";
import { BranchToolbarEnvModeSelector } from "./BranchToolbarEnvModeSelector";
import { Button } from "./ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "./ui/menu";
import { Separator } from "./ui/separator";

interface BranchToolbarProps {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  showGitControls: boolean;
  draftId?: DraftId;
  onEnvModeChange: (mode: EnvMode) => void;
  effectiveEnvModeOverride?: EnvMode;
  activeThreadBranchOverride?: string | null;
  onActiveThreadBranchOverrideChange?: (branch: string | null) => void;
  startFromOrigin: boolean;
  onStartFromOriginChange: (startFromOrigin: boolean) => void;
  envLocked: boolean;
  onCheckoutPullRequestRequest?: (reference: string) => void;
  onComposerFocusRequest?: () => void;
  availableEnvironments?: readonly EnvironmentOption[];
  onEnvironmentChange?: (environmentId: EnvironmentId) => void;
  conversationStats?: ConversationStats;
}

export interface ConversationStats {
  rounds: number;
  steps: number;
  llmDurationMs: number | null;
  toolDurationMs: number | null;
  cacheHitRate: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
}

interface MobileRunContextSelectorProps {
  envLocked: boolean;
  envModeLocked: boolean;
  environmentId: EnvironmentId;
  availableEnvironments: readonly EnvironmentOption[] | undefined;
  showEnvironmentPicker: boolean;
  showEnvironmentIndicator: boolean;
  onEnvironmentChange: ((environmentId: EnvironmentId) => void) | undefined;
  effectiveEnvMode: EnvMode;
  activeWorktreePath: string | null;
  onEnvModeChange: (mode: EnvMode) => void;
  previousWorktreeLabel: string | null;
  onUsePreviousWorktree: () => void;
}

const MobileRunContextSelector = memo(function MobileRunContextSelector({
  envLocked,
  envModeLocked,
  environmentId,
  availableEnvironments,
  showEnvironmentPicker,
  showEnvironmentIndicator,
  onEnvironmentChange,
  effectiveEnvMode,
  activeWorktreePath,
  onEnvModeChange,
  previousWorktreeLabel,
  onUsePreviousWorktree,
}: MobileRunContextSelectorProps) {
  const activeEnvironment = useMemo(
    () => availableEnvironments?.find((env) => env.environmentId === environmentId) ?? null,
    [availableEnvironments, environmentId],
  );
  const WorkspaceIcon =
    effectiveEnvMode === "worktree"
      ? FolderGit2Icon
      : activeWorktreePath
        ? FolderGitIcon
        : FolderIcon;
  const workspaceLabel = envModeLocked
    ? resolveLockedWorkspaceLabel(activeWorktreePath)
    : effectiveEnvMode === "worktree"
      ? resolveEnvModeLabel("worktree")
      : resolveCurrentWorkspaceLabel(activeWorktreePath);
  const isLocked = envLocked || envModeLocked;
  const EnvironmentIcon = activeEnvironment?.isPrimary ? MonitorIcon : CloudIcon;
  const icon = showEnvironmentIndicator ? (
    // Button's base styles apply `-mx-0.5` to descendant SVGs, which eats 4px
    // out of whatever gap we set. mx-0! cancels that so gap-0.5 reads as 2px.
    <span className="inline-flex shrink-0 items-center gap-0.5">
      <EnvironmentIcon className="size-3 shrink-0 mx-0!" />
      <WorkspaceIcon className="size-3 shrink-0 mx-0!" />
    </span>
  ) : (
    <WorkspaceIcon className="size-3 shrink-0" />
  );
  const triggerContent = (
    <>
      {icon}
      <span className="min-w-0 truncate">
        {showEnvironmentIndicator
          ? (activeEnvironment?.label ?? t("workspace.runOn"))
          : workspaceLabel}
      </span>
    </>
  );

  if (isLocked) {
    return (
      <span className="inline-flex h-7 min-w-0 max-w-[48%] flex-1 items-center justify-start gap-1 rounded-md border border-transparent px-[calc(--spacing(2)-1px)] text-sm font-medium text-muted-foreground/70 sm:h-6 md:hidden">
        {triggerContent}
      </span>
    );
  }

  return (
    <Menu>
      <MenuTrigger
        render={<Button variant="ghost" size="xs" />}
        className="min-w-0 max-w-[48%] flex-1 justify-start text-muted-foreground/70 hover:text-foreground/80 md:hidden"
      >
        {triggerContent}
        <ChevronDownIcon className="size-3 shrink-0 opacity-50" />
      </MenuTrigger>
      <MenuPopup align="start" side="top" className="w-64">
        {showEnvironmentPicker && availableEnvironments && onEnvironmentChange ? (
          <>
            <MenuGroup>
              <MenuGroupLabel>{t("workspace.runOn")}</MenuGroupLabel>
              <MenuRadioGroup
                value={environmentId}
                onValueChange={(value) => onEnvironmentChange(value as EnvironmentId)}
              >
                {availableEnvironments.map((env) => {
                  const Icon = env.isPrimary ? MonitorIcon : CloudIcon;
                  return (
                    <MenuRadioItem
                      key={env.environmentId}
                      disabled={envLocked}
                      value={env.environmentId}
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <Icon className="size-3" />
                        <span className="min-w-0 truncate">{env.label}</span>
                      </span>
                    </MenuRadioItem>
                  );
                })}
              </MenuRadioGroup>
            </MenuGroup>
            <MenuSeparator />
          </>
        ) : null}
        <MenuGroup>
          <MenuGroupLabel>{t("workspace.label")}</MenuGroupLabel>
          <MenuRadioGroup
            value={effectiveEnvMode}
            onValueChange={(value) => {
              if (value === "previous-worktree") {
                onUsePreviousWorktree();
                return;
              }
              onEnvModeChange(value as EnvMode);
            }}
          >
            <MenuRadioItem disabled={envModeLocked} value="local">
              <span className="flex min-w-0 items-center gap-1.5">
                {activeWorktreePath ? (
                  <FolderGitIcon className="size-3" />
                ) : (
                  <FolderIcon className="size-3" />
                )}
                <span className="min-w-0 truncate">
                  {resolveCurrentWorkspaceLabel(activeWorktreePath)}
                </span>
              </span>
            </MenuRadioItem>
            <MenuRadioItem disabled={envModeLocked} value="worktree">
              <span className="flex min-w-0 items-center gap-1.5">
                <FolderGit2Icon className="size-3" />
                <span className="min-w-0 truncate">{resolveEnvModeLabel("worktree")}</span>
              </span>
            </MenuRadioItem>
            {previousWorktreeLabel ? (
              <MenuRadioItem disabled={envModeLocked} value="previous-worktree">
                <span className="flex min-w-0 items-center gap-1.5">
                  <HistoryIcon className="size-3" />
                  <span className="min-w-0 truncate">{previousWorktreeLabel}</span>
                </span>
              </MenuRadioItem>
            ) : null}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
});

/**
 * Collapse the strip's labels to icons only when the text no longer fits.
 *
 * Hidden labels stay measurable because their inner text keeps its natural
 * width while the outer layout box collapses. This lets every pass recompute
 * the expanded width without remembered values that could go stale or latch
 * the strip compact. A small hysteresis keeps the boundary from flapping.
 */
const COMPACT_EXPAND_HYSTERESIS_PX = 16;
const COMPOSER_CONTEXT_MOTION_DURATION_MS = 180;
const COMPOSER_CONTEXT_MOTION_EASING = "cubic-bezier(0.32, 0.72, 0, 1)";
const COMPOSER_CONTEXT_CONTROL_SELECTOR = "[data-composer-context-control]";

function useLabelsOverflow(element: HTMLDivElement | null): boolean {
  const [overflows, setOverflows] = useState(false);
  const pendingControlRectsRef = useRef<Map<HTMLElement, DOMRect> | null>(null);
  const controlAnimationsRef = useRef(new Map<HTMLElement, Animation>());
  // A render-synced mirror instead of useEffectEvent: the compiler memoizes
  // the event callback, which left observers reading the first render's null
  // element forever.
  const stateRef = useRef({ element, overflows });
  stateRef.current = { element, overflows };

  const measure = useCallback(() => {
    const { element: current, overflows: compact } = stateRef.current;
    if (!current) return;
    const available = current.clientWidth;
    if (available === 0) return;
    // flex-1 stretches the groups to fill the strip, so their own boxes always
    // measure "full". Sum the laid-out content instead, skipping hidden form
    // artifacts and other out-of-flow nodes.
    const contentWidth = (parent: Element): number => {
      const gap = Number.parseFloat(getComputedStyle(parent).columnGap) || 0;
      let width = 0;
      let counted = 0;
      for (const child of parent.children) {
        if (!(child instanceof HTMLElement)) continue;
        if (child.offsetWidth <= 1) continue;
        const position = getComputedStyle(child).position;
        if (position === "absolute" || position === "fixed") continue;
        width += child.offsetWidth;
        counted += 1;
      }
      return width + gap * Math.max(0, counted - 1);
    };
    const stripGap = Number.parseFloat(getComputedStyle(current).columnGap) || 0;
    let needed = 0;
    let groups = 0;
    for (const child of current.children) {
      if (!(child instanceof HTMLElement) || child.offsetWidth <= 1) continue;
      needed += contentWidth(child);
      groups += 1;
    }
    needed += stripGap * Math.max(0, groups - 1);
    for (const label of current.querySelectorAll<HTMLElement>("[data-composer-label]")) {
      // The clipping can happen below the marker (SelectValue truncates
      // internally), where the outer span's scrollWidth matches its clipped
      // box. The text's real width is the largest scrollWidth in the subtree.
      let textWidth = label.scrollWidth;
      for (const inner of label.querySelectorAll<HTMLElement>("*")) {
        textWidth = Math.max(textWidth, inner.scrollWidth);
      }
      if (compact) {
        // Compact: the label is squeezed to zero width but keeps reporting
        // the full width it would need when expanded.
        needed += textWidth;
      } else {
        // Expanded: the label is in flow; only the clipped remainder is
        // missing from the content sum.
        needed += Math.max(0, textWidth - label.clientWidth);
      }
    }
    const nextOverflows = compact
      ? needed > available - COMPACT_EXPAND_HYSTERESIS_PX
      : needed > available;
    if (nextOverflows !== compact) {
      pendingControlRectsRef.current = new Map(
        Array.from(current.querySelectorAll<HTMLElement>(COMPOSER_CONTEXT_CONTROL_SELECTOR)).map(
          (control) => [control, control.getBoundingClientRect()],
        ),
      );
    }
    setOverflows(nextOverflows);
  }, []);

  useLayoutEffect(() => {
    const previousRects = pendingControlRectsRef.current;
    if (!previousRects) return;
    pendingControlRectsRef.current = null;

    for (const animation of controlAnimationsRef.current.values()) {
      animation.cancel();
    }
    controlAnimationsRef.current.clear();

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    for (const [control, previousRect] of previousRects) {
      if (!control.isConnected) continue;
      const nextRect = control.getBoundingClientRect();
      const deltaX = previousRect.left - nextRect.left;
      const deltaY = previousRect.top - nextRect.top;
      if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) continue;

      const animation = control.animate(
        [
          { transform: `translate3d(${deltaX}px, ${deltaY}px, 0)` },
          { transform: "translate3d(0, 0, 0)" },
        ],
        {
          duration: COMPOSER_CONTEXT_MOTION_DURATION_MS,
          easing: COMPOSER_CONTEXT_MOTION_EASING,
          fill: "backwards",
        },
      );
      controlAnimationsRef.current.set(control, animation);
      animation.addEventListener(
        "finish",
        () => {
          if (controlAnimationsRef.current.get(control) === animation) {
            controlAnimationsRef.current.delete(control);
          }
        },
        { once: true },
      );
    }
  }, [overflows]);

  useEffect(
    () => () => {
      for (const animation of controlAnimationsRef.current.values()) {
        animation.cancel();
      }
    },
    [],
  );

  // Label widths can change without the strip box moving (font family or
  // size preferences), so re-measure on every render as well as on resize
  // and font loads.
  useEffect(() => {
    measure();
  });

  useEffect(() => {
    if (!element) return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    document.fonts.addEventListener("loadingdone", measure);
    return () => {
      observer.disconnect();
      document.fonts.removeEventListener("loadingdone", measure);
    };
  }, [element, measure]);

  return overflows;
}

const STATS_PILL_CLASS =
  "inline-flex max-w-full items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] tabular-nums";

function StatsDialogShell({
  icon: Icon,
  title,
  titleValue,
  children,
}: {
  icon: typeof GaugeIcon;
  title: string;
  titleValue?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 p-3 text-left">
      <div className="mb-0.5 flex items-center justify-between gap-4 border-b border-border/50 pb-1.5 text-[11px] font-medium text-foreground">
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <Icon className="size-3.5 shrink-0" />
          <span className="truncate">{title}</span>
        </span>
        {titleValue !== undefined ? (
          <span className="shrink-0 text-muted-foreground tabular-nums">{titleValue}</span>
        ) : null}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[11px]">{children}</dl>
    </div>
  );
}

function StatsDialogRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-muted-foreground/70">{label}</dt>
      <dd className="text-right text-foreground/85 tabular-nums">{value}</dd>
    </>
  );
}

const formatExactTokenCount = (tokens: number) =>
  `${Math.round(tokens).toLocaleString()} ${t("tok")}`;

/** 仪表胶囊：轮次/步数计数；有计时数据时点开「会话统计」。 */
const ConversationTimePill = memo(function ConversationTimePill({
  rounds,
  steps,
  llmDurationMs,
  toolDurationMs,
}: {
  rounds: number;
  steps: number;
  llmDurationMs: number | null;
  toolDurationMs: number | null;
}) {
  // 值为 0 的分段直接省略，不显示「0 步」这种假数字。
  const face = (
    <>
      <span className="shrink-0">
        {rounds} {t("chat.rounds")}
        {steps > 0 ? (
          <>
            {" · "}
            {steps} {t("chat.steps")}
          </>
        ) : null}
      </span>
    </>
  );
  const icon = <GaugeIcon className="size-3 shrink-0" />;
  // 没有任何计时数据时保持纯文本，不伪装成可点开的控件。
  if (llmDurationMs === null && toolDurationMs === null) {
    return (
      <span className={`${STATS_PILL_CLASS} shrink-0 text-muted-foreground/70`}>
        {icon}
        {face}
      </span>
    );
  }
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={`${t("chat.rounds")} ${rounds}, ${t("chat.steps")} ${steps}`}
            className={`${STATS_PILL_CLASS} shrink-0 cursor-pointer text-muted-foreground/70 transition-colors duration-150 hover:bg-accent/30 hover:text-foreground/80`}
          />
        }
      >
        {icon}
        {face}
      </PopoverTrigger>
      <PopoverPopup
        tooltipStyle
        side="top"
        align="center"
        viewportClassName="p-0"
        className="w-52 max-w-[calc(100vw-1rem)] rounded-xl border border-border/70 bg-popover/95 whitespace-normal shadow-xl"
      >
        <StatsDialogShell icon={GaugeIcon} title={t("chat.sessionStats")}>
          {llmDurationMs !== null ? (
            <StatsDialogRow label={t("chat.modelTime")} value={formatDuration(llmDurationMs)} />
          ) : null}
          {toolDurationMs !== null ? (
            <StatsDialogRow label={t("chat.toolDuration")} value={formatDuration(toolDurationMs)} />
          ) : null}
        </StatsDialogShell>
      </PopoverPopup>
    </Popover>
  );
});

/** 用量胶囊：总 token 与缓存命中率；点开「Token 用量」明细。 */
const ConversationUsagePill = memo(function ConversationUsagePill({
  inputTokens,
  outputTokens,
  reasoningOutputTokens,
  cacheHitRate,
}: {
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
  cacheHitRate: number | null;
}) {
  const totalTokens =
    inputTokens === null && outputTokens === null ? null : (inputTokens ?? 0) + (outputTokens ?? 0);
  if (totalTokens === null) return null;
  const totalText = `${formatContextWindowTokens(totalTokens)} ${t("tok")}`;
  const cacheHitPercent =
    cacheHitRate === null ? null : `${cacheHitRate.toFixed(1).replace(/\.0$/, "")}%`;
  const formatTokenValue = (tokens: number | null) =>
    tokens === null ? "—" : formatContextWindowTokens(tokens);
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={
              cacheHitPercent === null
                ? totalText
                : `${totalText} · ${t("chat.cacheHitRate")} ${cacheHitPercent}`
            }
            className={`${STATS_PILL_CLASS} min-w-0 cursor-pointer text-muted-foreground/70 transition-colors duration-150 hover:bg-accent/30 hover:text-foreground/80`}
          />
        }
      >
        <DatabaseIcon className="size-3 shrink-0" />
        <span className="min-w-0 truncate">
          {totalText}
          {cacheHitPercent !== null ? (
            <>
              {" · "}
              {t("chat.cacheHitRate")} {cacheHitPercent}
            </>
          ) : null}
        </span>
      </PopoverTrigger>
      <PopoverPopup
        tooltipStyle
        side="top"
        align="center"
        viewportClassName="p-0"
        className="w-56 max-w-[calc(100vw-1rem)] rounded-xl border border-border/70 bg-popover/95 whitespace-normal shadow-xl"
      >
        <StatsDialogShell icon={DatabaseIcon} title={t("chat.tokenUsage")} titleValue={totalText}>
          {cacheHitPercent !== null ? (
            <StatsDialogRow label={t("chat.cacheHitRate")} value={cacheHitPercent} />
          ) : null}
          <StatsDialogRow
            label={t("chat.inputTokens")}
            value={inputTokens === null ? "—" : formatExactTokenCount(inputTokens)}
          />
          <StatsDialogRow
            label={t("chat.outputTokens")}
            value={outputTokens === null ? "—" : formatExactTokenCount(outputTokens)}
          />
          {reasoningOutputTokens !== null && reasoningOutputTokens > 0 ? (
            <StatsDialogRow
              label={t("chat.reasoningTokens")}
              value={formatExactTokenCount(reasoningOutputTokens)}
            />
          ) : null}
        </StatsDialogShell>
      </PopoverPopup>
    </Popover>
  );
});

/**
 * Composer 下方会话统计，双胶囊形态对齐 deepseek-harness 的 StatsPills：
 * 仪表胶囊（轮/步/计时）+ 用量胶囊（token/缓存命中），无数据的分段
 * 省略，整条无内容时不渲染。
 */
const ConversationStatsStrip = memo(function ConversationStatsStrip({
  stats,
}: {
  stats: ConversationStats;
}) {
  const hasUsage = stats.inputTokens !== null || stats.outputTokens !== null;
  if (stats.rounds === 0 && !hasUsage) return null;
  return (
    <div className="hidden min-w-0 shrink items-center justify-center gap-2 overflow-hidden whitespace-nowrap text-[11px] text-muted-foreground/70 md:flex">
      {stats.rounds > 0 ? (
        <ConversationTimePill
          rounds={stats.rounds}
          steps={stats.steps}
          llmDurationMs={stats.llmDurationMs}
          toolDurationMs={stats.toolDurationMs}
        />
      ) : null}
      {hasUsage ? (
        <ConversationUsagePill
          inputTokens={stats.inputTokens}
          outputTokens={stats.outputTokens}
          reasoningOutputTokens={stats.reasoningOutputTokens}
          cacheHitRate={stats.cacheHitRate}
        />
      ) : null}
    </div>
  );
});

export const BranchToolbar = memo(function BranchToolbar({
  environmentId,
  threadId,
  showGitControls,
  draftId,
  onEnvModeChange,
  effectiveEnvModeOverride,
  activeThreadBranchOverride,
  onActiveThreadBranchOverrideChange,
  startFromOrigin,
  onStartFromOriginChange,
  envLocked,
  onCheckoutPullRequestRequest,
  onComposerFocusRequest,
  availableEnvironments,
  onEnvironmentChange,
  conversationStats,
}: BranchToolbarProps) {
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const draftThread = useComposerDraftStore((store) =>
    draftId ? store.getDraftSession(draftId) : store.getDraftThreadByRef(threadRef),
  );
  const serverThread = useThread(threadRef, { waitForShell: draftThread !== null });
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const activeProjectRef = serverThread
    ? scopeProjectRef(serverThread.environmentId, serverThread.projectId)
    : draftThread
      ? scopeProjectRef(draftThread.environmentId, draftThread.projectId)
      : null;
  const activeProject = useProject(activeProjectRef);
  const hasActiveThread = serverThread !== null || draftThread !== null;
  const activeWorktreePath = serverThread?.worktreePath ?? draftThread?.worktreePath ?? null;
  const effectiveEnvMode =
    effectiveEnvModeOverride ??
    resolveEffectiveEnvMode({
      activeWorktreePath,
      hasServerThread: serverThread !== null,
      draftThreadEnvMode: draftThread?.envMode,
    });
  const envModeLocked = envLocked || (serverThread !== null && activeWorktreePath !== null);

  // "Previous worktree" hops a draft into the most recently active worktree
  // of this project — the "keep going where I just was" follow-up flow. Only
  // drafts can hop; started server threads have their workspace pinned.
  const canUsePreviousWorktree = draftThread !== null && serverThread === null && !envModeLocked;
  const projectRefsForWorktreeLookup = useMemo(
    () => (canUsePreviousWorktree && activeProjectRef ? [activeProjectRef] : []),
    [canUsePreviousWorktree, activeProjectRef],
  );
  const projectThreads = useThreadShellsForProjectRefs(projectRefsForWorktreeLookup);
  const previousWorktreeSeed = useMemo(
    () =>
      canUsePreviousWorktree
        ? resolvePreviousWorktreeSeed({
            threads: projectThreads,
            currentWorktreePath: activeWorktreePath,
          })
        : null,
    [activeWorktreePath, canUsePreviousWorktree, projectThreads],
  );
  const previousWorktreeLabel = previousWorktreeSeed
    ? resolvePreviousWorktreeLabel(previousWorktreeSeed)
    : null;
  const onUsePreviousWorktree = useCallback(() => {
    if (!previousWorktreeSeed || !activeProjectRef) return;
    // Same shape the branch selector writes when picking a branch that
    // already lives in a worktree: point the draft at the existing tree.
    setDraftThreadContext(draftId ?? threadRef, {
      branch: previousWorktreeSeed.branch,
      worktreePath: previousWorktreeSeed.worktreePath,
      envMode: "worktree",
      projectRef: activeProjectRef,
    });
  }, [activeProjectRef, draftId, previousWorktreeSeed, setDraftThreadContext, threadRef]);

  const showEnvironmentPicker = Boolean(
    availableEnvironments && availableEnvironments.length > 1 && onEnvironmentChange,
  );
  const activeEnvironmentOption =
    availableEnvironments?.find((env) => env.environmentId === environmentId) ?? null;
  const showEnvironmentIndicator = shouldShowEnvironmentIndicator({
    activeEnvironment: activeEnvironmentOption,
    canPickEnvironment: showEnvironmentPicker,
  });
  const isMobile = useIsMobile();
  const [stripElement, setStripElement] = useState<HTMLDivElement | null>(null);
  const labelsOverflow = useLabelsOverflow(stripElement);

  if (!hasActiveThread || !activeProject) return null;

  return (
    <div
      ref={setStripElement}
      data-compact={labelsOverflow ? "" : undefined}
      className="chat-composer-context-strip group/composer-context -mt-4 mx-auto flex w-[calc(100%-2.75rem)] max-w-[calc(48rem-2.75rem)] items-center gap-2 overflow-x-clip overflow-y-visible ps-1 pe-2 pt-5 pb-1"
    >
      {isMobile && showGitControls ? (
        <MobileRunContextSelector
          envLocked={envLocked}
          envModeLocked={envModeLocked}
          environmentId={environmentId}
          availableEnvironments={availableEnvironments}
          showEnvironmentPicker={showEnvironmentPicker}
          showEnvironmentIndicator={showEnvironmentIndicator}
          onEnvironmentChange={onEnvironmentChange}
          effectiveEnvMode={effectiveEnvMode}
          activeWorktreePath={activeWorktreePath}
          onEnvModeChange={onEnvModeChange}
          previousWorktreeLabel={previousWorktreeLabel}
          onUsePreviousWorktree={onUsePreviousWorktree}
        />
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-1">
          {showEnvironmentIndicator && availableEnvironments && (
            <>
              <BranchToolbarEnvironmentSelector
                envLocked={envLocked}
                environmentId={environmentId}
                availableEnvironments={availableEnvironments}
                {...(showEnvironmentPicker && onEnvironmentChange ? { onEnvironmentChange } : {})}
              />
              {showGitControls ? (
                <Separator
                  orientation="vertical"
                  className="mx-0.5 h-3.5!"
                  data-composer-context-control
                />
              ) : null}
            </>
          )}
          {showGitControls ? (
            <BranchToolbarEnvModeSelector
              envLocked={envModeLocked}
              effectiveEnvMode={effectiveEnvMode}
              activeWorktreePath={activeWorktreePath}
              onEnvModeChange={onEnvModeChange}
              previousWorktreeLabel={previousWorktreeLabel}
              onUsePreviousWorktree={onUsePreviousWorktree}
            />
          ) : null}
        </div>
      )}

      {showGitControls && conversationStats ? (
        <ConversationStatsStrip stats={conversationStats} />
      ) : null}

      {showGitControls ? (
        <BranchToolbarBranchSelector
          className="min-w-0 flex-1 justify-end md:ml-auto md:flex-none"
          environmentId={environmentId}
          threadId={threadId}
          {...(draftId ? { draftId } : {})}
          envLocked={envLocked}
          {...(effectiveEnvModeOverride ? { effectiveEnvModeOverride } : {})}
          {...(activeThreadBranchOverride !== undefined ? { activeThreadBranchOverride } : {})}
          {...(onActiveThreadBranchOverrideChange ? { onActiveThreadBranchOverrideChange } : {})}
          startFromOrigin={startFromOrigin}
          onStartFromOriginChange={onStartFromOriginChange}
          {...(onCheckoutPullRequestRequest ? { onCheckoutPullRequestRequest } : {})}
          {...(onComposerFocusRequest ? { onComposerFocusRequest } : {})}
        />
      ) : null}
    </div>
  );
});
