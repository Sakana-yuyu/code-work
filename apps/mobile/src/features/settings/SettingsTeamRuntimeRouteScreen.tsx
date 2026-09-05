import {
  multicaProviderInstanceRevision,
  type EnvironmentId,
  type ProviderInstanceConfig,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@codework/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/unstable/reactivity";
import { useNavigation } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Alert, Platform, Pressable, ScrollView, Switch, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@codework/client-runtime/state/runtime";
import {
  emptyMulticaRuntimeDraft,
  formFromMulticaRuntimeInstance,
  nextMulticaRuntimeInstanceId,
  safeMulticaRuntimeUrlLabel,
  teamRuntimeInstancesFromSettings,
  validateMulticaRuntimeDraft,
  type MulticaRuntimeDraft,
} from "@codework/shared/multicaRuntimeSettings";
import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { t } from "../../i18n";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsEnvironmentPicker } from "./components/SettingsEnvironmentPicker";
import { SettingsSection } from "./components/SettingsSection";
import {
  buildMobileTeamRuntimeDeletePatch,
  buildMobileTeamRuntimeSavePatch,
} from "./SettingsTeamRuntimeRouteScreen.logic";

const EMPTY_SERVER_SETTINGS_ATOM = Atom.make<ServerSettings | null>(null).pipe(
  Atom.withLabel("mobile-team-runtime:settings:empty"),
);
const EMPTY_PROVIDER_INSTANCES: ServerSettings["providerInstances"] = {};

export function SettingsTeamRuntimeRouteScreen() {
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
  const saveSettings = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  });
  const [draft, setDraft] = useState<MulticaRuntimeDraft | null>(null);
  const [originalInstanceId, setOriginalInstanceId] = useState<string | null>(null);
  const [expectedRevision, setExpectedRevision] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const providerInstances = settings?.providerInstances ?? EMPTY_PROVIDER_INSTANCES;
  const instances = useMemo(
    () => (settings === null ? [] : teamRuntimeInstancesFromSettings(settings)),
    [settings],
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
    setDraft(null);
    setOriginalInstanceId(null);
    setExpectedRevision(null);
    setError(null);
  }, [environmentId]);

  const openCreate = useCallback(() => {
    if (draft !== null || pending) return;
    setDraft(emptyMulticaRuntimeDraft(nextMulticaRuntimeInstanceId(providerInstances)));
    setOriginalInstanceId(null);
    setExpectedRevision(null);
    setError(null);
  }, [draft, pending, providerInstances]);

  const openEdit = useCallback(
    (instanceId: string, instance: ProviderInstanceConfig) => {
      if (draft !== null || pending) return;
      const nextDraft = formFromMulticaRuntimeInstance(instanceId, instance);
      if (nextDraft === null) {
        setError(t("teamRuntimeMobile.invalidStoredConfiguration"));
        return;
      }
      setDraft(nextDraft);
      setOriginalInstanceId(instanceId);
      setExpectedRevision(multicaProviderInstanceRevision(instanceId, instance));
      setError(null);
    },
    [draft, pending],
  );

  const closeEditor = useCallback(() => {
    if (pending) return;
    setDraft(null);
    setOriginalInstanceId(null);
    setExpectedRevision(null);
    setError(null);
  }, [pending]);

  const persist = useCallback(
    async (patch: ServerSettingsPatch, failureMessage: string): Promise<boolean> => {
      if (environmentId === null) return false;
      setPending(true);
      setError(null);
      const result = await saveSettings({ environmentId, input: { patch } });
      setPending(false);
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) return false;
        const failure = squashAtomCommandFailure(result);
        const metadata = failure as { readonly _tag?: unknown; readonly name?: unknown };
        setError(
          metadata._tag === "ServerSettingsConflictError" ||
            metadata.name === "ServerSettingsConflictError"
            ? t("teamRuntimeMobile.conflict")
            : failureMessage,
        );
        return false;
      }
      return true;
    },
    [environmentId, saveSettings],
  );

  const save = useCallback(async () => {
    if (draft === null || pending || settings === null) return;
    const validation = validateMulticaRuntimeDraft(draft);
    if (!validation.ok) {
      setError(t("teamRuntimeMobile.invalidConfiguration"));
      return;
    }
    const saved = await persist(
      buildMobileTeamRuntimeSavePatch(
        settings,
        originalInstanceId,
        expectedRevision,
        validation.value,
      ),
      t("teamRuntimeMobile.saveFailed"),
    );
    if (saved) closeEditor();
  }, [closeEditor, draft, expectedRevision, originalInstanceId, pending, persist, settings]);

  const deleteInstance = useCallback(
    (instanceId: string, instance: ProviderInstanceConfig) => {
      if (pending || draft !== null) return;
      Alert.alert(
        t("teamRuntimeMobile.deleteTitle", {
          name: safeTeamLabel(instance.displayName, instanceId),
        }),
        t("teamRuntimeMobile.deleteDescription"),
        [
          { text: t("cancel"), style: "cancel" },
          {
            text: t("delete"),
            style: "destructive",
            onPress: () => {
              void persist(
                buildMobileTeamRuntimeDeletePatch(instanceId, instance),
                t("teamRuntimeMobile.deleteFailed"),
              );
            },
          },
        ],
      );
    },
    [draft, pending, persist],
  );

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader
            title={t("teamRuntimeMobile.title")}
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
          {t("teamRuntimeMobile.description")}
        </Text>
        <SettingsEnvironmentPicker
          environments={environments}
          selectedEnvironmentId={environmentId}
          disabled={pending || draft !== null}
          onSelect={(next) => {
            setSelectedEnvironmentId(next);
            setError(null);
          }}
        />
        {environmentId === null ? (
          <StatusMessage text={t("teamRuntimeMobile.noEnvironment")} />
        ) : (
          <>
            <SettingsSection title={t("teamRuntimeMobile.title")}>
              <View className="gap-3 p-4">
                <View className="flex-row items-center gap-2">
                  <Text className="min-w-0 flex-1 text-sm text-foreground-muted">
                    {instances.length === 0
                      ? t("teamRuntimeMobile.noTeams")
                      : `${instances.length}`}
                  </Text>
                  <ActionButton
                    label={t("teamRuntimeMobile.new")}
                    disabled={pending || draft !== null}
                    emphasized
                    onPress={openCreate}
                  />
                </View>
                {instances.map((entry) => {
                  const instanceId = String(entry.instanceId);
                  return (
                    <TeamRuntimeCard
                      key={instanceId}
                      instanceId={instanceId}
                      instance={entry.instance}
                      disabled={pending || draft !== null}
                      onEdit={() => openEdit(instanceId, entry.instance)}
                      onDelete={() => deleteInstance(instanceId, entry.instance)}
                    />
                  );
                })}
              </View>
            </SettingsSection>

            {error === null ? null : (
              <Text selectable className="px-2 text-sm text-danger-foreground">
                {error}
              </Text>
            )}

            {draft === null ? null : (
              <TeamRuntimeEditor
                draft={draft}
                pending={pending}
                onChange={setDraft}
                onCancel={closeEditor}
                onSave={() => void save()}
              />
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}

function TeamRuntimeCard(props: {
  readonly instanceId: string;
  readonly instance: ProviderInstanceConfig;
  readonly disabled: boolean;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
}) {
  const draft = formFromMulticaRuntimeInstance(props.instanceId, props.instance);
  const url = draft === null ? null : safeMulticaRuntimeUrlLabel(draft.baseUrl);
  return (
    <View className="gap-2 rounded-[20px] bg-card p-4">
      <View className="flex-row items-center gap-2">
        <Text
          className="min-w-0 flex-1 text-base font-codework-medium text-foreground"
          numberOfLines={1}
        >
          {safeTeamLabel(props.instance.displayName, props.instanceId)}
        </Text>
        <BadgePill
          label={
            props.instance.enabled === false
              ? t("teamRuntimeMobile.disabled")
              : t("teamRuntimeMobile.enabled")
          }
        />
      </View>
      <Text className="font-mono text-xs text-foreground-muted" numberOfLines={1}>
        {props.instanceId}
      </Text>
      {draft === null ? (
        <Text className="text-sm text-danger-foreground">
          {t("teamRuntimeMobile.invalidStoredConfiguration")}
        </Text>
      ) : (
        <Text className="text-xs text-foreground-muted" numberOfLines={2}>
          {t("teamRuntimeMobile.urlSummary", {
            runtimeId: draft.runtimeId,
            url: url ?? draft.baseUrl,
          })}
        </Text>
      )}
      <View className="flex-row flex-wrap gap-2">
        <ActionButton
          label={t("teamRuntimeMobile.edit")}
          disabled={props.disabled || draft === null}
          onPress={props.onEdit}
        />
        <ActionButton
          label={t("teamRuntimeMobile.delete")}
          disabled={props.disabled}
          onPress={props.onDelete}
        />
      </View>
    </View>
  );
}

function TeamRuntimeEditor(props: {
  readonly draft: MulticaRuntimeDraft;
  readonly pending: boolean;
  readonly onChange: (draft: MulticaRuntimeDraft) => void;
  readonly onCancel: () => void;
  readonly onSave: () => void;
}) {
  const draft = props.draft;
  const update = <K extends keyof MulticaRuntimeDraft>(key: K, value: MulticaRuntimeDraft[K]) =>
    props.onChange({ ...draft, [key]: value });
  const validation = validateMulticaRuntimeDraft(draft);
  const updateEnvironment = (
    index: number,
    patch: Partial<MulticaRuntimeDraft["environment"][number]>,
  ) =>
    update(
      "environment",
      draft.environment.map((entry, entryIndex) =>
        entryIndex === index ? { ...entry, ...patch } : entry,
      ),
    );
  const updateEnvironmentValue = (index: number, value: string) => {
    const next = { ...draft.environment[index]!, value };
    if (value.length > 0) {
      delete next.valueRedacted;
      delete next.originalName;
    }
    updateEnvironment(index, next);
  };
  const updateRoute = (
    index: number,
    patch: Partial<MulticaRuntimeDraft["assigneeRoutes"][number]>,
  ) =>
    update(
      "assigneeRoutes",
      draft.assigneeRoutes.map((entry, entryIndex) =>
        entryIndex === index ? { ...entry, ...patch } : entry,
      ),
    );
  const extension = draft.taskExecutionExtension;

  return (
    <SettingsSection title={t("teamRuntimeMobile.editorTitle")} card>
      <View className="gap-4 p-4">
        <Text className="text-sm text-foreground-muted">
          {t("teamRuntimeMobile.editorDescription")}
        </Text>
        <SettingsSection title={t("teamRuntimeMobile.core")} card>
          <View className="gap-3 p-4">
            <Field label={t("teamRuntimeMobile.instanceId")}>
              <TextInput
                value={draft.instanceId}
                onChangeText={(value) => update("instanceId", value)}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!props.pending}
              />
            </Field>
            <Field label={t("teamRuntimeMobile.runtimeId")}>
              <TextInput
                value={draft.runtimeId}
                onChangeText={(value) => update("runtimeId", value)}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!props.pending}
              />
            </Field>
            <Field label={t("teamRuntimeMobile.daemonId")}>
              <TextInput
                value={draft.daemonId}
                onChangeText={(value) => update("daemonId", value)}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!props.pending}
              />
            </Field>
            <Field label={t("teamRuntimeMobile.daemonRuntimeId")}>
              <TextInput
                value={draft.daemonRuntimeId}
                onChangeText={(value) => update("daemonRuntimeId", value)}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!props.pending}
              />
            </Field>
            <Field label={t("teamRuntimeMobile.baseUrl")}>
              <TextInput
                value={draft.baseUrl}
                onChangeText={(value) => update("baseUrl", value)}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                editable={!props.pending}
              />
            </Field>
            <Field label={t("teamRuntimeMobile.version")}>
              <TextInput
                value={draft.version}
                onChangeText={(value) => update("version", value)}
                placeholder={t("teamRuntimeMobile.optional")}
                editable={!props.pending}
              />
            </Field>
            <ToggleRow
              label={t("teamRuntimeMobile.enabled")}
              value={draft.enabled}
              disabled={props.pending}
              onValueChange={(value) => update("enabled", value)}
            />
          </View>
        </SettingsSection>

        <SettingsSection title={t("teamRuntimeMobile.headers")} card>
          <View className="gap-3 p-4">
            {draft.headers.map((header, index) => (
              // eslint-disable-next-line react/no-array-index-key -- 草稿行没有持久化 ID，位置键可避免输入时整行重挂载。
              <View key={`header-${index}`} className="gap-2 rounded-[16px] bg-subtle p-3">
                <Field label={t("teamRuntimeMobile.headerName")}>
                  <TextInput
                    value={header.headerName}
                    onChangeText={(value) =>
                      update(
                        "headers",
                        draft.headers.map((entry, entryIndex) =>
                          entryIndex === index ? { ...entry, headerName: value } : entry,
                        ),
                      )
                    }
                    autoCapitalize="none"
                    autoCorrect={false}
                    editable={!props.pending}
                  />
                </Field>
                <Field label={t("teamRuntimeMobile.environmentVariable")}>
                  <TextInput
                    value={header.environmentVariable}
                    onChangeText={(value) =>
                      update(
                        "headers",
                        draft.headers.map((entry, entryIndex) =>
                          entryIndex === index ? { ...entry, environmentVariable: value } : entry,
                        ),
                      )
                    }
                    autoCapitalize="none"
                    autoCorrect={false}
                    editable={!props.pending}
                  />
                </Field>
                <ActionButton
                  label={t("teamRuntimeMobile.removeHeader")}
                  disabled={props.pending}
                  onPress={() =>
                    update(
                      "headers",
                      draft.headers.filter((_, entryIndex) => entryIndex !== index),
                    )
                  }
                />
              </View>
            ))}
            <ActionButton
              label={t("teamRuntimeMobile.addHeader")}
              disabled={props.pending}
              onPress={() =>
                update("headers", [...draft.headers, { headerName: "", environmentVariable: "" }])
              }
            />
          </View>
        </SettingsSection>

        <SettingsSection title={t("teamRuntimeMobile.environment")} card>
          <View className="gap-3 p-4">
            {draft.environment.map((entry, index) => (
              // eslint-disable-next-line react/no-array-index-key -- 草稿行没有持久化 ID，位置键可避免输入时整行重挂载。
              <View key={`environment-${index}`} className="gap-2 rounded-[16px] bg-subtle p-3">
                <Field label={t("teamRuntimeMobile.environmentName")}>
                  <TextInput
                    value={entry.name}
                    onChangeText={(value) => updateEnvironment(index, { name: value })}
                    autoCapitalize="characters"
                    autoCorrect={false}
                    editable={!props.pending}
                  />
                </Field>
                <Field label={t("teamRuntimeMobile.environmentValue")}>
                  <TextInput
                    value={entry.value}
                    onChangeText={(value) => updateEnvironmentValue(index, value)}
                    secureTextEntry={entry.sensitive}
                    placeholder={
                      entry.valueRedacted === true ? t("teamRuntimeMobile.storedValue") : undefined
                    }
                    editable={!props.pending}
                  />
                </Field>
                {entry.valueRedacted === true ? (
                  <Text className="text-xs text-foreground-muted">
                    {t("teamRuntimeMobile.storedValue")}
                  </Text>
                ) : null}
                <ToggleRow
                  label={t("teamRuntimeMobile.sensitive")}
                  value={entry.sensitive}
                  disabled={props.pending}
                  onValueChange={(value) => updateEnvironment(index, { sensitive: value })}
                />
                <ActionButton
                  label={t("teamRuntimeMobile.removeEnvironment")}
                  disabled={props.pending}
                  onPress={() =>
                    update(
                      "environment",
                      draft.environment.filter((_, entryIndex) => entryIndex !== index),
                    )
                  }
                />
              </View>
            ))}
            <ActionButton
              label={t("teamRuntimeMobile.addEnvironment")}
              disabled={props.pending}
              onPress={() =>
                update("environment", [
                  ...draft.environment,
                  { name: "", value: "", sensitive: false },
                ])
              }
            />
          </View>
        </SettingsSection>

        <SettingsSection title={t("teamRuntimeMobile.routing")} card>
          <View className="gap-3 p-4">
            {draft.assigneeRoutes.map((route, index) => (
              // eslint-disable-next-line react/no-array-index-key -- 草稿行没有持久化 ID，位置键可避免输入时整行重挂载。
              <View key={`route-${index}`} className="gap-2 rounded-[16px] bg-subtle p-3">
                <RouteField
                  label={t("teamRuntimeMobile.codeworkAgentId")}
                  value={route.codeworkAgentId}
                  disabled={props.pending}
                  onChange={(value) => updateRoute(index, { codeworkAgentId: value })}
                />
                <RouteField
                  label={t("teamRuntimeMobile.codeworkSquadId")}
                  value={route.codeworkSquadId}
                  disabled={props.pending}
                  onChange={(value) => updateRoute(index, { codeworkSquadId: value })}
                />
                <RouteField
                  label={t("teamRuntimeMobile.workspaceId")}
                  value={route.workspaceId}
                  disabled={props.pending}
                  onChange={(value) => updateRoute(index, { workspaceId: value })}
                />
                <RouteField
                  label={t("teamRuntimeMobile.multicaAgentId")}
                  value={route.multicaAgentId}
                  disabled={props.pending}
                  onChange={(value) => updateRoute(index, { multicaAgentId: value })}
                />
                <RouteField
                  label={t("teamRuntimeMobile.multicaSquadId")}
                  value={route.multicaSquadId}
                  disabled={props.pending}
                  onChange={(value) => updateRoute(index, { multicaSquadId: value })}
                />
                <RouteField
                  label={t("teamRuntimeMobile.mcpCredential")}
                  value={route.codeworkMcpCredentialEnvironmentVariable}
                  disabled={props.pending}
                  onChange={(value) =>
                    updateRoute(index, { codeworkMcpCredentialEnvironmentVariable: value })
                  }
                />
                <ActionButton
                  label={t("teamRuntimeMobile.removeRoute")}
                  disabled={props.pending}
                  onPress={() =>
                    update(
                      "assigneeRoutes",
                      draft.assigneeRoutes.filter((_, entryIndex) => entryIndex !== index),
                    )
                  }
                />
              </View>
            ))}
            <ActionButton
              label={t("teamRuntimeMobile.addRoute")}
              disabled={props.pending}
              onPress={() =>
                update("assigneeRoutes", [
                  ...draft.assigneeRoutes,
                  {
                    codeworkAgentId: "",
                    codeworkSquadId: "",
                    workspaceId: "",
                    multicaAgentId: "",
                    multicaSquadId: "",
                    codeworkMcpCredentialEnvironmentVariable: "",
                  },
                ])
              }
            />
          </View>
        </SettingsSection>

        <SettingsSection title={t("teamRuntimeMobile.capabilities")} card>
          <View className="gap-3 p-4">
            <Field label={t("teamRuntimeMobile.capabilities")}>
              <TextInput
                value={draft.capabilities.join(", ")}
                onChangeText={(value) => update("capabilities", value.split(","))}
                placeholder={t("teamRuntimeMobile.capabilitiesHint")}
                editable={!props.pending}
              />
            </Field>
            <ToggleRow
              label={t("teamRuntimeMobile.supportsResume")}
              value={draft.supportsResume}
              disabled={props.pending}
              onValueChange={(value) => update("supportsResume", value)}
            />
            <ToggleRow
              label={t("teamRuntimeMobile.supportsMcp")}
              value={draft.supportsMcp}
              disabled={props.pending}
              onValueChange={(value) =>
                value
                  ? update("supportsMcp", true)
                  : props.onChange({
                      ...draft,
                      supportsMcp: false,
                      taskMcpEndpoint: "",
                      assigneeRoutes: draft.assigneeRoutes.map((route) => ({
                        ...route,
                        codeworkMcpCredentialEnvironmentVariable: "",
                      })),
                    })
              }
            />
            <ToggleRow
              label={t("teamRuntimeMobile.supportsSquad")}
              value={draft.supportsSquad}
              disabled={props.pending}
              onValueChange={(value) => update("supportsSquad", value)}
            />
            <ToggleRow
              label={t("teamRuntimeMobile.supportsLeader")}
              value={draft.supportsLeader}
              disabled={props.pending}
              onValueChange={(value) => update("supportsLeader", value)}
            />
            <ToggleRow
              label={t("teamRuntimeMobile.supportsTaskGraph")}
              value={draft.supportsTaskGraph}
              disabled={props.pending}
              onValueChange={(value) => update("supportsTaskGraph", value)}
            />
            <Field label={t("teamRuntimeMobile.taskMcpEndpoint")}>
              <TextInput
                value={draft.taskMcpEndpoint}
                onChangeText={(value) => update("taskMcpEndpoint", value)}
                keyboardType="url"
                autoCapitalize="none"
                autoCorrect={false}
                editable={!props.pending && draft.supportsMcp}
              />
            </Field>
          </View>
        </SettingsSection>

        <SettingsSection title={t("teamRuntimeMobile.execution")} card>
          <View className="gap-3 p-4">
            <Text className="text-xs text-foreground-muted">
              {t("teamRuntimeMobile.executionHint")}
            </Text>
            <Field label={t("teamRuntimeMobile.command")}>
              <TextInput
                value={extension.command}
                onChangeText={(value) =>
                  update("taskExecutionExtension", { ...extension, command: value })
                }
                autoCapitalize="none"
                autoCorrect={false}
                editable={!props.pending}
              />
            </Field>
            <Field label={t("teamRuntimeMobile.cwd")}>
              <TextInput
                value={extension.cwd}
                onChangeText={(value) =>
                  update("taskExecutionExtension", { ...extension, cwd: value })
                }
                autoCapitalize="none"
                autoCorrect={false}
                editable={!props.pending}
              />
            </Field>
            <Field label={t("teamRuntimeMobile.timeout")}>
              <TextInput
                value={extension.timeoutMs}
                onChangeText={(value) =>
                  update("taskExecutionExtension", { ...extension, timeoutMs: value })
                }
                keyboardType="number-pad"
                editable={!props.pending}
              />
            </Field>
            <Field label={t("teamRuntimeMobile.args")}>
              <TextInput
                value={extension.args.join("\n")}
                onChangeText={(value) =>
                  update("taskExecutionExtension", {
                    ...extension,
                    args: value.length === 0 ? [] : value.split("\n"),
                  })
                }
                multiline
                textAlignVertical="top"
                placeholder={t("teamRuntimeMobile.argsHint")}
                className="min-h-24 font-mono"
                editable={!props.pending}
              />
            </Field>
          </View>
        </SettingsSection>

        {!validation.ok ? (
          <Text className="text-sm text-danger-foreground">
            {t("teamRuntimeMobile.invalidConfiguration")}
          </Text>
        ) : null}
        <View className="flex-row flex-wrap gap-2">
          <ActionButton
            label={t("teamRuntimeMobile.cancel")}
            disabled={props.pending}
            onPress={props.onCancel}
          />
          <ActionButton
            label={props.pending ? t("teamRuntimeMobile.saving") : t("teamRuntimeMobile.save")}
            disabled={props.pending || !validation.ok}
            emphasized
            onPress={props.onSave}
          />
        </View>
      </View>
    </SettingsSection>
  );
}

function Field(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <View className="gap-2">
      <Text className="text-sm font-codework-medium text-foreground">{props.label}</Text>
      {props.children}
    </View>
  );
}

function RouteField(props: {
  readonly label: string;
  readonly value: string;
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
}) {
  return (
    <Field label={props.label}>
      <TextInput
        value={props.value}
        onChangeText={props.onChange}
        autoCapitalize="none"
        autoCorrect={false}
        editable={!props.disabled}
      />
    </Field>
  );
}

function ToggleRow(props: {
  readonly label: string;
  readonly value: boolean;
  readonly disabled: boolean;
  readonly onValueChange: (value: boolean) => void;
}) {
  return (
    <View className="flex-row items-center gap-3">
      <Text className="min-w-0 flex-1 text-sm text-foreground">{props.label}</Text>
      <Switch
        value={props.value}
        onValueChange={props.onValueChange}
        disabled={props.disabled}
        accessibilityLabel={props.label}
      />
    </View>
  );
}

function ActionButton(props: {
  readonly label: string;
  readonly disabled: boolean;
  readonly emphasized?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      className={
        props.disabled
          ? "rounded-full bg-subtle px-3 py-1.5 opacity-[0.45]"
          : props.emphasized
            ? "rounded-full bg-subtle-strong px-3 py-1.5"
            : "rounded-full bg-card px-3 py-1.5"
      }
    >
      <Text className="text-sm font-codework-medium text-foreground">{props.label}</Text>
    </Pressable>
  );
}

function BadgePill(props: { readonly label: string }) {
  return (
    <View className="rounded-full bg-subtle px-2.5 py-0.5">
      <Text className="text-xs text-foreground">{props.label}</Text>
    </View>
  );
}

function StatusMessage(props: { readonly text: string }) {
  return (
    <View className="rounded-[24px] bg-card px-4 py-7">
      <Text className="text-center text-sm text-foreground-muted">{props.text}</Text>
    </View>
  );
}

function safeTeamLabel(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return (trimmed && trimmed.length > 0 ? trimmed : fallback).replace(
    /multica/giu,
    t("teamRuntimeMobile.multicaAlias"),
  );
}
