import type {
  DefaultBranchActionDialogCopy,
  DefaultBranchConfirmableAction,
  GitActionMenuItem,
} from "@codework/client-runtime/state/vcs";

import { t } from "../../../i18n/runtime";

/**
 * The shared git action builders (`@codework/client-runtime/state/vcs`) emit
 * English presentation strings. These helpers translate them at the render
 * sites, preferring the shared package's stable discriminants (menu item
 * ids, dialog actions) and falling back to matching the exact English text
 * where no discriminant exists (quick action labels, disabled reasons).
 * Unmapped strings pass through raw.
 */

/** Exact English strings emitted by the shared git action builders → catalog keys. */
export const SHARED_GIT_ACTION_STRING_KEYS: Record<string, string> = {
  // Menu / quick action labels
  Commit: "gitAction.commit",
  Push: "gitAction.push",
  Pull: "gitAction.pull",
  "View PR": "gitAction.viewPr",
  "Create PR": "gitAction.createPr",
  "Commit & push": "gitAction.commitPush",
  "Commit, push & PR": "gitAction.commitPushPr",
  "Push & create PR": "gitAction.pushCreatePr",
  "Sync branch": "gitAction.syncRef",
  // Disabled reasons and quick action hints
  "Git action in progress.": "gitHint.actionInProgress",
  "Git status is unavailable.": "gitHint.statusUnavailable",
  "Create and checkout a branch before pushing or opening a PR.": "gitHint.createRefFirst",
  "No local commits to push.": "gitHint.noCommitsToPush",
  "Branch has diverged from upstream. Rebase/merge first.": "gitHint.diverged",
  "Branch is up to date. No action needed.": "gitHint.upToDate",
  "Worktree is clean. Make changes before committing.": "gitHint.worktreeClean",
  "Commit is currently unavailable.": "gitHint.commitUnavailable",
  "Detached HEAD: checkout a branch before pushing.": "gitHint.detachedHeadPush",
  "Commit or stash local changes before pushing.": "gitHint.commitOrStashBeforePush",
  "Branch is behind upstream. Pull/rebase before pushing.": "gitHint.behindUpstreamPush",
  'Add an "origin" remote before pushing.': "gitHint.addOriginRemote",
  'Add an "origin" remote before pushing or creating a PR.': "gitHint.addOriginRemoteForPushOrPr",
  "Push is currently unavailable.": "gitHint.pushUnavailable",
  "View PR is currently unavailable.": "gitHint.viewPrUnavailable",
  "Detached HEAD: checkout a branch before creating a PR.": "gitHint.detachedHeadPr",
  "Commit local changes before creating a PR.": "gitHint.commitBeforePr",
  'Add an "origin" remote before creating a PR.': "gitHint.addOriginRemoteForPr",
  "No local commits to include in a PR.": "gitHint.noCommitsForPr",
  "Branch is behind upstream. Pull/rebase before creating a PR.": "gitHint.behindUpstreamPr",
  "Create PR is currently unavailable.": "gitHint.createPrUnavailable",
};

export function localizedGitActionString(value: string): string {
  const key = SHARED_GIT_ACTION_STRING_KEYS[value];
  return key ? t(key) : value;
}

export function localizedMenuItemLabel(item: GitActionMenuItem): string {
  if (item.id === "commit") return t("gitAction.commit");
  if (item.id === "push") return t("gitAction.push");
  return item.kind === "open_pr" ? t("gitAction.viewPr") : t("gitAction.createPr");
}

/** Mirror of the shared `resolveDefaultBranchActionDialogCopy`, localized. */
export function localizedDefaultBranchActionDialogCopy(input: {
  action: DefaultBranchConfirmableAction;
  branchName: string;
  includesCommit: boolean;
}): DefaultBranchActionDialogCopy {
  if (input.action === "push" || input.action === "commit_push") {
    if (input.includesCommit) {
      return {
        title: t("gitDialog.commitPushDefaultTitle"),
        description: t("gitDialog.commitPushDefaultDescription", { branch: input.branchName }),
        continueLabel: t("gitDialog.commitPushTo", { branch: input.branchName }),
      };
    }
    return {
      title: t("gitDialog.pushDefaultTitle"),
      description: t("gitDialog.pushDefaultDescription", { branch: input.branchName }),
      continueLabel: t("gitDialog.pushTo", { branch: input.branchName }),
    };
  }

  if (input.includesCommit) {
    return {
      title: t("gitDialog.commitPushPrDefaultTitle"),
      description: t("gitDialog.commitPushPrDefaultDescription", { branch: input.branchName }),
      continueLabel: t("gitDialog.commitPushPrLabel"),
    };
  }
  return {
    title: t("gitDialog.pushPrDefaultTitle"),
    description: t("gitDialog.pushPrDefaultDescription", { branch: input.branchName }),
    continueLabel: t("gitDialog.pushPrLabel"),
  };
}
