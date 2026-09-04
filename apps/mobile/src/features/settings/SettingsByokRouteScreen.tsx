import { useAtomValue } from "@effect/atom-react";
import type {
  ByokBalanceResult,
  ByokDelegationSnapshot,
  ByokDiscoveredModel,
  ByokDraftModelDiscoveryResult,
  ByokModelAdapter,
  ByokSupplierCatalogEntry,
  EnvironmentId,
  ProviderInstanceConfig,
  ProviderInstanceId,
  ServerSettings,
} from "@codework/contracts";
import { Atom } from "effect/unstable/reactivity";
import { useNavigation } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Platform, Pressable, RefreshControl, ScrollView, Switch, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { t } from "../../i18n";
import { uuidv4 } from "../../lib/uuid";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { byokEnvironment, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsEnvironmentPicker } from "./components/SettingsEnvironmentPicker";
import {
  adapterFormFromAdapter,
  buildByokAdapter,
  createByokProviderInstance,
  DEFAULT_BYOK_PROMPT_TEMPLATE,
  normalizeByokInstanceId,
  patchByokConfig,
  readByokConfigRecord,
  readByokDelegation,
  readByokModelAdapters,
  readByokPromptTemplate,
  type MobileByokAdapterForm,
} from "./SettingsByokRouteScreen.logic";

const EMPTY_SERVER_SETTINGS_ATOM = Atom.make<ServerSettings | null>(null).pipe(
  Atom.withLabel("mobile-byok:settings:empty"),
);
const EMPTY_PROVIDER_INSTANCES: Readonly<Record<ProviderInstanceId, ProviderInstanceConfig>> = {};

export function SettingsByokRouteScreen() {
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
  const providerInstances = settings?.providerInstances ?? EMPTY_PROVIDER_INSTANCES;
  const catalogQuery = useEnvironmentQuery(
    environmentId === null ? null : byokEnvironment.supplierCatalog({ environmentId, input: {} }),
  );
  const saveSettings = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  });
  const [saveError, setSaveError] = useState<string | null>(null);
  const [newInstanceId, setNewInstanceId] = useState("");
  const [newInstanceName, setNewInstanceName] = useState("");
  const [addingInstance, setAddingInstance] = useState(false);

  useEffect(() => {
    if (
      selectedEnvironmentId !== null &&
      environments.some((item) => item.environmentId === selectedEnvironmentId)
    ) {
      return;
    }
    setSelectedEnvironmentId(environments[0]?.environmentId ?? null);
  }, [environments, selectedEnvironmentId]);

  const byokInstances = useMemo(
    () =>
      Object.entries(providerInstances).filter(
        ([, instance]) => instance.driver === "byok",
      ) as ReadonlyArray<[string, ProviderInstanceConfig]>,
    [providerInstances],
  );

  const saveProviderInstances = useCallback(
    async (nextProviderInstances: ServerSettings["providerInstances"]): Promise<boolean> => {
      if (environmentId === null) return false;
      const result = await saveSettings({
        environmentId,
        input: { patch: { providerInstances: nextProviderInstances } },
      });
      if (result._tag === "Failure") {
        setSaveError(t("byokMobile.saveFailed"));
        return false;
      }
      setSaveError(null);
      return true;
    },
    [environmentId, saveSettings],
  );

  const addInstance = useCallback(async () => {
    const instanceId = normalizeByokInstanceId(newInstanceId);
    if (instanceId === null) {
      setSaveError(t("byokMobile.instanceIdInvalid"));
      return;
    }
    if (providerInstances[instanceId] !== undefined) {
      setSaveError(t("byokMobile.instanceExists"));
      return;
    }
    setAddingInstance(true);
    const saved = await saveProviderInstances({
      ...providerInstances,
      [instanceId]: createByokProviderInstance(instanceId, newInstanceName),
    });
    setAddingInstance(false);
    if (saved) {
      setNewInstanceId("");
      setNewInstanceName("");
    }
  }, [newInstanceId, newInstanceName, providerInstances, saveProviderInstances]);

  const removeInstance = useCallback(
    (instanceId: string, displayName: string) => {
      Alert.alert(
        t("byokMobile.deleteInstanceTitle", { name: displayName }),
        t("byokMobile.deleteInstanceDescription"),
        [
          { text: t("cancel"), style: "cancel" },
          {
            text: t("delete"),
            style: "destructive",
            onPress: () => {
              void saveProviderInstances(
                Object.fromEntries(
                  Object.entries(providerInstances).filter(
                    ([candidate]) => candidate !== instanceId,
                  ),
                ) as ServerSettings["providerInstances"],
              );
            },
          },
        ],
      );
    },
    [providerInstances, saveProviderInstances],
  );

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title={t("settings.byok")} onBack={() => navigation.goBack()} />
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
            refreshing={catalogQuery.isPending && catalogQuery.data !== null}
            onRefresh={catalogQuery.refresh}
          />
        }
      >
        <Text className="px-2 text-sm leading-5 text-foreground-muted">
          {t("byokMobile.description")}
        </Text>

        <SettingsEnvironmentPicker
          environments={environments}
          selectedEnvironmentId={environmentId}
          disabled={addingInstance}
          onSelect={(next) => {
            setSelectedEnvironmentId(next);
            setSaveError(null);
          }}
        />

        {environmentId === null ? (
          <StatusMessage text={t("byokMobile.noEnvironment")} />
        ) : (
          <>
            <SettingsSection title={t("byokMobile.addInstanceTitle")}>
              <View className="gap-3 p-4">
                <Field label={t("byokMobile.instanceId")}>
                  <TextInput
                    value={newInstanceId}
                    onChangeText={setNewInstanceId}
                    placeholder={t("byokMobile.instanceIdPlaceholder")}
                    autoCapitalize="none"
                    autoCorrect={false}
                    editable={!addingInstance}
                  />
                </Field>
                <Field label={t("byokMobile.instanceName")}>
                  <TextInput
                    value={newInstanceName}
                    onChangeText={setNewInstanceName}
                    placeholder={t("byokMobile.instanceNamePlaceholder")}
                    editable={!addingInstance}
                  />
                </Field>
                <ActionButton
                  label={addingInstance ? t("byokMobile.saving") : t("byokMobile.addInstance")}
                  disabled={addingInstance || newInstanceId.trim().length === 0}
                  emphasized
                  onPress={() => void addInstance()}
                />
              </View>
            </SettingsSection>

            {saveError === null ? null : (
              <Text selectable className="px-2 text-sm text-danger-foreground">
                {saveError}
              </Text>
            )}

            {byokInstances.length === 0 ? (
              <StatusMessage text={t("byokMobile.noInstances")} />
            ) : (
              byokInstances.map(([instanceId, instance]) => (
                <ByokInstanceCard
                  key={instanceId}
                  environmentId={environmentId}
                  instanceId={instanceId}
                  instance={instance}
                  catalog={catalogQuery.data ?? []}
                  onSave={async (nextInstance) =>
                    saveProviderInstances({ ...providerInstances, [instanceId]: nextInstance })
                  }
                  onDelete={() => removeInstance(instanceId, instance.displayName ?? instanceId)}
                />
              ))
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}

function ByokInstanceCard(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: string;
  readonly instance: ProviderInstanceConfig;
  readonly catalog: ReadonlyArray<ByokSupplierCatalogEntry>;
  readonly onSave: (instance: ProviderInstanceConfig) => Promise<boolean>;
  readonly onDelete: () => void;
}) {
  const config = readByokConfigRecord(props.instance.config);
  const adapters = readByokModelAdapters(config);
  const promptTemplate = readByokPromptTemplate(config);
  const delegation = readByokDelegation(config);
  const [editingAdapterId, setEditingAdapterId] = useState<string | null>(null);
  const [adapterForm, setAdapterForm] = useState<MobileByokAdapterForm>(() =>
    adapterFormFromAdapter(),
  );
  const [adapterError, setAdapterError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [discoveringAdapterId, setDiscoveringAdapterId] = useState<string | null>(null);
  const [matchingAdapterId, setMatchingAdapterId] = useState<string | null>(null);
  const [discoveryByAdapterId, setDiscoveryByAdapterId] = useState<
    Readonly<
      Record<
        string,
        { readonly models: ReadonlyArray<ByokDiscoveredModel>; readonly error?: string }
      >
    >
  >({});
  const [draftDiscovery, setDraftDiscovery] = useState<ByokDraftModelDiscoveryResult | null>(null);
  const [discoveringDraft, setDiscoveringDraft] = useState(false);
  const [balanceByAdapterId, setBalanceByAdapterId] = useState<
    Readonly<Record<string, ByokBalanceResult>>
  >({});
  const [importYaml, setImportYaml] = useState("");
  const [importing, setImporting] = useState(false);
  const [importSummary, setImportSummary] = useState<string | null>(null);
  const [delegationTask, setDelegationTask] = useState("");
  const [delegations, setDelegations] = useState<ReadonlyArray<ByokDelegationSnapshot>>([]);
  const [delegationBusy, setDelegationBusy] = useState(false);
  const [delegationError, setDelegationError] = useState<string | null>(null);
  const [promptDraft, setPromptDraft] = useState(promptTemplate);
  const discoverModelsCommand = useAtomCommand(byokEnvironment.discoverModels, {
    reportFailure: false,
  });
  const discoverDraftModelsCommand = useAtomCommand(byokEnvironment.discoverDraftModels, {
    reportFailure: false,
  });
  const matchContextWindowsCommand = useAtomCommand(byokEnvironment.matchContextWindows, {
    reportFailure: false,
  });
  const balanceCommand = useAtomCommand(byokEnvironment.balance, { reportFailure: false });

  const saveInstance = useCallback(
    async (nextInstance: ProviderInstanceConfig): Promise<boolean> => {
      setSaving(true);
      const saved = await props.onSave(nextInstance);
      setSaving(false);
      return saved;
    },
    [props],
  );

  const updateConfig = useCallback(
    async (key: string, value: unknown): Promise<boolean> =>
      saveInstance({
        ...props.instance,
        config: patchByokConfig(props.instance.config, key, value),
      }),
    [props.instance, saveInstance],
  );

  const toggleInstance = useCallback(
    (enabled: boolean) => {
      void saveInstance({
        ...props.instance,
        enabled,
        config: patchByokConfig(props.instance.config, "enabled", enabled),
      });
    },
    [props.instance, saveInstance],
  );

  const openAddAdapter = useCallback(() => {
    setEditingAdapterId("new");
    setAdapterForm(adapterFormFromAdapter());
    setAdapterError(null);
    setDraftDiscovery(null);
  }, []);

  const openEditAdapter = useCallback((adapter: ByokModelAdapter) => {
    setEditingAdapterId(adapter.id);
    setAdapterForm(adapterFormFromAdapter(adapter));
    setAdapterError(null);
    setDraftDiscovery(null);
  }, []);

  const closeAdapterEditor = useCallback(() => {
    setEditingAdapterId(null);
    setAdapterError(null);
    setDraftDiscovery(null);
  }, []);

  const saveAdapter = useCallback(async () => {
    const baseURL = adapterForm.baseURL.trim();
    const modelId = adapterForm.modelId.trim();
    const contextWindowTokens = Number(adapterForm.contextWindowTokens.trim());
    const existing =
      editingAdapterId === null || editingAdapterId === "new"
        ? undefined
        : adapters.find((adapter) => adapter.id === editingAdapterId);
    if (!baseURL) {
      setAdapterError(t("byokMobile.baseUrlRequired"));
      return;
    }
    if (!modelId) {
      setAdapterError(t("byokMobile.modelRequired"));
      return;
    }
    if (!Number.isInteger(contextWindowTokens) || contextWindowTokens <= 0) {
      setAdapterError(t("byokMobile.contextRequired"));
      return;
    }
    if (!adapterForm.apiKey.trim() && existing?.apiKeyRedacted !== true) {
      setAdapterError(t("byokMobile.apiKeyRequired"));
      return;
    }
    const adapterId = editingAdapterId === "new" ? uuidv4() : editingAdapterId;
    if (adapterId === null) return;
    const nextAdapter = buildByokAdapter(adapterForm, adapterId, existing);
    const nextAdapters =
      existing === undefined
        ? [...adapters, nextAdapter]
        : adapters.map((adapter) => (adapter.id === existing.id ? nextAdapter : adapter));
    const saved = await updateConfig("adapters", nextAdapters);
    if (saved) closeAdapterEditor();
  }, [adapterForm, adapters, closeAdapterEditor, editingAdapterId, updateConfig]);

  const deleteAdapter = useCallback(
    (adapter: ByokModelAdapter) => {
      Alert.alert(
        t("byokMobile.deleteAdapterTitle", { name: adapter.displayName || adapter.modelId }),
        t("byokMobile.deleteAdapterDescription"),
        [
          { text: t("cancel"), style: "cancel" },
          {
            text: t("delete"),
            style: "destructive",
            onPress: () => {
              void updateConfig(
                "adapters",
                adapters.filter((candidate) => candidate.id !== adapter.id),
              );
            },
          },
        ],
      );
    },
    [adapters, updateConfig],
  );

  const discoverAdapterModels = useCallback(
    async (adapter: ByokModelAdapter) => {
      setDiscoveringAdapterId(adapter.id);
      const result = await discoverModelsCommand({
        environmentId: props.environmentId,
        input: { instanceId: props.instanceId, adapterId: adapter.id, forceRefresh: true },
      });
      if (result._tag === "Success") {
        setDiscoveryByAdapterId((current) => ({
          ...current,
          [adapter.id]: { models: result.value.models },
        }));
      } else {
        setDiscoveryByAdapterId((current) => ({
          ...current,
          [adapter.id]: { models: [], error: t("byokMobile.discoveryFailed") },
        }));
      }
      setDiscoveringAdapterId(null);
    },
    [discoverModelsCommand, props.environmentId, props.instanceId],
  );

  const discoverDraftModels = useCallback(async () => {
    if (!adapterForm.baseURL.trim() || !adapterForm.apiKey.trim()) {
      setAdapterError(t("byokMobile.discoveryNeedsCredentials"));
      return;
    }
    setDiscoveringDraft(true);
    const result = await discoverDraftModelsCommand({
      environmentId: props.environmentId,
      input: {
        protocol: adapterForm.protocol,
        baseURL: adapterForm.baseURL.trim(),
        apiKey: adapterForm.apiKey.trim(),
        ...(adapterForm.supplierID.trim() ? { supplierID: adapterForm.supplierID.trim() } : {}),
      },
    });
    if (result._tag === "Success") setDraftDiscovery(result.value);
    else setAdapterError(t("byokMobile.discoveryFailed"));
    setDiscoveringDraft(false);
  }, [adapterForm, discoverDraftModelsCommand, props.environmentId]);

  const matchContextWindows = useCallback(
    async (adapter: ByokModelAdapter) => {
      setMatchingAdapterId(adapter.id);
      const result = await matchContextWindowsCommand({
        environmentId: props.environmentId,
        input: { instanceId: props.instanceId, adapterId: adapter.id },
      });
      if (result._tag === "Success") {
        const nextAdapters = adapters.map((current) => {
          const detail = result.value.details.find(
            (candidate) => candidate.adapterId === current.id,
          );
          return detail === undefined ? current : { ...current, contextWindowTokens: detail.after };
        });
        await updateConfig("adapters", nextAdapters);
      }
      setMatchingAdapterId(null);
    },
    [adapters, matchContextWindowsCommand, props.environmentId, props.instanceId, updateConfig],
  );

  const queryBalance = useCallback(
    async (adapter: ByokModelAdapter) => {
      const result = await balanceCommand({
        environmentId: props.environmentId,
        input: { instanceId: props.instanceId, adapterId: adapter.id, forceRefresh: true },
      });
      if (result._tag === "Success") {
        setBalanceByAdapterId((current) => ({ ...current, [adapter.id]: result.value }));
      }
    },
    [balanceCommand, props.environmentId, props.instanceId],
  );

  const importAdaptersCommand = useAtomCommand(byokEnvironment.importAdapters, {
    reportFailure: false,
  });
  const importAdapters = useCallback(async () => {
    if (!importYaml.trim()) return;
    setImporting(true);
    const result = await importAdaptersCommand({
      environmentId: props.environmentId,
      input: { instanceId: props.instanceId, yaml: importYaml.trim() },
    });
    if (result._tag === "Success") {
      setImportSummary(
        t("byokMobile.importSummary", {
          imported: result.value.imported,
          skipped: result.value.skipped,
        }),
      );
      setImportYaml("");
    } else {
      setImportSummary(t("byokMobile.importFailed"));
    }
    setImporting(false);
  }, [importAdaptersCommand, importYaml, props.environmentId, props.instanceId]);

  const listDelegationsCommand = useAtomCommand(byokEnvironment.listDelegations, {
    reportFailure: false,
  });
  const submitDelegationCommand = useAtomCommand(byokEnvironment.submitDelegation, {
    reportFailure: false,
  });
  const cancelDelegationCommand = useAtomCommand(byokEnvironment.cancelDelegation, {
    reportFailure: false,
  });

  const loadDelegations = useCallback(async () => {
    setDelegationBusy(true);
    const result = await listDelegationsCommand({
      environmentId: props.environmentId,
      input: { instanceId: props.instanceId },
    });
    if (result._tag === "Success") {
      setDelegations(result.value.delegations);
      setDelegationError(null);
    } else setDelegationError(t("byokMobile.delegationFailed"));
    setDelegationBusy(false);
  }, [listDelegationsCommand, props.environmentId, props.instanceId]);

  const submitDelegation = useCallback(async () => {
    const task = delegationTask.trim();
    if (!task) return;
    setDelegationBusy(true);
    const result = await submitDelegationCommand({
      environmentId: props.environmentId,
      input: { instanceId: props.instanceId, task },
    });
    if (result._tag === "Success") {
      setDelegations((current) => [result.value, ...current]);
      setDelegationTask("");
      setDelegationError(null);
    } else setDelegationError(t("byokMobile.delegationFailed"));
    setDelegationBusy(false);
  }, [delegationTask, props.environmentId, props.instanceId, submitDelegationCommand]);

  const cancelDelegation = useCallback(
    async (delegationId: string) => {
      setDelegationBusy(true);
      const result = await cancelDelegationCommand({
        environmentId: props.environmentId,
        input: { instanceId: props.instanceId, delegationId },
      });
      if (result._tag === "Success") {
        setDelegations((current) =>
          current.map((delegation) =>
            delegation.id === delegationId && result.value.snapshot !== null
              ? result.value.snapshot
              : delegation,
          ),
        );
      } else setDelegationError(t("byokMobile.delegationFailed"));
      setDelegationBusy(false);
    },
    [cancelDelegationCommand, props.environmentId, props.instanceId],
  );

  const updatePrompt = useCallback(
    async (patch: Partial<typeof DEFAULT_BYOK_PROMPT_TEMPLATE>) => {
      const next = { ...promptDraft, ...patch };
      setPromptDraft(next);
      await updateConfig("promptTemplate", next);
    },
    [promptDraft, updateConfig],
  );

  return (
    <View className="gap-4 rounded-[24px] border-continuous bg-card p-4">
      <View className="flex-row items-center gap-3">
        <View className="min-w-0 flex-1 gap-1">
          <Text className="text-lg font-codework-medium text-foreground" numberOfLines={1}>
            {props.instance.displayName ?? props.instanceId}
          </Text>
          <Text className="font-mono text-xs text-foreground-muted" numberOfLines={1}>
            {props.instanceId}
          </Text>
        </View>
        <Switch
          value={props.instance.enabled !== false}
          onValueChange={toggleInstance}
          disabled={saving}
          accessibilityLabel={t("byokMobile.enabled")}
        />
      </View>

      <SettingsSection title={t("byokMobile.adaptersTitle")} card>
        {adapters.length === 0 ? (
          <Text className="p-4 text-sm text-foreground-muted">{t("byokMobile.noAdapters")}</Text>
        ) : (
          adapters.map((adapter) => (
            <AdapterCard
              key={adapter.id}
              adapter={adapter}
              balance={balanceByAdapterId[adapter.id]}
              discovery={discoveryByAdapterId[adapter.id]}
              discovering={discoveringAdapterId === adapter.id}
              matching={matchingAdapterId === adapter.id}
              disabled={saving}
              onEdit={() => openEditAdapter(adapter)}
              onDelete={() => deleteAdapter(adapter)}
              onDiscover={() => void discoverAdapterModels(adapter)}
              onMatchContext={() => void matchContextWindows(adapter)}
              onBalance={() => void queryBalance(adapter)}
              onSelectModel={(model) => {
                void updateConfig(
                  "adapters",
                  adapters.map((current) =>
                    current.id === adapter.id
                      ? {
                          ...current,
                          modelId: model.id,
                          ...(model.contextWindowTokens === undefined
                            ? {}
                            : { contextWindowTokens: model.contextWindowTokens }),
                        }
                      : current,
                  ),
                );
              }}
            />
          ))
        )}
        <View className="border-t border-border-subtle p-4">
          <ActionButton
            label={t("byokMobile.addAdapter")}
            disabled={saving}
            onPress={openAddAdapter}
          />
        </View>
      </SettingsSection>

      {editingAdapterId === null ? null : (
        <AdapterEditor
          form={adapterForm}
          existing={
            editingAdapterId === "new"
              ? undefined
              : adapters.find((adapter) => adapter.id === editingAdapterId)
          }
          catalog={props.catalog}
          draftDiscovery={draftDiscovery}
          discoveringDraft={discoveringDraft}
          error={adapterError}
          disabled={saving}
          onChange={(patch) => setAdapterForm((current) => ({ ...current, ...patch }))}
          onDiscover={() => void discoverDraftModels()}
          onSelectModel={(model) =>
            setAdapterForm((current) => ({
              ...current,
              modelId: model.id,
              displayName: model.id,
              ...(model.contextWindowTokens === undefined
                ? {}
                : { contextWindowTokens: String(model.contextWindowTokens) }),
            }))
          }
          onSave={() => void saveAdapter()}
          onCancel={closeAdapterEditor}
        />
      )}

      <SettingsSection title={t("byokMobile.promptTitle")} card>
        <View className="gap-3 p-4">
          <ToggleRow
            label={t("byokMobile.promptEnabled")}
            value={promptDraft.enabled}
            disabled={saving}
            onValueChange={(enabled) => void updatePrompt({ enabled })}
          />
          <ToggleRow
            label={t("byokMobile.promptChinese")}
            value={promptDraft.softwareChineseEnabled}
            disabled={saving}
            onValueChange={(softwareChineseEnabled) =>
              void updatePrompt({ softwareChineseEnabled })
            }
          />
          <ToggleRow
            label={t("byokMobile.promptCustom")}
            value={promptDraft.customEnabled}
            disabled={saving}
            onValueChange={(customEnabled) => void updatePrompt({ customEnabled })}
          />
          {promptDraft.customEnabled ? (
            <TextInput
              value={promptDraft.customContent}
              onChangeText={(customContent) =>
                setPromptDraft((current) => ({ ...current, customContent }))
              }
              onEndEditing={() => void updatePrompt({ customContent: promptDraft.customContent })}
              multiline
              textAlignVertical="top"
              placeholder={t("byokMobile.promptPlaceholder")}
              className="min-h-28"
            />
          ) : null}
        </View>
      </SettingsSection>

      <SettingsSection title={t("byokMobile.delegationTitle")} card>
        <View className="gap-3 p-4">
          <ToggleRow
            label={t("byokMobile.delegationEnabled")}
            value={delegation.enabled}
            disabled={saving}
            onValueChange={(enabled) =>
              void updateConfig("delegation", {
                ...readByokConfigRecord(config["delegation"]),
                enabled,
              })
            }
          />
          <Field label={t("byokMobile.maxConcurrency")}>
            <TextInput
              value={String(delegation.maxConcurrency)}
              keyboardType="number-pad"
              editable={!saving}
              onEndEditing={(event) => {
                const value = Math.max(1, Math.min(16, Number(event.nativeEvent.text) || 4));
                void updateConfig("delegation", {
                  ...readByokConfigRecord(config["delegation"]),
                  maxConcurrency: value,
                });
              }}
            />
          </Field>
          <View className="flex-row flex-wrap gap-2">
            <ActionButton
              label={delegationBusy ? t("byokMobile.loading") : t("byokMobile.refreshDelegations")}
              disabled={delegationBusy}
              onPress={() => void loadDelegations()}
            />
          </View>
          <TextInput
            value={delegationTask}
            onChangeText={setDelegationTask}
            multiline
            textAlignVertical="top"
            placeholder={t("byokMobile.delegationPlaceholder")}
            className="min-h-24"
            editable={!delegationBusy}
          />
          <ActionButton
            label={delegationBusy ? t("byokMobile.submitting") : t("byokMobile.submitDelegation")}
            disabled={delegationBusy || delegationTask.trim().length === 0}
            emphasized
            onPress={() => void submitDelegation()}
          />
          {delegationError === null ? null : (
            <Text className="text-sm text-danger-foreground">{delegationError}</Text>
          )}
          {delegations.length === 0 ? (
            <Text className="text-sm text-foreground-muted">{t("byokMobile.noDelegations")}</Text>
          ) : (
            delegations.map((delegationSnapshot) => (
              <DelegationRow
                key={delegationSnapshot.id}
                delegation={delegationSnapshot}
                disabled={delegationBusy}
                onCancel={() => void cancelDelegation(delegationSnapshot.id)}
              />
            ))
          )}
        </View>
      </SettingsSection>

      <SettingsSection title={t("byokMobile.importTitle")} card>
        <View className="gap-3 p-4">
          <TextInput
            value={importYaml}
            onChangeText={setImportYaml}
            multiline
            textAlignVertical="top"
            placeholder={t("byokMobile.importPlaceholder")}
            className="min-h-32 font-mono"
            editable={!importing}
          />
          <ActionButton
            label={importing ? t("byokMobile.importing") : t("byokMobile.importButton")}
            disabled={importing || importYaml.trim().length === 0}
            onPress={() => void importAdapters()}
          />
          {importSummary === null ? null : (
            <Text className="text-sm text-foreground-muted">{importSummary}</Text>
          )}
        </View>
      </SettingsSection>

      <ActionButton
        label={t("byokMobile.deleteInstance")}
        disabled={saving}
        onPress={props.onDelete}
      />
    </View>
  );
}

function AdapterCard(props: {
  readonly adapter: ByokModelAdapter;
  readonly balance?: ByokBalanceResult;
  readonly discovery?: {
    readonly models: ReadonlyArray<ByokDiscoveredModel>;
    readonly error?: string;
  };
  readonly discovering: boolean;
  readonly matching: boolean;
  readonly disabled: boolean;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
  readonly onDiscover: () => void;
  readonly onMatchContext: () => void;
  readonly onBalance: () => void;
  readonly onSelectModel: (model: ByokDiscoveredModel) => void;
}) {
  return (
    <View className="gap-2 border-b border-border-subtle p-4 last:border-b-0">
      <View className="flex-row items-center gap-2">
        <Text
          className="min-w-0 flex-1 text-base font-codework-medium text-foreground"
          numberOfLines={1}
        >
          {props.adapter.displayName || props.adapter.modelId}
        </Text>
        <BadgePill label={props.adapter.protocol} />
      </View>
      <Text className="font-mono text-xs text-foreground-muted" numberOfLines={1}>
        {props.adapter.modelId}
      </Text>
      <Text className="text-xs text-foreground-muted" numberOfLines={1}>
        {props.adapter.baseURL}
      </Text>
      <Text className="text-xs text-foreground-muted">
        {t("byokMobile.contextWindowValue", { value: props.adapter.contextWindowTokens })} ·{" "}
        {props.adapter.apiKeyRedacted === true
          ? t("byokMobile.keyStored")
          : t("byokMobile.keyMissing")}
      </Text>
      <View className="flex-row flex-wrap gap-2">
        <ActionButton label={t("edit")} disabled={props.disabled} onPress={props.onEdit} />
        <ActionButton
          label={props.discovering ? t("byokMobile.discovering") : t("byokMobile.discover")}
          disabled={props.disabled || props.discovering}
          onPress={props.onDiscover}
        />
        <ActionButton
          label={props.matching ? t("byokMobile.matching") : t("byokMobile.matchContext")}
          disabled={props.disabled || props.matching}
          onPress={props.onMatchContext}
        />
        <ActionButton
          label={t("byokMobile.balance")}
          disabled={props.disabled}
          onPress={props.onBalance}
        />
        <ActionButton label={t("delete")} disabled={props.disabled} onPress={props.onDelete} />
      </View>
      {props.discovery?.error === undefined && (props.discovery?.models.length ?? 0) > 0 ? (
        <View className="gap-2 rounded-[16px] bg-subtle p-3">
          <Text className="text-xs font-codework-medium text-foreground">
            {t("byokMobile.discoveredModels")}
          </Text>
          {props.discovery?.models.slice(0, 12).map((model) => (
            <Pressable
              key={model.id}
              accessibilityRole="button"
              accessibilityLabel={t("byokMobile.useModel", { model: model.id })}
              disabled={props.disabled}
              onPress={() => props.onSelectModel(model)}
              className="rounded-xl bg-card px-3 py-2"
            >
              <Text className="font-mono text-xs text-foreground">{model.id}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {props.discovery?.error === undefined ? null : (
        <Text className="text-xs text-danger-foreground">{props.discovery.error}</Text>
      )}
      {props.balance === undefined ? null : (
        <View className="gap-1 rounded-[16px] bg-subtle p-3">
          <Text className="text-sm text-foreground">{props.balance.message}</Text>
          {props.balance.remaining === undefined ? null : (
            <Text className="text-xs text-foreground-muted">
              {t("byokMobile.remainingValue", { value: props.balance.remaining })}{" "}
              {props.balance.currency}
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

function AdapterEditor(props: {
  readonly form: MobileByokAdapterForm;
  readonly existing?: ByokModelAdapter;
  readonly catalog: ReadonlyArray<ByokSupplierCatalogEntry>;
  readonly draftDiscovery: ByokDraftModelDiscoveryResult | null;
  readonly discoveringDraft: boolean;
  readonly error: string | null;
  readonly disabled: boolean;
  readonly onChange: (patch: Partial<MobileByokAdapterForm>) => void;
  readonly onDiscover: () => void;
  readonly onSelectModel: (model: ByokDiscoveredModel) => void;
  readonly onSave: () => void;
  readonly onCancel: () => void;
}) {
  return (
    <View className="gap-3 rounded-[20px] bg-subtle p-4">
      <Text className="text-base font-codework-medium text-foreground">
        {props.existing === undefined ? t("byokMobile.addAdapter") : t("byokMobile.editAdapter")}
      </Text>
      {props.catalog.length === 0 ? null : (
        <View className="gap-2">
          <Text className="text-sm font-codework-medium text-foreground">
            {t("byokMobile.catalog")}
          </Text>
          <View className="flex-row flex-wrap gap-2">
            {props.catalog.map((entry) => (
              <ActionButton
                key={entry.id}
                label={entry.label}
                disabled={props.disabled}
                onPress={() =>
                  props.onChange({
                    supplierID: entry.id,
                    protocol: entry.protocol,
                    baseURL: entry.defaultBaseURL,
                  })
                }
              />
            ))}
          </View>
        </View>
      )}
      <Field label={t("byokMobile.displayName")}>
        <TextInput
          value={props.form.displayName}
          onChangeText={(displayName) => props.onChange({ displayName })}
          editable={!props.disabled}
          autoCorrect={false}
        />
      </Field>
      <Field label={t("byokMobile.groupName")}>
        <TextInput
          value={props.form.groupName}
          onChangeText={(groupName) => props.onChange({ groupName })}
          editable={!props.disabled}
          autoCorrect={false}
        />
      </Field>
      <ChoiceGroup
        label={t("byokMobile.protocol")}
        options={["openai", "anthropic", "gemini"]}
        selected={props.form.protocol}
        disabled={props.disabled}
        onSelect={(protocol) => props.onChange({ protocol })}
      />
      <Field label={t("byokMobile.baseURL")}>
        <TextInput
          value={props.form.baseURL}
          onChangeText={(baseURL) => props.onChange({ baseURL })}
          editable={!props.disabled}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
      </Field>
      <Field label={t("byokMobile.apiKey")}>
        <TextInput
          value={props.form.apiKey}
          onChangeText={(apiKey) => props.onChange({ apiKey })}
          editable={!props.disabled}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          placeholder={
            props.existing?.apiKeyRedacted === true
              ? t("byokMobile.keyStoredPlaceholder")
              : undefined
          }
        />
      </Field>
      <View className="flex-row flex-wrap gap-2">
        <ActionButton
          label={
            props.discoveringDraft ? t("byokMobile.discovering") : t("byokMobile.discoverDraft")
          }
          disabled={props.disabled || props.discoveringDraft}
          onPress={props.onDiscover}
        />
      </View>
      {props.draftDiscovery?.models.length ? (
        <View className="gap-2 rounded-[16px] bg-card p-3">
          <Text className="text-xs font-codework-medium text-foreground">
            {t("byokMobile.chooseModel")}
          </Text>
          {props.draftDiscovery.models.slice(0, 20).map((model) => (
            <Pressable
              key={model.id}
              accessibilityRole="button"
              accessibilityLabel={t("byokMobile.useModel", { model: model.id })}
              disabled={props.disabled}
              onPress={() => props.onSelectModel(model)}
              className="rounded-xl bg-subtle px-3 py-2"
            >
              <Text className="font-mono text-xs text-foreground">{model.id}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <Field label={t("byokMobile.modelId")}>
        <TextInput
          value={props.form.modelId}
          onChangeText={(modelId) => props.onChange({ modelId })}
          editable={!props.disabled}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </Field>
      <Field label={t("byokMobile.contextWindow")}>
        <TextInput
          value={props.form.contextWindowTokens}
          onChangeText={(contextWindowTokens) => props.onChange({ contextWindowTokens })}
          editable={!props.disabled}
          keyboardType="number-pad"
        />
      </Field>
      <ChoiceGroup
        label={t("byokMobile.balanceProfile")}
        options={["auto", "general", "newapi", "none"]}
        selected={props.form.balanceProfile}
        disabled={props.disabled}
        onSelect={(balanceProfile) => props.onChange({ balanceProfile })}
      />
      <Field label={t("byokMobile.balanceToken")}>
        <TextInput
          value={props.form.balanceAccessToken}
          onChangeText={(balanceAccessToken) => props.onChange({ balanceAccessToken })}
          editable={!props.disabled}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          placeholder={
            props.existing?.balanceAccessTokenRedacted === true
              ? t("byokMobile.keyStoredPlaceholder")
              : undefined
          }
        />
      </Field>
      <Field label={t("byokMobile.balanceUserId")}>
        <TextInput
          value={props.form.balanceUserID}
          onChangeText={(balanceUserID) => props.onChange({ balanceUserID })}
          editable={!props.disabled}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </Field>
      {props.error === null ? null : (
        <Text className="text-sm text-danger-foreground">{props.error}</Text>
      )}
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
  );
}

function DelegationRow(props: {
  readonly delegation: ByokDelegationSnapshot;
  readonly disabled: boolean;
  readonly onCancel: () => void;
}) {
  const terminal = [
    "succeeded",
    "failed",
    "cancelled",
    "queue_timed_out",
    "execution_timed_out",
  ].includes(props.delegation.status);
  return (
    <View className="gap-2 rounded-[16px] bg-subtle p-3">
      <View className="flex-row items-center gap-2">
        <Text className="min-w-0 flex-1 font-mono text-xs text-foreground-muted" numberOfLines={1}>
          {props.delegation.id}
        </Text>
        <BadgePill label={props.delegation.status} emphasized={!terminal} />
      </View>
      <Text className="text-sm text-foreground">{props.delegation.taskPreview}</Text>
      {props.delegation.resultPreview === undefined ? null : (
        <Text className="text-xs text-foreground-muted">{props.delegation.resultPreview}</Text>
      )}
      {terminal ? null : (
        <ActionButton label={t("cancel")} disabled={props.disabled} onPress={props.onCancel} />
      )}
    </View>
  );
}

function SettingsSection(props: {
  readonly title: string;
  readonly children: React.ReactNode;
  readonly card?: boolean;
}) {
  return (
    <View className="gap-2">
      <Text className="px-2 text-sm font-codework-medium text-foreground-muted">{props.title}</Text>
      <View
        className={
          props.card
            ? "overflow-hidden rounded-[20px] bg-card"
            : "overflow-hidden rounded-[20px] bg-subtle"
        }
      >
        {props.children}
      </View>
    </View>
  );
}

function Field(props: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <View className="gap-2">
      <Text className="text-sm font-codework-medium text-foreground">{props.label}</Text>
      {props.children}
    </View>
  );
}

function ChoiceGroup<T extends string>(props: {
  readonly label: string;
  readonly options: ReadonlyArray<T>;
  readonly selected: T;
  readonly disabled: boolean;
  readonly onSelect: (value: T) => void;
}) {
  return (
    <View className="gap-2">
      <Text className="text-sm font-codework-medium text-foreground">{props.label}</Text>
      <View className="flex-row flex-wrap gap-2">
        {props.options.map((option) => (
          <Pressable
            key={option}
            accessibilityRole="radio"
            accessibilityState={{ checked: props.selected === option, disabled: props.disabled }}
            disabled={props.disabled}
            onPress={() => props.onSelect(option)}
            className={
              props.selected === option
                ? "rounded-full bg-subtle-strong px-3 py-1.5"
                : "rounded-full bg-card px-3 py-1.5"
            }
          >
            <Text className="text-sm text-foreground">{option}</Text>
          </Pressable>
        ))}
      </View>
    </View>
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
      <Text className="min-w-0 flex-1 text-base text-foreground">{props.label}</Text>
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
  readonly emphasized?: boolean;
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

function StatusMessage(props: { readonly text: string }) {
  return (
    <View className="rounded-[24px] bg-card px-4 py-7">
      <Text className="text-center text-sm text-foreground-muted">{props.text}</Text>
    </View>
  );
}
