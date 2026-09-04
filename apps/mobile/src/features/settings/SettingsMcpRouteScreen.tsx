import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import type {
  CompositionMcpRuntimeServerConfig,
  CompositionMcpRuntimeServerState,
  CompositionMcpServerId,
  EnvironmentId,
  ServerSettings,
} from "@codework/contracts";
import { squashAtomCommandFailure } from "@codework/client-runtime/state/runtime";
import { Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Alert, Platform, Pressable, RefreshControl, ScrollView, Switch, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { t } from "../../i18n";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsEnvironmentPicker } from "./components/SettingsEnvironmentPicker";
import {
  configFromMcpForm,
  emptyMcpForm,
  formFromMcpConfig,
  isValidMcpServerId,
  MCP_TRANSPORTS,
  type MobileMcpForm,
  type MobileMcpSecretDraft,
} from "./SettingsMcpRouteScreen.logic";

const emptyMcpServers: ServerSettings["mcpServers"] = {};
const emptyServerSettingsAtom = Atom.make<ServerSettings | null>(null);

export function SettingsMcpRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { environments } = useEnvironments();
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(
    () => environments[0]?.environmentId ?? null,
  );
  const environmentId = selectedEnvironmentId;
  const settings = useAtomValue(
    environmentId === null
      ? emptyServerSettingsAtom
      : serverEnvironment.settingsValueAtom(environmentId),
  );
  const runtimeQuery = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.mcpServers({ environmentId, input: {} }),
  );
  const saveSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const connect = useAtomCommand(serverEnvironment.connectMcpServer, { reportFailure: false });
  const disconnect = useAtomCommand(serverEnvironment.disconnectMcpServer, {
    reportFailure: false,
  });
  const refresh = useAtomCommand(serverEnvironment.refreshMcpServer, { reportFailure: false });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<MobileMcpForm>(emptyMcpForm);
  const [saving, setSaving] = useState(false);
  const [pendingControl, setPendingControl] = useState<string | null>(null);
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

  const configuredServers = (settings?.mcpServers ?? emptyMcpServers) as Readonly<
    Record<string, CompositionMcpRuntimeServerConfig>
  >;
  const entries = useMemo(() => Object.entries(configuredServers), [configuredServers]);
  const runtimeById = useMemo(
    () => new Map((runtimeQuery.data ?? []).map((state) => [state.serverId, state] as const)),
    [runtimeQuery.data],
  );

  const beginNew = useCallback(() => {
    setError(null);
    setForm(emptyMcpForm());
    setEditingId("__new__");
  }, []);

  const beginEdit = useCallback((serverId: string, config: CompositionMcpRuntimeServerConfig) => {
    setError(null);
    setForm(formFromMcpConfig(serverId, config));
    setEditingId(serverId);
  }, []);

  const persist = useCallback(
    async (next: Record<string, CompositionMcpRuntimeServerConfig>) => {
      if (environmentId === null) return false;
      setSaving(true);
      const result = await saveSettings({
        environmentId,
        input: { patch: { mcpServers: next as ServerSettings["mcpServers"] } },
      });
      setSaving(false);
      if (result._tag === "Failure") {
        setError(t("mcpMobile.saveFailed"));
        return false;
      }
      runtimeQuery.refresh();
      return true;
    },
    [environmentId, runtimeQuery, saveSettings],
  );

  const saveForm = useCallback(async () => {
    const serverId = form.serverId.trim();
    const config = configFromMcpForm(form);
    if (config === null) {
      setError(t("mcpMobile.invalidForm"));
      return;
    }
    const previousId = editingId !== "__new__" ? editingId : null;
    const next = { ...configuredServers };
    if (previousId !== null && previousId !== serverId) {
      delete next[previousId];
    }
    next[serverId] = config;
    if (await persist(next)) setEditingId(null);
  }, [configuredServers, editingId, form, persist]);

  const deleteServer = useCallback(
    (serverId: string, name: string) => {
      Alert.alert(t("mcpMobile.deleteTitle", { name }), t("mcpMobile.deleteDescription"), [
        { text: t("cancel"), style: "cancel" },
        {
          text: t("delete"),
          style: "destructive",
          onPress: () => {
            const next = { ...configuredServers };
            delete next[serverId];
            void persist(next).then(() => {
              if (editingId === serverId) setEditingId(null);
            });
          },
        },
      ]);
    },
    [configuredServers, editingId, persist],
  );

  const toggleEnabled = useCallback(
    (serverId: string, enabled: boolean) => {
      const current = configuredServers[serverId];
      if (current === undefined) return;
      void persist({ ...configuredServers, [serverId]: { ...current, enabled } });
    },
    [configuredServers, persist],
  );

  const runControl = useCallback(
    async (serverId: string, operation: "connect" | "disconnect" | "refresh") => {
      if (environmentId === null || !isValidMcpServerId(serverId)) return;
      const key = `${operation}:${serverId}`;
      setPendingControl(key);
      setError(null);
      const input = { environmentId, input: { serverId: serverId as CompositionMcpServerId } };
      const result =
        operation === "connect"
          ? await connect(input)
          : operation === "disconnect"
            ? await disconnect(input)
            : await refresh(input);
      if (result._tag === "Failure") {
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : t("mcpMobile.operationFailed"));
      }
      setPendingControl(null);
      runtimeQuery.refresh();
    },
    [connect, disconnect, environmentId, refresh, runtimeQuery],
  );

  return (
    <View className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title={t("mcpMobile.title")} onBack={() => navigation.goBack()} />
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
            refreshing={runtimeQuery.isPending && runtimeQuery.data !== null}
            onRefresh={runtimeQuery.refresh}
          />
        }
      >
        <Text className="px-2 text-sm leading-5 text-foreground-muted">
          {t("mcpMobile.description")}
        </Text>
        <SettingsEnvironmentPicker
          environments={environments}
          selectedEnvironmentId={environmentId}
          disabled={saving || pendingControl !== null}
          onSelect={(next) => {
            setSelectedEnvironmentId(next);
            setError(null);
          }}
        />
        {environmentId === null ? <StatusMessage text={t("mcpMobile.noEnvironment")} /> : null}
        {error === null ? null : <StatusMessage text={error} tone="danger" />}
        {editingId !== null ? (
          <McpEditor
            form={form}
            editing={editingId !== "__new__"}
            disabled={saving}
            onChange={(patch) => setForm((current) => ({ ...current, ...patch }))}
            onSave={() => void saveForm()}
            onCancel={() => setEditingId(null)}
          />
        ) : null}
        <SettingsSection title={t("mcpMobile.title")} card>
          <View className="border-b border-border-subtle p-4">
            <ActionButton
              label={t("mcpMobile.add")}
              disabled={editingId !== null}
              onPress={beginNew}
            />
          </View>
          {environmentId !== null && runtimeQuery.data === null && runtimeQuery.isPending ? (
            <StatusMessage text={t("mcpMobile.loading")} />
          ) : null}
          {entries.length === 0 && editingId === null ? (
            <StatusMessage text={t("mcpMobile.noServers")} />
          ) : null}
          {entries.map(([serverId, config]) => (
            <McpServerCard
              key={serverId}
              serverId={serverId}
              config={config}
              state={runtimeById.get(serverId as CompositionMcpServerId)}
              disabled={saving || pendingControl !== null}
              pendingControl={pendingControl}
              onToggle={(enabled) => toggleEnabled(serverId, enabled)}
              onEdit={() => beginEdit(serverId, config)}
              onDelete={() => deleteServer(serverId, config.name)}
              onControl={(operation) => void runControl(serverId, operation)}
            />
          ))}
        </SettingsSection>
      </ScrollView>
    </View>
  );
}

function McpServerCard(props: {
  readonly serverId: string;
  readonly config: CompositionMcpRuntimeServerConfig;
  readonly state: CompositionMcpRuntimeServerState | undefined;
  readonly disabled: boolean;
  readonly pendingControl: string | null;
  readonly onToggle: (enabled: boolean) => void;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
  readonly onControl: (operation: "connect" | "disconnect" | "refresh") => void;
}) {
  const connected = props.state?.status === "connected";
  const status = props.state?.status ?? (props.config.enabled ? "registered" : "disabled");
  return (
    <View className="gap-3 border-b border-border-subtle p-4 last:border-b-0">
      <View className="flex-row items-start gap-3">
        <View className="min-w-0 flex-1 gap-1">
          <Text className="text-base font-codework-medium text-foreground" numberOfLines={1}>
            {props.config.name}
          </Text>
          <Text className="font-mono text-xs text-foreground-muted" numberOfLines={1}>
            {props.serverId} · {props.config.transport} · {status}
          </Text>
        </View>
        <Switch
          value={props.config.enabled}
          onValueChange={props.onToggle}
          disabled={props.disabled}
          accessibilityLabel={t("mcpMobile.enabled")}
        />
      </View>
      {props.state?.toolNames.length ? (
        <Text className="text-xs leading-4 text-foreground-muted" numberOfLines={3}>
          {`${t("mcpMobile.tools")}: ${props.state.toolNames.join(", ")}`}
        </Text>
      ) : null}
      {props.state?.errorCode ? (
        <Text className="text-xs text-danger-foreground">{props.state.errorCode}</Text>
      ) : null}
      <View className="flex-row flex-wrap gap-2">
        <ActionButton
          label={connected ? t("mcpMobile.disconnect") : t("mcpMobile.connect")}
          disabled={props.disabled || !props.config.enabled || !props.config.trusted}
          onPress={() => props.onControl(connected ? "disconnect" : "connect")}
        />
        <ActionButton
          label={t("mcpMobile.refresh")}
          disabled={props.disabled || props.pendingControl === `refresh:${props.serverId}`}
          onPress={() => props.onControl("refresh")}
        />
        <ActionButton label={t("edit")} disabled={props.disabled} onPress={props.onEdit} />
        <ActionButton
          label={t("delete")}
          disabled={props.disabled}
          onPress={props.onDelete}
          danger
        />
      </View>
    </View>
  );
}

function McpEditor(props: {
  readonly form: MobileMcpForm;
  readonly editing: boolean;
  readonly disabled: boolean;
  readonly onChange: (patch: Partial<MobileMcpForm>) => void;
  readonly onSave: () => void;
  readonly onCancel: () => void;
}) {
  return (
    <SettingsSection title={props.editing ? t("mcpMobile.edit") : t("mcpMobile.add")} card>
      <View className="gap-3 p-4">
        <Field label={t("mcpMobile.serverId")}>
          <TextInput
            value={props.form.serverId}
            onChangeText={(serverId) => props.onChange({ serverId })}
            editable={!props.disabled && !props.editing}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder={t("mcpMobile.serverIdPlaceholder")}
          />
        </Field>
        <Field label={t("mcpMobile.name")}>
          <TextInput
            value={props.form.name}
            onChangeText={(name) => props.onChange({ name })}
            editable={!props.disabled}
            placeholder={t("mcpMobile.namePlaceholder")}
          />
        </Field>
        <Field label={t("mcpMobile.transport")}>
          <View className="flex-row flex-wrap gap-2">
            {MCP_TRANSPORTS.map((transport) => (
              <Choice
                key={transport}
                label={t(`mcpMobile.transport.${transport}`)}
                selected={props.form.transport === transport}
                disabled={props.disabled}
                onPress={() => props.onChange({ transport })}
              />
            ))}
          </View>
        </Field>
        {props.form.transport === "stdio" ? (
          <>
            <Field label={t("mcpMobile.command")}>
              <TextInput
                value={props.form.command}
                onChangeText={(command) => props.onChange({ command })}
                editable={!props.disabled}
                autoCapitalize="none"
                placeholder={t("mcpMobile.commandPlaceholder")}
              />
            </Field>
            <Field label={t("mcpMobile.args")}>
              <TextInput
                value={props.form.args}
                onChangeText={(args) => props.onChange({ args })}
                editable={!props.disabled}
                multiline
                textAlignVertical="top"
                placeholder={t("mcpMobile.argsPlaceholder")}
              />
            </Field>
            <Field label={t("mcpMobile.cwd")}>
              <TextInput
                value={props.form.cwd}
                onChangeText={(cwd) => props.onChange({ cwd })}
                editable={!props.disabled}
                autoCapitalize="none"
              />
            </Field>
          </>
        ) : (
          <Field label={t("mcpMobile.url")}>
            <TextInput
              value={props.form.url}
              onChangeText={(url) => props.onChange({ url })}
              editable={!props.disabled}
              autoCapitalize="none"
              keyboardType="url"
              placeholder={t("mcpMobile.urlPlaceholder")}
            />
          </Field>
        )}
        <SecretList
          title={t("mcpMobile.headers")}
          addLabel={t("mcpMobile.addHeader")}
          entries={props.form.headers}
          disabled={props.disabled}
          onChange={(headers) => props.onChange({ headers })}
        />
        <SecretList
          title={t("mcpMobile.environment")}
          addLabel={t("mcpMobile.addEnvironment")}
          entries={props.form.environment}
          disabled={props.disabled}
          onChange={(environment) => props.onChange({ environment })}
        />
        <ToggleRow
          label={t("mcpMobile.enabled")}
          value={props.form.enabled}
          disabled={props.disabled}
          onValueChange={(enabled) => props.onChange({ enabled })}
        />
        <ToggleRow
          label={t("mcpMobile.trusted")}
          value={props.form.trusted}
          disabled={props.disabled}
          onValueChange={(trusted) => props.onChange({ trusted })}
        />
        <Field label={t("mcpMobile.fingerprint")}>
          <TextInput
            value={props.form.trustFingerprint}
            onChangeText={(trustFingerprint) => props.onChange({ trustFingerprint })}
            editable={!props.disabled}
            autoCapitalize="none"
          />
        </Field>
        <View className="flex-row flex-wrap gap-2 pt-1">
          <ActionButton label={t("save")} disabled={props.disabled} onPress={props.onSave} />
          <ActionButton label={t("cancel")} disabled={props.disabled} onPress={props.onCancel} />
        </View>
      </View>
    </SettingsSection>
  );
}

function SecretList(props: {
  readonly title: string;
  readonly addLabel: string;
  readonly entries: ReadonlyArray<MobileMcpSecretDraft>;
  readonly disabled: boolean;
  readonly onChange: (entries: ReadonlyArray<MobileMcpSecretDraft>) => void;
}) {
  return (
    <View className="gap-2">
      <Text className="text-sm font-codework-medium text-foreground">{props.title}</Text>
      {props.entries.map((entry, index) => (
        <View
          key={`${entry.name}-${entry.valueRedacted === true ? "stored" : "draft"}`}
          className="gap-2 rounded-[16px] bg-subtle p-3"
        >
          <TextInput
            value={entry.name}
            onChangeText={(name) => {
              const next = [...props.entries];
              next[index] = { ...entry, name };
              props.onChange(next);
            }}
            editable={!props.disabled}
            autoCapitalize="none"
            placeholder={t("mcpMobile.secretName")}
          />
          <TextInput
            value={entry.value}
            onChangeText={(value) => {
              const next = [...props.entries];
              const { valueRedacted: _oldValueRedacted, ...preserved } = entry;
              next[index] = {
                ...preserved,
                value,
                ...(value.length === 0 && entry.valueRedacted === true
                  ? { valueRedacted: true }
                  : {}),
              };
              props.onChange(next);
            }}
            editable={!props.disabled}
            autoCapitalize="none"
            secureTextEntry={entry.sensitive}
            placeholder={
              entry.valueRedacted === true
                ? t("mcpMobile.secretStoredPlaceholder")
                : t("mcpMobile.secretValue")
            }
          />
          <ActionButton
            label={t("delete")}
            disabled={props.disabled}
            danger
            onPress={() =>
              props.onChange(props.entries.filter((_, candidate) => candidate !== index))
            }
          />
        </View>
      ))}
      <ActionButton
        label={props.addLabel}
        disabled={props.disabled}
        onPress={() => props.onChange([...props.entries, { name: "", value: "", sensitive: true }])}
      />
    </View>
  );
}

function Field(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <View className="gap-1.5">
      <Text className="text-sm text-foreground-muted">{props.label}</Text>
      {props.children}
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

function ToggleRow(props: {
  readonly label: string;
  readonly value: boolean;
  readonly disabled: boolean;
  readonly onValueChange: (value: boolean) => void;
}) {
  return (
    <View className="flex-row items-center justify-between gap-3 py-1">
      <Text className="flex-1 text-sm text-foreground">{props.label}</Text>
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
  readonly onPress: () => void;
  readonly danger?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      className={
        props.danger
          ? "rounded-full bg-danger px-3 py-2 opacity-100 disabled:opacity-40"
          : "rounded-full bg-subtle-strong px-3 py-2 opacity-100 disabled:opacity-40"
      }
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
