import { useAtomValue } from "@effect/atom-react";
import type {
  ByokModelAdapter,
  EnvironmentId,
  ProviderInstanceConfig,
  ServerSettings,
} from "@codework/contracts";
import { Atom } from "effect/reactivity";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { t } from "../../i18n";
import { uuidv4 } from "../../lib/uuid";
import {
  findProviderImportDuplicate,
  maskProviderImportKey,
  type ProviderImportPayload,
} from "@codework/shared/providerImport";
import { resolveProviderImportRequest } from "../../lib/providerImportLink";
import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsEnvironmentPicker } from "./components/SettingsEnvironmentPicker";
import {
  createByokProviderInstance,
  normalizeByokInstanceId,
  patchByokConfig,
  readByokModelAdapters,
} from "./SettingsByokRouteScreen.logic";

const EMPTY_SERVER_SETTINGS_ATOM = Atom.make<ServerSettings | null>(null).pipe(
  Atom.withLabel("mobile-provider-import:settings:empty"),
);

type DuplicateChoice = "update-key" | "save-another";

const protocolLabel = (protocol: ProviderImportPayload["protocol"]): string => {
  switch (protocol) {
    case "anthropic":
      return "Anthropic";
    case "gemini":
      return "Gemini";
    default:
      return "OpenAI";
  }
};

export function SettingsProviderImportRouteScreen({
  route,
}: StaticScreenProps<Record<string, string> | undefined>) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { environments } = useEnvironments();

  const request = useMemo(() => resolveProviderImportRequest(route.params), [route.params]);
  const payload = request?.payload ?? null;

  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(
    () => environments[0]?.environmentId ?? null,
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

  const settings = useAtomValue(
    selectedEnvironmentId === null
      ? EMPTY_SERVER_SETTINGS_ATOM
      : serverEnvironment.settingsValueAtom(selectedEnvironmentId),
  );
  const saveSettings = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  });

  const [name, setName] = useState(payload?.name ?? "");
  const [apiKey, setApiKey] = useState(payload?.apiKey ?? "");
  const [modelId, setModelId] = useState("");
  const [duplicateChoice, setDuplicateChoice] = useState<DuplicateChoice>("update-key");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const providerInstances = settings?.providerInstances ?? {};
  const byokEntries = useMemo(
    () =>
      Object.entries(providerInstances).filter(
        ([, instance]) => instance.driver === "byok",
      ) as ReadonlyArray<[string, ProviderInstanceConfig]>,
    [providerInstances],
  );

  const duplicate = useMemo(() => {
    if (payload === null) return null;
    for (const [instanceId, instance] of byokEntries) {
      const match = findProviderImportDuplicate(readByokModelAdapters(instance.config), payload);
      if (match !== undefined) return { instanceId, instance, adapter: match };
    }
    return null;
  }, [byokEntries, payload]);

  const saveProviderInstances = async (
    nextProviderInstances: ServerSettings["providerInstances"],
  ): Promise<boolean> => {
    if (selectedEnvironmentId === null) return false;
    const result = await saveSettings({
      environmentId: selectedEnvironmentId,
      input: { patch: { providerInstances: nextProviderInstances } },
    });
    if (result._tag === "Failure") {
      setError(t("byokMobile.saveFailed"));
      return false;
    }
    return true;
  };

  const handleSave = async () => {
    if (payload === null || selectedEnvironmentId === null || saving) return;
    const trimmedKey = apiKey.trim();

    if (duplicate !== null && duplicateChoice === "update-key") {
      setSaving(true);
      try {
        const { instanceId, instance, adapter } = duplicate;
        const nextAdapters = readByokModelAdapters(instance.config).map((current) =>
          current.id === adapter.id ? { ...current, apiKey: trimmedKey } : current,
        );
        const { config: _omitConfig, ...rest } = instance;
        const saved = await saveProviderInstances({
          ...providerInstances,
          [instanceId]: {
            ...rest,
            config: patchByokConfig(instance.config, "adapters", nextAdapters),
          } as ProviderInstanceConfig,
        });
        if (saved) navigation.goBack();
      } finally {
        setSaving(false);
      }
      return;
    }

    if (modelId.trim().length === 0) {
      setError(t("providerImport.modelIdRequired"));
      return;
    }

    const nextAdapter: ByokModelAdapter = {
      id: uuidv4(),
      displayName: name.trim() || payload.name,
      protocol: payload.protocol,
      baseURL: payload.baseURL,
      apiKey: trimmedKey,
      modelId: modelId.trim(),
      contextWindowTokens: 128000,
      balanceAccessToken: "",
      customHeaders: "",
    };

    setSaving(true);
    try {
      const targetId = duplicate !== null ? duplicate.instanceId : (byokEntries[0]?.[0] ?? null);
      if (targetId !== null) {
        const instance = (providerInstances as Readonly<Record<string, ProviderInstanceConfig>>)[
          targetId
        ];
        if (instance === undefined) return;
        const { config: _omitConfig, ...rest } = instance;
        const nextAdapters = [...readByokModelAdapters(instance.config), nextAdapter];
        const saved = await saveProviderInstances({
          ...providerInstances,
          [targetId]: {
            ...rest,
            config: patchByokConfig(instance.config, "adapters", nextAdapters),
          } as ProviderInstanceConfig,
        });
        if (saved) navigation.goBack();
      } else {
        // No BYOK instance yet: the import creates one so the adapter has a home.
        const instanceId = normalizeByokInstanceId("byok");
        if (instanceId === null) return;
        const instance = createByokProviderInstance(instanceId, t("settings.byok"));
        const { config: _omitConfig, ...rest } = instance;
        const saved = await saveProviderInstances({
          ...providerInstances,
          [instanceId]: {
            ...rest,
            config: patchByokConfig(instance.config, "adapters", [nextAdapter]),
          } as ProviderInstanceConfig,
        });
        if (saved) navigation.goBack();
      }
    } finally {
      setSaving(false);
    }
  };

  const maskedKey = maskProviderImportKey(apiKey);
  const canSave =
    payload !== null &&
    selectedEnvironmentId !== null &&
    !saving &&
    (duplicate !== null && duplicateChoice === "update-key" ? true : modelId.trim().length > 0);

  return (
    <View style={{ flex: 1, paddingTop: insets.top }}>
      <AndroidScreenHeader title={t("providerImport.title")} onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }}>
        {request?.error !== undefined ? (
          <Text style={{ color: "#b91c1c" }}>{t("providerImport.errorInvalidLink")}</Text>
        ) : null}

        {payload !== null ? (
          <>
            {environments.length > 1 ? (
              <SettingsEnvironmentPicker
                environments={environments}
                selectedEnvironmentId={selectedEnvironmentId}
                onSelect={setSelectedEnvironmentId}
              />
            ) : null}

            <View style={{ gap: 6 }}>
              <Text style={{ fontSize: 13, fontWeight: "600" }}>{t("providerImport.name")}</Text>
              <TextInput value={name} onChangeText={setName} />
            </View>

            <View style={{ flexDirection: "row", gap: 12 }}>
              <View style={{ flex: 1, gap: 6 }}>
                <Text style={{ fontSize: 13, fontWeight: "600" }}>
                  {t("providerImport.protocol")}
                </Text>
                <Text>{protocolLabel(payload.protocol)}</Text>
              </View>
              <View style={{ flex: 2, gap: 6 }}>
                <Text style={{ fontSize: 13, fontWeight: "600" }}>
                  {t("providerImport.baseUrl")}
                </Text>
                <Text numberOfLines={1}>{payload.baseURL}</Text>
              </View>
            </View>

            <View style={{ gap: 6 }}>
              <Text style={{ fontSize: 13, fontWeight: "600" }}>{t("providerImport.apiKey")}</Text>
              <TextInput
                value={apiKey}
                onChangeText={setApiKey}
                secureTextEntry
                placeholder={t("providerImport.apiKeyEmpty")}
              />
              {maskedKey ? (
                <Text style={{ fontSize: 12, opacity: 0.7 }}>
                  {t("providerImport.apiKeyMasked", { key: maskedKey })}
                </Text>
              ) : null}
            </View>

            {duplicate !== null ? (
              <View style={{ gap: 8 }}>
                <Text style={{ fontSize: 13 }}>{t("providerImport.duplicateDescription")}</Text>
                {(["update-key", "save-another"] as const).map((choice) => (
                  <Pressable
                    key={choice}
                    onPress={() => setDuplicateChoice(choice)}
                    style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
                  >
                    <View
                      style={{
                        width: 16,
                        height: 16,
                        borderRadius: 8,
                        borderWidth: 2,
                        borderColor: "#888",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      {duplicateChoice === choice ? (
                        <View
                          style={{
                            width: 8,
                            height: 8,
                            borderRadius: 4,
                            backgroundColor: "#0a84ff",
                          }}
                        />
                      ) : null}
                    </View>
                    <Text>
                      {choice === "update-key"
                        ? t("providerImport.updateKey")
                        : t("providerImport.saveAnother")}
                    </Text>
                  </Pressable>
                ))}
              </View>
            ) : null}

            {duplicate === null || duplicateChoice === "save-another" ? (
              <View style={{ gap: 6 }}>
                <Text style={{ fontSize: 13, fontWeight: "600" }}>
                  {t("providerImport.modelId")}
                </Text>
                <TextInput
                  value={modelId}
                  onChangeText={(text) => {
                    setModelId(text);
                    setError(null);
                  }}
                  placeholder={t("providerImport.modelIdPlaceholder")}
                />
              </View>
            ) : null}

            {error !== null ? <Text style={{ color: "#b91c1c" }}>{error}</Text> : null}

            <Pressable
              onPress={() => void handleSave()}
              disabled={!canSave}
              style={{
                backgroundColor: canSave ? "#0a84ff" : "#9ca3af",
                borderRadius: 10,
                paddingVertical: 12,
                alignItems: "center",
              }}
            >
              <Text style={{ color: "#fff", fontWeight: "600" }}>
                {duplicate !== null && duplicateChoice === "update-key"
                  ? t("providerImport.updateKey")
                  : t("providerImport.confirm")}
              </Text>
            </Pressable>
          </>
        ) : request === null ? (
          <Text>{t("providerImport.errorInvalidLink")}</Text>
        ) : null}
      </ScrollView>
    </View>
  );
}
