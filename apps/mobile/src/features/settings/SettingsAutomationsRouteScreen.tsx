import { useNavigation } from "@react-navigation/native";
import type {
  CompositionAutomation,
  CompositionAutomationRun,
  EnvironmentId,
} from "@codework/contracts";
import {
  buildCompositionAutomationCreateRequest,
  buildCompositionAutomationUpdateRequest,
  createEmptyCompositionAutomationDraft,
  draftFromCompositionAutomation,
  getCompositionAutomationActions,
  type CompositionAutomationAction,
  type CompositionAutomationDraft,
} from "@codework/client-runtime/composition/automation-builder";
import { squashAtomCommandFailure } from "@codework/client-runtime/state/runtime";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Alert, Platform, Pressable, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { t } from "../../i18n";
import { uuidv4 } from "../../lib/uuid";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useEnvironments } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsEnvironmentPicker } from "./components/SettingsEnvironmentPicker";

const INTERVAL_UNITS: ReadonlyArray<CompositionAutomationDraft["intervalUnit"]> = [
  "millisecond",
  "second",
  "minute",
  "hour",
  "day",
];
const TARGET_TYPES: ReadonlyArray<CompositionAutomationDraft["targetType"]> = [
  "agent",
  "squad",
  "goal_loop",
];
const EXECUTION_MODES: ReadonlyArray<CompositionAutomationDraft["executionMode"]> = [
  "isolated",
  "existing_thread",
];

const formatTime = (unixMs: number | null): string =>
  unixMs === null ? t("automationMobile.never") : new Date(unixMs).toLocaleString();

const statusLabel = (status: CompositionAutomation["status"]): string =>
  t(`automationMobile.status.${status}`);

const runStatusLabel = (status: CompositionAutomationRun["status"]): string =>
  t(`automationMobile.runStatus.${status}`);

export function SettingsAutomationsRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { environments } = useEnvironments();
  const allProjects = useProjects();
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(
    () => environments[0]?.environmentId ?? null,
  );
  const environmentId = selectedEnvironmentId;
  const projects = useMemo(
    () => allProjects.filter((project) => project.environmentId === environmentId),
    [allProjects, environmentId],
  );
  const automationsQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.compositionAutomations({ environmentId, input: {} }),
  );
  const automations = automationsQuery.data?.automations ?? [];
  const [selectedAutomationId, setSelectedAutomationId] = useState<string | null>(null);
  const [editorMode, setEditorMode] = useState<"create" | "edit" | null>(null);
  const [draft, setDraft] = useState<CompositionAutomationDraft>(() =>
    createEmptyCompositionAutomationDraft(),
  );
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selectedAutomation =
    automations.find((automation) => automation.automationId === selectedAutomationId) ?? null;
  const runsQuery = useEnvironmentQuery(
    environmentId === null || selectedAutomation === null
      ? null
      : serverEnvironment.compositionAutomationRuns({
          environmentId,
          input: { automationId: selectedAutomation.automationId, limit: 50 },
        }),
  );
  const createAutomation = useAtomCommand(serverEnvironment.createCompositionAutomation, {
    reportFailure: false,
  });
  const updateAutomation = useAtomCommand(serverEnvironment.updateCompositionAutomation, {
    reportFailure: false,
  });
  const pauseAutomation = useAtomCommand(serverEnvironment.pauseCompositionAutomation, {
    reportFailure: false,
  });
  const resumeAutomation = useAtomCommand(serverEnvironment.resumeCompositionAutomation, {
    reportFailure: false,
  });
  const deleteAutomation = useAtomCommand(serverEnvironment.deleteCompositionAutomation, {
    reportFailure: false,
  });
  const runAutomationOnce = useAtomCommand(serverEnvironment.runCompositionAutomationOnce, {
    reportFailure: false,
  });
  const retryAutomationRun = useAtomCommand(serverEnvironment.retryCompositionAutomationRun, {
    reportFailure: false,
  });
  const buildResult = useMemo(
    () =>
      editorMode === "edit" && selectedAutomation !== null
        ? buildCompositionAutomationUpdateRequest(draft, selectedAutomation)
        : buildCompositionAutomationCreateRequest(draft),
    [draft, editorMode, selectedAutomation],
  );

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
    if (editorMode !== null) return;
    if (selectedAutomationId === null && automations[0] !== undefined) {
      setSelectedAutomationId(automations[0].automationId);
      setDraft(draftFromCompositionAutomation(automations[0]));
      return;
    }
    if (selectedAutomationId !== null && selectedAutomation === null) {
      setSelectedAutomationId(null);
    }
  }, [automations, editorMode, selectedAutomation, selectedAutomationId]);

  const selectAutomation = (automation: CompositionAutomation): void => {
    setSelectedAutomationId(automation.automationId);
    setEditorMode("edit");
    setDraft(draftFromCompositionAutomation(automation));
    setError(null);
  };

  const startCreate = (): void => {
    const firstProject = projects[0];
    setSelectedAutomationId(null);
    setEditorMode("create");
    setDraft({
      ...createEmptyCompositionAutomationDraft(),
      projectId: firstProject?.id ?? "",
      workspaceRoot: firstProject?.workspaceRoot ?? "",
    });
    setError(null);
  };

  const cancelEditor = (): void => {
    if (pendingAction !== null) return;
    setEditorMode(null);
    setError(null);
    if (selectedAutomation !== null) setDraft(draftFromCompositionAutomation(selectedAutomation));
  };

  const handleFailure = (result: Parameters<typeof squashAtomCommandFailure>[0]): void => {
    const failure = squashAtomCommandFailure(result);
    setError(failure instanceof Error ? failure.message : t("automationMobile.operationFailed"));
  };

  const save = async (): Promise<void> => {
    if (environmentId === null || pendingAction !== null) return;
    setPendingAction("save");
    setError(null);
    if (editorMode === "edit" && selectedAutomation !== null) {
      const updateResult = buildCompositionAutomationUpdateRequest(draft, selectedAutomation);
      if (updateResult.request === null) {
        setPendingAction(null);
        return;
      }
      const result = await updateAutomation({ environmentId, input: updateResult.request });
      if (result._tag === "Failure") {
        handleFailure(result);
        setPendingAction(null);
        return;
      }
      const automation = result.value.automation;
      setSelectedAutomationId(automation.automationId);
      setEditorMode("edit");
      setDraft(draftFromCompositionAutomation(automation));
      automationsQuery.refresh();
      runsQuery.refresh();
    } else {
      const createResult = buildCompositionAutomationCreateRequest(draft);
      if (createResult.request === null) {
        setPendingAction(null);
        return;
      }
      const result = await createAutomation({ environmentId, input: createResult.request });
      if (result._tag === "Failure") {
        handleFailure(result);
        setPendingAction(null);
        return;
      }
      const automation = result.value.automation;
      setSelectedAutomationId(automation.automationId);
      setEditorMode("edit");
      setDraft(draftFromCompositionAutomation(automation));
      automationsQuery.refresh();
      runsQuery.refresh();
    }
    setPendingAction(null);
  };

  const runLifecycleAction = async (action: CompositionAutomationAction): Promise<void> => {
    if (environmentId === null || selectedAutomation === null || pendingAction !== null) return;
    if (action === "delete") {
      Alert.alert(
        t("automationMobile.deleteTitle", { name: selectedAutomation.name }),
        t("automationMobile.deleteDescription"),
        [
          { text: t("cancel"), style: "cancel" },
          {
            text: t("delete"),
            style: "destructive",
            onPress: () => void deleteAutomationFor(selectedAutomation),
          },
        ],
      );
      return;
    }
    setPendingAction(action);
    setError(null);
    const input = {
      environmentId,
      input: {
        automationId: selectedAutomation.automationId,
        expectedRevision: selectedAutomation.revision,
      },
    };
    const result =
      action === "pause"
        ? await pauseAutomation(input)
        : action === "resume"
          ? await resumeAutomation(input)
          : await runAutomationOnce({
              environmentId,
              input: {
                automationId: selectedAutomation.automationId,
                expectedRevision: selectedAutomation.revision,
                operationId: `mobile-automation-run-${uuidv4()}`,
              },
            });
    if (result._tag === "Failure") {
      handleFailure(result);
      setPendingAction(null);
      return;
    }
    automationsQuery.refresh();
    runsQuery.refresh();
    setPendingAction(null);
  };

  const deleteAutomationFor = async (automation: CompositionAutomation): Promise<void> => {
    if (environmentId === null || pendingAction !== null) return;
    setPendingAction("delete");
    setError(null);
    const result = await deleteAutomation({
      environmentId,
      input: { automationId: automation.automationId, expectedRevision: automation.revision },
    });
    if (result._tag === "Failure") {
      handleFailure(result);
      setPendingAction(null);
      return;
    }
    setSelectedAutomationId(null);
    setEditorMode(null);
    setDraft(createEmptyCompositionAutomationDraft());
    automationsQuery.refresh();
    setPendingAction(null);
  };

  const retryRun = async (run: CompositionAutomationRun): Promise<void> => {
    if (environmentId === null || selectedAutomation === null || pendingAction !== null) return;
    setPendingAction(`retry:${run.automationRunId}`);
    setError(null);
    const result = await retryAutomationRun({
      environmentId,
      input: {
        automationId: selectedAutomation.automationId,
        automationRunId: run.automationRunId,
        expectedRevision: selectedAutomation.revision,
        operationId: `mobile-automation-retry-${uuidv4()}`,
      },
    });
    if (result._tag === "Failure") {
      handleFailure(result);
      setPendingAction(null);
      return;
    }
    automationsQuery.refresh();
    runsQuery.refresh();
    setPendingAction(null);
  };

  return (
    <View className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader
            title={t("automationMobile.title")}
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
            refreshing={automationsQuery.isPending && automationsQuery.data !== null}
            onRefresh={() => {
              automationsQuery.refresh();
              runsQuery.refresh();
            }}
          />
        }
      >
        <Text className="px-2 text-sm leading-5 text-foreground-muted">
          {t("automationMobile.description")}
        </Text>
        <SettingsEnvironmentPicker
          environments={environments}
          selectedEnvironmentId={environmentId}
          disabled={pendingAction !== null}
          onSelect={(next) => {
            setSelectedEnvironmentId(next);
            setSelectedAutomationId(null);
            setEditorMode(null);
            setError(null);
          }}
        />
        {environmentId === null ? (
          <StatusMessage text={t("automationMobile.noEnvironment")} />
        ) : null}
        {error === null ? null : <StatusMessage text={error} tone="danger" />}
        {environmentId !== null ? (
          <ActionButton
            label={t("automationMobile.new")}
            disabled={pendingAction !== null || editorMode !== null}
            emphasized
            onPress={startCreate}
          />
        ) : null}
        <SettingsSection title={t("automationMobile.list")} card>
          {automationsQuery.data === null && automationsQuery.isPending ? (
            <StatusMessage text={t("automationMobile.loading")} />
          ) : automationsQuery.error !== null ? (
            <StatusMessage text={t("automationMobile.loadFailed")} tone="danger" />
          ) : automations.length === 0 ? (
            <StatusMessage text={t("automationMobile.empty")} />
          ) : (
            automations.map((automation) => (
              <Pressable
                key={automation.automationId}
                onPress={() => selectAutomation(automation)}
                disabled={pendingAction !== null}
                className={
                  automation.automationId === selectedAutomationId && editorMode === "edit"
                    ? "border-b border-border-subtle bg-subtle-strong p-4 last:border-b-0"
                    : "border-b border-border-subtle p-4 last:border-b-0"
                }
              >
                <View className="flex-row items-start gap-3">
                  <View className="min-w-0 flex-1 gap-1">
                    <Text
                      className="text-base font-codework-medium text-foreground"
                      numberOfLines={1}
                    >
                      {automation.name}
                    </Text>
                    <Text className="font-mono text-xs text-foreground-muted" numberOfLines={1}>
                      {automation.automationId}
                    </Text>
                    <Text className="text-xs text-foreground-muted">
                      {t("automationMobile.nextRun", {
                        time: formatTime(automation.nextRunAtUnixMs),
                      })}
                    </Text>
                  </View>
                  <StatusPill label={statusLabel(automation.status)} />
                </View>
              </Pressable>
            ))
          )}
        </SettingsSection>
        {editorMode !== null ? (
          <AutomationEditor
            mode={editorMode}
            draft={draft}
            issues={buildResult.issues}
            projects={projects}
            pending={pendingAction !== null}
            onDraftChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
            onSave={() => void save()}
            onCancel={cancelEditor}
          />
        ) : null}
        {selectedAutomation !== null && editorMode === "edit" ? (
          <SettingsSection title={t("automationMobile.actions")} card>
            <View className="flex-row flex-wrap gap-2 p-4">
              {getCompositionAutomationActions(selectedAutomation).map((action) => (
                <ActionButton
                  key={action}
                  label={t(`automationMobile.action.${action}`)}
                  disabled={pendingAction !== null}
                  onPress={() => void runLifecycleAction(action)}
                  danger={action === "delete"}
                />
              ))}
            </View>
          </SettingsSection>
        ) : null}
        <SettingsSection title={t("automationMobile.history")} card>
          {selectedAutomation === null || editorMode !== "edit" ? (
            <StatusMessage text={t("automationMobile.selectForHistory")} />
          ) : runsQuery.data === null && runsQuery.isPending ? (
            <StatusMessage text={t("automationMobile.loadingRuns")} />
          ) : runsQuery.error !== null ? (
            <StatusMessage text={t("automationMobile.runsLoadFailed")} tone="danger" />
          ) : (runsQuery.data?.runs ?? []).length === 0 ? (
            <StatusMessage text={t("automationMobile.noRuns")} />
          ) : (
            (runsQuery.data?.runs ?? []).map((run) => (
              <AutomationRunCard
                key={run.automationRunId}
                run={run}
                disabled={pendingAction !== null}
                pending={pendingAction === `retry:${run.automationRunId}`}
                onRetry={() => void retryRun(run)}
              />
            ))
          )}
        </SettingsSection>
      </ScrollView>
    </View>
  );
}

function AutomationEditor(props: {
  readonly mode: "create" | "edit";
  readonly draft: CompositionAutomationDraft;
  readonly issues: ReadonlyArray<{ readonly code: string; readonly path: string }>;
  readonly projects: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly workspaceRoot: string;
  }>;
  readonly pending: boolean;
  readonly onDraftChange: (patch: Partial<CompositionAutomationDraft>) => void;
  readonly onSave: () => void;
  readonly onCancel: () => void;
}) {
  const patch = props.onDraftChange;
  return (
    <SettingsSection
      title={t(
        props.mode === "create" ? "automationMobile.createTitle" : "automationMobile.editTitle",
      )}
      card
    >
      <View className="gap-4 p-4">
        <View className="flex-row items-center justify-between gap-3">
          <Text className="text-sm leading-5 text-foreground-muted">
            {t("automationMobile.editorDescription")}
          </Text>
          <ActionButton label={t("cancel")} disabled={props.pending} onPress={props.onCancel} />
        </View>
        <Field label={t("automationMobile.automationId")}>
          <TextInput
            value={props.draft.automationId}
            onChangeText={(automationId) => patch({ automationId })}
            editable={!props.pending && props.mode === "create"}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder={t("automationMobile.automationIdPlaceholder")}
          />
        </Field>
        <Field label={t("automationMobile.project")}>
          {props.projects.length === 0 ? (
            <Text className="text-sm text-warning-foreground">
              {t("automationMobile.noProjects")}
            </Text>
          ) : (
            <ChoiceGroup
              values={props.projects.map((project) => ({
                value: project.id,
                label: project.title,
              }))}
              selected={props.draft.projectId}
              disabled={props.pending || props.mode === "edit"}
              onSelect={(projectId) => {
                const project = props.projects.find((item) => item.id === projectId);
                patch({
                  projectId,
                  workspaceRoot: project?.workspaceRoot ?? props.draft.workspaceRoot,
                });
              }}
            />
          )}
        </Field>
        <Field label={t("automationMobile.name")}>
          <TextInput
            value={props.draft.name}
            onChangeText={(name) => patch({ name })}
            editable={!props.pending}
            placeholder={t("automationMobile.namePlaceholder")}
          />
        </Field>
        <Field label={t("automationMobile.prompt")}>
          <TextInput
            value={props.draft.prompt}
            onChangeText={(prompt) => patch({ prompt })}
            editable={!props.pending}
            multiline
            textAlignVertical="top"
            className="min-h-24"
            placeholder={t("automationMobile.promptPlaceholder")}
          />
        </Field>
        <Field label={t("automationMobile.maxRuns")} hint={t("automationMobile.optional")}>
          <TextInput
            value={props.draft.maxRunsText}
            onChangeText={(maxRunsText) => patch({ maxRunsText })}
            editable={!props.pending}
            keyboardType="number-pad"
          />
        </Field>
        <Text className="text-base font-codework-medium text-foreground">
          {t("automationMobile.schedule")}
        </Text>
        <ChoiceGroup
          values={[
            { value: "every", label: t("automationMobile.cadence.every") },
            { value: "cron", label: t("automationMobile.cadence.cron") },
          ]}
          selected={props.draft.cadenceType}
          disabled={props.pending}
          onSelect={(cadenceType) => patch({ cadenceType: cadenceType as "every" | "cron" })}
        />
        {props.draft.cadenceType === "every" ? (
          <View className="flex-row gap-3">
            <View className="min-w-0 flex-1">
              <Field label={t("automationMobile.interval")}>
                <TextInput
                  value={props.draft.intervalValueText}
                  onChangeText={(intervalValueText) => patch({ intervalValueText })}
                  editable={!props.pending}
                  keyboardType="decimal-pad"
                />
              </Field>
            </View>
            <View className="min-w-0 flex-1">
              <Field label={t("automationMobile.intervalUnit")}>
                <ChoiceGroup
                  values={INTERVAL_UNITS.map((value) => ({
                    value,
                    label: t(`automationMobile.intervalUnit.${value}`),
                  }))}
                  selected={props.draft.intervalUnit}
                  disabled={props.pending}
                  onSelect={(intervalUnit) => patch({ intervalUnit })}
                />
              </Field>
            </View>
          </View>
        ) : (
          <>
            <Field label={t("automationMobile.cronExpression")}>
              <TextInput
                value={props.draft.cronExpression}
                onChangeText={(cronExpression) => patch({ cronExpression })}
                editable={!props.pending}
                autoCapitalize="none"
                placeholder={t("automationMobile.cronExpressionPlaceholder")}
              />
            </Field>
            <Field label={t("automationMobile.timezone")}>
              <TextInput
                value={props.draft.timezone}
                onChangeText={(timezone) => patch({ timezone })}
                editable={!props.pending}
                autoCapitalize="none"
                placeholder={t("automationMobile.timezonePlaceholder")}
              />
            </Field>
          </>
        )}
        <Field label={t("automationMobile.expiresAt")} hint={t("automationMobile.expiresAtHint")}>
          <TextInput
            value={props.draft.expiresAtText}
            onChangeText={(expiresAtText) => patch({ expiresAtText })}
            editable={!props.pending}
            autoCapitalize="none"
            placeholder={t("automationMobile.expiresAtPlaceholder")}
          />
        </Field>
        {props.mode === "create" ? (
          <Choice
            label={t("automationMobile.runOnCreate")}
            selected={props.draft.runOnCreate}
            disabled={props.pending}
            onPress={() => patch({ runOnCreate: !props.draft.runOnCreate })}
          />
        ) : null}
        <Text className="text-base font-codework-medium text-foreground">
          {t("automationMobile.target")}
        </Text>
        <ChoiceGroup
          values={TARGET_TYPES.map((value) => ({
            value,
            label: t(`automationMobile.targetType.${value}`),
          }))}
          selected={props.draft.targetType}
          disabled={props.pending}
          onSelect={(targetType) => patch({ targetType })}
        />
        <ChoiceGroup
          values={EXECUTION_MODES.map((value) => ({
            value,
            label: t(`automationMobile.executionMode.${value}`),
          }))}
          selected={props.draft.executionMode}
          disabled={props.pending}
          onSelect={(executionMode) => patch({ executionMode })}
        />
        {props.draft.targetType === "squad" ? (
          <>
            <Field label={t("automationMobile.squadId")}>
              <TextInput
                value={props.draft.squadId}
                onChangeText={(squadId) => patch({ squadId })}
                editable={!props.pending}
                autoCapitalize="none"
              />
            </Field>
            <Field label={t("automationMobile.squadRevision")}>
              <TextInput
                value={props.draft.squadRevisionText}
                onChangeText={(squadRevisionText) => patch({ squadRevisionText })}
                editable={!props.pending}
                keyboardType="number-pad"
              />
            </Field>
          </>
        ) : (
          <>
            <Field label={t("automationMobile.agentId")}>
              <TextInput
                value={props.draft.agentId}
                onChangeText={(agentId) => patch({ agentId })}
                editable={!props.pending}
                autoCapitalize="none"
                autoCorrect={false}
              />
            </Field>
            <Field label={t("automationMobile.model")} hint={t("automationMobile.optional")}>
              <TextInput
                value={props.draft.model}
                onChangeText={(model) => patch({ model })}
                editable={!props.pending}
                autoCapitalize="none"
              />
            </Field>
            <Field
              label={t("automationMobile.capabilityIds")}
              hint={t("automationMobile.capabilityIdsHint")}
            >
              <TextInput
                value={props.draft.capabilityIdsText}
                onChangeText={(capabilityIdsText) => patch({ capabilityIdsText })}
                editable={!props.pending}
                autoCapitalize="none"
                placeholder={t("automationMobile.capabilityIdsPlaceholder")}
              />
            </Field>
          </>
        )}
        {props.draft.targetType === "goal_loop" ? (
          <>
            <Field
              label={t("automationMobile.reviewerAgentId")}
              hint={t("automationMobile.optional")}
            >
              <TextInput
                value={props.draft.reviewerAgentId}
                onChangeText={(reviewerAgentId) => patch({ reviewerAgentId })}
                editable={!props.pending}
                autoCapitalize="none"
              />
            </Field>
            <Field label={t("automationMobile.maxAttempts")}>
              <TextInput
                value={props.draft.maxAttemptsText}
                onChangeText={(maxAttemptsText) => patch({ maxAttemptsText })}
                editable={!props.pending}
                keyboardType="number-pad"
              />
            </Field>
            <Field label={t("automationMobile.maxCostUnits")} hint={t("automationMobile.optional")}>
              <TextInput
                value={props.draft.maxCostUnitsText}
                onChangeText={(maxCostUnitsText) => patch({ maxCostUnitsText })}
                editable={!props.pending}
                keyboardType="number-pad"
              />
            </Field>
            <Field
              label={t("automationMobile.stalePivotRounds")}
              hint={t("automationMobile.optional")}
            >
              <TextInput
                value={props.draft.stalePivotRoundsText}
                onChangeText={(stalePivotRoundsText) => patch({ stalePivotRoundsText })}
                editable={!props.pending}
                keyboardType="number-pad"
              />
            </Field>
            <Field
              label={t("automationMobile.deadlineMinutes")}
              hint={t("automationMobile.optional")}
            >
              <TextInput
                value={props.draft.deadlineMinutesText}
                onChangeText={(deadlineMinutesText) => patch({ deadlineMinutesText })}
                editable={!props.pending}
                keyboardType="decimal-pad"
              />
            </Field>
          </>
        ) : null}
        {props.draft.executionMode === "existing_thread" ? (
          <Field label={t("automationMobile.threadId")}>
            <TextInput
              value={props.draft.threadId}
              onChangeText={(threadId) => patch({ threadId })}
              editable={!props.pending}
              autoCapitalize="none"
            />
          </Field>
        ) : (
          <>
            <Field label={t("automationMobile.workspaceRoot")}>
              <TextInput
                value={props.draft.workspaceRoot}
                onChangeText={(workspaceRoot) => patch({ workspaceRoot })}
                editable={!props.pending}
                autoCapitalize="none"
              />
            </Field>
            <Choice
              label={t("automationMobile.archiveOnFinish")}
              selected={props.draft.archiveOnFinish}
              disabled={props.pending}
              onPress={() => patch({ archiveOnFinish: !props.draft.archiveOnFinish })}
            />
          </>
        )}
        <View className="gap-1 border-t border-border-subtle pt-3">
          <Text className="text-sm font-codework-medium text-foreground">
            {t("automationMobile.validation")}
          </Text>
          {props.issues.length === 0 ? (
            <Text className="text-sm text-success-foreground">{t("automationMobile.ready")}</Text>
          ) : (
            props.issues.map((issue) => (
              <Text key={`${issue.code}:${issue.path}`} className="text-sm text-warning-foreground">
                {t(`automationMobile.validationIssue.${issue.code}`, { path: issue.path })}
              </Text>
            ))
          )}
        </View>
        <ActionButton
          label={props.pending ? t("automationMobile.saving") : t("save")}
          disabled={props.pending || props.issues.length > 0}
          emphasized
          onPress={props.onSave}
        />
      </View>
    </SettingsSection>
  );
}

function AutomationRunCard(props: {
  readonly run: CompositionAutomationRun;
  readonly disabled: boolean;
  readonly pending: boolean;
  readonly onRetry: () => void;
}) {
  return (
    <View className="gap-2 border-b border-border-subtle p-4 last:border-b-0">
      <View className="flex-row items-start gap-3">
        <View className="min-w-0 flex-1 gap-1">
          <Text className="text-base font-codework-medium text-foreground">
            {runStatusLabel(props.run.status)}
          </Text>
          <Text className="font-mono text-xs text-foreground-muted" numberOfLines={1}>
            {props.run.automationRunId}
          </Text>
        </View>
        <StatusPill label={t(`automationMobile.trigger.${props.run.trigger}`)} />
      </View>
      <Text className="text-xs text-foreground-muted">
        {t("automationMobile.runSchedule", {
          time: formatTime(props.run.scheduledForUnixMs),
          attempt: props.run.attempt,
        })}
      </Text>
      {props.run.outputSummary === null ? null : (
        <Text className="text-sm leading-5 text-foreground" numberOfLines={4}>
          {props.run.outputSummary}
        </Text>
      )}
      {props.run.errorCode === null ? null : (
        <Text className="text-xs leading-4 text-danger-foreground" numberOfLines={4}>
          {`${props.run.errorCode}${props.run.errorDetail === null ? "" : `: ${props.run.errorDetail}`}`}
        </Text>
      )}
      <Text className="text-xs text-foreground-muted">
        {t("automationMobile.runTimes", {
          started: formatTime(props.run.startedAtUnixMs),
          finished: formatTime(props.run.finishedAtUnixMs),
        })}
      </Text>
      {props.run.status === "failed" ? (
        <ActionButton
          label={props.pending ? t("automationMobile.retrying") : t("automationMobile.retry")}
          disabled={props.disabled}
          onPress={props.onRetry}
        />
      ) : null}
    </View>
  );
}

function Field(props: {
  readonly label: string;
  readonly hint?: string;
  readonly children: ReactNode;
}) {
  return (
    <View className="gap-1.5">
      <Text className="text-sm font-codework-medium text-foreground">{props.label}</Text>
      {props.children}
      {props.hint === undefined ? null : (
        <Text className="text-xs leading-4 text-foreground-muted">{props.hint}</Text>
      )}
    </View>
  );
}

function ChoiceGroup<T extends string>(props: {
  readonly values: ReadonlyArray<{ readonly value: T; readonly label: string }>;
  readonly selected: T;
  readonly disabled: boolean;
  readonly onSelect: (value: T) => void;
}) {
  return (
    <View className="flex-row flex-wrap gap-2">
      {props.values.map((value) => (
        <Choice
          key={value.value}
          label={value.label}
          selected={props.selected === value.value}
          disabled={props.disabled}
          onPress={() => props.onSelect(value.value)}
        />
      ))}
    </View>
  );
}

function Choice(props: {
  readonly label: string;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: props.selected, disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      className={
        props.selected
          ? "rounded-full bg-subtle-strong px-3 py-2"
          : "rounded-full bg-subtle px-3 py-2"
      }
    >
      <Text className="text-sm text-foreground">{props.label}</Text>
    </Pressable>
  );
}

function ActionButton(props: {
  readonly label: string;
  readonly disabled: boolean;
  readonly emphasized?: boolean;
  readonly danger?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      className={
        props.emphasized
          ? "self-start rounded-full bg-accent px-4 py-2 opacity-100 disabled:opacity-40"
          : props.danger
            ? "self-start rounded-full bg-danger px-3 py-2 opacity-100 disabled:opacity-40"
            : "self-start rounded-full bg-subtle-strong px-3 py-2 opacity-100 disabled:opacity-40"
      }
    >
      <Text className="text-sm text-foreground">{props.label}</Text>
    </Pressable>
  );
}

function StatusPill(props: { readonly label: string }) {
  return (
    <View className="rounded-full bg-subtle-strong px-2.5 py-1">
      <Text className="text-xs text-foreground">{props.label}</Text>
    </View>
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
