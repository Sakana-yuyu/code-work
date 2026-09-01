import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  mapAtomCommandResult,
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@codework/client-runtime/state/runtime";
import { scopeProjectRef } from "@codework/client-runtime/environment";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  deriveProjectGroupingOverrideKey,
  selectProjectGroupingSettings,
} from "../../logicalProject";
import type {
  ContextMenuItem,
  ModelSelection,
  ProviderDriverKind,
  SidebarProjectGroupingMode,
  CodeworkProjectFileScript,
  ThreadEnvMode,
} from "@codework/contracts";
import { resolveEnvModeLabel } from "../BranchToolbar.logic";
import { createModelSelection } from "@codework/shared/model";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@codework/shared/keybindings";
import { useCanGoBack, useNavigate } from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import { ChevronDownIcon, CopyIcon, PlusIcon, SettingsIcon, Trash2Icon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { isElectron } from "../../env";
import {
  useClientSettings,
  useUpdateClientSettings,
  usePrimarySettings,
} from "../../hooks/useSettings";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useCodeworkProjectFileState } from "../../hooks/useCodeworkProjectFileScripts";
import { shortcutLabelForCommand } from "../../keybindings";
import { keybindingValueForCommand } from "../../lib/projectScriptKeybindings";
import { releaseProjectDraftUploads } from "../../lib/composerDraftUploads";
import { readLocalApi } from "../../localApi";
import {
  buildProjectScript,
  commandForProjectScript,
  nextProjectScriptId,
} from "../../projectScripts";
import { decodeProjectScriptKeybindingRule } from "../../lib/projectScriptKeybindings";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  buildSidebarProjectSnapshots,
  type SidebarProjectGroupMember,
  type SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useProjects, useThreadShells } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { primaryServerProvidersAtom, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  EMPTY_PROJECT_SCRIPT_INPUT,
  editorRequestForScript,
  ProjectScriptEditorDialog,
  ScriptIcon,
  type NewProjectScriptInput,
  type ProjectScriptEditorRequest,
} from "../projectScriptEditor";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import {
  canPickExternalProjectFavicon,
  ProjectFaviconPickerDialog,
} from "./ProjectFaviconPickerDialog";
import { t } from "~/i18n";
import { projectGroupTitleNeedsUpdate } from "./ProjectSettingsPanel.logic";

export const PROJECT_GROUPING_MODE_LABELS: Record<SidebarProjectGroupingMode, string> = {
  get repository() {
    return t("settings.groupByRepository");
  },
  get repository_path() {
    return t("settings.groupByRepositoryPath");
  },
  get separate() {
    return t("settings.keepSeparate");
  },
};

/** Logical project groups for the settings page, sorted by display name. */
export function useSettingsProjectGroups(): SidebarProjectSnapshot[] {
  const projects = useProjects();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const environmentLabelById = useMemo(
    () =>
      new Map(
        environments.map((environment) => [environment.environmentId, environment.label] as const),
      ),
    [environments],
  );
  return useMemo(
    () =>
      buildSidebarProjectSnapshots({
        projects,
        settings: projectGroupingSettings,
        primaryEnvironmentId,
        resolveEnvironmentLabel: (environmentId) => environmentLabelById.get(environmentId) ?? null,
      }).sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [environmentLabelById, primaryEnvironmentId, projectGroupingSettings, projects],
  );
}

function memberKey(member: { environmentId: string; id: string }): string {
  return `${member.environmentId}:${member.id}`;
}

export function ProjectSettingsPage({ projectKey }: { projectKey: string }) {
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const navigateBackWithinApp = useCallback(() => {
    if (canGoBack) {
      window.history.back();
      return;
    }
    void navigate({ to: "/" });
  }, [canGoBack, navigate]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key !== "Escape") return;
      event.preventDefault();
      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLElement) {
        activeElement.blur();
      }
      navigateBackWithinApp();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigateBackWithinApp]);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <ProjectSettingsBreadcrumb projectKey={projectKey} />
        </WorkspacePageHeader>
        <ProjectSettingsPanel projectKey={projectKey} />
      </div>
    </SidebarInset>
  );
}

function ProjectSettingsBreadcrumb({ projectKey }: { projectKey: string }) {
  const groups = useSettingsProjectGroups();
  const navigate = useNavigate();
  const selected = groups.find((group) => group.projectKey === projectKey) ?? null;
  const openProjectMenu = (event: ReactMouseEvent<HTMLButtonElement>) => {
    const api = readLocalApi();
    if (!api) return;

    const rect = event.currentTarget.getBoundingClientRect();
    const items: ContextMenuItem<string>[] = groups.map((group) => ({
      id: group.projectKey,
      label: group.displayName,
    }));
    void settlePromise(() =>
      api.contextMenu.show(items, { x: rect.left, y: rect.bottom + 4 }),
    ).then((clicked) => {
      if (clicked._tag === "Failure" || clicked.value === null) return;
      void navigate({
        to: "/projects/$projectKey",
        params: { projectKey: clicked.value },
        replace: true,
        hashScrollIntoView: false,
      });
    });
  };

  return (
    <WorkspaceBreadcrumb ariaLabel={t("projectSettings.breadcrumb")}>
      <WorkspaceBreadcrumbItem>{t("projects")}</WorkspaceBreadcrumbItem>
      <WorkspaceBreadcrumbSeparator />
      <WorkspaceBreadcrumbItem current>
        {selected ? (
          <button
            type="button"
            aria-haspopup="menu"
            aria-label={t("switchProject")}
            onClick={openProjectMenu}
            className="group/project-title inline-flex min-w-0 max-w-64 cursor-pointer items-center gap-1 rounded-sm text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="min-w-0 truncate">{selected.displayName}</span>
            <ChevronDownIcon
              aria-hidden
              className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/project-title:opacity-100 group-focus-visible/project-title:opacity-100"
            />
          </button>
        ) : (
          <span className="truncate text-muted-foreground">{t("unavailableProject")}</span>
        )}
      </WorkspaceBreadcrumbItem>
    </WorkspaceBreadcrumb>
  );
}

export function ProjectSettingsPanel({ projectKey }: { projectKey: string }) {
  const groups = useSettingsProjectGroups();
  const navigate = useNavigate();

  const selected = groups.find((group) => group.projectKey === projectKey) ?? null;

  // Remember the members of the last rendered group so a grouping-rule change
  // (which changes the group key) can follow the project to its new group.
  const lastSelectionRef = useRef<{ key: string; memberKeys: string[] } | null>(null);
  useEffect(() => {
    if (!selected) return;
    lastSelectionRef.current = {
      key: selected.projectKey,
      memberKeys: selected.memberProjects.map((member) => member.physicalProjectKey),
    };
  }, [selected]);

  // A grouping-rule change replaces the group key mid-visit; follow the
  // project to its new key instead of parking on the not-found state.
  useEffect(() => {
    if (selected !== null) return;
    const last = lastSelectionRef.current;
    if (last?.key !== projectKey) return;
    const successor = groups.find((group) =>
      group.memberProjects.some((member) => last.memberKeys.includes(member.physicalProjectKey)),
    );
    if (successor) {
      void navigate({
        to: "/projects/$projectKey",
        params: { projectKey: successor.projectKey },
        replace: true,
        hashScrollIntoView: false,
      });
    }
  }, [groups, navigate, projectKey, selected]);

  if (!selected) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
        {groups.length === 0
          ? t("addAProjectFromTheSidebarToConfigureItHere")
          : t("thisProjectIsNoLongerAvailable")}
      </div>
    );
  }
  return <ProjectDetail key={selected.projectKey} group={selected} />;
}

function ProjectDetail({ group }: { group: SidebarProjectSnapshot }) {
  const navigate = useNavigate();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const settings = usePrimarySettings();
  const updateClientSettings = useUpdateClientSettings();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const threads = useThreadShells();
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const deleteProject = useAtomCommand(projectEnvironment.delete, { reportFailure: false });
  const upsertKeybinding = useAtomCommand(serverEnvironment.upsertKeybinding, {
    reportFailure: false,
  });
  const removeKeybinding = useAtomCommand(serverEnvironment.removeKeybinding, {
    reportFailure: false,
  });
  const projectNameEditedRef = useRef(false);
  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{ path: string }>({
    onCopy: ({ path }) => {
      toastManager.add({ type: "success", title: t("pathCopied"), description: path });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: t("failedToCopyPath"),
          description: error instanceof Error ? error.message : t("commandPalette.anErrorOccurred"),
        }),
      );
    },
  });

  const representative =
    group.memberProjects.find(
      (member) => member.environmentId === group.environmentId && member.id === group.id,
    ) ?? group.memberProjects[0]!;
  const faviconPath = representative.faviconPath ?? null;
  const pickProjectFavicon =
    typeof window !== "undefined" &&
    group.memberProjects.every(
      (member) =>
        member.environmentId === primaryEnvironmentId &&
        canPickExternalProjectFavicon(member.workspaceRoot, navigator.platform),
    )
      ? window.desktopBridge?.pickProjectFavicon
      : undefined;

  const threadCountByMember = useMemo(() => {
    const counts = new Map<string, number>();
    for (const thread of threads) {
      const key = `${thread.environmentId}:${thread.projectId}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [threads]);
  const reportFailure = useCallback((title: string, result: AtomCommandResult<void, unknown>) => {
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : t("commandPalette.anErrorOccurred"),
      }),
    );
  }, []);

  // Group-shared fields live on each physical project record, so a
  // group-level edit fans out to every member.
  const updateAllMembers = useCallback(
    async (
      input: Partial<{
        title: string;
        defaultModelSelection: ModelSelection | null;
        defaultThreadEnvMode: ThreadEnvMode | null;
        faviconPath: string | null;
      }>,
      failureTitle: string,
    ): Promise<AtomCommandResult<void, unknown>> => {
      for (const member of group.memberProjects) {
        const result = mapAtomCommandResult(
          await updateProject({
            environmentId: member.environmentId,
            input: { projectId: member.id, ...input },
          }),
          () => undefined,
        );
        if (result._tag === "Failure") {
          // A partial fan-out is possible: earlier members already took the
          // write. Name the environment so the user knows where it stopped.
          reportFailure(
            group.memberProjects.length > 1
              ? t("projectSettings.failureOnEnvironment", {
                  message: failureTitle,
                  environment:
                    member.environmentLabel ?? t("projectSettings.theCurrentEnvironment"),
                })
              : failureTitle,
            result,
          );
          return result;
        }
      }
      return AsyncResult.success(undefined);
    },
    [group.memberProjects, reportFailure, updateProject],
  );

  const renameGroup = useCallback(
    async (nextTitle: string, wasEdited: boolean) => {
      const title = nextTitle.trim();
      if (!title) {
        toastManager.add({ type: "warning", title: t("projectTitleCannotBeEmpty") });
        return;
      }
      if (
        !projectGroupTitleNeedsUpdate(
          group.memberProjects.map((member) => member.title),
          title,
          wasEdited,
        )
      ) {
        return;
      }
      await updateAllMembers({ title }, t("failedToRenameProject"));
    },
    [group.memberProjects, updateAllMembers],
  );

  // ----- default model -----
  const storedSelection = representative.defaultModelSelection;
  const resolvedSelection = resolveDefaultProviderModelSelection(serverProviders, storedSelection);
  const instanceEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(serverProviders), settings),
      ),
    [serverProviders, settings],
  );
  const modelOptionsByInstance = useMemo(
    () => getCustomModelOptionsByInstance(settings, serverProviders),
    [serverProviders, settings],
  );
  const activeEntry = instanceEntries.find(
    (entry) => entry.instanceId === resolvedSelection?.instanceId,
  );
  const setDefaultModel = useCallback(
    (selection: ModelSelection | null) =>
      void updateAllMembers(
        { defaultModelSelection: selection },
        t("projectSettings.failedUpdateDefaultModel"),
      ),
    [updateAllMembers],
  );

  // ----- new-thread workspace mode -----
  const storedEnvMode = representative.defaultThreadEnvMode ?? null;
  const setDefaultThreadEnvMode = useCallback(
    (mode: ThreadEnvMode | null) =>
      void updateAllMembers(
        { defaultThreadEnvMode: mode },
        t("projectSettings.failedUpdateNewThreadWorkspace"),
      ),
    [updateAllMembers],
  );

  // ----- favicon -----
  const [faviconPickerOpen, setFaviconPickerOpen] = useState(false);
  const [isSavingFavicon, setIsSavingFavicon] = useState(false);
  const savingFaviconRef = useRef(false);
  const setFaviconPath = useCallback(
    async (faviconPath: string | null) => {
      if (savingFaviconRef.current) return;
      savingFaviconRef.current = true;
      setIsSavingFavicon(true);
      try {
        await updateAllMembers({ faviconPath }, t("projectSettings.failedUpdateProjectIcon"));
      } finally {
        savingFaviconRef.current = false;
        setIsSavingFavicon(false);
      }
    },
    [updateAllMembers],
  );

  // ----- checkout selection and scripts -----
  const [selectedCheckoutKey, setSelectedCheckoutKey] = useState(representative.physicalProjectKey);
  const selectedCheckout =
    group.memberProjects.find((member) => member.physicalProjectKey === selectedCheckoutKey) ??
    representative;
  const selectedServerConfig = useAtomValue(
    serverEnvironment.configValueAtom(selectedCheckout.environmentId),
  );
  const keybindings = selectedServerConfig?.keybindings ?? DEFAULT_RESOLVED_KEYBINDINGS;
  const scripts = selectedCheckout.scripts;
  const [editorRequest, setEditorRequest] = useState<ProjectScriptEditorRequest | null>(null);
  // Script writes replace the whole array, so two overlapping writes computed
  // from the same snapshot would drop each other's changes. One at a time.
  const [isSavingScripts, setIsSavingScripts] = useState(false);
  const savingScriptsRef = useRef(false);
  const codeworkFile = useCodeworkProjectFileState(
    selectedCheckout.environmentId,
    selectedCheckout.workspaceRoot,
  );
  // What the "Default" option resolves to while no override is set: the
  // repo's t3.json value when present, otherwise the global setting.
  const inheritedEnvMode = codeworkFile.file?.defaultThreadEnvMode ?? settings.defaultThreadEnvMode;
  const inheritedEnvModeSource =
    codeworkFile.file?.defaultThreadEnvMode != null ? "t3.json" : "global";
  const importableScripts = useMemo(
    () =>
      codeworkFile.scripts.filter(
        (fileScript) =>
          !scripts.some(
            (script) =>
              script.command === fileScript.command ||
              script.name.toLowerCase() === fileScript.name.toLowerCase(),
          ),
      ),
    [scripts, codeworkFile.scripts],
  );

  const persistScripts = useCallback(
    async (
      nextScripts: ReadonlyArray<ReturnType<typeof buildProjectScript>>,
      keybinding: string | null | undefined,
      keybindingCommand: ReturnType<typeof commandForProjectScript>,
    ): Promise<AtomCommandResult<void, unknown>> => {
      if (savingScriptsRef.current) {
        return AsyncResult.failure(
          Cause.fail(new Error(t("projectSettings.scriptSaveInProgress"))),
        );
      }
      savingScriptsRef.current = true;
      setIsSavingScripts(true);
      try {
        // Captured before the write so a cleared or deleted binding can be
        // removed from the keybindings config afterwards.
        const previousKeybinding = keybindingValueForCommand(keybindings, keybindingCommand);
        const updateResult = mapAtomCommandResult(
          await updateProject({
            environmentId: selectedCheckout.environmentId,
            input: { projectId: selectedCheckout.id, scripts: nextScripts },
          }),
          () => undefined,
        );
        if (updateResult._tag === "Failure") {
          reportFailure(t("projectSettings.failedSaveScripts"), updateResult);
          return updateResult;
        }

        const keybindingRule = decodeProjectScriptKeybindingRule({
          keybinding,
          command: keybindingCommand,
        });
        if (!isElectron) return updateResult;
        const environmentIds = [selectedCheckout.environmentId];
        const previousTarget = previousKeybinding
          ? decodeProjectScriptKeybindingRule({
              keybinding: previousKeybinding,
              command: keybindingCommand,
            })
          : null;
        if (keybindingRule) {
          // `replace` swaps the command's previous rule instead of appending a
          // second one that would keep the old shortcut alive.
          const input =
            previousTarget && previousTarget.key !== keybindingRule.key
              ? { ...keybindingRule, replace: previousTarget }
              : keybindingRule;
          for (const environmentId of environmentIds) {
            const result = mapAtomCommandResult(
              await upsertKeybinding({ environmentId, input }),
              () => undefined,
            );
            if (result._tag === "Failure") {
              reportFailure(t("projectSettings.failedSaveKeybinding"), result);
              return result;
            }
          }
        } else if (previousTarget) {
          for (const environmentId of environmentIds) {
            const result = mapAtomCommandResult(
              await removeKeybinding({ environmentId, input: previousTarget }),
              () => undefined,
            );
            if (result._tag === "Failure") {
              reportFailure(t("projectSettings.failedRemoveKeybinding"), result);
              return result;
            }
          }
        }
        return updateResult;
      } finally {
        savingScriptsRef.current = false;
        setIsSavingScripts(false);
      }
    },
    [
      keybindings,
      removeKeybinding,
      reportFailure,
      selectedCheckout.environmentId,
      selectedCheckout.id,
      updateProject,
      upsertKeybinding,
    ],
  );

  const submitScript = useCallback(
    async (
      scriptId: string | null,
      input: NewProjectScriptInput,
    ): Promise<AtomCommandResult<void, unknown>> => {
      if (scriptId === null) {
        const nextId = nextProjectScriptId(
          input.name,
          scripts.map((script) => script.id),
        );
        const nextScript = buildProjectScript(nextId, input);
        const nextScripts = input.runOnWorktreeCreate
          ? [
              ...scripts.map((script) =>
                script.runOnWorktreeCreate ? { ...script, runOnWorktreeCreate: false } : script,
              ),
              nextScript,
            ]
          : [...scripts, nextScript];
        return persistScripts(nextScripts, input.keybinding, commandForProjectScript(nextId));
      }

      const updatedScript = buildProjectScript(scriptId, input);
      const nextScripts = scripts.map((script) =>
        script.id === scriptId
          ? updatedScript
          : input.runOnWorktreeCreate
            ? { ...script, runOnWorktreeCreate: false }
            : script,
      );
      return persistScripts(nextScripts, input.keybinding, commandForProjectScript(scriptId));
    },
    [persistScripts, scripts],
  );

  const deleteScript = useCallback(
    (scriptId: string) => {
      const nextScripts = scripts.filter((script) => script.id !== scriptId);
      void persistScripts(nextScripts, null, commandForProjectScript(scriptId));
    },
    [persistScripts, scripts],
  );

  const importFileScript = useCallback(
    async (fileScript: CodeworkProjectFileScript) => {
      const payload: NewProjectScriptInput = {
        name: fileScript.name,
        command: fileScript.command,
        icon: fileScript.icon ?? "play",
        runOnWorktreeCreate: fileScript.runOnWorktreeCreate ?? false,
        keybinding: null,
        previewUrl: fileScript.previewUrl ?? null,
        autoOpenPreview: fileScript.previewUrl ? (fileScript.autoOpenPreview ?? false) : false,
      };
      const result = await submitScript(null, payload);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setEditorRequest({
          scriptId: null,
          initial: payload,
          error: error instanceof Error ? error.message : t("failedToImportAction"),
        });
      }
    },
    [submitScript],
  );

  // ----- checkouts -----
  const updateGroupingPreference = useCallback(
    (member: SidebarProjectGroupMember, selection: SidebarProjectGroupingMode | "inherit") => {
      const overrideKey = deriveProjectGroupingOverrideKey(member);
      const nextOverrides = { ...projectGroupingSettings.sidebarProjectGroupingOverrides };
      if (selection === "inherit") {
        delete nextOverrides[overrideKey];
      } else {
        nextOverrides[overrideKey] = selection;
      }
      updateClientSettings({ sidebarProjectGroupingOverrides: nextOverrides });
    },
    [projectGroupingSettings.sidebarProjectGroupingOverrides, updateClientSettings],
  );

  const removeMembers = useCallback(
    async (members: ReadonlyArray<SidebarProjectGroupMember>) => {
      const api = readLocalApi();
      if (!api) return;

      const memberKeys = new Set(members.map(memberKey));
      const projectThreads = threads.filter((thread) =>
        memberKeys.has(`${thread.environmentId}:${thread.projectId}`),
      );
      const isWholeGroup = members.length === group.memberProjects.length;
      const singleMember = members.length === 1 ? members[0]! : null;
      const targetLabel = singleMember?.title ?? group.displayName;
      const confirmed = await settlePromise(() =>
        api.dialogs.confirm(
          [
            projectThreads.length > 0
              ? t("removeProjectWithThreadsConfirm", {
                  count: projectThreads.length,
                  countValue: projectThreads.length,
                  projectTitle: targetLabel,
                })
              : t("removeProjectConfirm", { projectTitle: targetLabel }),
            ...(singleMember
              ? [
                  t("removeProjectPathLine", { path: singleMember.workspaceRoot }),
                  ...(singleMember.environmentLabel
                    ? [
                        t("removeProjectEnvironmentLine", {
                          environment: singleMember.environmentLabel,
                        }),
                      ]
                    : []),
                ]
              : [
                  t("removeProjectGroupedEntriesLine", {
                    count: members.length,
                    countValue: members.length,
                  }),
                ]),
            ...(projectThreads.length > 0 ? [t("removeProjectClearsThreadsLine")] : []),
            isWholeGroup
              ? t("removeProjectEntriesOnlyLine")
              : t("removeProjectOtherEntriesUnaffectedLine"),
            t("actionCannotBeUndone"),
          ].join("\n"),
          { variant: "destructive" },
        ),
      );
      if (confirmed._tag === "Failure" || !confirmed.value) return;

      const draftStore = useComposerDraftStore.getState();
      for (const member of members) {
        const memberThreads = projectThreads.filter(
          (thread) =>
            thread.environmentId === member.environmentId && thread.projectId === member.id,
        );
        const result = mapAtomCommandResult(
          await deleteProject({
            environmentId: member.environmentId,
            input: {
              projectId: member.id,
              ...(memberThreads.length > 0 ? { force: true } : {}),
            },
          }),
          () => undefined,
        );
        if (result._tag === "Failure") {
          reportFailure(t("failedToRemove", { title: member.title }), result);
          return;
        }
        const projectRef = scopeProjectRef(member.environmentId, member.id);
        releaseProjectDraftUploads(projectRef);
        const projectDraftThread = draftStore.getDraftThreadByProjectRef(projectRef);
        if (projectDraftThread) {
          draftStore.clearDraftThread(projectDraftThread.draftId);
        }
        draftStore.clearProjectDraftThreadId(projectRef);
      }

      // The project's settings page just deleted itself; there is no projects
      // listing to fall back to, so leave settings entirely.
      if (isWholeGroup) {
        void navigate({ to: "/", replace: true });
      }
    },
    [
      deleteProject,
      group.displayName,
      group.memberProjects.length,
      navigate,
      reportFailure,
      threads,
    ],
  );

  const selectedCheckoutThreadCount = threadCountByMember.get(memberKey(selectedCheckout)) ?? 0;
  const selectedCheckoutGrouping =
    projectGroupingSettings.sidebarProjectGroupingOverrides?.[
      deriveProjectGroupingOverrideKey(selectedCheckout)
    ] ?? "inherit";
  const selectedCheckoutLabel = selectedCheckout.environmentLabel ?? t("thisMachine");

  return (
    <>
      <SettingsPageContainer>
        <SettingsSection title={t("pullRequests.project")}>
          <SettingsRow
            title={t("name")}
            description={t("theSharedNameForThisProjectGroupInTheSidebarAndThreadLists")}
            control={
              <Input
                key={`${group.projectKey}:${group.displayName}`}
                className="w-full sm:w-64"
                aria-label={t("projectName")}
                defaultValue={group.displayName}
                onChange={() => {
                  projectNameEditedRef.current = true;
                }}
                onBlur={(event) => {
                  const wasEdited = projectNameEditedRef.current;
                  projectNameEditedRef.current = false;
                  void renameGroup(event.currentTarget.value, wasEdited);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
            }
          />
          <SettingsRow
            title={t("projectIcon")}
            description={faviconPath ?? t("automatic")}
            resetAction={
              faviconPath !== null ? (
                <SettingResetButton
                  label={t("projectIcon2")}
                  disabled={isSavingFavicon}
                  onClick={() => void setFaviconPath(null)}
                />
              ) : null
            }
            control={
              <div className="flex items-center gap-2">
                <ProjectFavicon
                  environmentId={representative.environmentId}
                  cwd={representative.workspaceRoot}
                  faviconPath={faviconPath}
                  className="size-6"
                />
                <Button
                  size="xs"
                  variant="outline"
                  type="button"
                  aria-label={t("chooseAProjectIconFile")}
                  disabled={isSavingFavicon}
                  onClick={() => setFaviconPickerOpen(true)}
                >
                  {t("chooseFile")}
                </Button>
              </div>
            }
          />
        </SettingsSection>

        <SettingsSection title={t("settings.newThreads")}>
          <SettingsRow
            title={t("model")}
            description={t(
              "newThreadsInThisProjectStartWithThisModelAppliesToEveryCheckoutInThisGro",
            )}
            resetAction={
              storedSelection !== null ? (
                <SettingResetButton
                  label={t("projectDefaultModel")}
                  onClick={() => setDefaultModel(null)}
                />
              ) : null
            }
            control={
              resolvedSelection && activeEntry ? (
                <div className="flex flex-wrap items-center justify-end gap-1.5">
                  <ProviderModelPicker
                    activeInstanceId={resolvedSelection.instanceId}
                    model={resolvedSelection.model}
                    lockedProvider={null}
                    instanceEntries={instanceEntries}
                    modelOptionsByInstance={modelOptionsByInstance}
                    triggerVariant="outline"
                    triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                    onInstanceModelChange={(instanceId, model) => {
                      setDefaultModel(createModelSelection(instanceId, model));
                    }}
                  />
                  <TraitsPicker
                    provider={activeEntry.driverKind as ProviderDriverKind}
                    models={activeEntry.models}
                    model={resolvedSelection.model}
                    prompt=""
                    onPromptChange={() => {}}
                    modelOptions={resolvedSelection.options ?? []}
                    allowPromptInjectedEffort={false}
                    planModeEnabled={true}
                    triggerVariant="outline"
                    triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                    onModelOptionsChange={(nextOptions) => {
                      setDefaultModel(
                        createModelSelection(
                          resolvedSelection.instanceId,
                          resolvedSelection.model,
                          nextOptions,
                        ),
                      );
                    }}
                  />
                </div>
              ) : (
                <span className="text-sm text-muted-foreground">{t("noProvidersAvailable")}</span>
              )
            }
          />
          <SettingsRow
            title={t("workspace.label")}
            description={t(
              "whereNewThreadsInThisProjectStartOverridesT3JsonAndTheGlobalDefaultAppli",
            )}
            resetAction={
              storedEnvMode !== null ? (
                <SettingResetButton
                  label={t("projectWorkspaceDefault")}
                  onClick={() => setDefaultThreadEnvMode(null)}
                />
              ) : null
            }
            control={
              <Select
                value={storedEnvMode ?? "inherit"}
                onValueChange={(value) => {
                  if (value === "worktree" || value === "local") {
                    setDefaultThreadEnvMode(value);
                  } else if (value === "inherit") {
                    setDefaultThreadEnvMode(null);
                  }
                }}
              >
                <SelectTrigger aria-label={t("newThreadWorkspace")}>
                  <SelectValue>
                    {storedEnvMode === null
                      ? group.memberProjects.length > 1
                        ? t("defaultPerCheckout")
                        : t("default4", {
                            value1: resolveEnvModeLabel(inheritedEnvMode).toLowerCase(),
                          })
                      : resolveEnvModeLabel(storedEnvMode)}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="inherit">
                    {group.memberProjects.length > 1
                      ? t("defaultEachCheckoutST3JsonOrGlobalSetting")
                      : t("default5", {
                          inheritedEnvModeSource: inheritedEnvModeSource,
                          value2: resolveEnvModeLabel(inheritedEnvMode).toLowerCase(),
                        })}
                  </SelectItem>
                  <SelectItem value="worktree">{resolveEnvModeLabel("worktree")}</SelectItem>
                  <SelectItem value="local">{resolveEnvModeLabel("local")}</SelectItem>
                </SelectPopup>
              </Select>
            }
          />
        </SettingsSection>

        <SettingsSection
          title={t("checkout")}
          headerAction={
            <Select
              value={selectedCheckout.physicalProjectKey}
              onValueChange={(value) => setSelectedCheckoutKey(String(value))}
            >
              <SelectTrigger className="max-w-64" aria-label={t("selectedCheckout")}>
                <SelectValue>{selectedCheckoutLabel}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {group.memberProjects.map((member) => (
                  <SelectItem
                    key={member.physicalProjectKey}
                    hideIndicator
                    value={member.physicalProjectKey}
                  >
                    {member.environmentLabel ?? t("thisMachine")} · {member.workspaceRoot}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        >
          <div className="px-3 py-2 sm:px-4">
            <div className="flex min-w-0 items-center rounded-lg bg-muted/30 p-1 text-base text-muted-foreground sm:text-sm">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      aria-label={t("copyCheckoutPath")}
                      className="group flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left outline-none hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                      type="button"
                      onClick={() =>
                        copyPathToClipboard(selectedCheckout.workspaceRoot, {
                          path: selectedCheckout.workspaceRoot,
                        })
                      }
                    >
                      <code className="min-w-0 flex-1 truncate font-mono">
                        {selectedCheckout.workspaceRoot}
                      </code>
                      <CopyIcon className="size-4 shrink-0 opacity-60 group-hover:opacity-100" />
                    </button>
                  }
                />
                <TooltipPopup side="top">{t("copyPath2")}</TooltipPopup>
              </Tooltip>
              <div className="shrink-0 border-l border-border/60 px-2 tabular-nums">
                {selectedCheckoutThreadCount === 1
                  ? t("m1Thread")
                  : t("threads", { selectedCheckoutThreadCount: selectedCheckoutThreadCount })}
              </div>
            </div>
          </div>
          <SettingsRow
            title={t("projectGrouping")}
            description={t(
              "howThisCheckoutJoinsProjectGroupsInTheSidebarChangingItCanMoveYouToADiff",
            )}
            control={
              <Select
                value={selectedCheckoutGrouping}
                onValueChange={(value) => {
                  if (
                    value === "inherit" ||
                    value === "repository" ||
                    value === "repository_path" ||
                    value === "separate"
                  ) {
                    updateGroupingPreference(selectedCheckout, value);
                  }
                }}
              >
                <SelectTrigger
                  aria-label={t("groupingRuleFor", {
                    selectedCheckoutLabel: selectedCheckoutLabel,
                  })}
                >
                  <SelectValue>
                    {selectedCheckoutGrouping === "inherit"
                      ? t("default4", {
                          value1:
                            PROJECT_GROUPING_MODE_LABELS[
                              projectGroupingSettings.sidebarProjectGroupingMode
                            ],
                        })
                      : PROJECT_GROUPING_MODE_LABELS[selectedCheckoutGrouping]}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value="inherit">
                    {t("useGlobalDefault2")}
                  </SelectItem>
                  <SelectItem hideIndicator value="repository">
                    {PROJECT_GROUPING_MODE_LABELS.repository}
                  </SelectItem>
                  <SelectItem hideIndicator value="repository_path">
                    {PROJECT_GROUPING_MODE_LABELS.repository_path}
                  </SelectItem>
                  <SelectItem hideIndicator value="separate">
                    {PROJECT_GROUPING_MODE_LABELS.separate}
                  </SelectItem>
                </SelectPopup>
              </Select>
            }
          />
          {group.memberProjects.length > 1 ? (
            <SettingsRow
              title={t("removeCheckout")}
              description={t(
                "removesThisCheckoutAndItsThreadsFromTheProjectGroupFilesOnDiskAreNotTouc",
              )}
              control={
                <Button
                  size="xs"
                  variant="destructive-outline"
                  onClick={() => void removeMembers([selectedCheckout])}
                >
                  <Trash2Icon className="size-3.5" />
                  {t("removeCheckout")}
                </Button>
              }
            />
          ) : null}
          <div className="flex min-h-8 flex-col items-start gap-3 px-3 pt-4 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:px-4">
            <div className="min-w-0">
              <h3 className="text-base font-semibold text-foreground">
                {t("commandPalette.actions")}
              </h3>
              <p className="text-pretty text-sm text-muted-foreground">
                {t("savedAndRunOnlyIn")} {selectedCheckoutLabel}.
              </p>
            </div>
            <div className="flex w-full flex-wrap gap-1.5 sm:w-auto sm:shrink-0 sm:justify-end">
              {importableScripts.length > 0 ? (
                <Menu>
                  <MenuTrigger
                    render={
                      <Button size="xs" variant="ghost" disabled={isSavingScripts} type="button" />
                    }
                  >
                    {t("importScripts")}
                    <ChevronDownIcon className="size-3.5" />
                  </MenuTrigger>
                  <MenuPopup align="end" className="w-72">
                    <MenuGroup>
                      <MenuGroupLabel>{t("importFromT3Json")}</MenuGroupLabel>
                      <p className="px-2 pb-2 text-pretty text-sm text-muted-foreground">
                        {t("addActionsDeclaredByThisCheckoutWithoutEditingThemFirst")}
                      </p>
                    </MenuGroup>
                    <MenuSeparator />
                    {importableScripts.map((fileScript) => (
                      <MenuItem
                        key={`${fileScript.name} ${fileScript.command}`}
                        onClick={() => void importFileScript(fileScript)}
                      >
                        <ScriptIcon icon={fileScript.icon ?? "play"} className="size-4 shrink-0" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium">{fileScript.name}</div>
                          <div className="truncate font-mono text-muted-foreground">
                            {fileScript.command}
                          </div>
                        </div>
                      </MenuItem>
                    ))}
                  </MenuPopup>
                </Menu>
              ) : null}
              <Button
                size="xs"
                variant="outline"
                disabled={isSavingScripts}
                onClick={() =>
                  setEditorRequest({ scriptId: null, initial: EMPTY_PROJECT_SCRIPT_INPUT })
                }
              >
                <PlusIcon className="size-3.5" />
                {t("addAction")}
              </Button>
            </div>
          </div>
          {scripts.length === 0 ? (
            <p className="px-3 py-2 text-base text-muted-foreground sm:px-4 sm:text-sm">
              {t("noActionsConfiguredForThisCheckout")}
            </p>
          ) : (
            scripts.map((script) => {
              const shortcutLabel = shortcutLabelForCommand(
                keybindings,
                commandForProjectScript(script.id),
              );
              return (
                <SettingsRow
                  key={script.id}
                  className="group py-2"
                  title={
                    <span className="flex min-w-0 items-center gap-2">
                      <ScriptIcon
                        icon={script.icon}
                        className="size-4 shrink-0 text-muted-foreground"
                      />
                      <span className="max-w-40 shrink-0 truncate">{script.name}</span>
                      <code className="min-w-0 flex-1 truncate font-mono font-normal text-muted-foreground">
                        {script.command}
                      </code>
                      {script.runOnWorktreeCreate ? (
                        <span className="shrink-0 rounded-sm border border-border/60 px-1.5 py-px text-[11px] font-normal text-muted-foreground">
                          {t("setup2")}
                        </span>
                      ) : null}
                      {script.previewUrl ? (
                        <span className="shrink-0 rounded-sm border border-border/60 px-1.5 py-px text-[11px] font-normal text-muted-foreground max-sm:hidden">
                          {t("previewDesktopOnly")}
                        </span>
                      ) : null}
                    </span>
                  }
                  control={
                    <>
                      {shortcutLabel ? (
                        <span className="text-xs text-muted-foreground">{shortcutLabel}</span>
                      ) : null}
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        className="shrink-0 text-muted-foreground opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
                        aria-label={t("editScriptName", { name: script.name })}
                        disabled={isSavingScripts}
                        onClick={() =>
                          setEditorRequest(editorRequestForScript(script, keybindings))
                        }
                      >
                        <SettingsIcon className="size-3.5" />
                      </Button>
                    </>
                  }
                />
              );
            })
          )}
          {codeworkFile.status === "invalid" ? (
            <SettingsRow
              title={t("t3JsonIsInvalid")}
              description={t(
                "aT3JsonExistsInThisCheckoutButFailsToParseSoEveryActionAndIconItDeclares",
              )}
              className="text-warning"
            />
          ) : null}
        </SettingsSection>

        <SettingsSection title={t("danger")}>
          <SettingsRow
            title={
              group.memberProjects.length > 1
                ? t("removeThisProjectEverywhere")
                : t("removeProject")
            }
            description={
              group.memberProjects.length > 1
                ? t("deletesAllCheckoutEntriesAndTheirThreadsOnEveryMachineFilesOnDiskAreNotT", {
                    value1: group.memberProjects.length,
                  })
                : t("deletesTheProjectEntryAndItsThreadsFilesOnDiskAreNotTouched")
            }
            control={
              <Button
                variant="destructive-outline"
                onClick={() => void removeMembers(group.memberProjects)}
              >
                <Trash2Icon />
                {group.memberProjects.length > 1 ? t("removeAllEntries") : t("removeProject")}
              </Button>
            }
          />
        </SettingsSection>
      </SettingsPageContainer>

      <ProjectScriptEditorDialog
        request={editorRequest}
        scripts={scripts}
        onSubmit={submitScript}
        onDelete={deleteScript}
        onClose={() => setEditorRequest(null)}
      />
      <ProjectFaviconPickerDialog
        key={`${representative.environmentId}:${representative.workspaceRoot}:${faviconPickerOpen}`}
        cwd={representative.workspaceRoot}
        environmentId={representative.environmentId}
        onOpenChange={setFaviconPickerOpen}
        {...(pickProjectFavicon
          ? { onPickExternal: () => pickProjectFavicon(representative.workspaceRoot) }
          : {})}
        onSelect={(path) => void setFaviconPath(path)}
        open={faviconPickerOpen}
        projectName={group.displayName}
      />
    </>
  );
}
