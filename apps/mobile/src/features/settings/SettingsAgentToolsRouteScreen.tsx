import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import {
  AGENT_HOOK_EVENTS,
  DEFAULT_SERVER_SETTINGS,
  WEB_SEARCH_ENGINES,
  type AgentHookEntry,
  type AgentHookEvent,
  type EnvironmentId,
  type ServerSettings,
  type ServerSettingsPatch,
  type WebSearchEngine,
} from "@codework/contracts";
import { Atom } from "effect/reactivity";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Platform, Pressable, ScrollView, Switch, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { t } from "../../i18n";
import { uuidv4 } from "../../lib/uuid";
import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsEnvironmentPicker } from "./components/SettingsEnvironmentPicker";
import { SettingsSection } from "./components/SettingsSection";

const emptyServerSettingsAtom = Atom.make<ServerSettings | null>(null);

const HOOK_EVENT_LABELS: Readonly<Record<AgentHookEvent, string>> = {
  user_prompt_submit: "agentToolsMobile.event.userPromptSubmit",
  pre_tool_use: "agentToolsMobile.event.preToolUse",
  post_tool_use: "agentToolsMobile.event.postToolUse",
  stop: "agentToolsMobile.event.stop",
};

const ENGINE_LABELS: Readonly<Record<WebSearchEngine, string>> = {
  duckduckgo: "agentToolsMobile.engine.duckduckgo",
  searxng: "agentToolsMobile.engine.searxng",
  tavily: "agentToolsMobile.engine.tavily",
  brave: "agentToolsMobile.engine.brave",
};

export function SettingsAgentToolsRouteScreen() {
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
  const saveSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notesDraft, setNotesDraft] = useState("");
  const [baseUrlDraft, setBaseUrlDraft] = useState("");
  const [apiKeyDraft, setApiKeyDraft] = useState("");

  useEffect(() => {
    if (
      selectedEnvironmentId !== null &&
      environments.some((item) => item.environmentId === selectedEnvironmentId)
    ) {
      return;
    }
    setSelectedEnvironmentId(environments[0]?.environmentId ?? null);
  }, [environments, selectedEnvironmentId]);

  const memory = settings?.agentMemory ?? DEFAULT_SERVER_SETTINGS.agentMemory;
  const hooksSettings = settings?.agentHooks ?? DEFAULT_SERVER_SETTINGS.agentHooks;
  const search = settings?.webSearch ?? DEFAULT_SERVER_SETTINGS.webSearch;
  const disabled = environmentId === null || saving;

  useEffect(() => {
    setNotesDraft(memory.userNotes);
    setBaseUrlDraft(search.baseUrl);
    setApiKeyDraft("");
  }, [environmentId, memory.userNotes, search.baseUrl]);

  const persist = useCallback(
    async (patch: ServerSettingsPatch) => {
      if (environmentId === null) return false;
      setSaving(true);
      const result = await saveSettings({ environmentId, input: { patch } });
      setSaving(false);
      if (result._tag === "Failure") {
        setError(t("agentToolsMobile.saveFailed"));
        return false;
      }
      setError(null);
      return true;
    },
    [environmentId, saveSettings],
  );

  const replaceHooks = useCallback(
    (hooks: ReadonlyArray<AgentHookEntry>) => {
      void persist({ agentHooks: { enabled: hooksSettings.enabled, hooks: [...hooks] } });
    },
    [hooksSettings.enabled, persist],
  );

  const needsKey = search.engine === "tavily" || search.engine === "brave";
  const needsUrl = search.engine === "searxng";

  return (
    <View className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader
            title={t("agentToolsMobile.title")}
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
        keyboardShouldPersistTaps="handled"
      >
        <Text className="px-2 text-sm leading-5 text-foreground-muted">
          {t("agentToolsMobile.description")}
        </Text>
        <SettingsEnvironmentPicker
          environments={environments}
          selectedEnvironmentId={environmentId}
          disabled={saving}
          onSelect={(next) => {
            setSelectedEnvironmentId(next);
            setError(null);
          }}
        />
        {environmentId === null ? (
          <StatusMessage text={t("agentToolsMobile.noEnvironment")} />
        ) : null}
        {error === null ? null : <StatusMessage text={error} tone="danger" />}

        <SettingsSection title={t("agentToolsMobile.memoryTitle")} card>
          <View className="gap-3 p-4">
            <Text className="text-sm leading-5 text-foreground-muted">
              {t("agentToolsMobile.memoryExplanation")}
            </Text>
            <ToggleRow
              label={t("agentToolsMobile.memoryToggle")}
              value={memory.enabled}
              disabled={disabled}
              onValueChange={(enabled) => void persist({ agentMemory: { enabled } })}
            />
            <Field label={t("agentToolsMobile.userNotes")}>
              <TextInput
                value={notesDraft}
                onChangeText={setNotesDraft}
                onBlur={() => {
                  if (notesDraft !== memory.userNotes) {
                    void persist({ agentMemory: { userNotes: notesDraft } });
                  }
                }}
                editable={!disabled && memory.enabled}
                multiline
                textAlignVertical="top"
                className="min-h-32"
                placeholder={t("agentToolsMobile.userNotesPlaceholder")}
              />
            </Field>
          </View>
        </SettingsSection>

        <SettingsSection title={t("agentToolsMobile.hooksTitle")} card>
          <View className="gap-3 p-4">
            <Text className="text-sm leading-5 text-foreground-muted">
              {t("agentToolsMobile.hooksExplanation")}
            </Text>
            <ToggleRow
              label={t("agentToolsMobile.hooksToggle")}
              value={hooksSettings.enabled}
              disabled={disabled}
              onValueChange={(enabled) =>
                void persist({ agentHooks: { enabled, hooks: [...hooksSettings.hooks] } })
              }
            />
            {hooksSettings.hooks.map((hook, index) => (
              <HookCard
                key={hook.id}
                hook={hook}
                disabled={disabled || !hooksSettings.enabled}
                onChange={(patch) => {
                  const next = hooksSettings.hooks.map((entry, entryIndex) =>
                    entryIndex === index ? { ...entry, ...patch } : entry,
                  );
                  replaceHooks(next);
                }}
                onRemove={() =>
                  replaceHooks(hooksSettings.hooks.filter((_, entryIndex) => entryIndex !== index))
                }
              />
            ))}
            <View className="flex-row">
              <ActionButton
                label={t("agentToolsMobile.addHook")}
                disabled={disabled}
                onPress={() =>
                  replaceHooks([
                    ...hooksSettings.hooks,
                    {
                      id: uuidv4(),
                      enabled: true,
                      event: "user_prompt_submit",
                      command: "",
                      matcher: "",
                    },
                  ])
                }
              />
            </View>
          </View>
        </SettingsSection>

        <SettingsSection title={t("agentToolsMobile.searchTitle")} card>
          <View className="gap-3 p-4">
            <Text className="text-sm leading-5 text-foreground-muted">
              {t("agentToolsMobile.searchExplanation")}
            </Text>
            <ToggleRow
              label={t("agentToolsMobile.searchToggle")}
              value={search.enabled}
              disabled={disabled}
              onValueChange={(enabled) => void persist({ webSearch: { enabled } })}
            />
            <Field label={t("agentToolsMobile.engine")}>
              <View className="flex-row flex-wrap gap-2">
                {WEB_SEARCH_ENGINES.map((engine) => (
                  <Choice
                    key={engine}
                    label={t(ENGINE_LABELS[engine])}
                    selected={search.engine === engine}
                    disabled={disabled}
                    onPress={() => void persist({ webSearch: { engine } })}
                  />
                ))}
              </View>
            </Field>
            {needsUrl ? (
              <Field label={t("agentToolsMobile.baseUrl")}>
                <TextInput
                  value={baseUrlDraft}
                  onChangeText={setBaseUrlDraft}
                  onBlur={() => {
                    const baseUrl = baseUrlDraft.trim();
                    if (baseUrl !== search.baseUrl) {
                      void persist({ webSearch: { baseUrl } });
                    }
                  }}
                  editable={!disabled}
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder="https://searx.example"
                />
              </Field>
            ) : null}
            {needsKey ? (
              <Field label={t("agentToolsMobile.apiKey")}>
                <TextInput
                  value={apiKeyDraft}
                  onChangeText={setApiKeyDraft}
                  onBlur={() => {
                    const apiKey = apiKeyDraft.trim();
                    if (apiKey.length > 0) {
                      void persist({ webSearch: { apiKey } });
                      setApiKeyDraft("");
                    }
                  }}
                  editable={!disabled}
                  autoCapitalize="none"
                  autoCorrect={false}
                  secureTextEntry
                  placeholder={
                    search.apiKeyRedacted === true
                      ? t("agentToolsMobile.apiKeyStored")
                      : t("agentToolsMobile.apiKeyPlaceholder")
                  }
                />
                {search.apiKeyRedacted === true ? (
                  <View className="flex-row">
                    <ActionButton
                      label={t("agentToolsMobile.apiKeyRemove")}
                      disabled={disabled}
                      danger
                      onPress={() =>
                        void persist({ webSearch: { apiKey: "", apiKeyRedacted: false } })
                      }
                    />
                  </View>
                ) : null}
              </Field>
            ) : null}
          </View>
        </SettingsSection>
      </ScrollView>
    </View>
  );
}

function HookCard(props: {
  readonly hook: AgentHookEntry;
  readonly disabled: boolean;
  readonly onChange: (patch: Partial<AgentHookEntry>) => void;
  readonly onRemove: () => void;
}) {
  const [command, setCommand] = useState(props.hook.command);
  const [matcher, setMatcher] = useState(props.hook.matcher);
  const showMatcher = props.hook.event === "pre_tool_use" || props.hook.event === "post_tool_use";

  useEffect(() => {
    setCommand(props.hook.command);
    setMatcher(props.hook.matcher);
  }, [props.hook.command, props.hook.matcher]);

  return (
    <View className="gap-3 rounded-[16px] bg-subtle p-3">
      <View className="flex-row flex-wrap gap-2">
        {AGENT_HOOK_EVENTS.map((event) => (
          <Choice
            key={event}
            label={t(HOOK_EVENT_LABELS[event])}
            selected={props.hook.event === event}
            disabled={props.disabled}
            onPress={() => props.onChange({ event })}
          />
        ))}
      </View>
      <ToggleRow
        label={t("agentToolsMobile.hookEnabled")}
        value={props.hook.enabled}
        disabled={props.disabled}
        onValueChange={(enabled) => props.onChange({ enabled })}
      />
      <Field label={t("agentToolsMobile.command")}>
        <TextInput
          value={command}
          onChangeText={setCommand}
          onBlur={() => {
            if (command !== props.hook.command) props.onChange({ command });
          }}
          editable={!props.disabled}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={t("agentToolsMobile.commandPlaceholder")}
        />
      </Field>
      {showMatcher ? (
        <Field label={t("agentToolsMobile.matcher")}>
          <TextInput
            value={matcher}
            onChangeText={setMatcher}
            onBlur={() => {
              if (matcher !== props.hook.matcher) props.onChange({ matcher });
            }}
            editable={!props.disabled}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder={t("agentToolsMobile.matcherPlaceholder")}
          />
        </Field>
      ) : null}
      <View className="flex-row">
        <ActionButton
          label={t("agentToolsMobile.removeHook")}
          disabled={props.disabled}
          danger
          onPress={props.onRemove}
        />
      </View>
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
