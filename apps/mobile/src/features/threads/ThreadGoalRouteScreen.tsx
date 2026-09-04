import type { ThreadGoalStatus } from "@codework/contracts";
import { EnvironmentId, ThreadId } from "@codework/contracts";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { t } from "../../i18n";
import { useThreadGoalController } from "../../state/threadGoal";
import { SettingsSection } from "../settings/components/SettingsSection";

type ThreadGoalRouteParams = {
  readonly environmentId: string;
  readonly threadId: string;
};

const statusLabelKey: Record<ThreadGoalStatus, string> = {
  active: "threadGoal.status.active",
  paused: "threadGoal.status.paused",
  blocked: "threadGoal.status.blocked",
  usageLimited: "threadGoal.status.usageLimited",
  budgetLimited: "threadGoal.status.budgetLimited",
  complete: "threadGoal.status.complete",
};

function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  return `${minutes}m ${String(remainder).padStart(2, "0")}s`;
}

export function ThreadGoalRouteScreen({ route }: StaticScreenProps<ThreadGoalRouteParams>) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const threadId = ThreadId.make(route.params.threadId);
  const controller = useThreadGoalController({ environmentId, threadId });
  const [objective, setObjective] = useState("");
  const [working, setWorking] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const goalSnapshotKey = controller.goal
    ? `${controller.goal.goalId}:${controller.goal.status}:${controller.goal.updatedAt}:${controller.goal.timeUsedSeconds}`
    : "empty";
  const goalSnapshotAnchorRef = useRef({ key: goalSnapshotKey, receivedAt: Date.now() });

  if (goalSnapshotAnchorRef.current.key !== goalSnapshotKey) {
    goalSnapshotAnchorRef.current = { key: goalSnapshotKey, receivedAt: Date.now() };
  }

  useEffect(() => {
    setObjective(controller.goal?.objective ?? "");
  }, [controller.goal?.goalId, controller.goal?.objective, controller.goal?.updatedAt]);

  useEffect(() => {
    if (controller.goal?.status !== "active") return;
    const timer = setInterval(() => setClockNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [controller.goal?.status]);

  const runAction = useCallback(
    async (action: () => Promise<boolean>) => {
      if (working) return;
      setWorking(true);
      setLocalError(null);
      try {
        if (!(await action())) setLocalError(t("threadGoal.error.failed"));
      } finally {
        setWorking(false);
      }
    },
    [working],
  );

  const save = useCallback(() => {
    const nextObjective = objective.trim();
    if (nextObjective.length === 0) {
      setLocalError(t("threadGoal.objectiveRequired"));
      return;
    }
    void runAction(() => controller.set(nextObjective));
  }, [controller, objective, runAction]);

  const confirmClear = useCallback(() => {
    Alert.alert(t("threadGoal.clearConfirmTitle"), t("threadGoal.clearConfirmDescription"), [
      { text: t("cancel"), style: "cancel" },
      {
        text: t("threadGoal.clear"),
        style: "destructive",
        onPress: () => void runAction(controller.clear),
      },
    ]);
  }, [controller.clear, runAction]);

  const goal = controller.goal;
  const displayedDuration = goal
    ? goal.timeUsedSeconds +
      (goal.status === "active"
        ? Math.floor(Math.max(0, clockNow - goalSnapshotAnchorRef.current.receivedAt) / 1_000)
        : 0)
    : 0;
  const loading = controller.isPending && goal === null;
  const readOnly = goal?.status === "complete";

  return (
    <View className="flex-1 bg-sheet">
      <NativeStackScreenOptions
        options={{
          headerShown: Platform.OS !== "android",
          title: t("threadGoal.title"),
        }}
      />
      {Platform.OS === "android" ? (
        <AndroidScreenHeader title={t("threadGoal.title")} onBack={() => navigation.goBack()} />
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        refreshControl={
          <RefreshControl
            refreshing={controller.isPending && goal !== null}
            onRefresh={controller.refresh}
          />
        }
      >
        <Text className="px-2 text-sm leading-5 text-foreground-muted">
          {t("threadGoal.mobileDescription")}
        </Text>

        {loading ? (
          <View className="items-center gap-3 rounded-[24px] border-continuous bg-card px-6 py-8">
            <ActivityIndicator />
            <Text className="text-sm text-foreground-muted">{t("threadGoal.loading")}</Text>
          </View>
        ) : null}

        {controller.errorCode !== null ? (
          <View className="rounded-[24px] border-continuous bg-card px-4 py-5">
            <Text className="text-center text-sm text-danger-foreground">
              {t("threadGoal.error.failed")}
            </Text>
          </View>
        ) : null}

        <SettingsSection title={t("threadGoal.objective")} card>
          <View className="gap-3 p-4">
            <TextInput
              accessibilityLabel={t("threadGoal.objective")}
              editable={!working && !loading && !readOnly}
              multiline
              numberOfLines={4}
              onChangeText={setObjective}
              placeholder={t("threadGoal.objectivePlaceholder")}
              textAlignVertical="top"
              value={objective}
            />
            <View className="flex-row flex-wrap gap-2">
              <ActionButton
                disabled={working || loading || readOnly || objective.trim().length === 0}
                emphasized
                label={goal === null ? t("threadGoal.set") : t("threadGoal.save")}
                onPress={save}
              />
              {goal?.status === "active" ? (
                <ActionButton
                  disabled={working}
                  label={t("threadGoal.pause")}
                  onPress={() => void runAction(controller.pause)}
                />
              ) : null}
              {goal?.status === "paused" ? (
                <ActionButton
                  disabled={working}
                  emphasized
                  label={t("threadGoal.resume")}
                  onPress={() => void runAction(controller.resume)}
                />
              ) : null}
              {goal !== null ? (
                <ActionButton
                  disabled={working}
                  destructive
                  label={t("threadGoal.clear")}
                  onPress={confirmClear}
                />
              ) : null}
            </View>
            {localError !== null ? (
              <Text className="text-sm text-danger-foreground">{localError}</Text>
            ) : null}
          </View>
        </SettingsSection>

        {goal !== null ? (
          <SettingsSection title={t("threadGoal.details")} card>
            <View className="gap-2 p-4">
              <DetailRow
                label={t("threadGoal.statusLabel")}
                value={t(statusLabelKey[goal.status])}
              />
              <DetailRow
                label={t("threadGoal.duration")}
                value={formatDuration(displayedDuration)}
              />
              <DetailRow label={t("threadGoal.usage")} value={String(goal.tokensUsed)} />
              {goal.tokenBudget !== null ? (
                <DetailRow label={t("threadGoal.budget")} value={String(goal.tokenBudget)} />
              ) : null}
            </View>
          </SettingsSection>
        ) : null}
      </ScrollView>
    </View>
  );
}

function DetailRow(props: { readonly label: string; readonly value: string }) {
  return (
    <View className="flex-row items-center justify-between gap-4">
      <Text className="text-sm text-foreground-muted">{props.label}</Text>
      <Text className="shrink text-right text-sm font-codework-medium text-foreground">
        {props.value}
      </Text>
    </View>
  );
}

function ActionButton(props: {
  readonly destructive?: boolean;
  readonly disabled: boolean;
  readonly emphasized?: boolean;
  readonly label: string;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel={props.label}
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      className={
        props.destructive
          ? "rounded-full bg-danger px-3.5 py-2 opacity-100 disabled:opacity-40"
          : props.emphasized
            ? "rounded-full bg-accent px-3.5 py-2 opacity-100 disabled:opacity-40"
            : "rounded-full bg-subtle-strong px-3.5 py-2 opacity-100 disabled:opacity-40"
      }
    >
      <Text
        className={
          props.destructive
            ? "text-sm font-codework-medium text-danger-foreground"
            : props.emphasized
              ? "text-sm font-codework-medium text-accent-foreground"
              : "text-sm text-foreground"
        }
      >
        {props.label}
      </Text>
    </Pressable>
  );
}
