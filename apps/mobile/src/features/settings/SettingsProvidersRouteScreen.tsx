import { useAtomValue } from "@effect/atom-react";
import { ProviderDriverKind } from "@codework/contracts";
import type {
  EnvironmentId,
  ProviderInstanceConfig,
  ProviderInstanceId,
  ServerProvider,
  ServerSettings,
} from "@codework/contracts";
import { Atom } from "effect/unstable/reactivity";
import { useNavigation } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Alert, Platform, Pressable, RefreshControl, ScrollView, Switch, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@codework/client-runtime/state/runtime";
import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { t } from "../../i18n";
import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsEnvironmentPicker } from "./components/SettingsEnvironmentPicker";
import { SettingsSection } from "./components/SettingsSection";
import {
  MOBILE_PROVIDER_DRIVERS,
  buildMobileProviderRows,
  makeMobileProviderInstance,
  materializeProviderInstances,
  providerEnabled,
  providerFields,
  readProviderConfigBoolean,
  readProviderConfigString,
  updateProviderConfig,
  type MobileProviderDriver,
  type MobileProviderField,
  type MobileProviderRow,
} from "./SettingsProvidersRouteScreen.logic";

const EMPTY_SERVER_SETTINGS_ATOM = Atom.make<ServerSettings | null>(null).pipe(
  Atom.withLabel("mobile-providers:settings:empty"),
);
const EMPTY_SERVER_PROVIDERS_ATOM = Atom.make<ReadonlyArray<ServerProvider>>([]).pipe(
  Atom.withLabel("mobile-providers:providers:empty"),
);
export function SettingsProvidersRouteScreen() {
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
  const serverProviders = useAtomValue(
    environmentId === null
      ? EMPTY_SERVER_PROVIDERS_ATOM
      : serverEnvironment.providersValueAtom(environmentId),
  );
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const updateProvider = useAtomCommand(serverEnvironment.updateProvider, {
    reportFailure: false,
  });
  const installProvider = useAtomCommand(serverEnvironment.installProvider, {
    reportFailure: false,
  });
  const saveSettings = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  });
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Readonly<Record<string, ProviderInstanceConfig>>>({});
  const [newDriver, setNewDriver] = useState<MobileProviderDriver>(MOBILE_PROVIDER_DRIVERS[0]);
  const [newInstanceId, setNewInstanceId] = useState("");
  const [newInstanceName, setNewInstanceName] = useState("");

  useEffect(() => {
    if (
      selectedEnvironmentId !== null &&
      environments.some((item) => item.environmentId === selectedEnvironmentId)
    ) {
      return;
    }
    setSelectedEnvironmentId(environments[0]?.environmentId ?? null);
    setDrafts({});
  }, [environments, selectedEnvironmentId]);

  const rows = useMemo(
    () => (settings === null ? [] : buildMobileProviderRows(settings)),
    [settings],
  );
  const providerSnapshots = serverProviders ?? [];
  const snapshotByInstanceId = useMemo(
    () => new Map(providerSnapshots.map((provider) => [String(provider.instanceId), provider])),
    [providerSnapshots],
  );

  const saveProviderInstances = useCallback(
    async (nextProviderInstances: ServerSettings["providerInstances"]): Promise<boolean> => {
      if (environmentId === null) return false;
      const result = await saveSettings({
        environmentId,
        input: { patch: { providerInstances: nextProviderInstances } },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const failure = squashAtomCommandFailure(result);
          setError(failure instanceof Error ? failure.message : t("providersMobile.saveFailed"));
        }
        return false;
      }
      setError(null);
      return true;
    },
    [environmentId, saveSettings],
  );

  const updateDraft = useCallback((row: MobileProviderRow, next: ProviderInstanceConfig) => {
    setDrafts((current) => ({ ...current, [String(row.instanceId)]: next }));
  }, []);

  const saveRow = useCallback(
    async (row: MobileProviderRow) => {
      if (settings === null) return;
      const next = drafts[String(row.instanceId)] ?? row.instance;
      setPendingAction(`save:${row.instanceId}`);
      const saved = await saveProviderInstances({
        ...materializeProviderInstances(settings),
        [row.instanceId]: next,
      });
      if (saved) {
        setDrafts((current) => {
          const nextDrafts = { ...current };
          delete nextDrafts[String(row.instanceId)];
          return nextDrafts;
        });
      }
      setPendingAction(null);
    },
    [drafts, saveProviderInstances, settings],
  );

  const addInstance = useCallback(async () => {
    if (settings === null || environmentId === null) return;
    const id = newInstanceId.trim();
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(id)) {
      setError(t("providersMobile.instanceIdInvalid"));
      return;
    }
    if (materializeProviderInstances(settings)[id as ProviderInstanceId] !== undefined) {
      setError(t("providersMobile.instanceExists"));
      return;
    }
    setPendingAction("add");
    const saved = await saveProviderInstances({
      ...materializeProviderInstances(settings),
      [id as ProviderInstanceId]: makeMobileProviderInstance(newDriver, newInstanceName),
    });
    if (saved) {
      setNewInstanceId("");
      setNewInstanceName("");
    }
    setPendingAction(null);
  }, [environmentId, newInstanceId, newInstanceName, newDriver, saveProviderInstances, settings]);

  const deleteRow = useCallback(
    (row: MobileProviderRow) => {
      if (settings === null || row.isDefault) return;
      Alert.alert(
        t("providersMobile.deleteTitle", { name: row.instance.displayName ?? row.instanceId }),
        t("providersMobile.deleteDescription"),
        [
          { text: t("cancel"), style: "cancel" },
          {
            text: t("delete"),
            style: "destructive",
            onPress: () => {
              void (async () => {
                setPendingAction(`delete:${row.instanceId}`);
                await saveProviderInstances(
                  Object.fromEntries(
                    Object.entries(materializeProviderInstances(settings)).filter(
                      ([id]) => id !== String(row.instanceId),
                    ),
                  ) as ServerSettings["providerInstances"],
                );
                setPendingAction(null);
              })();
            },
          },
        ],
      );
    },
    [saveProviderInstances, settings],
  );

  const runRefresh = useCallback(async () => {
    if (environmentId === null) return;
    setPendingAction("refresh");
    setError(null);
    const result = await refreshProviders({ environmentId, input: {} });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : t("providersMobile.refreshFailed"));
    }
    setPendingAction(null);
  }, [environmentId, refreshProviders]);

  const runProviderAction = useCallback(
    async (row: MobileProviderRow, action: "update" | "install") => {
      if (environmentId === null) return;
      setPendingAction(`${action}:${row.instanceId}`);
      setError(null);
      const command = action === "update" ? updateProvider : installProvider;
      const result = await command({
        environmentId,
        input: {
          provider: ProviderDriverKind.make(row.driver),
          instanceId: row.instanceId,
        },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : t("providersMobile.operationFailed"));
      }
      setPendingAction(null);
    },
    [environmentId, installProvider, updateProvider],
  );

  return (
    <View className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader
            title={t("providersMobile.title")}
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
            refreshing={pendingAction === "refresh"}
            onRefresh={() => void runRefresh()}
          />
        }
      >
        <Text className="px-2 text-sm leading-5 text-foreground-muted">
          {t("providersMobile.description")}
        </Text>
        <SettingsEnvironmentPicker
          environments={environments}
          selectedEnvironmentId={environmentId}
          disabled={pendingAction !== null}
          onSelect={(next) => {
            setSelectedEnvironmentId(next);
            setDrafts({});
            setError(null);
          }}
        />
        {environmentId === null ? (
          <StatusMessage text={t("providersMobile.noEnvironment")} />
        ) : null}
        {error === null ? null : <StatusMessage text={error} tone="danger" />}
        {environmentId === null ? null : (
          <>
            <AddProviderSection
              driver={newDriver}
              instanceId={newInstanceId}
              instanceName={newInstanceName}
              disabled={pendingAction !== null}
              onDriverChange={setNewDriver}
              onInstanceIdChange={setNewInstanceId}
              onInstanceNameChange={setNewInstanceName}
              onAdd={() => void addInstance()}
            />
            <SettingsSection title={t("providersMobile.configuredTitle")} card>
              {settings === null ? (
                <StatusMessage text={t("providersMobile.loading")} />
              ) : rows.length === 0 ? (
                <StatusMessage text={t("providersMobile.noProviders")} />
              ) : (
                rows.map((row) => (
                  <ProviderCard
                    key={String(row.instanceId)}
                    row={row}
                    draft={drafts[String(row.instanceId)]}
                    snapshot={snapshotByInstanceId.get(String(row.instanceId))}
                    disabled={pendingAction !== null}
                    onChange={(next) => updateDraft(row, next)}
                    onSave={() => void saveRow(row)}
                    onDelete={() => deleteRow(row)}
                    onUpdate={() => void runProviderAction(row, "update")}
                    onInstall={() => void runProviderAction(row, "install")}
                  />
                ))
              )}
            </SettingsSection>
          </>
        )}
      </ScrollView>
    </View>
  );
}

function AddProviderSection(props: {
  readonly driver: MobileProviderDriver;
  readonly instanceId: string;
  readonly instanceName: string;
  readonly disabled: boolean;
  readonly onDriverChange: (driver: MobileProviderDriver) => void;
  readonly onInstanceIdChange: (value: string) => void;
  readonly onInstanceNameChange: (value: string) => void;
  readonly onAdd: () => void;
}) {
  return (
    <SettingsSection title={t("providersMobile.addTitle")} card>
      <View className="gap-3 p-4">
        <Text className="text-sm text-foreground-muted">{t("providersMobile.driver")}</Text>
        <ChoiceGroup
          values={MOBILE_PROVIDER_DRIVERS.map((driver) => ({
            id: driver,
            label: providerLabel(driver),
          }))}
          selectedId={props.driver}
          disabled={props.disabled}
          onSelect={props.onDriverChange}
        />
        <Field label={t("providersMobile.instanceId")}>
          <TextInput
            value={props.instanceId}
            onChangeText={props.onInstanceIdChange}
            placeholder={t("providersMobile.instanceIdPlaceholder")}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!props.disabled}
          />
        </Field>
        <Field label={t("providersMobile.instanceName")}>
          <TextInput
            value={props.instanceName}
            onChangeText={props.onInstanceNameChange}
            placeholder={t("providersMobile.instanceNamePlaceholder")}
            editable={!props.disabled}
          />
        </Field>
        <ActionButton
          label={t("providersMobile.add")}
          disabled={props.disabled || props.instanceId.trim().length === 0}
          emphasized
          onPress={props.onAdd}
        />
      </View>
    </SettingsSection>
  );
}

function ProviderCard(props: {
  readonly row: MobileProviderRow;
  readonly draft: ProviderInstanceConfig | undefined;
  readonly snapshot: ServerProvider | undefined;
  readonly disabled: boolean;
  readonly onChange: (next: ProviderInstanceConfig) => void;
  readonly onSave: () => void;
  readonly onDelete: () => void;
  readonly onUpdate: () => void;
  readonly onInstall: () => void;
}) {
  const instance = props.draft ?? props.row.instance;
  const fields = providerFields(props.row.driver);
  const config = instance.config;
  const dirty = props.draft !== undefined;
  const snapshot = props.snapshot;
  const isInstallable = snapshot?.installed === false && snapshot.canInstall === true;
  const hasUpdate = snapshot?.versionAdvisory?.canUpdate === true;

  const changeField = (field: MobileProviderField, value: string | boolean) => {
    props.onChange({
      ...instance,
      config: updateProviderConfig(config, field, value),
    });
  };

  return (
    <View className="gap-3 border-b border-border-subtle p-4 last:border-b-0">
      <View className="flex-row items-start justify-between gap-3">
        <View className="min-w-0 flex-1 gap-1">
          <Text className="text-base font-codework-medium text-foreground">
            {instance.displayName ?? providerLabel(props.row.driver)}
          </Text>
          <Text className="font-mono text-xs text-foreground-muted" numberOfLines={1}>
            {`${props.row.instanceId} · ${props.row.driver}`}
          </Text>
          <Text className="text-xs text-foreground-muted">
            {snapshot === undefined
              ? t("providersMobile.statusUnknown")
              : `${t("providersMobile.status")}: ${snapshot.status} · ${snapshot.auth.status}`}
          </Text>
          {snapshot?.version ? (
            <Text className="text-xs text-foreground-muted">
              {`${t("providersMobile.version")}: ${snapshot.version}`}
            </Text>
          ) : null}
        </View>
        <Switch
          value={providerEnabled(instance)}
          disabled={props.disabled}
          onValueChange={(enabled) =>
            props.onChange({
              ...instance,
              enabled,
            })
          }
          accessibilityLabel={t("providersMobile.enabled")}
        />
      </View>
      {props.row.driver === "byok" ? (
        <Text className="text-sm text-foreground-muted">{t("providersMobile.byokDedicated")}</Text>
      ) : !props.row.known ? (
        <Text className="text-sm text-warning-foreground">
          {t("providersMobile.unknownDriver")}
        </Text>
      ) : (
        fields.map((field) => (
          <Field key={field.key} label={t(field.labelKey)}>
            {field.kind === "switch" ? (
              <View className="flex-row items-center justify-between rounded-2xl bg-input px-3.5 py-3">
                <Text className="text-sm text-foreground-muted">{t(field.labelKey)}</Text>
                <Switch
                  value={readProviderConfigBoolean(config, field.key)}
                  disabled={props.disabled}
                  onValueChange={(value) => changeField(field, value)}
                />
              </View>
            ) : (
              <TextInput
                value={readProviderConfigString(config, field.key)}
                onChangeText={(value) => changeField(field, value)}
                placeholder={field.placeholderKey === null ? undefined : t(field.placeholderKey)}
                secureTextEntry={field.kind === "password"}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!props.disabled}
              />
            )}
          </Field>
        ))
      )}
      {snapshot?.models.length ? (
        <View className="gap-2">
          <Text className="text-sm font-codework-medium text-foreground">
            {t("providersMobile.models")}
          </Text>
          <Text className="font-mono text-xs leading-5 text-foreground-muted" numberOfLines={5}>
            {snapshot.models.map((model) => model.slug).join(", ")}
          </Text>
        </View>
      ) : null}
      <View className="flex-row flex-wrap gap-2">
        <ActionButton
          label={dirty ? t("providersMobile.save") : t("providersMobile.noChanges")}
          disabled={props.disabled || !dirty}
          emphasized={dirty}
          onPress={props.onSave}
        />
        {hasUpdate ? (
          <ActionButton
            label={t("providersMobile.update")}
            disabled={props.disabled}
            onPress={props.onUpdate}
          />
        ) : null}
        {isInstallable ? (
          <ActionButton
            label={t("providersMobile.install")}
            disabled={props.disabled}
            onPress={props.onInstall}
          />
        ) : null}
        {!props.row.isDefault ? (
          <ActionButton
            label={t("providersMobile.delete")}
            disabled={props.disabled}
            destructive
            onPress={props.onDelete}
          />
        ) : null}
      </View>
    </View>
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

function providerLabel(driver: string): string {
  switch (driver) {
    case "codex":
      return t("providersMobile.driverCodex");
    case "claudeAgent":
      return t("providersMobile.driverClaude");
    case "cursor":
      return t("providersMobile.driverCursor");
    case "grok":
      return t("providersMobile.driverGrok");
    case "opencode":
      return t("providersMobile.driverOpenCode");
    default:
      return driver;
  }
}

function ActionButton(props: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly emphasized?: boolean;
  readonly destructive?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      className={
        props.destructive
          ? "rounded-2xl border border-danger-border px-4 py-3"
          : props.emphasized
            ? "rounded-2xl bg-accent px-4 py-3"
            : "rounded-2xl border border-input-border px-4 py-3"
      }
    >
      <Text
        className={
          props.destructive
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
