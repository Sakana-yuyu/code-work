import {
  worktreeSetupStageLabel,
  type WorktreeSetupSnapshot,
  type WorktreeSetupStage,
} from "@codework/contracts";
import { worktreeSetupAgentStarted } from "@codework/client-runtime/worktree-setup";
import { formatDuration } from "@codework/shared/orchestrationTiming";
import { useEffect, useState } from "react";
import { ActivityIndicator, AppState, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText as Text } from "../../components/AppText";
import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { useThemeColor } from "../../lib/useThemeColor";
import { t } from "../../i18n";
import { WorktreeSetupSheet } from "./worktree-setup-sheet";

export interface WorktreeSetupCardProps {
  snapshot: WorktreeSetupSnapshot;
  turnStarted: boolean;
  turnStartedAt: string | null;
  working: boolean;
  onCancel: () => void;
  onWorkLocally: (() => void) | null;
}

function elapsed(start: string | null, end: string | null, now: number) {
  const duration = (end ? Date.parse(end) : now) - (start ? Date.parse(start) : NaN);
  return Number.isFinite(duration) ? formatDuration(Math.max(0, duration)) : null;
}

const icons: Record<WorktreeSetupStage["status"], AppSymbolName> = {
  pending: "circle",
  running: "clock",
  done: "checkmark",
  skipped: "minus",
  failed: "xmark",
  warning: "exclamationmark.triangle",
};

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

function stageStatusLabel(status: WorktreeSetupStage["status"]): string {
  switch (status) {
    case "pending":
      return t("worktreeSetup.stageStatus.pending");
    case "running":
      return t("worktreeSetup.stageStatus.running");
    case "done":
      return t("worktreeSetup.stageStatus.done");
    case "skipped":
      return t("worktreeSetup.stageStatus.skipped");
    case "failed":
      return t("worktreeSetup.stageStatus.failed");
    case "warning":
      return t("worktreeSetup.stageStatus.warning");
  }
}

/** Setup stages collapse into the working header once the agent's turn is live. */
export function WorktreeSetupCard(props: WorktreeSetupCardProps) {
  const { snapshot, turnStarted, turnStartedAt, working } = props;
  const handedOff = turnStarted && worktreeSetupAgentStarted(snapshot);
  const running = snapshot.phase === "running";
  const backgroundSetup = handedOff && running;
  const scriptName = snapshot.setupScript?.name ?? t("worktreeSetup.scriptFallback");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const now = useSetupClock(running || working);
  const failed =
    snapshot.phase === "failed" || snapshot.stages.some((stage) => stage.status === "failed");
  const label =
    handedOff && working
      ? t("worktreeSetup.workingFor", { duration: elapsed(turnStartedAt, null, now) ?? "0s" })
      : running
        ? handedOff
          ? t("worktreeSetup.continues")
          : t("worktreeSetup.settingUp")
        : snapshot.phase === "cancelled"
          ? t("worktreeSetup.cancelled")
          : snapshot.phase === "failed"
            ? t("worktreeSetup.failed")
            : failed
              ? t("worktreeSetup.readyScriptFailed")
              : t("worktreeSetup.ready");

  return (
    <View accessibilityLabel={t("worktreeSetup.ariaLabel")} className="py-1">
      <View className="min-h-11 flex-row items-center gap-2 border-b border-border px-1">
        <HeaderLabel
          label={label}
          active={(running || working) && !detailsOpen}
          failed={failed && !working}
        />
        {!handedOff ? (
          <Text
            className="text-2xs text-foreground-secondary"
            style={{ fontVariant: ["tabular-nums"] }}
          >
            {elapsed(snapshot.startedAt, snapshot.endedAt, now)}
          </Text>
        ) : null}
        <SetupDetailsButton
          backgroundSetup={backgroundSetup}
          failed={failed}
          scriptName={scriptName}
          expanded={detailsOpen}
          onPress={() => setDetailsOpen(true)}
        />
      </View>
      {!handedOff ? (
        <View className="pb-2 pt-1">
          {snapshot.stages
            .filter((stage) => stage.id !== "agent")
            .map((stage) => (
              <StageRow
                key={stage.id}
                stage={stage}
                scriptName={snapshot.setupScript?.name ?? null}
                now={now}
                compact
                animate={!detailsOpen}
              />
            ))}
        </View>
      ) : null}
      {detailsOpen ? (
        <SetupDetailsSheet {...props} now={now} onClose={() => setDetailsOpen(false)} />
      ) : null}
    </View>
  );
}

export function WorktreeWorkingHeader({ startedAt }: { startedAt: string }) {
  const now = useSetupClock(true);
  return (
    <View className="py-1">
      <View className="min-h-11 flex-row items-center border-b border-border px-1">
        <HeaderLabel
          label={t("worktreeSetup.workingFor", {
            duration: elapsed(startedAt, null, now) ?? "0s",
          })}
          active
        />
      </View>
    </View>
  );
}

function WorkingDots() {
  return (
    <View className="flex-row items-center gap-1">
      <View className="h-1 w-1 rounded-full bg-neutral-400 dark:bg-neutral-500" />
      <View className="h-1 w-1 rounded-full bg-neutral-400/80 dark:bg-neutral-500/80" />
      <View className="h-1 w-1 rounded-full bg-neutral-400/60 dark:bg-neutral-500/60" />
    </View>
  );
}

function HeaderLabel({
  label,
  active,
  failed = false,
}: {
  label: string;
  active: boolean;
  failed?: boolean;
}) {
  if (active) {
    return (
      <View className="flex-1 flex-row items-center gap-2">
        <WorkingDots />
        <Text
          numberOfLines={1}
          className="flex-1 font-codework-medium text-sm text-foreground-secondary"
          style={{ fontVariant: ["tabular-nums"] }}
        >
          {label}
        </Text>
      </View>
    );
  }
  return (
    <Text
      numberOfLines={1}
      className={
        failed
          ? "flex-1 text-sm text-danger-foreground"
          : "flex-1 text-sm text-foreground-secondary"
      }
      style={{ fontVariant: ["tabular-nums"] }}
    >
      {label}
    </Text>
  );
}

function SetupDetailsButton({
  backgroundSetup,
  failed,
  scriptName,
  expanded,
  onPress,
}: {
  backgroundSetup: boolean;
  failed: boolean;
  scriptName: string;
  expanded: boolean;
  onPress: () => void;
}) {
  const iconMuted = useThemeColor("--color-icon-muted");
  const danger = useThemeColor("--color-danger-foreground");
  const chevron = useThemeColor("--color-icon-muted");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        backgroundSetup
          ? t("worktreeSetup.chipAriaLabel", { name: scriptName })
          : t("worktreeSetup.detailsAria")
      }
      accessibilityState={{ expanded }}
      onPress={onPress}
      className="min-h-11 max-w-[55%] justify-center px-2"
    >
      <View
        className={
          backgroundSetup
            ? "min-w-0 flex-row items-center gap-1 rounded-full border border-border px-2 py-1"
            : "flex-row items-center gap-1"
        }
      >
        {backgroundSetup ? (
          <ActivityIndicator
            size="small"
            color={iconMuted}
            style={{ width: 12, height: 12, transform: [{ scale: 0.65 }] }}
          />
        ) : failed ? (
          <SymbolView name="exclamationmark.circle" size={12} tintColor={danger} />
        ) : null}
        <Text numberOfLines={1} className="shrink text-2xs text-foreground-secondary">
          {backgroundSetup ? scriptName : t("worktreeSetup.details")}
        </Text>
        {!backgroundSetup ? (
          <SymbolView name="chevron.right" size={10} tintColor={chevron} />
        ) : null}
      </View>
    </Pressable>
  );
}

function useSetupClock(active: boolean) {
  const [now, setNow] = useState(Date.now);
  const [appState, setAppState] = useState(AppState.currentState);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", setAppState);
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    if (!active || appState !== "active") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, appState]);
  return now;
}

function SetupDetailsSheet({
  snapshot,
  turnStarted,
  onCancel,
  onWorkLocally,
  onClose,
  now,
}: WorktreeSetupCardProps & { onClose: () => void; now: number }) {
  const insets = useSafeAreaInsets();
  const [bodyHeight, setBodyHeight] = useState(0);
  const canCancel = snapshot.phase === "running" && !turnStarted;
  return (
    <WorktreeSetupSheet height={bodyHeight} onClose={onClose}>
      <ScrollView
        bounces={false}
        onContentSizeChange={(_width, height) => setBodyHeight(height)}
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingTop: 12,
          paddingBottom: Math.max(20, insets.bottom),
        }}
      >
        {/* Agent startup is the header handoff, not a fifth setup step. */}
        {snapshot.stages
          .filter((stage) => stage.id !== "agent")
          .map((stage) => (
            <View key={stage.id}>
              <StageRow stage={stage} scriptName={snapshot.setupScript?.name ?? null} now={now} />
              {stage.id === "setup-script" &&
              (stage.status === "running" || stage.status === "failed" || stage.tail.length > 0) ? (
                <OutputTail lines={stage.tail} failed={stage.status === "failed"} />
              ) : null}
            </View>
          ))}
        {snapshot.phase === "failed" && snapshot.error ? (
          <Text selectable className="ml-8 mt-2 text-xs text-danger-foreground">
            {snapshot.error}
          </Text>
        ) : null}
        {canCancel ? (
          <View className="mt-3 flex-row items-center justify-end gap-4 border-t border-border pt-1">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("worktreeSetup.cancel")}
              onPress={() => {
                onClose();
                onCancel();
              }}
              className="min-h-11 justify-center px-2"
            >
              <Text className="text-sm text-danger-foreground">
                {t("worktreeSetup.cancelSetup")}
              </Text>
            </Pressable>
            {onWorkLocally ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  onClose();
                  onWorkLocally();
                }}
                className="min-h-11 justify-center px-2"
              >
                <Text className="text-sm text-foreground">{t("worktreeSetup.workLocally")}</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
      </ScrollView>
    </WorktreeSetupSheet>
  );
}

function StageRow({
  stage,
  scriptName,
  now,
  compact = false,
  animate = true,
}: {
  stage: WorktreeSetupStage;
  scriptName: string | null;
  now: number;
  compact?: boolean;
  animate?: boolean;
}) {
  const iconMuted = useThemeColor("--color-icon-muted");
  const danger = useThemeColor("--color-danger-foreground");
  const warning = useThemeColor("--color-warning-foreground");
  const label =
    stage.id === "setup-script" ? (scriptName ?? stageLabel(stage.id)) : stageLabel(stage.id);
  const detail =
    stage.status === "pending"
      ? null
      : stage.status === "skipped"
        ? (stage.detail ?? t("worktreeSetup.skipped"))
        : stage.id === "checkout" && stage.status === "running" && stage.percent !== null
          ? `${stage.percent}%`
          : stage.detail;
  const tint =
    stage.status === "failed" ? danger : stage.status === "warning" ? warning : iconMuted;
  return (
    <View
      accessibilityLabel={`${label}, ${stageStatusLabel(stage.status)}`}
      className={compact ? "min-h-8 flex-row items-center" : "min-h-11 flex-row items-center"}
      style={{ columnGap: 8, opacity: stage.status === "pending" ? 0.4 : 1 }}
    >
      <View className="w-6 items-center">
        {stage.status === "running" && animate ? (
          <ActivityIndicator
            size="small"
            color={iconMuted}
            style={{ transform: [{ scale: 0.75 }] }}
          />
        ) : (
          <SymbolView name={icons[stage.status]} size={14} tintColor={tint} />
        )}
      </View>
      <Text
        numberOfLines={1}
        className={
          stage.status === "failed"
            ? "flex-1 text-sm text-danger-foreground"
            : stage.status === "running" && animate
              ? "flex-1 font-codework-medium text-sm text-foreground-secondary"
              : "flex-1 text-sm text-foreground-secondary"
        }
      >
        {label}
      </Text>
      {detail ? (
        <Text numberOfLines={1} className="max-w-[25%] shrink text-2xs text-foreground-secondary">
          {detail}
        </Text>
      ) : null}
      {stage.status !== "pending" && stage.status !== "skipped" ? (
        <Text
          className="text-2xs text-foreground-secondary"
          style={{ fontVariant: ["tabular-nums"] }}
        >
          {elapsed(stage.startedAt, stage.endedAt, now)}
        </Text>
      ) : null}
    </View>
  );
}

const OUTPUT_TAIL_SLOTS = [0, 1, 2, 3] as const;

/** Fixed four-line output window, shown only in Details. */
function OutputTail({ lines, failed }: { lines: ReadonlyArray<string>; failed: boolean }) {
  return (
    <View
      accessibilityLabel={t("worktreeSetup.outputLabel")}
      className={
        failed
          ? "mb-2 ml-8 rounded-md border border-danger-border bg-danger px-3 py-2"
          : "mb-2 ml-8 rounded-md border border-border bg-card-alt px-3 py-2"
      }
    >
      {OUTPUT_TAIL_SLOTS.map((slot) => (
        <Text
          key={slot}
          selectable
          numberOfLines={1}
          className={
            failed
              ? "font-mono text-2xs leading-5 text-danger-foreground"
              : "font-mono text-2xs leading-5 text-foreground-secondary"
          }
        >
          {lines[lines.length - OUTPUT_TAIL_SLOTS.length + slot] || " "}
        </Text>
      ))}
    </View>
  );
}
