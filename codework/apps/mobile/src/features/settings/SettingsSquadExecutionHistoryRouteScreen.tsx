import { useNavigation } from "@react-navigation/native";
import { useMemo } from "react";
import { Platform, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { t } from "../../i18n";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useEnvironments } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import {
  projectSquadExecutionHistory,
  type SquadExecutionHistoryItem,
} from "./SettingsSquadExecutionHistoryRouteScreen.logic";

const EXECUTION_CREATED_AT_FORMATTER = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

/** 最近 Squad execution 的只读移动端视图，数据以服务端安全摘要投影为准。 */
export function SettingsSquadExecutionHistoryRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { environments } = useEnvironments();
  const projects = useProjects();
  const environmentId = environments[0]?.environmentId ?? null;
  const summariesQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.compositionSquadExecutionSummaries({
          environmentId,
          input: { limit: 20 },
        }),
  );
  const environmentProjects = useMemo(
    () => projects.filter((project) => project.environmentId === environmentId),
    [environmentId, projects],
  );
  const history = useMemo(() => {
    const projectTitlesById = new Map(
      environmentProjects.map((project) => [project.id, project.title]),
    );
    return projectSquadExecutionHistory(summariesQuery.data?.executions ?? [], projectTitlesById);
  }, [environmentProjects, summariesQuery.data]);
  const refreshing = summariesQuery.isPending && summariesQuery.data !== null;

  const refresh = (): void => {
    summariesQuery.refresh();
  };

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader
            title={t("squadExecutionHistory.title")}
            onBack={() => navigation.goBack()}
          />
        </>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-3 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
      >
        {environmentId === null ? (
          <StatusMessage text={t("squadExecutionHistory.noEnvironment")} />
        ) : summariesQuery.data === null && summariesQuery.isPending ? (
          <StatusMessage text={t("squadExecutionHistory.pending")} />
        ) : summariesQuery.data === null && summariesQuery.error !== null ? (
          <StatusMessage text={t("squadExecutionHistory.error")} tone="danger" />
        ) : summariesQuery.data === null || history.length === 0 ? (
          <StatusMessage
            text={t(
              summariesQuery.error === null
                ? "squadExecutionHistory.empty"
                : "squadExecutionHistory.error",
            )}
            tone={summariesQuery.error === null ? undefined : "danger"}
          />
        ) : (
          <View className="gap-3">
            {summariesQuery.error === null ? null : (
              <StatusMessage text={t("squadExecutionHistory.error")} tone="danger" />
            )}
            {history.map((item) => (
              <SquadExecutionHistoryCard key={item.executionId} item={item} />
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function SquadExecutionHistoryCard(props: { readonly item: SquadExecutionHistoryItem }) {
  const { item } = props;
  return (
    <View className="gap-3 rounded-[24px] border-continuous bg-card p-4">
      <View className="gap-1">
        <View className="flex-row flex-wrap items-center gap-2">
          <Text
            className="min-w-0 flex-1 text-base font-t3-medium text-foreground"
            numberOfLines={1}
          >
            {item.squadDisplayName}
          </Text>
          <BadgePill label={t(item.statusLabelKey)} emphasized />
        </View>
        <Text className="font-mono text-xs text-foreground-muted" numberOfLines={1}>
          {item.executionId}
        </Text>
      </View>

      <View className="flex-row flex-wrap gap-2">
        <BadgePill label={t("squadExecutionHistory.revision", { revision: item.revision })} />
        <BadgePill label={t("squadExecutionHistory.nodes", { count: item.nodeCount })} />
        <BadgePill
          label={t("squadExecutionHistory.pendingApprovals", {
            count: item.pendingApprovalCount,
          })}
        />
      </View>

      <View className="gap-1 border-t border-border-subtle pt-3">
        <Text className="text-sm text-foreground" numberOfLines={1}>
          {`${t("squadExecutionHistory.project")}: ${item.projectTitle}`}
        </Text>
        <Text className="text-xs text-foreground-muted">
          {EXECUTION_CREATED_AT_FORMATTER.format(new Date(item.createdAtUnixMs))}
        </Text>
      </View>

      {item.resultSummary === undefined ? null : (
        <View className="gap-1 border-t border-border-subtle pt-3">
          <Text className="text-xs font-t3-medium text-foreground-muted">
            {t("squadExecutionHistory.resultSummary")}
          </Text>
          <Text className="text-sm text-foreground">{item.resultSummary}</Text>
        </View>
      )}

      {item.failureCode === undefined ? null : (
        <View className="gap-1 border-t border-border-subtle pt-3">
          <Text className="text-xs font-t3-medium text-foreground-muted">
            {t("squadExecutionHistory.failureCode")}
          </Text>
          <Text className="font-mono text-sm text-danger-foreground">{item.failureCode}</Text>
        </View>
      )}
    </View>
  );
}

function StatusMessage(props: { readonly text: string; readonly tone?: "danger" }) {
  return (
    <View className="rounded-[24px] border-continuous bg-card px-4 py-6">
      <Text
        className={
          props.tone === "danger"
            ? "text-center text-sm text-danger-foreground"
            : "text-center text-sm text-foreground-muted"
        }
      >
        {props.text}
      </Text>
    </View>
  );
}

function BadgePill(props: { readonly label: string; readonly emphasized?: boolean }) {
  return (
    <View
      className={
        props.emphasized
          ? "rounded-full bg-subtle-strong px-2.5 py-0.5"
          : "rounded-full bg-subtle px-2.5 py-0.5"
      }
    >
      <Text className="text-xs text-foreground">{props.label}</Text>
    </View>
  );
}
