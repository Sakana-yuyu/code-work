import { useAtomValue } from "@effect/atom-react";
import {
  ProviderDriverKind,
  type CompositionIdeResolveResult,
  type CompositionIdeRuntimeProfile,
  type EnvironmentId,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironmentVariable,
  type ServerSettings,
} from "@codework/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@codework/client-runtime/state/runtime";
import {
  configFromIdeSessionDraft,
  emptyIdeSessionDraft,
  formFromIdeInstance,
  type IdeSessionDraft,
  type IdeSessionHeaderDraft,
} from "@codework/shared/ideSessionSettings";
import { Atom } from "effect/unstable/reactivity";
import { useNavigation } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Alert, Platform, Pressable, RefreshControl, ScrollView, Switch, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { t } from "../../i18n";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsEnvironmentPicker } from "./components/SettingsEnvironmentPicker";
import { SettingsSection } from "./components/SettingsSection";

const EMPTY_SERVER_SETTINGS_ATOM = Atom.make<ServerSettings | null>(null).pipe(
  Atom.withLabel("mobile-ide-sessions:settings:empty"),
);
const EMPTY_INSTANCES: Readonly<Record<string, ProviderInstanceConfig>> = {};

export function SettingsIdeSessionsRouteScreen() {
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
  const statusQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.compositionIdeSessions({ environmentId, input: {} }),
  );
  const saveSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<IdeSessionDraft>(emptyIdeSessionDraft());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (
      selectedEnvironmentId !== null &&
      environments.some((item) => item.environmentId === selectedEnvironmentId)
    ) {
      return;
    }
    setSelectedEnvironmentId(environments[0]?.environmentId ?? null);
    setEditingId(null);
  }, [environments, selectedEnvironmentId]);

  const instances = (settings?.providerInstances ?? EMPTY_INSTANCES) as Readonly<
    Record<string, ProviderInstanceConfig>
  >;
  const ideEntries = useMemo(
    () => Object.entries(instances).filter(([, instance]) => instance.driver === "ide"),
    [instances],
  );
  const statuses = useMemo(
    () => new Map((statusQuery.data ?? []).map((status) => [status.sessionId, status] as const)),
    [statusQuery.data],
  );

  const nextInstanceId = useCallback(() => {
    let index = 1;
    let candidate = "ide_local";
    while (instances[candidate] !== undefined) {
      index += 1;
      candidate = `ide_local_${index}`;
    }
    return candidate;
  }, [instances]);

  const persist = useCallback(
    async (nextInstances: Record<string, ProviderInstanceConfig>): Promise<boolean> => {
      if (environmentId === null) return false;
      setSaving(true);
      const result = await saveSettings({
        environmentId,
        input: {
          patch: { providerInstances: nextInstances as ServerSettings["providerInstances"] },
        },
      });
      setSaving(false);
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const failure = squashAtomCommandFailure(result);
          setError(failure instanceof Error ? failure.message : t("ideSessionsMobile.saveFailed"));
        }
        return false;
      }
      setError(null);
      statusQuery.refresh();
      return true;
    },
    [environmentId, saveSettings, statusQuery],
  );

  const beginNew = useCallback(() => {
    setError(null);
    setForm(emptyIdeSessionDraft(nextInstanceId()));
    setEditingId("__new__");
  }, [nextInstanceId]);

  const beginEdit = useCallback((instanceId: string, instance: ProviderInstanceConfig) => {
    setError(null);
    setForm(formFromIdeInstance(instanceId, instance) ?? emptyIdeSessionDraft(instanceId));
    setEditingId(instanceId);
  }, []);

  const saveForm = useCallback(async () => {
    const saved = configFromIdeSessionDraft(form);
    if (saved === null) {
      setError(t("ideSessionsMobile.invalidForm"));
      return;
    }
    const previousId = editingId !== null && editingId !== "__new__" ? editingId : null;
    if (saved.instanceId !== previousId && instances[saved.instanceId] !== undefined) {
      setError(t("ideSessionsMobile.instanceExists"));
      return;
    }
    const nextInstances = { ...instances };
    if (previousId !== null && previousId !== saved.instanceId) delete nextInstances[previousId];
    nextInstances[saved.instanceId] = {
      driver: ProviderDriverKind.make("ide"),
      enabled: saved.config.enabled,
      environment: saved.environment,
      config: saved.config,
    };
    if (await persist(nextInstances)) setEditingId(null);
  }, [editingId, form, instances, persist]);

  const deleteSession = useCallback(
    (instanceId: string) => {
      Alert.alert(t("ideSessionsMobile.deleteTitle"), t("ideSessionsMobile.deleteDescription"), [
        { text: t("cancel"), style: "cancel" },
        {
          text: t("delete"),
          style: "destructive",
          onPress: () => {
            const nextInstances = { ...instances };
            delete nextInstances[instanceId];
            void persist(nextInstances).then((saved) => {
              if (saved && editingId === instanceId) setEditingId(null);
            });
          },
        },
      ]);
    },
    [editingId, instances, persist],
  );

  const toggleEnabled = useCallback(
    (instanceId: string, enabled: boolean) => {
      const instance = instances[instanceId];
      if (instance === undefined) return;
      void persist({ ...instances, [instanceId]: { ...instance, enabled } });
    },
    [instances, persist],
  );

  return (
    <View className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader
            title={t("ideSessionsMobile.title")}
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
            refreshing={statusQuery.isPending && statusQuery.data !== null}
            onRefresh={statusQuery.refresh}
          />
        }
      >
        <Text className="px-2 text-sm leading-5 text-foreground-muted">
          {t("ideSessionsMobile.description")}
        </Text>
        <SettingsEnvironmentPicker
          environments={environments}
          selectedEnvironmentId={environmentId}
          disabled={saving}
          onSelect={(next) => {
            setSelectedEnvironmentId(next);
            setEditingId(null);
            setError(null);
          }}
        />
        {environmentId === null ? (
          <StatusMessage text={t("ideSessionsMobile.noEnvironment")} />
        ) : null}
        {error === null ? null : <StatusMessage text={error} tone="danger" />}
        {editingId !== null ? (
          <IdeSessionEditor
            form={form}
            editing={editingId !== "__new__"}
            disabled={saving}
            onChange={(patch) => setForm((current) => ({ ...current, ...patch }))}
            onSave={() => void saveForm()}
            onCancel={() => setEditingId(null)}
          />
        ) : null}
        <SettingsSection title={t("ideSessionsMobile.title")} card>
          <View className="border-b border-border-subtle p-4">
            <ActionButton
              label={t("ideSessionsMobile.add")}
              disabled={environmentId === null || editingId !== null || saving}
              emphasized
              onPress={beginNew}
            />
          </View>
          {environmentId !== null && statusQuery.data === null && statusQuery.isPending ? (
            <StatusMessage text={t("ideSessionsMobile.loading")} />
          ) : null}
          {ideEntries.length === 0 && editingId === null ? (
            <StatusMessage
              text={t("ideSessionsMobile.empty")}
              detail={t("ideSessionsMobile.emptyDescription")}
            />
          ) : null}
          {ideEntries.map(([instanceId, instance]) => {
            const draft =
              formFromIdeInstance(instanceId, instance) ?? emptyIdeSessionDraft(instanceId);
            return (
              <IdeSessionCard
                key={instanceId}
                instanceId={instanceId}
                instance={instance}
                draft={draft}
                status={statuses.get(draft.sessionId)}
                disabled={saving || editingId !== null}
                onToggle={(enabled) => toggleEnabled(instanceId, enabled)}
                onEdit={() => beginEdit(instanceId, instance)}
                onDelete={() => deleteSession(instanceId)}
              />
            );
          })}
          <View className="border-t border-border-subtle p-4">
            <Text className="text-xs leading-5 text-foreground-muted">
              {t("ideSessionsMobile.authorizationDescription")}
            </Text>
          </View>
        </SettingsSection>
      </ScrollView>
    </View>
  );
}

function IdeSessionCard(props: {
  readonly instanceId: string;
  readonly instance: ProviderInstanceConfig;
  readonly draft: IdeSessionDraft;
  readonly status: CompositionIdeResolveResult | undefined;
  readonly disabled: boolean;
  readonly onToggle: (enabled: boolean) => void;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
}) {
  const enabled = props.instance.enabled ?? props.draft.enabled;
  return (
    <View className="gap-3 border-b border-border-subtle p-4 last:border-b-0">
      <View className="flex-row items-start gap-3">
        <View className="min-w-0 flex-1 gap-1">
          <Text className="text-base font-codework-medium text-foreground" numberOfLines={1}>
            {props.draft.sessionId}
          </Text>
          <Text className="font-mono text-xs text-foreground-muted" numberOfLines={1}>
            {`${props.instanceId} · ${props.draft.profile}`}
          </Text>
          <SessionStatus status={props.status} />
        </View>
        <Switch
          value={enabled}
          disabled={props.disabled}
          onValueChange={props.onToggle}
          accessibilityLabel={t("ideSessionsMobile.enabled")}
        />
      </View>
      <View className="gap-1">
        <Text className="font-mono text-xs leading-5 text-foreground-muted" numberOfLines={2}>
          {props.draft.url}
        </Text>
        {props.draft.environment.some((entry) => entry.valueRedacted === true) ? (
          <Text className="text-xs text-warning-foreground">
            {t("ideSessionsMobile.sensitiveConfigured")}
          </Text>
        ) : null}
        {props.status?.verifiedOperations.length ? (
          <Text className="text-xs text-foreground-muted">
            {`${t("ideSessionsMobile.verifiedOperations")}: ${props.status.verifiedOperations.length}`}
          </Text>
        ) : null}
      </View>
      <View className="flex-row flex-wrap gap-2">
        <ActionButton label={t("edit")} disabled={props.disabled} onPress={props.onEdit} />
        <ActionButton
          label={t("delete")}
          disabled={props.disabled}
          danger
          onPress={props.onDelete}
        />
      </View>
    </View>
  );
}

function SessionStatus(props: { readonly status: CompositionIdeResolveResult | undefined }) {
  const label =
    props.status?.status === "ready"
      ? t("ideSessionsMobile.ready")
      : props.status?.status === "incomplete"
        ? t("ideSessionsMobile.registeredIncomplete")
        : props.status?.status === "unavailable"
          ? t("ideSessionsMobile.unavailable")
          : t("ideSessionsMobile.notRegistered");
  return (
    <Text
      className={
        props.status?.status === "ready"
          ? "text-xs text-success-foreground"
          : props.status?.status === "unavailable"
            ? "text-xs text-danger-foreground"
            : "text-xs text-foreground-muted"
      }
    >
      {`${label}${props.status?.reasonCode ? ` · ${props.status.reasonCode}` : ""}`}
    </Text>
  );
}

function IdeSessionEditor(props: {
  readonly form: IdeSessionDraft;
  readonly editing: boolean;
  readonly disabled: boolean;
  readonly onChange: (patch: Partial<IdeSessionDraft>) => void;
  readonly onSave: () => void;
  readonly onCancel: () => void;
}) {
  return (
    <SettingsSection
      title={props.editing ? t("ideSessionsMobile.edit") : t("ideSessionsMobile.add")}
      card
    >
      <View className="gap-3 p-4">
        <Field label={t("ideSessionsMobile.sessionId")}>
          <TextInput
            value={props.form.sessionId}
            onChangeText={(sessionId) => props.onChange({ sessionId })}
            placeholder="vscode-session-1"
            autoCapitalize="none"
            autoCorrect={false}
            editable={!props.disabled}
          />
        </Field>
        <Field label={t("ideSessionsMobile.profile")}>
          <ChoiceGroup
            values={
              [
                ["cursor_ide", t("ideSessionsMobile.profileCursor")],
                ["vscode_ide", t("ideSessionsMobile.profileVsCode")],
                ["browser_mcp", t("ideSessionsMobile.profileBrowserMcp")],
              ] satisfies ReadonlyArray<readonly [CompositionIdeRuntimeProfile, string]>
            }
            selectedId={props.form.profile}
            disabled={props.disabled}
            onSelect={(profile) => props.onChange({ profile })}
          />
        </Field>
        <Field label={t("ideSessionsMobile.instanceId")}>
          <TextInput
            value={props.form.instanceId}
            onChangeText={(instanceId) => props.onChange({ instanceId })}
            editable={!props.disabled && !props.editing}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </Field>
        <Field label={t("ideSessionsMobile.websocketUrl")}>
          <TextInput
            value={props.form.url}
            onChangeText={(url) => props.onChange({ url })}
            placeholder={t("ideSessionsMobile.websocketUrlPlaceholder")}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!props.disabled}
          />
        </Field>
        <HeaderEditor
          values={props.form.headers}
          disabled={props.disabled}
          onChange={(headers) => props.onChange({ headers })}
        />
        <EnvironmentEditor
          values={props.form.environment}
          disabled={props.disabled}
          onChange={(environment) => props.onChange({ environment })}
        />
        <View className="gap-3">
          <Field label={t("ideSessionsMobile.openTimeout")}>
            <TextInput
              value={props.form.openTimeoutMs}
              onChangeText={(openTimeoutMs) => props.onChange({ openTimeoutMs })}
              inputMode="numeric"
              editable={!props.disabled}
            />
          </Field>
          <Field label={t("ideSessionsMobile.requestTimeout")}>
            <TextInput
              value={props.form.requestTimeoutMs}
              onChangeText={(requestTimeoutMs) => props.onChange({ requestTimeoutMs })}
              inputMode="numeric"
              editable={!props.disabled}
            />
          </Field>
          <Field label={t("ideSessionsMobile.reconnectDelays")}>
            <TextInput
              value={props.form.reconnectDelaysMs}
              onChangeText={(reconnectDelaysMs) => props.onChange({ reconnectDelaysMs })}
              placeholder="250, 1000, 3000"
              inputMode="numeric"
              editable={!props.disabled}
            />
          </Field>
        </View>
        <View className="flex-row items-center justify-between rounded-2xl bg-input px-3.5 py-3">
          <Text className="text-sm text-foreground">{t("ideSessionsMobile.enabled")}</Text>
          <Switch
            value={props.form.enabled}
            disabled={props.disabled}
            onValueChange={(enabled) => props.onChange({ enabled })}
          />
        </View>
        <View className="flex-row flex-wrap gap-2">
          <ActionButton label={t("cancel")} disabled={props.disabled} onPress={props.onCancel} />
          <ActionButton
            label={t("save")}
            disabled={props.disabled}
            emphasized
            onPress={props.onSave}
          />
        </View>
      </View>
    </SettingsSection>
  );
}

function HeaderEditor(props: {
  readonly values: ReadonlyArray<IdeSessionHeaderDraft>;
  readonly disabled: boolean;
  readonly onChange: (values: ReadonlyArray<IdeSessionHeaderDraft>) => void;
}) {
  const update = (index: number, patch: Partial<IdeSessionHeaderDraft>) =>
    props.onChange(
      props.values.map((entry, entryIndex) =>
        entryIndex === index ? { ...entry, ...patch } : entry,
      ),
    );
  return (
    <SettingsSection title={t("ideSessionsMobile.requestHeaders")} card>
      <View className="gap-3 p-4">
        {props.values.map((entry, index) => (
          <View key={`${entry.headerName}-${entry.environmentVariable}`} className="gap-2">
            <Field label={`${t("ideSessionsMobile.headerName")} ${index + 1}`}>
              <TextInput
                value={entry.headerName}
                onChangeText={(headerName) => update(index, { headerName })}
                editable={!props.disabled}
                autoCapitalize="none"
                autoCorrect={false}
              />
            </Field>
            <Field label={`${t("ideSessionsMobile.environmentVariableName")} ${index + 1}`}>
              <TextInput
                value={entry.environmentVariable}
                onChangeText={(environmentVariable) => update(index, { environmentVariable })}
                editable={!props.disabled}
                autoCapitalize="none"
                autoCorrect={false}
              />
            </Field>
            <ActionButton
              label={t("ideSessionsMobile.deleteHeader")}
              disabled={props.disabled}
              danger
              onPress={() =>
                props.onChange(props.values.filter((_, entryIndex) => entryIndex !== index))
              }
            />
          </View>
        ))}
        {props.values.length === 0 ? (
          <Text className="text-sm text-foreground-muted">{t("ideSessionsMobile.noHeaders")}</Text>
        ) : null}
        <ActionButton
          label={t("ideSessionsMobile.addHeader")}
          disabled={props.disabled}
          onPress={() =>
            props.onChange([...props.values, { headerName: "", environmentVariable: "" }])
          }
        />
        <Text className="text-xs leading-5 text-foreground-muted">
          {t("ideSessionsMobile.headerFromEnvironment")}
        </Text>
      </View>
    </SettingsSection>
  );
}

function EnvironmentEditor(props: {
  readonly values: ReadonlyArray<ProviderInstanceEnvironmentVariable>;
  readonly disabled: boolean;
  readonly onChange: (values: ReadonlyArray<ProviderInstanceEnvironmentVariable>) => void;
}) {
  const update = (index: number, patch: Partial<ProviderInstanceEnvironmentVariable>) =>
    props.onChange(
      props.values.map((entry, entryIndex) =>
        entryIndex === index
          ? {
              ...entry,
              ...patch,
              ...(patch.value === undefined ? {} : { valueRedacted: false }),
            }
          : entry,
      ),
    );
  return (
    <SettingsSection title={t("ideSessionsMobile.environmentVariables")} card>
      <View className="gap-3 p-4">
        {props.values.map((entry, index) => (
          <View key={`${entry.name}-${entry.value}`} className="gap-2">
            <Field label={`${t("ideSessionsMobile.variableName")} ${index + 1}`}>
              <TextInput
                value={entry.name}
                onChangeText={(name) => update(index, { name })}
                editable={!props.disabled}
                autoCapitalize="none"
                autoCorrect={false}
              />
            </Field>
            <Field label={`${t("ideSessionsMobile.variableValue")} ${index + 1}`}>
              <TextInput
                value={entry.valueRedacted ? "" : entry.value}
                onChangeText={(value) => update(index, { value })}
                placeholder={
                  entry.valueRedacted
                    ? t("ideSessionsMobile.savedSecretPlaceholder")
                    : t("ideSessionsMobile.value")
                }
                secureTextEntry={entry.sensitive}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!props.disabled}
              />
            </Field>
            <View className="flex-row items-center justify-between rounded-2xl bg-input px-3.5 py-3">
              <Text className="text-sm text-foreground-muted">
                {t("ideSessionsMobile.sensitiveValue")}
              </Text>
              <Switch
                value={entry.sensitive}
                disabled={props.disabled}
                onValueChange={(sensitive) => update(index, { sensitive })}
              />
            </View>
            <ActionButton
              label={t("ideSessionsMobile.deleteEnvironmentVariable")}
              disabled={props.disabled}
              danger
              onPress={() =>
                props.onChange(props.values.filter((_, entryIndex) => entryIndex !== index))
              }
            />
          </View>
        ))}
        {props.values.length === 0 ? (
          <Text className="text-sm text-foreground-muted">
            {t("ideSessionsMobile.noEnvironmentVariables")}
          </Text>
        ) : null}
        <ActionButton
          label={t("ideSessionsMobile.addEnvironmentVariable")}
          disabled={props.disabled}
          onPress={() =>
            props.onChange([...props.values, { name: "", value: "", sensitive: true }])
          }
        />
        <Text className="text-xs leading-5 text-foreground-muted">
          {t("ideSessionsMobile.sensitiveValueDescription")}
        </Text>
      </View>
    </SettingsSection>
  );
}

function ChoiceGroup<T extends string>(props: {
  readonly values: ReadonlyArray<readonly [T, string]>;
  readonly selectedId: T;
  readonly disabled: boolean;
  readonly onSelect: (value: T) => void;
}) {
  return (
    <View className="flex-row flex-wrap gap-2">
      {props.values.map(([id, label]) => (
        <Pressable
          key={id}
          accessibilityRole="button"
          disabled={props.disabled}
          onPress={() => props.onSelect(id)}
          className={
            props.selectedId === id
              ? "rounded-full bg-accent px-3 py-2"
              : "rounded-full border border-input-border px-3 py-2"
          }
        >
          <Text
            className={
              props.selectedId === id
                ? "text-xs font-codework-medium text-accent-foreground"
                : "text-xs text-foreground"
            }
          >
            {label}
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

function ActionButton(props: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly emphasized?: boolean;
  readonly danger?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      className={
        props.danger
          ? "rounded-2xl border border-danger-border px-4 py-3"
          : props.emphasized
            ? "rounded-2xl bg-accent px-4 py-3"
            : "rounded-2xl border border-input-border px-4 py-3"
      }
    >
      <Text
        className={
          props.danger
            ? "text-center text-sm text-danger-foreground"
            : props.emphasized
              ? "text-center text-sm text-accent-foreground"
              : "text-center text-sm text-foreground"
        }
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

function StatusMessage(props: {
  readonly text: string;
  readonly detail?: string;
  readonly tone?: "danger";
}) {
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
      {props.detail ? (
        <Text className="mt-1 text-center text-xs leading-5 text-foreground-muted">
          {props.detail}
        </Text>
      ) : null}
    </View>
  );
}
