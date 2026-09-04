import { useNavigation } from "@react-navigation/native";
import type { StaticScreenProps } from "@react-navigation/native";
import {
  CODEWORK_PROJECT_FILE_NAME,
  EnvironmentId,
  MAX_SCRIPT_ID_LENGTH,
  SCRIPT_RUN_COMMAND_PATTERN,
  ProjectId,
  type CodeworkProjectFileScript,
  type KeybindingCommand,
  type ModelSelection,
  type ProjectScript,
  type ProjectScriptIcon,
  type ProjectReadFileResult,
  type ResolvedKeybindingsConfig,
  type ThreadEnvMode,
} from "@codework/contracts";
import { parseCodeworkProjectFile } from "@codework/shared/codeworkProjectFile";
import { parseKeybindingShortcut, shortcutToKeybindingInput } from "@codework/shared/keybindings";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Alert, Platform, Pressable, ScrollView, Switch, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@codework/client-runtime/state/runtime";
import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { buildModelOptions } from "../../lib/modelOptions";
import { uuidv4 } from "../../lib/uuid";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { t } from "../../i18n";
import { useEnvironmentServerConfig, useProject } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "../settings/components/SettingsSection";

type ProjectSettingsRouteProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly projectId: string;
}>;

type ProjectPatch = {
  readonly title?: string;
  readonly defaultModelSelection?: ModelSelection | null;
  readonly defaultThreadEnvMode?: ThreadEnvMode | null;
  readonly faviconPath?: string | null;
  readonly scripts?: ReadonlyArray<ProjectScript>;
};

type ScriptDraft = {
  readonly editingId: string | null;
  readonly name: string;
  readonly command: string;
  readonly icon: ProjectScriptIcon;
  readonly previewUrl: string;
  readonly autoOpenPreview: boolean;
  readonly runOnWorktreeCreate: boolean;
  readonly keybinding: string;
};

const PROJECT_SCRIPT_ICON_OPTIONS: ReadonlyArray<{
  readonly id: ProjectScriptIcon;
  readonly labelKey: string;
}> = [
  { id: "play", labelKey: "projectScript.iconPlay" },
  { id: "test", labelKey: "projectScript.iconTest" },
  { id: "lint", labelKey: "projectScript.iconLint" },
  { id: "configure", labelKey: "projectScript.iconConfigure" },
  { id: "build", labelKey: "projectScript.iconBuild" },
  { id: "debug", labelKey: "projectScript.iconDebug" },
];

const WORKSPACE_MODE_OPTIONS: ReadonlyArray<{
  readonly id: string;
  readonly value: ThreadEnvMode | null;
  readonly labelKey: string;
  readonly descriptionKey: string;
}> = [
  {
    id: "inherit",
    value: null,
    labelKey: "projectSettingsMobile.inheritWorkspace",
    descriptionKey: "projectSettingsMobile.inheritWorkspaceDescription",
  },
  {
    id: "local",
    value: "local",
    labelKey: "projectSettingsMobile.localWorkspace",
    descriptionKey: "projectSettingsMobile.localWorkspaceDescription",
  },
  {
    id: "worktree",
    value: "worktree",
    labelKey: "projectSettingsMobile.worktreeWorkspace",
    descriptionKey: "projectSettingsMobile.worktreeWorkspaceDescription",
  },
];

function upsertProjectScript(
  scripts: ReadonlyArray<ProjectScript>,
  nextScript: ProjectScript,
): ReadonlyArray<ProjectScript> {
  const nextScripts = scripts.some((script) => script.id === nextScript.id)
    ? scripts.map((script) => (script.id === nextScript.id ? nextScript : script))
    : [...scripts, nextScript];
  return nextScript.runOnWorktreeCreate
    ? nextScripts.map((script) =>
        script.id === nextScript.id ? script : { ...script, runOnWorktreeCreate: false },
      )
    : nextScripts;
}

function projectScriptCommand(scriptId: string): KeybindingCommand | null {
  const command = `script.${scriptId}.run` as `script.${string}.run`;
  return scriptId.length <= MAX_SCRIPT_ID_LENGTH && /^[a-z0-9][a-z0-9-]*$/u.test(scriptId)
    ? SCRIPT_RUN_COMMAND_PATTERN.make(command)
    : null;
}

function keybindingForProjectScript(
  keybindings: ResolvedKeybindingsConfig,
  scriptId: string,
): string | null {
  const command = projectScriptCommand(scriptId);
  if (command === null) return null;
  for (let index = keybindings.length - 1; index >= 0; index -= 1) {
    const binding = keybindings[index];
    if (binding?.command === command) return shortcutToKeybindingInput(binding.shortcut);
  }
  return null;
}

export function ProjectSettingsRouteScreen(props: ProjectSettingsRouteProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const projectId = ProjectId.make(props.route.params.projectId);
  const project = useProject({ environmentId, projectId });
  const serverConfig = useEnvironmentServerConfig(environmentId);
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const deleteProject = useAtomCommand(projectEnvironment.delete, { reportFailure: false });
  const upsertKeybinding = useAtomCommand(serverEnvironment.upsertKeybinding, {
    reportFailure: false,
  });
  const removeKeybinding = useAtomCommand(serverEnvironment.removeKeybinding, {
    reportFailure: false,
  });
  const [titleDraft, setTitleDraft] = useState("");
  const [faviconDraft, setFaviconDraft] = useState("");
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [scriptDraft, setScriptDraft] = useState<ScriptDraft | null>(null);
  const projectFileQuery = useEnvironmentQuery(
    project?.workspaceRoot
      ? projectEnvironment.readFile({
          environmentId,
          input: { cwd: project.workspaceRoot, relativePath: CODEWORK_PROJECT_FILE_NAME },
        })
      : null,
  );

  useEffect(() => {
    setTitleDraft(project?.title ?? "");
    setFaviconDraft(project?.faviconPath ?? "");
    setError(null);
    setNotice(null);
    setScriptDraft(null);
  }, [project?.id, project?.title]);

  const modelOptions = useMemo(
    () => buildModelOptions(serverConfig, project?.defaultModelSelection ?? null),
    [project?.defaultModelSelection, serverConfig],
  );
  const currentModelKey = project?.defaultModelSelection
    ? `${project.defaultModelSelection.instanceId}:${project.defaultModelSelection.model}`
    : null;
  const currentWorkspaceMode = project?.defaultThreadEnvMode ?? null;
  const projectFileScripts = useMemo(() => {
    const data = projectFileQuery.data as ProjectReadFileResult | null;
    if (data === null || data.truncated) return [] as ReadonlyArray<CodeworkProjectFileScript>;
    return parseCodeworkProjectFile(data.contents)?.scripts ?? [];
  }, [projectFileQuery.data]);
  const importableScripts = useMemo(
    () =>
      projectFileScripts.filter(
        (fileScript) =>
          project?.scripts.every(
            (script) =>
              script.command !== fileScript.command &&
              script.name.toLowerCase() !== fileScript.name.toLowerCase(),
          ) ?? false,
      ),
    [project?.scripts, projectFileScripts],
  );

  const saveProject = async (action: string, patch: ProjectPatch): Promise<boolean> => {
    if (project === null) return false;
    setPendingAction(action);
    setError(null);
    setNotice(null);
    const result = await updateProject({
      environmentId,
      input: { projectId: project.id, ...patch },
    });
    setPendingAction(null);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setError(
          failure instanceof Error ? failure.message : t("projectSettingsMobile.saveFailed"),
        );
      }
      return false;
    }
    setNotice(t("projectSettingsMobile.saved"));
    return true;
  };

  const saveTitle = () => {
    const title = titleDraft.trim();
    if (title.length === 0) {
      setError(t("projectSettingsMobile.titleRequired"));
      return;
    }
    void saveProject("title", { title });
  };

  const saveFavicon = () => {
    const faviconPath = faviconDraft.trim();
    void saveProject("icon", { faviconPath: faviconPath.length > 0 ? faviconPath : null });
  };

  const saveScript = () => {
    if (project === null || scriptDraft === null) return;
    const name = scriptDraft.name.trim();
    const command = scriptDraft.command.trim();
    if (name.length === 0 || command.length === 0) {
      setError(t("projectSettingsMobile.scriptFieldsRequired"));
      return;
    }
    const keybinding = scriptDraft.keybinding.trim();
    if (keybinding.length > 0 && parseKeybindingShortcut(keybinding) === null) {
      setError(t("projectSettingsMobile.keybindingInvalid"));
      return;
    }
    const existing = project.scripts.find((script) => script.id === scriptDraft.editingId);
    const scriptId = existing?.id ?? `mobile-${uuidv4().replaceAll("-", "").slice(0, 17)}`;
    const previewUrl = scriptDraft.previewUrl.trim();
    const nextScript: ProjectScript = {
      id: scriptId,
      name,
      command,
      icon: scriptDraft.icon,
      runOnWorktreeCreate: scriptDraft.runOnWorktreeCreate,
      ...(previewUrl.length > 0
        ? { previewUrl, autoOpenPreview: scriptDraft.autoOpenPreview }
        : {}),
    };
    const scripts = upsertProjectScript(project.scripts, nextScript);
    void (async () => {
      if (!(await saveProject("script", { scripts }))) return;
      const keybindingCommand = projectScriptCommand(scriptId);
      if (keybindingCommand === null) {
        setScriptDraft(null);
        return;
      }
      const previousKeybinding = keybindingForProjectScript(
        serverConfig?.keybindings ?? [],
        scriptId,
      );
      if (keybinding.length > 0) {
        setPendingAction("script-keybinding");
        const result = await upsertKeybinding({
          environmentId,
          input: {
            key: keybinding,
            command: keybindingCommand,
            ...(previousKeybinding
              ? { replace: { key: previousKeybinding, command: keybindingCommand } }
              : {}),
          },
        });
        setPendingAction(null);
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            const failure = squashAtomCommandFailure(result);
            setError(
              failure instanceof Error
                ? failure.message
                : t("projectSettingsMobile.keybindingSaveFailed"),
            );
          }
          return;
        }
      } else if (previousKeybinding) {
        setPendingAction("script-keybinding");
        const result = await removeKeybinding({
          environmentId,
          input: { key: previousKeybinding, command: keybindingCommand },
        });
        setPendingAction(null);
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            const failure = squashAtomCommandFailure(result);
            setError(
              failure instanceof Error
                ? failure.message
                : t("projectSettingsMobile.keybindingSaveFailed"),
            );
          }
          return;
        }
      }
      setScriptDraft(null);
    })();
  };

  const removeScript = (script: ProjectScript) => {
    if (project === null || pendingAction !== null) return;
    Alert.alert(
      t("projectSettingsMobile.deleteScriptTitle", { name: script.name }),
      t("projectSettingsMobile.deleteScriptDescription"),
      [
        { text: t("cancel"), style: "cancel" },
        {
          text: t("delete"),
          style: "destructive",
          onPress: () => {
            void (async () => {
              if (
                !(await saveProject("script", {
                  scripts: project.scripts.filter((candidate) => candidate.id !== script.id),
                }))
              ) {
                return;
              }
              const command = projectScriptCommand(script.id);
              const previousKeybinding = keybindingForProjectScript(
                serverConfig?.keybindings ?? [],
                script.id,
              );
              if (command === null || previousKeybinding === null) return;
              setPendingAction("script-keybinding");
              const result = await removeKeybinding({
                environmentId,
                input: { key: previousKeybinding, command },
              });
              setPendingAction(null);
              if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
                const failure = squashAtomCommandFailure(result);
                setError(
                  failure instanceof Error
                    ? failure.message
                    : t("projectSettingsMobile.keybindingSaveFailed"),
                );
              }
            })();
          },
        },
      ],
    );
  };

  const importScript = (fileScript: CodeworkProjectFileScript) => {
    if (project === null || pendingAction !== null) return;
    const importedScript: ProjectScript = {
      id: `mobile-${uuidv4().replaceAll("-", "").slice(0, 17)}`,
      name: fileScript.name,
      command: fileScript.command,
      icon: fileScript.icon ?? "play",
      runOnWorktreeCreate: fileScript.runOnWorktreeCreate ?? false,
      ...(fileScript.previewUrl === undefined ? {} : { previewUrl: fileScript.previewUrl }),
      ...(fileScript.autoOpenPreview === undefined
        ? {}
        : { autoOpenPreview: fileScript.autoOpenPreview }),
    };
    void saveProject("script", {
      scripts: upsertProjectScript(project.scripts, importedScript),
    });
  };

  const removeProject = () => {
    if (project === null || pendingAction !== null) return;
    Alert.alert(
      t("projectSettingsMobile.removeTitle", { title: project.title }),
      t("projectSettingsMobile.removeDescription"),
      [
        { text: t("cancel"), style: "cancel" },
        {
          text: t("delete"),
          style: "destructive",
          onPress: () => {
            void (async () => {
              setPendingAction("remove");
              setError(null);
              const result = await deleteProject({
                environmentId,
                input: { projectId: project.id, force: true },
              });
              setPendingAction(null);
              if (result._tag === "Failure") {
                if (!isAtomCommandInterrupted(result)) {
                  const failure = squashAtomCommandFailure(result);
                  setError(
                    failure instanceof Error
                      ? failure.message
                      : t("projectSettingsMobile.removeFailed"),
                  );
                }
                return;
              }
              navigation.goBack();
            })();
          },
        },
      ],
    );
  };

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader
            title={t("projectSettingsMobile.title")}
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
        {project === null ? (
          <StatusMessage text={t("projectSettingsMobile.loading")} />
        ) : (
          <>
            <Text className="px-2 text-sm leading-5 text-foreground-muted">
              {t("projectSettingsMobile.description")}
            </Text>
            {error === null ? null : <StatusMessage text={error} tone="danger" />}
            {notice === null ? null : <StatusMessage text={notice} />}

            <SettingsSection title={t("projectSettingsMobile.details")} card>
              <View className="gap-3 p-4">
                <Field label={t("projectSettingsMobile.titleLabel")}>
                  <TextInput
                    value={titleDraft}
                    onChangeText={setTitleDraft}
                    editable={pendingAction === null}
                    placeholder={t("projectSettingsMobile.titlePlaceholder")}
                  />
                </Field>
                <ActionButton
                  label={pendingAction === "title" ? t("projectSettingsMobile.saving") : t("save")}
                  disabled={pendingAction !== null}
                  onPress={saveTitle}
                  emphasized
                />
                <InfoRow label={t("projectSettingsMobile.path")} value={project.workspaceRoot} />
                <InfoRow label={t("projectSettingsMobile.projectId")} value={String(project.id)} />
                <View className="flex-row items-center gap-3 border-t border-border-subtle pt-3">
                  <ProjectFavicon
                    environmentId={environmentId}
                    projectTitle={project.title}
                    workspaceRoot={project.workspaceRoot}
                    faviconPath={project.faviconPath}
                    size={36}
                  />
                  <Text className="min-w-0 flex-1 text-xs leading-5 text-foreground-muted">
                    {project.faviconPath ?? t("projectSettingsMobile.automaticIcon")}
                  </Text>
                </View>
                <Field label={t("projectSettingsMobile.iconPath")}>
                  <TextInput
                    value={faviconDraft}
                    onChangeText={setFaviconDraft}
                    editable={pendingAction === null}
                    autoCapitalize="none"
                    autoCorrect={false}
                    placeholder={t("projectSettingsMobile.iconPathPlaceholder")}
                  />
                </Field>
                <View className="flex-row gap-2">
                  <ActionButton
                    label={pendingAction === "icon" ? t("projectSettingsMobile.saving") : t("save")}
                    disabled={pendingAction !== null}
                    onPress={saveFavicon}
                  />
                  <ActionButton
                    label={t("projectSettingsMobile.clearIcon")}
                    disabled={pendingAction !== null || faviconDraft.trim().length === 0}
                    onPress={() => {
                      setFaviconDraft("");
                      void saveProject("icon", { faviconPath: null });
                    }}
                  />
                </View>
                <Text className="text-xs leading-5 text-foreground-muted">
                  {t("projectSettingsMobile.iconPathHint")}
                </Text>
              </View>
            </SettingsSection>

            <SettingsSection title={t("projectSettingsMobile.defaultModel")} card>
              <ChoiceList
                values={modelOptions.map((option) => ({
                  id: option.key,
                  label: option.label,
                  detail: option.subtitle,
                }))}
                selectedId={currentModelKey}
                disabled={pendingAction !== null}
                onSelect={(key) => {
                  const option = modelOptions.find((candidate) => candidate.key === key);
                  if (option)
                    void saveProject("model", { defaultModelSelection: option.selection });
                }}
              />
              <ActionButton
                label={t("projectSettingsMobile.clearDefaultModel")}
                disabled={pendingAction !== null || currentModelKey === null}
                onPress={() => void saveProject("model", { defaultModelSelection: null })}
              />
            </SettingsSection>

            <SettingsSection title={t("projectSettingsMobile.workspaceMode")} card>
              <ChoiceList
                values={WORKSPACE_MODE_OPTIONS.map((option) => ({
                  id: option.id,
                  label: t(option.labelKey),
                  detail: t(option.descriptionKey),
                }))}
                selectedId={
                  WORKSPACE_MODE_OPTIONS.find((option) => option.value === currentWorkspaceMode)
                    ?.id ?? "inherit"
                }
                disabled={pendingAction !== null}
                onSelect={(id) => {
                  const option = WORKSPACE_MODE_OPTIONS.find((candidate) => candidate.id === id);
                  if (option) void saveProject("workspace", { defaultThreadEnvMode: option.value });
                }}
              />
            </SettingsSection>

            <SettingsSection title={t("projectSettingsMobile.scripts")} card>
              {importableScripts.length > 0 ? (
                <View className="gap-3 border-b border-border-subtle p-4">
                  <Text className="text-sm font-codework-medium text-foreground">
                    {t("projectSettingsMobile.importScripts")}
                  </Text>
                  {importableScripts.map((script) => (
                    <ActionButton
                      key={`${script.name}:${script.command}`}
                      label={t("projectSettingsMobile.importScript", { name: script.name })}
                      disabled={pendingAction !== null}
                      onPress={() => importScript(script)}
                    />
                  ))}
                </View>
              ) : null}
              {scriptDraft === null ? (
                <View className="p-4">
                  <ActionButton
                    label={t("projectSettingsMobile.addScript")}
                    disabled={pendingAction !== null}
                    onPress={() =>
                      setScriptDraft({
                        editingId: null,
                        name: "",
                        command: "",
                        icon: "play",
                        previewUrl: "",
                        autoOpenPreview: false,
                        runOnWorktreeCreate: false,
                        keybinding: "",
                      })
                    }
                  />
                </View>
              ) : (
                <ScriptEditor
                  draft={scriptDraft}
                  disabled={pendingAction !== null}
                  onChange={(patch) =>
                    setScriptDraft((current) => (current ? { ...current, ...patch } : current))
                  }
                  onSave={saveScript}
                  onCancel={() => setScriptDraft(null)}
                />
              )}
              {project.scripts.length === 0 ? (
                <StatusMessage text={t("projectSettingsMobile.noScripts")} />
              ) : (
                project.scripts.map((script) => (
                  <View
                    key={script.id}
                    className="gap-2 border-b border-border-subtle p-4 last:border-b-0"
                  >
                    <View className="flex-row items-start gap-3">
                      <View className="min-w-0 flex-1 gap-1">
                        <Text className="text-base font-codework-medium text-foreground">
                          {script.name}
                        </Text>
                        <Text className="font-mono text-xs text-foreground-muted" numberOfLines={2}>
                          {script.command}
                        </Text>
                      </View>
                      <View className="flex-row gap-2">
                        <ActionButton
                          label={t("projectSettingsMobile.editScript")}
                          disabled={pendingAction !== null}
                          onPress={() =>
                            setScriptDraft({
                              editingId: script.id,
                              name: script.name,
                              command: script.command,
                              icon: script.icon,
                              previewUrl: script.previewUrl ?? "",
                              autoOpenPreview: script.autoOpenPreview ?? false,
                              runOnWorktreeCreate: script.runOnWorktreeCreate,
                              keybinding:
                                keybindingForProjectScript(
                                  serverConfig?.keybindings ?? [],
                                  script.id,
                                ) ?? "",
                            })
                          }
                        />
                        <ActionButton
                          label={t("projectSettingsMobile.deleteScript")}
                          disabled={pendingAction !== null}
                          onPress={() => removeScript(script)}
                          destructive
                        />
                      </View>
                    </View>
                  </View>
                ))
              )}
              <Text className="px-4 pb-4 text-xs leading-5 text-foreground-muted">
                {t("projectSettingsMobile.scriptsHint")}
              </Text>
            </SettingsSection>

            <SettingsSection title={t("projectSettingsMobile.danger")} card>
              <View className="gap-2 p-4">
                <ActionButton
                  label={
                    pendingAction === "remove"
                      ? t("projectSettingsMobile.removing")
                      : t("projectSettingsMobile.remove")
                  }
                  disabled={pendingAction !== null}
                  onPress={removeProject}
                  destructive
                />
                <Text className="text-xs leading-5 text-foreground-muted">
                  {t("projectSettingsMobile.removeHint")}
                </Text>
              </View>
            </SettingsSection>
          </>
        )}
      </ScrollView>
    </View>
  );
}

function ScriptEditor(props: {
  readonly draft: ScriptDraft;
  readonly disabled: boolean;
  readonly onChange: (patch: Partial<Omit<ScriptDraft, "editingId">>) => void;
  readonly onSave: () => void;
  readonly onCancel: () => void;
}) {
  return (
    <View className="gap-3 border-b border-border-subtle p-4">
      <Field label={t("projectSettingsMobile.scriptName")}>
        <TextInput
          value={props.draft.name}
          onChangeText={(name) => props.onChange({ name })}
          editable={!props.disabled}
          placeholder={t("projectSettingsMobile.scriptNamePlaceholder")}
        />
      </Field>
      <Field label={t("projectSettingsMobile.scriptCommand")}>
        <TextInput
          value={props.draft.command}
          onChangeText={(command) => props.onChange({ command })}
          editable={!props.disabled}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={t("projectSettingsMobile.scriptCommandPlaceholder")}
        />
      </Field>
      <Field label={t("projectSettingsMobile.scriptIcon")}>
        <ChoiceList
          values={PROJECT_SCRIPT_ICON_OPTIONS.map((option) => ({
            id: option.id,
            label: t(option.labelKey),
          }))}
          selectedId={props.draft.icon}
          disabled={props.disabled}
          onSelect={(id) => {
            const option = PROJECT_SCRIPT_ICON_OPTIONS.find((candidate) => candidate.id === id);
            if (option) props.onChange({ icon: option.id });
          }}
        />
      </Field>
      <Field label={t("projectSettingsMobile.keybinding")}>
        <TextInput
          value={props.draft.keybinding}
          onChangeText={(keybinding) => props.onChange({ keybinding })}
          editable={!props.disabled}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={t("projectSettingsMobile.keybindingPlaceholder")}
        />
      </Field>
      <Field label={t("projectSettingsMobile.previewUrl")}>
        <TextInput
          value={props.draft.previewUrl}
          onChangeText={(previewUrl) => props.onChange({ previewUrl })}
          editable={!props.disabled}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          placeholder={t("projectSettingsMobile.previewUrlPlaceholder")}
        />
        <Text className="text-xs leading-5 text-foreground-muted">
          {t("projectSettingsMobile.previewUrlHint")}
        </Text>
      </Field>
      <View className="flex-row items-center justify-between gap-3">
        <Text className="min-w-0 flex-1 text-sm text-foreground-muted">
          {t("projectSettingsMobile.autoOpenPreview")}
        </Text>
        <Switch
          value={props.draft.autoOpenPreview}
          disabled={props.disabled || props.draft.previewUrl.trim().length === 0}
          onValueChange={(autoOpenPreview) => props.onChange({ autoOpenPreview })}
        />
      </View>
      <View className="flex-row items-center justify-between gap-3">
        <Text className="min-w-0 flex-1 text-sm text-foreground-muted">
          {t("projectSettingsMobile.runOnWorktreeCreate")}
        </Text>
        <Switch
          value={props.draft.runOnWorktreeCreate}
          disabled={props.disabled}
          onValueChange={(runOnWorktreeCreate) => props.onChange({ runOnWorktreeCreate })}
        />
      </View>
      <View className="flex-row gap-2">
        <ActionButton
          label={props.disabled ? t("projectSettingsMobile.saving") : t("save")}
          disabled={props.disabled}
          onPress={props.onSave}
          emphasized
        />
        <ActionButton label={t("cancel")} disabled={props.disabled} onPress={props.onCancel} />
      </View>
    </View>
  );
}

function ChoiceList(props: {
  readonly values: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly detail?: string;
  }>;
  readonly selectedId: string | null;
  readonly disabled: boolean;
  readonly onSelect: (id: string) => void;
}) {
  return (
    <View className="gap-2 p-3">
      {props.values.length === 0 ? (
        <StatusMessage text={t("projectSettingsMobile.noModels")} />
      ) : (
        props.values.map((value) => {
          const selected = props.selectedId === value.id;
          return (
            <Pressable
              key={value.id}
              accessibilityRole="radio"
              accessibilityState={{ checked: selected, disabled: props.disabled }}
              disabled={props.disabled}
              onPress={() => props.onSelect(value.id)}
              className={
                selected
                  ? "rounded-[16px] bg-subtle-strong px-3 py-3"
                  : "rounded-[16px] bg-subtle px-3 py-3"
              }
            >
              <Text className="text-sm font-codework-medium text-foreground" numberOfLines={1}>
                {value.label}
              </Text>
              {value.detail ? (
                <Text className="mt-1 text-xs leading-5 text-foreground-muted" numberOfLines={2}>
                  {value.detail}
                </Text>
              ) : null}
            </Pressable>
          );
        })
      )}
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

function InfoRow(props: { readonly label: string; readonly value: string }) {
  return (
    <View className="gap-1 border-t border-border-subtle pt-3">
      <Text className="text-xs text-foreground-muted">{props.label}</Text>
      <Text className="font-mono text-xs text-foreground" selectable>
        {props.value}
      </Text>
    </View>
  );
}

function ActionButton(props: {
  readonly label: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
  readonly emphasized?: boolean;
  readonly destructive?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      className={
        props.destructive
          ? "self-start rounded-full bg-danger px-4 py-2.5 opacity-100 disabled:opacity-40"
          : props.emphasized
            ? "self-start rounded-full bg-accent px-4 py-2.5 opacity-100 disabled:opacity-40"
            : "self-start rounded-full bg-subtle-strong px-4 py-2.5 opacity-100 disabled:opacity-40"
      }
    >
      <Text
        className={
          props.destructive || props.emphasized
            ? "text-sm font-codework-medium text-accent-foreground"
            : "text-sm font-codework-medium text-foreground"
        }
      >
        {props.label}
      </Text>
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
