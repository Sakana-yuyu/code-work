import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ModelSelection,
  ServerConfig,
  ServerSelfUpdateCapability,
  ServerSettings,
  ServerSettingsPatch,
} from "@codework/contracts";
import type { ServerUpdateState } from "@codework/client-runtime/state/server";
import { Atom } from "effect/unstable/reactivity";
import { useNavigation } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Alert, Platform, Pressable, ScrollView, Switch, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@codework/client-runtime/state/runtime";
import { resolveServerBackgroundActivitySettings } from "@codework/shared/backgroundActivitySettings";
import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { buildModelOptions, type ModelOption } from "../../lib/modelOptions";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { t } from "../../i18n";
import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsEnvironmentPicker } from "./components/SettingsEnvironmentPicker";
import { SettingsSection } from "./components/SettingsSection";
import {
  BACKGROUND_ACTIVITY_PROFILES,
  backgroundActivityBooleanPatch,
  backgroundActivityCustomPatch,
  backgroundActivityDurationPatch,
  backgroundActivityPresetPatch,
  normalizeMobileDirectory,
  secondsFromDuration,
  type BackgroundActivityBooleanSetting,
  type DurationSetting,
} from "./SettingsServerRouteScreen.logic";

const EMPTY_SERVER_SETTINGS_ATOM = Atom.make<ServerSettings | null>(null).pipe(
  Atom.withLabel("mobile-server-settings:empty"),
);
const EMPTY_SERVER_CONFIG_ATOM = Atom.make<ServerConfig | null>(null).pipe(
  Atom.withLabel("mobile-server-config:empty"),
);

export function SettingsServerRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { environments } = useEnvironments();
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(
    () => environments[0]?.environmentId ?? null,
  );
  const environmentId = selectedEnvironmentId;
  const settings = useAtomValue(
    environmentId === null
      ? EMPTY_SERVER_SETTINGS_ATOM
      : serverEnvironment.settingsValueAtom(environmentId),
  );
  const serverConfig = useAtomValue(
    environmentId === null
      ? EMPTY_SERVER_CONFIG_ATOM
      : serverEnvironment.configValueAtom(environmentId),
  );
  const serverUpdateState = useAtomValue(serverEnvironment.updateStateAtom(environmentId));
  const updateServer = useAtomCommand(serverEnvironment.updateServer, {
    reportFailure: false,
  });
  const saveSettings = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [baseDirectoryDraft, setBaseDirectoryDraft] = useState("");
  const [customInstructionsDraft, setCustomInstructionsDraft] = useState("");
  const [tracesUrlDraft, setTracesUrlDraft] = useState("");
  const [metricsUrlDraft, setMetricsUrlDraft] = useState("");
  const [targetVersionDraft, setTargetVersionDraft] = useState("");
  const [updateError, setUpdateError] = useState<string | null>(null);

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
    setBaseDirectoryDraft(settings?.addProjectBaseDirectory ?? "");
    setCustomInstructionsDraft(settings?.sourceControlWritingStyle.customInstructions ?? "");
    setTracesUrlDraft(settings?.observability.otlpTracesUrl ?? "");
    setMetricsUrlDraft(settings?.observability.otlpMetricsUrl ?? "");
    setTargetVersionDraft(serverConfig?.environment.serverVersion ?? "");
    setUpdateError(null);
  }, [
    environmentId,
    settings?.addProjectBaseDirectory,
    settings?.observability.otlpMetricsUrl,
    settings?.observability.otlpTracesUrl,
    settings?.sourceControlWritingStyle.customInstructions,
    serverConfig?.environment.serverVersion,
  ]);

  const resolvedBackgroundActivity = useMemo(
    () => (settings === null ? null : resolveServerBackgroundActivitySettings(settings)),
    [settings],
  );
  const modelOptions = useMemo(
    () =>
      settings === null
        ? []
        : buildModelOptions(serverConfig, settings.textGenerationModelSelection),
    [serverConfig, settings],
  );

  const persist = useCallback(
    async (patch: ServerSettingsPatch): Promise<boolean> => {
      if (environmentId === null) return false;
      setPending(true);
      setError(null);
      const result = await saveSettings({ environmentId, input: { patch } });
      setPending(false);
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const failure = squashAtomCommandFailure(result);
          setError(
            failure instanceof Error ? failure.message : t("serverSettingsMobile.saveFailed"),
          );
        }
        return false;
      }
      return true;
    },
    [environmentId, saveSettings],
  );

  const setBackgroundProfile = useCallback(
    (profile: (typeof BACKGROUND_ACTIVITY_PROFILES)[number]) => {
      void persist(backgroundActivityPresetPatch(profile));
    },
    [persist],
  );

  const setBackgroundDuration = useCallback(
    (field: DurationSetting, seconds: number) => {
      if (settings === null || resolvedBackgroundActivity === null) return;
      void persist(
        backgroundActivityDurationPatch(settings, resolvedBackgroundActivity, field, seconds),
      );
    },
    [persist, resolvedBackgroundActivity, settings],
  );

  const setBackgroundBoolean = useCallback(
    (field: BackgroundActivityBooleanSetting, value: boolean) => {
      if (settings === null || resolvedBackgroundActivity === null) return;
      void persist(
        backgroundActivityBooleanPatch(settings, resolvedBackgroundActivity, field, value),
      );
    },
    [persist, resolvedBackgroundActivity, settings],
  );

  const setBackgroundCustom = useCallback(() => {
    if (settings === null || resolvedBackgroundActivity === null) return;
    void persist(backgroundActivityCustomPatch(settings, resolvedBackgroundActivity));
  }, [persist, resolvedBackgroundActivity, settings]);

  const setDefaultModel = useCallback(
    (selection: ModelSelection) => {
      void persist({ textGenerationModelSelection: selection });
    },
    [persist],
  );

  const setSourceControlWriterModel = useCallback(
    (selection: ModelSelection) => {
      void persist({ sourceControlWriterModelSelection: selection });
    },
    [persist],
  );

  const selfUpdate = serverConfig?.environment.capabilities.serverSelfUpdate ?? null;
  const runServerUpdate = useCallback(async () => {
    if (environmentId === null || !canUpdateServer(selfUpdate)) return;
    const targetVersion = targetVersionDraft.trim();
    if (targetVersion.length === 0) {
      setUpdateError(t("serverUpdateMobile.targetRequired"));
      return;
    }
    if (targetVersion === serverConfig?.environment.serverVersion) {
      setUpdateError(t("serverUpdateMobile.targetMustDiffer"));
      return;
    }
    const confirmed = await new Promise<boolean>((resolve) => {
      Alert.alert(
        t("serverUpdateMobile.confirmTitle"),
        t("serverUpdateMobile.confirmDescription", { targetVersion }),
        [
          { text: t("cancel"), style: "cancel", onPress: () => resolve(false) },
          {
            text: t("serverUpdateMobile.update"),
            style: "destructive",
            onPress: () => resolve(true),
          },
        ],
      );
    });
    if (!confirmed) return;
    setUpdateError(null);
    const result = await updateServer({
      environmentId,
      input: { targetVersion },
    });
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const failure = squashAtomCommandFailure(result);
      setUpdateError(failure instanceof Error ? failure.message : t("serverUpdateMobile.failed"));
    }
  }, [
    environmentId,
    serverConfig?.environment.serverVersion,
    selfUpdate,
    targetVersionDraft,
    updateServer,
  ]);

  return (
    <View className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader
            title={t("serverSettingsMobile.title")}
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
      >
        <Text className="px-2 text-sm leading-5 text-foreground-muted">
          {t("serverSettingsMobile.description")}
        </Text>
        <SettingsEnvironmentPicker
          environments={environments}
          selectedEnvironmentId={environmentId}
          disabled={pending}
          onSelect={(next) => {
            setSelectedEnvironmentId(next);
            setError(null);
          }}
        />
        {environmentId === null ? (
          <StatusMessage text={t("serverSettingsMobile.noEnvironment")} />
        ) : null}
        {error === null ? null : <StatusMessage text={error} tone="danger" />}
        {updateError === null ? null : <StatusMessage text={updateError} tone="danger" />}
        {settings === null && environmentId !== null ? (
          <StatusMessage text={t("serverSettingsMobile.loading")} />
        ) : null}
        {serverConfig !== null ? (
          <ServerUpdateSection
            currentVersion={serverConfig.environment.serverVersion}
            capability={selfUpdate}
            targetVersion={targetVersionDraft}
            updateState={serverUpdateState}
            disabled={pending}
            onTargetVersionChange={setTargetVersionDraft}
            onUpdate={() => void runServerUpdate()}
          />
        ) : null}
        {settings !== null && resolvedBackgroundActivity !== null ? (
          <>
            <SettingsSection title={t("serverSettingsMobile.runtimeTitle")} card>
              <SwitchRow
                label={t("serverSettingsMobile.providerUpdates")}
                value={settings.enableProviderUpdateChecks}
                disabled={pending}
                onValueChange={(value) => void persist({ enableProviderUpdateChecks: value })}
              />
              <SwitchRow
                label={t("serverSettingsMobile.agentBrowser")}
                value={settings.enableAgentBrowserAccess}
                disabled={pending}
                onValueChange={(value) => void persist({ enableAgentBrowserAccess: value })}
              />
              <SwitchRow
                label={t("serverSettingsMobile.legacyStreaming")}
                value={settings.enableLegacyTokenStreaming}
                disabled={pending}
                onValueChange={(value) => void persist({ enableLegacyTokenStreaming: value })}
              />
            </SettingsSection>

            <ModelSelectionSection
              settings={settings}
              modelOptions={modelOptions}
              disabled={pending}
              onDefaultModelChange={setDefaultModel}
              onSourceControlWriterModelChange={setSourceControlWriterModel}
              onDedicatedSourceControlWriterChange={(enabled) =>
                void persist({
                  sourceControlWriterModelSelection: enabled
                    ? settings.textGenerationModelSelection
                    : null,
                })
              }
            />

            <SettingsSection title={t("serverSettingsMobile.newThreadsTitle")} card>
              <View className="gap-3 p-4">
                <Field label={t("serverSettingsMobile.defaultMode")}>
                  <ChoiceGroup
                    values={[
                      { id: "local" as const, label: t("serverSettingsMobile.local") },
                      { id: "worktree" as const, label: t("serverSettingsMobile.worktree") },
                    ]}
                    selectedId={settings.defaultThreadEnvMode}
                    disabled={pending}
                    onSelect={(value) => void persist({ defaultThreadEnvMode: value })}
                  />
                </Field>
                {settings.defaultThreadEnvMode === "worktree" ? (
                  <SwitchRow
                    label={t("serverSettingsMobile.startFromOrigin")}
                    value={settings.newWorktreesStartFromOrigin}
                    disabled={pending}
                    onValueChange={(value) => void persist({ newWorktreesStartFromOrigin: value })}
                  />
                ) : null}
                <Field label={t("serverSettingsMobile.projectBaseDirectory")}>
                  <TextInput
                    value={baseDirectoryDraft}
                    onChangeText={setBaseDirectoryDraft}
                    onBlur={() =>
                      void persist({
                        addProjectBaseDirectory: normalizeMobileDirectory(baseDirectoryDraft),
                      })
                    }
                    placeholder={t("serverSettingsMobile.projectBaseDirectoryPlaceholder")}
                    autoCapitalize="none"
                    autoCorrect={false}
                    editable={!pending}
                  />
                </Field>
              </View>
            </SettingsSection>

            <BackgroundActivitySection
              settings={settings}
              resolved={resolvedBackgroundActivity}
              disabled={pending}
              onProfileChange={setBackgroundProfile}
              onCustomProfile={setBackgroundCustom}
              onDurationChange={setBackgroundDuration}
              onBooleanChange={setBackgroundBoolean}
            />

            <SettingsSection title={t("serverSettingsMobile.sourceControlTitle")} card>
              <View className="gap-3 p-4">
                <Field label={t("serverSettingsMobile.writingMode")}>
                  <ChoiceGroup
                    values={[
                      {
                        id: "repo_conventions" as const,
                        label: t("serverSettingsMobile.repoConventions"),
                      },
                      {
                        id: "conventional_commits" as const,
                        label: t("serverSettingsMobile.conventionalCommits"),
                      },
                      { id: "custom" as const, label: t("serverSettingsMobile.custom") },
                    ]}
                    selectedId={settings.sourceControlWritingStyle.mode}
                    disabled={pending}
                    onSelect={(mode) =>
                      void persist({
                        sourceControlWritingStyle: { mode },
                      })
                    }
                  />
                </Field>
                {settings.sourceControlWritingStyle.mode === "custom" ? (
                  <Field label={t("serverSettingsMobile.customInstructions")}>
                    <TextInput
                      value={customInstructionsDraft}
                      onChangeText={setCustomInstructionsDraft}
                      onBlur={() =>
                        void persist({
                          sourceControlWritingStyle: {
                            customInstructions: customInstructionsDraft.trim(),
                          },
                        })
                      }
                      placeholder={t("serverSettingsMobile.customInstructionsPlaceholder")}
                      multiline
                      numberOfLines={4}
                      textAlignVertical="top"
                      editable={!pending}
                    />
                  </Field>
                ) : null}
                <SwitchRow
                  label={t("serverSettingsMobile.followTemplates")}
                  value={settings.sourceControlWritingStyle.followChangeRequestTemplates}
                  disabled={pending}
                  onValueChange={(value) =>
                    void persist({
                      sourceControlWritingStyle: { followChangeRequestTemplates: value },
                    })
                  }
                />
              </View>
            </SettingsSection>

            <SettingsSection title={t("serverSettingsMobile.observabilityTitle")} card>
              <View className="gap-3 p-4">
                <Field label={t("serverSettingsMobile.tracesUrl")}>
                  <TextInput
                    value={tracesUrlDraft}
                    onChangeText={setTracesUrlDraft}
                    onBlur={() =>
                      void persist({
                        observability: {
                          ...settings.observability,
                          otlpTracesUrl: tracesUrlDraft.trim(),
                        },
                      })
                    }
                    placeholder={t("serverSettingsMobile.urlPlaceholder")}
                    autoCapitalize="none"
                    autoCorrect={false}
                    editable={!pending}
                  />
                </Field>
                <Field label={t("serverSettingsMobile.metricsUrl")}>
                  <TextInput
                    value={metricsUrlDraft}
                    onChangeText={setMetricsUrlDraft}
                    onBlur={() =>
                      void persist({
                        observability: {
                          ...settings.observability,
                          otlpMetricsUrl: metricsUrlDraft.trim(),
                        },
                      })
                    }
                    placeholder={t("serverSettingsMobile.urlPlaceholder")}
                    autoCapitalize="none"
                    autoCorrect={false}
                    editable={!pending}
                  />
                </Field>
              </View>
            </SettingsSection>
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

function canUpdateServer(capability: ServerSelfUpdateCapability | null): boolean {
  return capability === "boot-service" || capability === "respawn";
}

function ServerUpdateSection(props: {
  readonly currentVersion: string;
  readonly capability: ServerSelfUpdateCapability | null;
  readonly targetVersion: string;
  readonly updateState: ServerUpdateState;
  readonly disabled: boolean;
  readonly onTargetVersionChange: (value: string) => void;
  readonly onUpdate: () => void;
}) {
  const stateLabel =
    props.updateState.status === "running"
      ? props.updateState.stage === "resuming"
        ? t("serverUpdateMobile.restarting")
        : t("serverUpdateMobile.updating")
      : props.updateState.status === "failed"
        ? props.updateState.message
        : null;

  return (
    <SettingsSection title={t("serverUpdateMobile.title")} card>
      <View className="gap-3 p-4">
        <Text className="text-sm leading-5 text-foreground-muted">
          {t("serverUpdateMobile.description")}
        </Text>
        <Text className="font-mono text-sm text-foreground">
          {`${t("serverUpdateMobile.currentVersion")}: ${props.currentVersion}`}
        </Text>
        {props.capability === "desktop-managed" ? (
          <StatusMessage text={t("serverUpdateMobile.desktopManaged")} />
        ) : !canUpdateServer(props.capability) ? (
          <StatusMessage text={t("serverUpdateMobile.manualOnly")} />
        ) : (
          <>
            <Field label={t("serverUpdateMobile.targetVersion")}>
              <TextInput
                value={props.targetVersion}
                onChangeText={props.onTargetVersionChange}
                placeholder={t("serverUpdateMobile.targetPlaceholder")}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!props.disabled && props.updateState.status !== "running"}
              />
            </Field>
            <Pressable
              accessibilityRole="button"
              disabled={
                props.disabled ||
                props.updateState.status === "running" ||
                props.targetVersion.trim().length === 0
              }
              onPress={props.onUpdate}
              className="self-start rounded-full bg-accent px-4 py-2.5 opacity-100 disabled:opacity-40"
            >
              <Text className="text-sm font-codework-medium text-accent-foreground">
                {t("serverUpdateMobile.update")}
              </Text>
            </Pressable>
          </>
        )}
        {stateLabel ? (
          <Text
            className={
              props.updateState.status === "failed"
                ? "text-sm text-danger-foreground"
                : "text-sm text-foreground-muted"
            }
          >
            {stateLabel}
          </Text>
        ) : null}
      </View>
    </SettingsSection>
  );
}

function ModelSelectionSection(props: {
  readonly settings: ServerSettings;
  readonly modelOptions: ReadonlyArray<ModelOption>;
  readonly disabled: boolean;
  readonly onDefaultModelChange: (selection: ModelSelection) => void;
  readonly onSourceControlWriterModelChange: (selection: ModelSelection) => void;
  readonly onDedicatedSourceControlWriterChange: (enabled: boolean) => void;
}) {
  const dedicatedSelection = props.settings.sourceControlWriterModelSelection;

  return (
    <SettingsSection title={t("serverSettingsMobile.modelTitle")} card>
      <View className="gap-3 p-4">
        <Field label={t("serverSettingsMobile.defaultModel")}>
          <ModelChoiceList
            options={props.modelOptions}
            selected={props.settings.textGenerationModelSelection}
            disabled={props.disabled}
            onSelect={props.onDefaultModelChange}
          />
        </Field>
        <SwitchRow
          label={t("serverSettingsMobile.useDedicatedSourceControlWriter")}
          value={dedicatedSelection !== null}
          disabled={props.disabled}
          onValueChange={props.onDedicatedSourceControlWriterChange}
        />
        {dedicatedSelection !== null ? (
          <Field label={t("serverSettingsMobile.sourceControlWriterModel")}>
            <ModelChoiceList
              options={props.modelOptions}
              selected={dedicatedSelection}
              disabled={props.disabled}
              onSelect={props.onSourceControlWriterModelChange}
            />
          </Field>
        ) : null}
      </View>
    </SettingsSection>
  );
}

function ModelChoiceList(props: {
  readonly options: ReadonlyArray<ModelOption>;
  readonly selected: ModelSelection;
  readonly disabled: boolean;
  readonly onSelect: (selection: ModelSelection) => void;
}) {
  if (props.options.length === 0) {
    return (
      <Text className="text-sm text-foreground-muted">{t("serverSettingsMobile.noModels")}</Text>
    );
  }

  return (
    <View className="overflow-hidden rounded-2xl bg-input">
      {props.options.map((option, index) => {
        const selected =
          option.selection.instanceId === props.selected.instanceId &&
          option.selection.model === props.selected.model;
        return (
          <Pressable
            key={option.key}
            accessibilityRole="radio"
            accessibilityState={{ checked: selected, disabled: props.disabled }}
            disabled={props.disabled}
            onPress={() => props.onSelect(option.selection)}
            className={
              index === 0
                ? "flex-row items-center gap-3 p-3.5"
                : "flex-row items-center gap-3 border-t border-border-subtle p-3.5"
            }
          >
            <View className="min-w-0 flex-1">
              <Text className="text-sm font-codework-medium text-foreground" numberOfLines={1}>
                {option.label}
              </Text>
              <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                {option.subtitle}
              </Text>
            </View>
            {selected ? <Text className="text-base text-accent">✓</Text> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

function BackgroundActivitySection(props: {
  readonly settings: ServerSettings;
  readonly resolved: ReturnType<typeof resolveServerBackgroundActivitySettings>;
  readonly disabled: boolean;
  readonly onProfileChange: (profile: (typeof BACKGROUND_ACTIVITY_PROFILES)[number]) => void;
  readonly onCustomProfile: () => void;
  readonly onDurationChange: (field: DurationSetting, seconds: number) => void;
  readonly onBooleanChange: (field: BackgroundActivityBooleanSetting, value: boolean) => void;
}) {
  const profile = props.settings.backgroundActivity.profile;
  const selectedProfile = profile === "custom" ? "custom" : profile;
  const durationFields: ReadonlyArray<{
    readonly key: DurationSetting;
    readonly label: string;
  }> = [
    {
      key: "automaticGitFetchInterval",
      label: t("serverSettingsMobile.automaticGitFetchInterval"),
    },
    {
      key: "providerHealthRefreshInterval",
      label: t("serverSettingsMobile.providerHealthRefreshInterval"),
    },
    {
      key: "hostPowerMonitorActiveInterval",
      label: t("serverSettingsMobile.hostPowerMonitorActiveInterval"),
    },
    {
      key: "hostPowerMonitorIdleInterval",
      label: t("serverSettingsMobile.hostPowerMonitorIdleInterval"),
    },
    { key: "idleClientTtl", label: t("serverSettingsMobile.idleClientTtl") },
  ];
  const booleanFields: ReadonlyArray<{
    readonly key: BackgroundActivityBooleanSetting;
    readonly label: string;
  }> = [
    { key: "pauseWhenHostLocked", label: t("serverSettingsMobile.pauseWhenHostLocked") },
    { key: "pauseWhenHostLowPower", label: t("serverSettingsMobile.pauseWhenHostLowPower") },
    { key: "pauseWhenClientLowPower", label: t("serverSettingsMobile.pauseWhenClientLowPower") },
    { key: "pauseWhenOnBattery", label: t("serverSettingsMobile.pauseWhenOnBattery") },
  ];

  return (
    <SettingsSection title={t("serverSettingsMobile.backgroundTitle")} card>
      <View className="gap-3 p-4">
        <Text className="text-sm leading-5 text-foreground-muted">
          {t("serverSettingsMobile.backgroundDescription")}
        </Text>
        <Field label={t("serverSettingsMobile.profile")}>
          <ChoiceGroup
            values={[
              { id: "balanced" as const, label: t("serverSettingsMobile.balanced") },
              { id: "performance" as const, label: t("serverSettingsMobile.performance") },
              { id: "battery-saver" as const, label: t("serverSettingsMobile.batterySaver") },
              { id: "custom" as const, label: t("serverSettingsMobile.custom") },
            ]}
            selectedId={selectedProfile}
            disabled={props.disabled}
            onSelect={(value) => {
              if (value === "custom") props.onCustomProfile();
              else props.onProfileChange(value);
            }}
          />
        </Field>
        {durationFields.map((field) => (
          <DurationInput
            key={field.key}
            label={field.label}
            seconds={secondsFromDuration(props.resolved[field.key])}
            disabled={props.disabled}
            onCommit={(seconds) => props.onDurationChange(field.key, seconds)}
          />
        ))}
        {booleanFields.map((field) => (
          <SwitchRow
            key={field.key}
            label={field.label}
            value={props.resolved[field.key]}
            disabled={props.disabled}
            onValueChange={(value) => props.onBooleanChange(field.key, value)}
          />
        ))}
      </View>
    </SettingsSection>
  );
}

function DurationInput(props: {
  readonly label: string;
  readonly seconds: number;
  readonly disabled: boolean;
  readonly onCommit: (seconds: number) => void;
}) {
  const [draft, setDraft] = useState(String(props.seconds));

  useEffect(() => {
    setDraft(String(props.seconds));
  }, [props.seconds]);

  return (
    <Field label={props.label}>
      <TextInput
        value={draft}
        onChangeText={setDraft}
        onBlur={() => props.onCommit(Number(draft))}
        keyboardType="number-pad"
        placeholder={t("serverSettingsMobile.seconds")}
        editable={!props.disabled}
      />
    </Field>
  );
}

function ChoiceGroup<T extends string>(props: {
  readonly values: ReadonlyArray<{ readonly id: T; readonly label: string }>;
  readonly selectedId: T;
  readonly disabled: boolean;
  readonly onSelect: (value: T) => void;
}) {
  return (
    <View className="flex-row flex-wrap gap-2">
      {props.values.map((value) => (
        <Pressable
          key={value.id}
          accessibilityRole="button"
          disabled={props.disabled}
          onPress={() => props.onSelect(value.id)}
          className={
            props.selectedId === value.id
              ? "rounded-full bg-accent px-3 py-2"
              : "rounded-full border border-input-border px-3 py-2"
          }
        >
          <Text
            className={
              props.selectedId === value.id
                ? "text-xs font-codework-medium text-accent-foreground"
                : "text-xs text-foreground"
            }
          >
            {value.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

function Field(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <View className="gap-1.5">
      <Text className="text-sm font-codework-medium text-foreground">{props.label}</Text>
      {props.children}
    </View>
  );
}

function SwitchRow(props: {
  readonly label: string;
  readonly value: boolean;
  readonly disabled: boolean;
  readonly onValueChange: (value: boolean) => void;
}) {
  return (
    <View
      className={
        props.disabled
          ? "flex-row items-center gap-3 opacity-[0.45]"
          : "flex-row items-center gap-3"
      }
    >
      <Text className="min-w-0 flex-1 text-base text-foreground">{props.label}</Text>
      <Switch
        value={props.value}
        disabled={props.disabled}
        onValueChange={props.onValueChange}
        accessibilityLabel={props.label}
      />
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
