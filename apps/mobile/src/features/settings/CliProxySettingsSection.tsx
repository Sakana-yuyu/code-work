import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Alert, Pressable, View } from "react-native";
import {
  ProviderInstanceId,
  type CliProxyRequest,
  type CliProxyResult,
  type EnvironmentId,
  type LocalAccountPoolStrategy,
} from "@codework/contracts";
import { squashAtomCommandFailure } from "@codework/client-runtime/state/runtime";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { t } from "../../i18n";
import { SettingsSection } from "./components/SettingsSection";

export function CliProxySettingsSection({
  environmentId,
  readOnly,
  onManageRoutes,
}: {
  environmentId: EnvironmentId;
  readOnly: boolean;
  onManageRoutes: () => void;
}) {
  const command = useAtomCommand(serverEnvironment.cliProxy, { reportFailure: false });
  const [status, setStatus] = useState<CliProxyResult | null>(null);
  const [strategy, setStrategy] = useState<LocalAccountPoolStrategy>("round-robin");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importName, setImportName] = useState("");
  const [importContent, setImportContent] = useState("");
  const [instanceId, setInstanceId] = useState("cpa");
  const [displayName, setDisplayName] = useState("CPA");
  const [localProvider, setLocalProvider] = useState<"codex" | "claude" | "xai" | "cursor">(
    "codex",
  );
  const [localId, setLocalId] = useState("");
  const [localDisplayName, setLocalDisplayName] = useState("");
  const [localContent, setLocalContent] = useState("");
  const [localModels, setLocalModels] = useState("");
  const [localInstanceId, setLocalInstanceId] = useState("");
  const [localStrategy, setLocalStrategy] = useState<LocalAccountPoolStrategy>("round-robin");
  const [externalKeyName, setExternalKeyName] = useState("");
  const [issuedExternalKey, setIssuedExternalKey] = useState("");

  const run = useCallback(
    async (input: CliProxyRequest) => {
      if (lock.current || readOnly) return;
      lock.current = true;
      setBusy(true);
      setFeedback(null);
      try {
        const result = await command({ environmentId, input });
        if (result._tag !== "Success") {
          const failure = squashAtomCommandFailure(result);
          throw failure instanceof Error ? failure : new Error(t("cliProxy.failed"));
        }
        setStatus(result.value);
        if (input.action === "status" || input.action === "configure") {
          setStrategy(result.value.config.strategy);
        }
        if (input.action === "importAccount") {
          setImportContent("");
          setImportName("");
          setImportOpen(false);
        }
        if (input.action === "importLocalAccount") setLocalContent("");
        if (result.value.localStrategy) setLocalStrategy(result.value.localStrategy);
        setIssuedExternalKey(result.value.externalGateway?.issuedKey ?? "");
        if (result.value.connectedInstanceId) setInstanceId(result.value.connectedInstanceId);
        setFeedback({ error: false, text: t("cliProxy.done") });
      } catch (error) {
        setFeedback({
          error: true,
          text: error instanceof Error ? error.message : t("cliProxy.failed"),
        });
      } finally {
        lock.current = false;
        setBusy(false);
      }
    },
    [command, environmentId, readOnly],
  );
  useEffect(() => {
    void run({ action: "status" });
  }, [run]);
  const disabled = busy || readOnly;
  const unavailable = disabled || !status?.running;
  const configure = () => {
    void run({ action: "configure", config: { strategy } });
  };
  return (
    <SettingsSection title={t("cliProxy.title")} card>
      <View className="gap-3 p-4">
        <Text className="text-sm text-foreground-muted">{t("cliProxy.description")}</Text>
        {readOnly ? (
          <Text className="text-sm text-foreground-muted">{t("cliProxy.noAccess")}</Text>
        ) : null}
        <Text accessibilityRole="text" className="text-sm text-foreground">
          {status ? t("cliProxy.running") : t("cliProxy.unknown")}
        </Text>
        {status?.running ? (
          <Text selectable className="text-xs text-foreground-muted">
            {status.baseUrl}
          </Text>
        ) : null}
        <Field label={t("cliProxy.strategy")}>
          <View className="flex-row flex-wrap gap-2">
            {(["round-robin", "fill-first", "weighted-round-robin"] as const).map((value) => (
              <Action
                key={value}
                label={t(
                  value === "round-robin"
                    ? "cliProxy.roundRobin"
                    : value === "fill-first"
                      ? "cliProxy.fillFirst"
                      : "cliProxy.weightedRoundRobin",
                )}
                selected={value === strategy}
                disabled={disabled}
                onPress={() => setStrategy(value)}
              />
            ))}
          </View>
        </Field>
        <View className="flex-row flex-wrap gap-2">
          <Action
            label={t("cliProxy.saveConfig")}
            disabled={disabled || (status !== null && strategy === status.config.strategy)}
            onPress={configure}
          />
          <Action
            label={t("cliProxy.refresh")}
            disabled={disabled}
            onPress={() => void run({ action: "status" })}
          />
        </View>
        <View className="gap-2 border-t border-border-subtle pt-3">
          <Text className="text-sm font-codework-medium text-foreground">
            {t("localAccountPool.title")}
          </Text>
          <Text className="text-xs text-foreground-muted">{t("localAccountPool.description")}</Text>
          <Field label={t("localAccountPool.provider")}>
            <View className="flex-row flex-wrap gap-2">
              {(["codex", "claude", "xai", "cursor"] as const).map((value) => (
                <Action
                  key={value}
                  label={t("cliProxy.login", {
                    provider:
                      value === "xai"
                        ? "Grok"
                        : value === "claude"
                          ? "Claude"
                          : value === "cursor"
                            ? "Cursor"
                            : "Codex",
                  })}
                  selected={localProvider === value}
                  disabled={disabled}
                  onPress={() => setLocalProvider(value)}
                />
              ))}
            </View>
          </Field>
          <Field label={t("localAccountPool.id")}>
            <TextInput
              value={localId}
              editable={!disabled}
              onChangeText={setLocalId}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </Field>
          <Field label={t("localAccountPool.displayName")}>
            <TextInput
              value={localDisplayName}
              editable={!disabled}
              onChangeText={setLocalDisplayName}
            />
          </Field>
          <Field label={t("localAccountPool.credential")}>
            <TextInput
              secureTextEntry
              autoComplete="off"
              value={localContent}
              editable={!disabled}
              onChangeText={setLocalContent}
              multiline
              autoCapitalize="none"
              autoCorrect={false}
            />
          </Field>
          <Field label={t("localAccountPool.models")}>
            <TextInput
              value={localModels}
              editable={!disabled}
              onChangeText={setLocalModels}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </Field>
          <Action
            label={t("localAccountPool.import")}
            disabled={
              disabled || !localId.trim() || !localDisplayName.trim() || !localContent.trim()
            }
            onPress={() => {
              let content = localContent;
              try {
                const value = JSON.parse(content) as Record<string, unknown>;
                const models = localModels
                  .split(",")
                  .map((model) => model.trim())
                  .filter(Boolean);
                if (models.length > 0) value.models = models;
                content = JSON.stringify(value);
              } catch {
                /* 服务端校验 JSON */
              }
              void run({
                action: "importLocalAccount",
                id: localId.trim(),
                provider: localProvider,
                displayName: localDisplayName.trim(),
                content,
              });
            }}
          />
          {status?.localAccounts?.map((account) => (
            <View
              key={account.id}
              className="flex-row items-center justify-between gap-2 rounded-2xl border border-border-subtle p-3"
            >
              <Text className="flex-1 text-xs text-foreground" numberOfLines={1}>
                {account.displayName} · {account.provider}
              </Text>
              {localStrategy === "weighted-round-robin" ? (
                <TextInput
                  defaultValue={String(account.weight ?? 1)}
                  editable={!disabled}
                  keyboardType="number-pad"
                  accessibilityLabel={t("cliProxy.weightFor", { name: account.displayName })}
                  className="w-12 rounded-lg border border-border-subtle px-2 py-1 text-center text-xs text-foreground"
                  onEndEditing={(event) => {
                    const weight = Number.parseInt(event.nativeEvent.text, 10);
                    if (!Number.isFinite(weight)) return;
                    void run({
                      action: "setLocalAccountWeight",
                      id: account.id,
                      weight: Math.min(99, Math.max(1, weight)),
                    });
                  }}
                />
              ) : null}
              <View className="flex-row gap-2">
                <Action
                  label={account.enabled ? t("cliProxy.disable") : t("cliProxy.enable")}
                  disabled={disabled}
                  onPress={() =>
                    void run({
                      action: "setLocalAccountEnabled",
                      id: account.id,
                      enabled: !account.enabled,
                    })
                  }
                />
                <Action
                  label={t("delete")}
                  disabled={disabled}
                  onPress={() => void run({ action: "deleteLocalAccount", id: account.id })}
                />
              </View>
            </View>
          ))}
          <Field label={t("localAccountPool.strategy")}>
            <View className="flex-row flex-wrap gap-2">
              {(["round-robin", "fill-first", "weighted-round-robin"] as const).map((value) => (
                <Action
                  key={value}
                  label={t(
                    value === "round-robin"
                      ? "cliProxy.roundRobin"
                      : value === "fill-first"
                        ? "cliProxy.fillFirst"
                        : "cliProxy.weightedRoundRobin",
                  )}
                  selected={localStrategy === value}
                  disabled={disabled}
                  onPress={() => {
                    setLocalStrategy(value);
                    void run({ action: "setLocalAccountPoolStrategy", strategy: value });
                  }}
                />
              ))}
            </View>
          </Field>
          <Field label={t("localAccountPool.instancePlaceholder")}>
            <TextInput
              value={localInstanceId}
              editable={!disabled}
              onChangeText={setLocalInstanceId}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </Field>
          <Action
            label={t("localAccountPool.bind")}
            disabled={disabled || !localInstanceId.trim()}
            onPress={() =>
              void run({
                action: "publishLocalAccountPool",
                instanceId: ProviderInstanceId.make(localInstanceId.trim()),
                provider: localProvider,
              })
            }
          />
        </View>
        <View className="gap-2 border-t border-border-subtle pt-3">
          <Text className="text-sm font-codework-medium text-foreground">
            {t("localAccountPool.externalTitle")}
          </Text>
          <Text className="text-xs text-foreground-muted">
            {t("localAccountPool.externalDescription")}
          </Text>
          {status?.externalGateway ? (
            <>
              <Field label={t("localAccountPool.externalOpenai")}>
                <Text selectable className="text-xs text-foreground">
                  {status.externalGateway.openaiBaseUrl}
                </Text>
              </Field>
              <Field label={t("localAccountPool.externalAnthropic")}>
                <Text selectable className="text-xs text-foreground">
                  {status.externalGateway.anthropicBaseUrl}
                </Text>
              </Field>
            </>
          ) : null}
          <Field label={t("localAccountPool.externalName")}>
            <TextInput
              value={externalKeyName}
              editable={!disabled}
              onChangeText={setExternalKeyName}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </Field>
          <Action
            label={t("localAccountPool.externalCreate")}
            disabled={disabled || !externalKeyName.trim()}
            onPress={() =>
              void run({ action: "createExternalGatewayKey", name: externalKeyName.trim() })
            }
          />
          {issuedExternalKey ? (
            <Field label={t("localAccountPool.externalKey")}>
              <Text selectable className="text-xs text-foreground">
                {issuedExternalKey}
              </Text>
            </Field>
          ) : null}
          {status?.externalGateway?.keys.length ? (
            status.externalGateway.keys.map((key) => (
              <View
                key={key.id}
                className="flex-row items-center justify-between gap-2 rounded-2xl border border-border-subtle p-3"
              >
                <Text className="text-xs text-foreground">{key.name}</Text>
                <View className="flex-row gap-2">
                  <Action
                    label={t("localAccountPool.externalRotate")}
                    disabled={disabled}
                    onPress={() => void run({ action: "rotateExternalGatewayKey", id: key.id })}
                  />
                  <Action
                    label={t("localAccountPool.externalRevoke")}
                    disabled={disabled}
                    onPress={() => void run({ action: "revokeExternalGatewayKey", id: key.id })}
                  />
                </View>
              </View>
            ))
          ) : (
            <Text className="text-xs text-foreground-muted">
              {t("localAccountPool.externalEmpty")}
            </Text>
          )}
        </View>
        <Text className="text-sm font-codework-medium text-foreground">
          {t("cliProxy.accounts")}
        </Text>
        <Action
          label={t("cliProxy.refreshAccounts")}
          disabled={unavailable}
          onPress={() => void run({ action: "accounts" })}
        />
        {status?.accounts.length === 0 ? (
          <Text className="text-xs text-foreground-muted">{t("cliProxy.noAccounts")}</Text>
        ) : null}
        {status?.accounts.map((account) => (
          <View key={account.name} className="gap-2 rounded-2xl border border-border-subtle p-3">
            <Text className="text-xs text-foreground">
              {account.name} · {account.provider}
            </Text>
            <Text className="text-xs text-foreground-muted">
              {account.disabled ? t("cliProxy.disabled") : account.status}
            </Text>
            <View className="flex-row flex-wrap gap-2">
              <Action
                label={t(account.disabled ? "cliProxy.enable" : "cliProxy.disable")}
                disabled={unavailable}
                onPress={() =>
                  void run({
                    action: "setAccountEnabled",
                    name: account.name,
                    enabled: account.disabled,
                  })
                }
              />
              <Action
                label={t("delete")}
                disabled={unavailable}
                onPress={() =>
                  Alert.alert(t("cliProxy.confirmDelete"), account.name, [
                    { text: t("cancel"), style: "cancel" },
                    {
                      text: t("delete"),
                      style: "destructive",
                      onPress: () => void run({ action: "deleteAccount", name: account.name }),
                    },
                  ])
                }
              />
            </View>
          </View>
        ))}
        <Action
          label={t("cliProxy.import")}
          disabled={unavailable}
          onPress={() => setImportOpen(true)}
        />
        {importOpen ? (
          <View className="gap-2">
            <Field label={t("cliProxy.importName")}>
              <TextInput
                value={importName}
                editable={!unavailable}
                onChangeText={setImportName}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="account.json"
              />
            </Field>
            <Field label={t("cliProxy.importContent")}>
              <TextInput
                secureTextEntry
                autoComplete="off"
                autoCorrect={false}
                autoCapitalize="none"
                value={importContent}
                maxLength={1048576}
                editable={!unavailable}
                onChangeText={setImportContent}
              />
            </Field>
            <Text className="text-xs text-foreground-muted">{t("cliProxy.importHint")}</Text>
            <View className="flex-row flex-wrap gap-2">
              <Action
                label={t("cliProxy.import")}
                disabled={unavailable || !importName.trim() || !importContent.trim()}
                onPress={() =>
                  void run({
                    action: "importAccount",
                    name: importName.trim(),
                    content: importContent,
                  })
                }
              />
              <Action
                label={t("cancel")}
                disabled={busy}
                onPress={() => {
                  setImportContent("");
                  setImportName("");
                  setImportOpen(false);
                }}
              />
            </View>
          </View>
        ) : null}
        <Text className="text-xs text-foreground-muted">{t("cliProxy.connectHint")}</Text>
        <Field label={t("cliProxy.instanceId")}>
          <TextInput
            editable={!unavailable && !status?.connectedInstanceId}
            value={instanceId}
            maxLength={64}
            onChangeText={setInstanceId}
            autoCorrect={false}
            autoCapitalize="none"
          />
        </Field>
        <Field label={t("cliProxy.displayName")}>
          <TextInput editable={!unavailable} value={displayName} onChangeText={setDisplayName} />
        </Field>
        <Action
          label={t("cliProxy.connect")}
          disabled={
            unavailable || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(instanceId) || !displayName.trim()
          }
          onPress={() =>
            void run({
              action: "connectByok",
              instanceId: ProviderInstanceId.make(instanceId),
              displayName: displayName.trim(),
            })
          }
        />
        {status?.connectedInstanceId ? (
          <Text className="text-xs text-foreground-muted">
            {t("cliProxy.connected", { id: status.connectedInstanceId })}
          </Text>
        ) : null}
        <Action label={t("cliProxy.editRoute")} disabled={readOnly} onPress={onManageRoutes} />
        {feedback ? (
          <Text
            accessibilityRole="alert"
            className={
              feedback.error ? "text-xs text-danger-foreground" : "text-xs text-foreground-muted"
            }
          >
            {feedback.text}
          </Text>
        ) : null}
      </View>
    </SettingsSection>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View className="gap-1.5">
      <Text className="text-sm font-codework-medium text-foreground">{label}</Text>
      {children}
    </View>
  );
}

function Action({
  label,
  disabled,
  selected,
  onPress,
}: {
  label: string;
  disabled?: boolean;
  selected?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled, selected: !!selected }}
      disabled={disabled}
      onPress={onPress}
      className={`rounded-2xl border border-input-border px-4 py-3 ${disabled ? "opacity-50" : ""} ${selected ? "bg-accent" : ""}`}
    >
      <Text className={selected ? "text-sm text-accent-foreground" : "text-sm text-foreground"}>
        {label}
      </Text>
    </Pressable>
  );
}
