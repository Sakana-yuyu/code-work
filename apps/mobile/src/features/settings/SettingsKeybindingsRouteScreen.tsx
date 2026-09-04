import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ServerConfig } from "@codework/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@codework/client-runtime/state/runtime";
import { Atom } from "effect/unstable/reactivity";
import { useNavigation } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Alert, Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { t } from "../../i18n";
import { useEnvironments } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { serverEnvironment } from "../../state/server";
import { SettingsEnvironmentPicker } from "./components/SettingsEnvironmentPicker";
import { SettingsSection } from "./components/SettingsSection";
import {
  defaultKeybindingForRow,
  draftFromKeybindingRow,
  emptyKeybindingDraft,
  keybindingInputFromDraft,
  keybindingRemoveTarget,
  keybindingRows,
  type MobileKeybindingDraft,
  type MobileKeybindingRow,
} from "./SettingsKeybindingsRouteScreen.logic";

const EMPTY_SERVER_CONFIG_ATOM = Atom.make<ServerConfig | null>(null).pipe(
  Atom.withLabel("mobile-keybindings:config:empty"),
);

export function SettingsKeybindingsRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { environments } = useEnvironments();
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(
    () => environments[0]?.environmentId ?? null,
  );
  const environmentId = selectedEnvironmentId;
  const config = useAtomValue(
    environmentId === null
      ? EMPTY_SERVER_CONFIG_ATOM
      : serverEnvironment.configValueAtom(environmentId),
  );
  const upsertKeybinding = useAtomCommand(serverEnvironment.upsertKeybinding, {
    reportFailure: false,
  });
  const removeKeybinding = useAtomCommand(serverEnvironment.removeKeybinding, {
    reportFailure: false,
  });
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<MobileKeybindingDraft>(emptyKeybindingDraft());
  const [pendingAction, setPendingAction] = useState<string | null>(null);
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

  const rows = useMemo(
    () => keybindingRows(config?.keybindings ?? [], query),
    [config?.keybindings, query],
  );

  const beginNew = useCallback(() => {
    setError(null);
    setForm(emptyKeybindingDraft());
    setEditingId("__new__");
  }, []);

  const beginEdit = useCallback((row: MobileKeybindingRow) => {
    setError(null);
    setForm(draftFromKeybindingRow(row));
    setEditingId(row.id);
  }, []);

  const saveForm = useCallback(async () => {
    if (environmentId === null) return;
    const input = keybindingInputFromDraft(form);
    if (input === null) {
      setError(t("keybindingsMobile.invalidForm"));
      return;
    }
    const editingRow =
      editingId === null || editingId === "__new__"
        ? undefined
        : rows.find((row) => row.id === editingId);
    setPendingAction(`save:${editingId ?? "new"}`);
    const result = await upsertKeybinding({
      environmentId,
      input: {
        ...input,
        ...(editingRow ? { replace: keybindingRemoveTarget(editingRow) } : {}),
      },
    });
    setPendingAction(null);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : t("keybindingsMobile.saveFailed"));
      }
      return;
    }
    setError(null);
    setEditingId(null);
  }, [editingId, environmentId, form, rows, upsertKeybinding]);

  const deleteRow = useCallback(
    (row: MobileKeybindingRow) => {
      Alert.alert(t("keybindingsMobile.deleteTitle"), t("keybindingsMobile.deleteDescription"), [
        { text: t("cancel"), style: "cancel" },
        {
          text: t("delete"),
          style: "destructive",
          onPress: () => {
            if (environmentId === null) return;
            void (async () => {
              setPendingAction(`delete:${row.id}`);
              const result = await removeKeybinding({
                environmentId,
                input: keybindingRemoveTarget(row),
              });
              setPendingAction(null);
              if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
                const failure = squashAtomCommandFailure(result);
                setError(
                  failure instanceof Error ? failure.message : t("keybindingsMobile.deleteFailed"),
                );
              } else if (editingId === row.id) {
                setEditingId(null);
              }
            })();
          },
        },
      ]);
    },
    [editingId, environmentId, removeKeybinding],
  );

  const resetRow = useCallback(
    (row: MobileKeybindingRow) => {
      if (environmentId === null) return;
      const defaultBinding = defaultKeybindingForRow(row);
      if (!defaultBinding) return;
      void (async () => {
        setPendingAction(`reset:${row.id}`);
        const result = await upsertKeybinding({
          environmentId,
          input: {
            ...defaultBinding,
            replace: keybindingRemoveTarget(row),
          },
        });
        setPendingAction(null);
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const failure = squashAtomCommandFailure(result);
          setError(failure instanceof Error ? failure.message : t("keybindingsMobile.saveFailed"));
        }
      })();
    },
    [environmentId, upsertKeybinding],
  );

  return (
    <View className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader
            title={t("keybindingsMobile.title")}
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
          {t("keybindingsMobile.description")}
        </Text>
        <SettingsEnvironmentPicker
          environments={environments}
          selectedEnvironmentId={environmentId}
          disabled={pendingAction !== null}
          onSelect={(next) => {
            setSelectedEnvironmentId(next);
            setEditingId(null);
            setError(null);
          }}
        />
        {environmentId === null ? (
          <StatusMessage text={t("keybindingsMobile.noEnvironment")} />
        ) : null}
        {config === null && environmentId !== null ? (
          <StatusMessage text={t("keybindingsMobile.loading")} />
        ) : null}
        {error ? <StatusMessage text={error} tone="danger" /> : null}
        {editingId !== null ? (
          <KeybindingEditor
            draft={form}
            disabled={pendingAction !== null}
            onChange={(patch) => setForm((current) => ({ ...current, ...patch }))}
            onSave={() => void saveForm()}
            onCancel={() => setEditingId(null)}
          />
        ) : null}
        <SettingsSection title={t("keybindingsMobile.title")} card>
          <View className="gap-3 border-b border-border-subtle p-4">
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder={t("keybindingsMobile.searchPlaceholder")}
              autoCapitalize="none"
              autoCorrect={false}
              editable={pendingAction === null}
            />
            <ActionButton
              label={t("keybindingsMobile.add")}
              disabled={pendingAction !== null || editingId !== null || environmentId === null}
              emphasized
              onPress={beginNew}
            />
          </View>
          {rows.length === 0 && config !== null ? (
            <StatusMessage text={t("keybindingsMobile.empty")} />
          ) : null}
          {rows.map((row) => (
            <KeybindingCard
              key={row.id}
              row={row}
              disabled={pendingAction !== null || editingId !== null}
              onEdit={() => beginEdit(row)}
              onDelete={() => deleteRow(row)}
              onReset={() => resetRow(row)}
            />
          ))}
          <View className="border-t border-border-subtle p-4">
            <Text className="text-xs leading-5 text-foreground-muted">
              {t("keybindingsMobile.syntaxDescription")}
            </Text>
          </View>
        </SettingsSection>
      </ScrollView>
    </View>
  );
}

function KeybindingCard(props: {
  readonly row: MobileKeybindingRow;
  readonly disabled: boolean;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
  readonly onReset: () => void;
}) {
  return (
    <View className="gap-2 border-b border-border-subtle p-4 last:border-b-0">
      <Text className="text-sm font-codework-medium text-foreground">{props.row.command}</Text>
      <Text className="font-mono text-xs text-foreground-muted">{props.row.key}</Text>
      <Text className="font-mono text-xs text-foreground-muted">
        {`${t("keybindingsMobile.when")}: ${props.row.when || t("keybindingsMobile.always")}`}
      </Text>
      <View className="flex-row flex-wrap gap-2">
        <ActionButton label={t("edit")} disabled={props.disabled} onPress={props.onEdit} />
        {defaultKeybindingForRow(props.row) ? (
          <ActionButton
            label={t("keybindingsMobile.reset")}
            disabled={props.disabled}
            onPress={props.onReset}
          />
        ) : null}
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

function KeybindingEditor(props: {
  readonly draft: MobileKeybindingDraft;
  readonly disabled: boolean;
  readonly onChange: (patch: Partial<MobileKeybindingDraft>) => void;
  readonly onSave: () => void;
  readonly onCancel: () => void;
}) {
  return (
    <SettingsSection title={t("keybindingsMobile.edit")} card>
      <View className="gap-3 p-4">
        <Field label={t("keybindingsMobile.command")}>
          <TextInput
            value={props.draft.command}
            onChangeText={(command) => props.onChange({ command })}
            placeholder="terminal.toggle"
            autoCapitalize="none"
            autoCorrect={false}
            editable={!props.disabled}
          />
        </Field>
        <Field label={t("keybindingsMobile.key")}>
          <TextInput
            value={props.draft.key}
            onChangeText={(key) => props.onChange({ key })}
            placeholder={t("keybindingsMobile.keyPlaceholder")}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!props.disabled}
          />
        </Field>
        <Field label={t("keybindingsMobile.when")}>
          <TextInput
            value={props.draft.when}
            onChangeText={(when) => props.onChange({ when })}
            placeholder={t("keybindingsMobile.whenPlaceholder")}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!props.disabled}
          />
        </Field>
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
