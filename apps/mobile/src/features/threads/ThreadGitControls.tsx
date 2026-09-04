import {
  EnvironmentId,
  type GitRunStackedActionResult,
  type ProjectScript,
  type PullRequestRef,
  ThreadId,
  type VcsStatusResult,
} from "@codework/contracts";
import {
  type GitActionRequestInput,
  requiresDefaultBranchConfirmation,
  resolveQuickAction,
} from "@codework/client-runtime/state/vcs";
import { useNavigation } from "@react-navigation/native";
import { NativeHeaderToolbar } from "../../native/StackHeader";
import { useCallback, useMemo } from "react";
import { Alert } from "react-native";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import {
  basename,
  getTerminalStatusLabel,
  projectScriptMenuIcon,
  projectScriptMenuLabel,
  type TerminalMenuSession,
} from "../terminal/terminalMenu";
import { t } from "../../i18n";

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  const headLength = Math.ceil((maxLength - 1) / 2);
  const tailLength = Math.floor((maxLength - 1) / 2);
  return `${value.slice(0, headLength)}…${value.slice(value.length - tailLength)}`;
}

function compactMenuBranchLabel(branch: string): string {
  return truncateMiddle(branch, 24);
}

function compactMenuStatus(gitStatus: VcsStatusResult | null): string {
  if (!gitStatus) {
    return t("git.checkingStatus");
  }
  if (!gitStatus.isRepo) {
    return t("git.notRepo");
  }

  const parts: string[] = [];
  if (gitStatus.hasWorkingTreeChanges) {
    parts.push(t("git.changedCount", { count: gitStatus.workingTree.files.length }));
  } else if (gitStatus.aheadCount === 0 && gitStatus.behindCount === 0) {
    parts.push(t("git.clean"));
  }
  if (gitStatus.aheadCount > 0) {
    parts.push(t("git.aheadCount", { count: gitStatus.aheadCount }));
  }
  if (gitStatus.behindCount > 0) {
    parts.push(t("git.behindCount", { count: gitStatus.behindCount }));
  }
  if (gitStatus.pr?.state === "open") {
    parts.push(t("git.prNumber", { number: gitStatus.pr.number }));
  }

  return parts.join(" · ");
}

type HeaderItem = Record<string, unknown>;
type HeaderItems = HeaderItem[];
type ThreadGitHeaderActionItems = {
  readonly terminal: HeaderItem;
  readonly files: HeaderItem;
  readonly git: HeaderItem;
};
type QuickActionIcon =
  | "arrow.down.circle"
  | "arrow.up.right.circle"
  | "checkmark.circle"
  | "arrow.up.circle";

/** The subset of git-control wiring the standalone git menu needs. */
export type ThreadGitMenuProps = {
  readonly environmentId: EnvironmentId | string;
  readonly threadId: ThreadId | string;
  readonly currentBranch: string | null;
  readonly gitStatus: VcsStatusResult | null;
  readonly gitOperationLabel: string | null;
  readonly onOpenFilesInspector?: () => void;
  readonly onOpenGitInspector?: () => void;
  readonly pullRequestReference?: PullRequestRef;
  readonly onPull: () => Promise<void>;
  readonly onRunAction: (input: GitActionRequestInput) => Promise<GitRunStackedActionResult | null>;
};

type ThreadGitControlsProps = ThreadGitMenuProps & {
  readonly auxiliaryPaneControl?: {
    readonly accessibilityLabel: string;
    readonly onPress: () => void;
  };
  readonly canOpenTerminal: boolean;
  readonly canOpenFiles: boolean;
  readonly projectScripts: ReadonlyArray<ProjectScript>;
  readonly terminalSessions: ReadonlyArray<TerminalMenuSession>;
  readonly showActionControls?: boolean;
  readonly showDirectFileControl?: boolean;
  readonly onOpenTerminal: (terminalId?: string | null) => void;
  readonly onOpenNewTerminal: () => void;
  readonly onRunProjectScript: (script: ProjectScript) => Promise<void>;
};

function useThreadGitControlModel(props: ThreadGitMenuProps) {
  const navigation = useNavigation();
  const environmentId = props.environmentId;
  const threadId = props.threadId;
  const { gitStatus, gitOperationLabel, onPull, onRunAction } = props;

  const currentBranchLabel = gitStatus?.refName ?? props.currentBranch ?? "Detached HEAD";
  const busy = gitOperationLabel !== null;
  const isRepo = gitStatus?.isRepo ?? true;
  const hasPrimaryRemote = gitStatus?.hasPrimaryRemote ?? false;
  const isDefaultRef = gitStatus?.isDefaultRef ?? false;

  const quickAction = useMemo(
    () =>
      isRepo
        ? resolveQuickAction(gitStatus, busy, isDefaultRef, hasPrimaryRemote)
        : {
            label: t("gitUnavailable"),
            disabled: true,
            kind: "show_hint" as const,
            hint: t("interface.this-workspace-is-not-a-git-repository"),
          },
    [busy, gitStatus, hasPrimaryRemote, isDefaultRef, isRepo],
  );

  const quickActionHint = quickAction.disabled
    ? (quickAction.hint ?? t("git.actionUnavailable"))
    : null;

  const quickActionIcon: QuickActionIcon = (() => {
    if (quickAction.kind === "run_pull") return "arrow.down.circle";
    if (quickAction.kind === "open_pr") return "arrow.up.right.circle";
    if (quickAction.kind === "run_action") {
      if (quickAction.action === "commit") return "checkmark.circle";
      if (quickAction.action === "push" || quickAction.action === "commit_push")
        return "arrow.up.circle";
    }
    return "arrow.up.right.circle";
  })();

  const openExistingPr = useCallback(async () => {
    if (props.pullRequestReference) {
      navigation.navigate("PullRequestDetail", {
        environmentId: String(environmentId),
        projectId: String(props.pullRequestReference.projectId),
        repository: props.pullRequestReference.repository,
        number: props.pullRequestReference.number,
      });
      return;
    }
    const prUrl = gitStatus?.pr?.state === "open" ? gitStatus.pr.url : null;
    if (!prUrl) {
      Alert.alert(t("noOpenPr"), t("thisBranchDoesNotHaveAnOpenPullRequest"));
      return;
    }
    if (!(await tryOpenExternalUrl(prUrl, "pull-request"))) {
      Alert.alert(t("unableToOpenPr"), t("thePullRequestCouldNotBeOpened"));
    }
  }, [environmentId, gitStatus, navigation, props.pullRequestReference]);

  const runActionWithPrompt = useCallback(
    async (input: GitActionRequestInput) => {
      const confirmableAction =
        input.action === "push" ||
        input.action === "create_pr" ||
        input.action === "commit_push" ||
        input.action === "commit_push_pr"
          ? input.action
          : null;
      const branchName = gitStatus?.refName;
      if (
        branchName &&
        confirmableAction &&
        !input.featureBranch &&
        requiresDefaultBranchConfirmation(input.action, isDefaultRef)
      ) {
        navigation.navigate("GitConfirm", {
          environmentId: String(environmentId),
          threadId: String(threadId),
          confirmAction: confirmableAction,
          branchName,
          includesCommit: String(
            input.action === "commit_push" || input.action === "commit_push_pr",
          ),
        });
        return;
      }

      await onRunAction(input);
    },
    [environmentId, gitStatus, isDefaultRef, onRunAction, navigation, threadId],
  );

  const runQuickAction = useCallback(async () => {
    if (quickAction.kind === "open_pr") {
      await openExistingPr();
      return;
    }
    if (quickAction.kind === "run_pull") {
      await onPull();
      return;
    }
    if (quickAction.kind === "run_action" && quickAction.action) {
      await runActionWithPrompt({ action: quickAction.action });
    }
  }, [onPull, openExistingPr, quickAction, runActionWithPrompt]);

  const openFiles = useCallback(() => {
    if (props.onOpenFilesInspector) {
      props.onOpenFilesInspector();
      return;
    }
    navigation.navigate("ThreadFiles", {
      environmentId: String(environmentId),
      threadId: String(threadId),
    });
  }, [environmentId, props.onOpenFilesInspector, navigation, threadId]);

  const openReview = useCallback(() => {
    navigation.navigate("ThreadReview", {
      environmentId: EnvironmentId.make(String(environmentId)),
      threadId: ThreadId.make(String(threadId)),
    });
  }, [environmentId, navigation, threadId]);

  const openGitInspector = useCallback(() => {
    if (props.onOpenGitInspector) {
      props.onOpenGitInspector();
      return;
    }
    navigation.navigate("GitOverview", {
      environmentId: String(environmentId),
      threadId: String(threadId),
    });
  }, [environmentId, props.onOpenGitInspector, navigation, threadId]);

  return {
    currentBranchLabel,
    isRepo,
    openFiles,
    openGitInspector,
    openReview,
    quickAction,
    quickActionHint,
    quickActionIcon,
    runQuickAction,
  };
}

function useThreadGitHeaderActionItems(props: ThreadGitControlsProps): ThreadGitHeaderActionItems {
  const model = useThreadGitControlModel(props);

  return useMemo(
    () => ({
      terminal: {
        accessibilityLabel: t("openTerminal"),
        disabled: !props.canOpenTerminal,
        icon: { name: "terminal", type: "sfSymbol" },
        identifier: "thread-right-terminal",
        label: t("surface.terminal"),
        menu: {
          items: [
            ...props.projectScripts.map((script) => ({
              description: script.command,
              icon: { name: projectScriptMenuIcon(script.icon), type: "sfSymbol" as const },
              label: projectScriptMenuLabel(script),
              onPress: () => void props.onRunProjectScript(script),
              type: "action" as const,
            })),
            ...(props.projectScripts.length === 0
              ? [
                  {
                    description: t("thisProjectHasNoSavedScriptsYet"),
                    disabled: true,
                    icon: { name: "play", type: "sfSymbol" as const },
                    label: t("noProjectScripts"),
                    onPress: () => {},
                    type: "action" as const,
                  },
                ]
              : []),
            ...props.terminalSessions.map((session) => ({
              description: [
                getTerminalStatusLabel({
                  status: session.status,
                  hasRunningSubprocess: session.hasRunningSubprocess,
                }),
                basename(session.cwd),
              ]
                .filter(Boolean)
                .join(" · "),
              icon: { name: "terminal", type: "sfSymbol" as const },
              label: session.displayLabel,
              onPress: () => props.onOpenTerminal(session.terminalId),
              type: "action" as const,
            })),
            {
              description: t("startAnotherShellForThisThread"),
              icon: { name: "plus", type: "sfSymbol" },
              label: t("openNewTerminal"),
              onPress: props.onOpenNewTerminal,
              type: "action",
            },
          ],
          title: t("surface.terminal"),
        },
        sharesBackground: true,
        type: "menu",
        variant: "plain",
      },
      files: {
        accessibilityLabel: t("openFiles"),
        disabled: !props.canOpenFiles,
        icon: { name: "folder", type: "sfSymbol" },
        identifier: "thread-right-files",
        label: t("surface.files"),
        onPress: model.openFiles,
        sharesBackground: true,
        type: "button",
        variant: "plain",
      },
      git: {
        accessibilityLabel: t("gitActions"),
        icon: { name: "point.topleft.down.curvedto.point.bottomright.up", type: "sfSymbol" },
        identifier: "thread-right-git",
        label: "Git",
        menu: {
          items: [
            {
              description: compactMenuStatus(props.gitStatus),
              disabled: true,
              icon: {
                name: "point.topleft.down.curvedto.point.bottomright.up",
                type: "sfSymbol",
              },
              label: compactMenuBranchLabel(model.currentBranchLabel),
              onPress: (): void => {},
              type: "action",
            },
            {
              description: model.quickActionHint ?? undefined,
              disabled: model.quickAction.disabled,
              icon: { name: model.quickActionIcon, type: "sfSymbol" },
              label: model.quickAction.label,
              onPress: (): void => void model.runQuickAction(),
              type: "action",
            },
            {
              description: t("turnDiffsAndWorktreeChanges"),
              disabled: !model.isRepo,
              icon: { name: "text.bubble", type: "sfSymbol" },
              label: t("reviewChanges"),
              onPress: model.openReview,
              type: "action",
            },
            {
              description: t("commitFilesBranches"),
              icon: { name: "ellipsis", type: "sfSymbol" },
              label: t("more"),
              onPress: model.openGitInspector,
              type: "action",
            },
          ],
          title: "Git",
        },
        sharesBackground: true,
        type: "menu",
        variant: "plain",
      },
    }),
    [
      model.currentBranchLabel,
      model.isRepo,
      model.openFiles,
      model.openGitInspector,
      model.openReview,
      model.quickAction.disabled,
      model.quickAction.label,
      model.quickActionHint,
      model.quickActionIcon,
      model.runQuickAction,
      props.canOpenFiles,
      props.canOpenTerminal,
      props.gitStatus,
      props.onOpenNewTerminal,
      props.onOpenTerminal,
      props.onRunProjectScript,
      props.projectScripts,
      props.terminalSessions,
    ],
  );
}

export function useThreadGitRightHeaderItems(props: ThreadGitControlsProps): HeaderItems {
  const actionItems = useThreadGitHeaderActionItems(props);
  return useMemo(
    () => [actionItems.git, actionItems.files, actionItems.terminal] as HeaderItems,
    [actionItems],
  );
}

export function useThreadGitCenterHeaderItems(props: ThreadGitControlsProps): HeaderItems {
  const actionItems = useThreadGitHeaderActionItems(props);
  return useMemo(
    () => [actionItems.files, actionItems.git, actionItems.terminal] as HeaderItems,
    [actionItems],
  );
}

export function ThreadGitControls(props: ThreadGitControlsProps) {
  const model = useThreadGitControlModel(props);
  const showActionControls = props.showActionControls ?? true;

  if (!showActionControls) {
    return null;
  }

  return (
    <NativeHeaderToolbar placement="right">
      {showActionControls && props.auxiliaryPaneControl ? (
        <NativeHeaderToolbar.Button
          accessibilityLabel={props.auxiliaryPaneControl.accessibilityLabel}
          icon="sidebar.right"
          onPress={props.auxiliaryPaneControl.onPress}
          separateBackground
        />
      ) : null}
      {showActionControls ? (
        <NativeHeaderToolbar.Menu
          icon="terminal"
          disabled={!props.canOpenTerminal}
          separateBackground
        >
          {props.projectScripts.length > 0 ? (
            props.projectScripts.map((script) => (
              <NativeHeaderToolbar.MenuAction
                key={script.id}
                icon={projectScriptMenuIcon(script.icon)}
                onPress={() => void props.onRunProjectScript(script)}
                subtitle={script.command}
              >
                <NativeHeaderToolbar.Label>
                  {projectScriptMenuLabel(script)}
                </NativeHeaderToolbar.Label>
              </NativeHeaderToolbar.MenuAction>
            ))
          ) : (
            <NativeHeaderToolbar.MenuAction
              icon="play"
              disabled
              onPress={() => {}}
              subtitle={t("thisProjectHasNoSavedScriptsYet")}
            >
              <NativeHeaderToolbar.Label>{t("noProjectScripts")}</NativeHeaderToolbar.Label>
            </NativeHeaderToolbar.MenuAction>
          )}
          {props.terminalSessions.map((session) => (
            <NativeHeaderToolbar.MenuAction
              key={session.terminalId}
              icon="terminal"
              onPress={() => props.onOpenTerminal(session.terminalId)}
              subtitle={[
                getTerminalStatusLabel({
                  status: session.status,
                  hasRunningSubprocess: session.hasRunningSubprocess,
                }),
                basename(session.cwd),
              ]
                .filter(Boolean)
                .join(" · ")}
            >
              <NativeHeaderToolbar.Label>{session.displayLabel}</NativeHeaderToolbar.Label>
            </NativeHeaderToolbar.MenuAction>
          ))}
          <NativeHeaderToolbar.MenuAction
            icon="plus"
            onPress={props.onOpenNewTerminal}
            subtitle={t("startAnotherShellForThisThread")}
          >
            <NativeHeaderToolbar.Label>{t("openNewTerminal")}</NativeHeaderToolbar.Label>
          </NativeHeaderToolbar.MenuAction>
        </NativeHeaderToolbar.Menu>
      ) : null}
      {showActionControls && props.showDirectFileControl ? (
        <NativeHeaderToolbar.Button
          accessibilityLabel={t("openFiles")}
          disabled={!props.canOpenFiles}
          icon="folder"
          onPress={model.openFiles}
          separateBackground
        />
      ) : null}
      {showActionControls ? <ThreadGitMenu {...props} /> : null}
    </NativeHeaderToolbar>
  );
}

/**
 * The standalone git actions menu (branch status, quick commit/push action,
 * review, more). Rendered inside a NativeHeaderToolbar by both the thread
 * chat header and the review screen's toolbar.
 */
export function ThreadGitMenu(props: ThreadGitMenuProps) {
  const model = useThreadGitControlModel(props);

  return (
    <NativeHeaderToolbar.Menu icon="point.topleft.down.curvedto.point.bottomright.up">
      <NativeHeaderToolbar.MenuAction
        icon="point.topleft.down.curvedto.point.bottomright.up"
        disabled
        onPress={() => {}}
        subtitle={compactMenuStatus(props.gitStatus)}
      >
        <NativeHeaderToolbar.Label>
          {compactMenuBranchLabel(model.currentBranchLabel)}
        </NativeHeaderToolbar.Label>
      </NativeHeaderToolbar.MenuAction>
      <NativeHeaderToolbar.MenuAction
        icon={model.quickActionIcon}
        disabled={model.quickAction.disabled}
        onPress={() => void model.runQuickAction()}
        subtitle={model.quickActionHint ?? undefined}
      >
        <NativeHeaderToolbar.Label>{model.quickAction.label}</NativeHeaderToolbar.Label>
      </NativeHeaderToolbar.MenuAction>
      <NativeHeaderToolbar.MenuAction
        icon="text.bubble"
        disabled={!model.isRepo}
        onPress={model.openReview}
        subtitle={t("turnDiffsAndWorktreeChanges")}
      >
        <NativeHeaderToolbar.Label>{t("reviewChanges")}</NativeHeaderToolbar.Label>
      </NativeHeaderToolbar.MenuAction>
      <NativeHeaderToolbar.MenuAction
        icon="ellipsis"
        onPress={model.openGitInspector}
        subtitle={t("commitFilesBranches")}
      >
        <NativeHeaderToolbar.Label>{t("more")}</NativeHeaderToolbar.Label>
      </NativeHeaderToolbar.MenuAction>
    </NativeHeaderToolbar.Menu>
  );
}
