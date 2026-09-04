import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId, WorkspaceScriptRun } from "@codework/contracts";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@codework/client-runtime/state/runtime";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Platform, Pressable, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { uuidv4 } from "../../lib/uuid";
import { useEnvironments } from "../../state/environments";
import { useProjects, useThreadShells } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { t } from "../../i18n";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsEnvironmentPicker } from "./components/SettingsEnvironmentPicker";

const canStop = (run: WorkspaceScriptRun): boolean =>
  run.status === "starting" || run.status === "running";

export function SettingsWorkspaceScriptsRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { environments } = useEnvironments();
  const allProjects = useProjects();
  const allThreads = useThreadShells();
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(
    () => environments[0]?.environmentId ?? null,
  );
  const environmentId = selectedEnvironmentId;
  const projects = useMemo(
    () => allProjects.filter((project) => project.environmentId === environmentId),
    [allProjects, environmentId],
  );
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    () => projects[0]?.id ?? null,
  );
  const selectedProject =
    projects.find((project) => project.id === selectedProjectId) ?? projects[0] ?? null;
  const threads = useMemo(
    () =>
      selectedProject === null
        ? []
        : allThreads.filter(
            (thread) =>
              thread.environmentId === environmentId &&
              thread.projectId === selectedProject.id &&
              thread.archivedAt === null,
          ),
    [allThreads, environmentId, selectedProject],
  );
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(
    () => threads[0]?.id ?? null,
  );
  const selectedThread =
    threads.find((thread) => thread.id === selectedThreadId) ?? threads[0] ?? null;
  const runsQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.workspaceScriptRuns({
          environmentId,
          input: {
            ...(selectedProject === null ? {} : { projectId: selectedProject.id }),
            ...(selectedThread === null ? {} : { threadId: selectedThread.id }),
          },
        }),
  );
  const startScript = useAtomCommand(serverEnvironment.startWorkspaceScript, {
    reportFailure: false,
  });
  const stopScript = useAtomCommand(serverEnvironment.stopWorkspaceScript, {
    reportFailure: false,
  });
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (
      selectedEnvironmentId !== null &&
      environments.some((item) => item.environmentId === selectedEnvironmentId)
    ) {
      return;
    }
    setSelectedEnvironmentId(environments[0]?.environmentId ?? null);
  }, [environments, selectedEnvironmentId]);

  useEffect(() => {
    if (selectedProject === null) {
      if (selectedProjectId !== null) setSelectedProjectId(null);
      return;
    }
    if (selectedProject.id !== selectedProjectId) setSelectedProjectId(selectedProject.id);
  }, [selectedProject, selectedProjectId]);

  useEffect(() => {
    if (selectedThread === null) {
      if (selectedThreadId !== null) setSelectedThreadId(null);
      return;
    }
    if (selectedThread.id !== selectedThreadId) setSelectedThreadId(selectedThread.id);
  }, [selectedThread, selectedThreadId]);

  const runs = useMemo(
    () =>
      [...(runsQuery.data?.runs ?? [])].sort(
        (left, right) => right.updatedAtUnixMs - left.updatedAtUnixMs,
      ),
    [runsQuery.data?.runs],
  );

  const actionFailure = useCallback((result: AtomCommandResult<unknown, unknown>) => {
    if (result._tag !== "Failure") return;
    const failure = squashAtomCommandFailure(result);
    setError(
      failure instanceof Error ? failure.message : t("workspaceScriptsMobile.operationFailed"),
    );
  }, []);

  const runStart = useCallback(
    async (scriptId: string) => {
      if (environmentId === null || selectedProject === null || selectedThread === null) return;
      const action = `start:${scriptId}`;
      setPendingAction(action);
      setError(null);
      const result = await startScript({
        environmentId,
        input: {
          operationId: `mobile-${uuidv4()}`,
          projectId: selectedProject.id,
          threadId: selectedThread.id,
          scriptId,
          ...(selectedThread.worktreePath === null
            ? {}
            : { worktreePath: selectedThread.worktreePath }),
        },
      });
      actionFailure(result);
      if (result._tag === "Success") runsQuery.refresh();
      setPendingAction(null);
    },
    [actionFailure, environmentId, runsQuery, selectedProject, selectedThread, startScript],
  );

  const runStop = useCallback(
    async (run: WorkspaceScriptRun) => {
      if (environmentId === null || !canStop(run)) return;
      setPendingAction(`stop:${run.workspaceScriptRunId}`);
      setError(null);
      const result = await stopScript({
        environmentId,
        input: {
          workspaceScriptRunId: run.workspaceScriptRunId,
          operationId: `mobile-${uuidv4()}`,
          expectedRevision: run.revision,
        },
      });
      actionFailure(result);
      if (result._tag === "Success") runsQuery.refresh();
      setPendingAction(null);
    },
    [actionFailure, environmentId, runsQuery, stopScript],
  );

  return (
    <View className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader
            title={t("workspaceScriptsMobile.title")}
            onBack={() => navigation.goBack()}
          />
        </>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        refreshControl={
          <RefreshControl
            refreshing={runsQuery.isPending && runsQuery.data !== null}
            onRefresh={runsQuery.refresh}
          />
        }
      >
        <Text className="px-2 text-sm leading-5 text-foreground-muted">
          {t("workspaceScriptsMobile.description")}
        </Text>
        <SettingsEnvironmentPicker
          environments={environments}
          selectedEnvironmentId={environmentId}
          disabled={pendingAction !== null}
          onSelect={(next) => {
            setSelectedEnvironmentId(next);
            setSelectedProjectId(null);
            setSelectedThreadId(null);
            setError(null);
          }}
        />
        {environmentId === null ? (
          <StatusMessage text={t("workspaceScriptsMobile.noEnvironment")} />
        ) : null}
        {error === null ? null : <StatusMessage text={error} tone="danger" />}
        <SettingsSection title={t("workspaceScriptsMobile.project")} card>
          {projects.length === 0 ? (
            <StatusMessage text={t("workspaceScriptsMobile.noProjects")} />
          ) : (
            <ChoiceList
              values={projects.map((project) => ({ id: project.id, label: project.title }))}
              selectedId={selectedProject?.id ?? null}
              disabled={pendingAction !== null}
              onSelect={(id) => {
                setSelectedProjectId(id);
                setSelectedThreadId(null);
                setError(null);
              }}
            />
          )}
        </SettingsSection>
        <SettingsSection title={t("workspaceScriptsMobile.thread")} card>
          {threads.length === 0 ? (
            <StatusMessage text={t("workspaceScriptsMobile.noThreads")} />
          ) : (
            <ChoiceList
              values={threads.map((thread) => ({ id: thread.id, label: thread.title }))}
              selectedId={selectedThread?.id ?? null}
              disabled={pendingAction !== null}
              onSelect={(id) => {
                setSelectedThreadId(id);
                setError(null);
              }}
            />
          )}
        </SettingsSection>
        <SettingsSection title={t("workspaceScriptsMobile.scripts")} card>
          {selectedProject === null || selectedProject.scripts.length === 0 ? (
            <StatusMessage text={t("workspaceScriptsMobile.noScripts")} />
          ) : (
            selectedProject.scripts.map((script) => (
              <View
                key={script.id}
                className="gap-2 border-b border-border-subtle p-4 last:border-b-0"
              >
                <Text className="text-base font-codework-medium text-foreground">
                  {script.name}
                </Text>
                <Text className="font-mono text-xs text-foreground-muted" numberOfLines={2}>
                  {script.command}
                </Text>
                <ActionButton
                  label={
                    pendingAction === `start:${script.id}`
                      ? t("workspaceScriptsMobile.starting")
                      : t("workspaceScriptsMobile.start")
                  }
                  disabled={pendingAction !== null || selectedThread === null}
                  onPress={() => void runStart(script.id)}
                />
              </View>
            ))
          )}
        </SettingsSection>
        <SettingsSection title={t("workspaceScriptsMobile.history")} card>
          {runsQuery.data === null && runsQuery.isPending ? (
            <StatusMessage text={t("workspaceScriptsMobile.loading")} />
          ) : runsQuery.error !== null ? (
            <StatusMessage text={t("workspaceScriptsMobile.loadFailed")} tone="danger" />
          ) : runs.length === 0 ? (
            <StatusMessage text={t("workspaceScriptsMobile.noRuns")} />
          ) : (
            runs.map((run) => (
              <RunCard
                key={run.workspaceScriptRunId}
                run={run}
                pending={pendingAction === `stop:${run.workspaceScriptRunId}`}
                disabled={pendingAction !== null}
                onStop={() => void runStop(run)}
              />
            ))
          )}
        </SettingsSection>
      </ScrollView>
    </View>
  );
}

function ChoiceList(props: {
  readonly values: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  readonly selectedId: string | null;
  readonly disabled: boolean;
  readonly onSelect: (id: string) => void;
}) {
  return (
    <View className="gap-2 p-3">
      {props.values.map((value) => (
        <Pressable
          key={value.id}
          accessibilityRole="radio"
          accessibilityState={{ checked: props.selectedId === value.id, disabled: props.disabled }}
          disabled={props.disabled}
          onPress={() => props.onSelect(value.id)}
          className={
            props.selectedId === value.id
              ? "rounded-[16px] bg-subtle-strong px-3 py-3"
              : "rounded-[16px] bg-subtle px-3 py-3"
          }
        >
          <Text className="text-sm text-foreground" numberOfLines={1}>
            {value.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

function RunCard(props: {
  readonly run: WorkspaceScriptRun;
  readonly pending: boolean;
  readonly disabled: boolean;
  readonly onStop: () => void;
}) {
  return (
    <View className="gap-2 border-b border-border-subtle p-4 last:border-b-0">
      <View className="flex-row items-start gap-3">
        <View className="min-w-0 flex-1 gap-1">
          <Text className="text-base font-codework-medium text-foreground">
            {props.run.scriptName}
          </Text>
          <Text className="font-mono text-xs text-foreground-muted" numberOfLines={1}>
            {props.run.workspaceScriptRunId}
          </Text>
        </View>
        <StatusPill label={t(`workspaceScriptsMobile.status.${props.run.status}`)} />
      </View>
      <Text className="text-xs text-foreground-muted" numberOfLines={2}>
        {`${t("workspaceScriptsMobile.cwd")}: ${props.run.cwd}`}
      </Text>
      <Text className="text-xs text-foreground-muted">
        {`${t("workspaceScriptsMobile.health")}: ${t(`workspaceScriptsMobile.health.${props.run.healthStatus}`)}`}
      </Text>
      {canStop(props.run) ? (
        <ActionButton
          label={
            props.pending ? t("workspaceScriptsMobile.stopping") : t("workspaceScriptsMobile.stop")
          }
          disabled={props.disabled}
          onPress={props.onStop}
        />
      ) : null}
    </View>
  );
}

function StatusPill(props: { readonly label: string }) {
  return (
    <View className="rounded-full bg-subtle-strong px-2.5 py-1">
      <Text className="text-xs text-foreground">{props.label}</Text>
    </View>
  );
}

function ActionButton(props: {
  readonly label: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      className="self-start rounded-full bg-subtle-strong px-3 py-2 opacity-100 disabled:opacity-40"
    >
      <Text className="text-sm text-foreground">{props.label}</Text>
    </Pressable>
  );
}

function StatusMessage(props: { readonly text: string; readonly tone?: "danger" }) {
  return (
    <View className="rounded-[20px] bg-card px-4 py-4">
      <Text
        className={
          props.tone === "danger"
            ? "text-sm text-danger-foreground"
            : "text-sm text-foreground-muted"
        }
      >
        {props.text}
      </Text>
    </View>
  );
}
