import { setCurrentLanguage } from "../../../i18n/runtime";

setCurrentLanguage("en");

import { describe, expect, it } from "vite-plus/test";

import { type VcsStatusResult } from "@codework/contracts";
import {
  buildMenuItems,
  getGitActionDisabledReason,
  resolveQuickAction,
} from "@codework/client-runtime/state/vcs";

import { en } from "../../../i18n/messages";
import {
  SHARED_GIT_ACTION_STRING_KEYS,
  localizedDefaultBranchActionDialogCopy,
  localizedGitActionString,
  localizedMenuItemLabel,
} from "./gitActionStrings";

const OPEN_PR = {
  number: 7,
  title: "Add a thing",
  url: "https://github.test/org/repo/pull/7",
  baseRef: "main",
  headRef: "feature",
  state: "open" as const,
} satisfies NonNullable<VcsStatusResult["pr"]>;

const makeStatus = (overrides: Partial<VcsStatusResult> = {}): VcsStatusResult => ({
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "feature",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
  ...overrides,
});

const STATUSES: (VcsStatusResult | null)[] = [
  null,
  makeStatus(),
  makeStatus({ refName: null }),
  makeStatus({ hasWorkingTreeChanges: true }),
  makeStatus({ hasUpstream: false }),
  makeStatus({ hasUpstream: false, hasPrimaryRemote: false }),
  makeStatus({ aheadCount: 1 }),
  makeStatus({ aheadCount: 1, hasUpstream: false }),
  makeStatus({ aheadCount: 1, hasUpstream: false, hasPrimaryRemote: false }),
  makeStatus({ behindCount: 1 }),
  makeStatus({ aheadCount: 1, behindCount: 1 }),
  makeStatus({ pr: OPEN_PR }),
];

/** Every label, hint, and disabled reason the shared builders can emit. */
function sharedGitActionStrings(): string[] {
  const strings = new Set<string>();
  for (const busy of [false, true]) {
    for (const gitStatus of STATUSES) {
      for (const isDefaultRef of [false, true]) {
        for (const hasPrimaryRemote of [false, true]) {
          const quick = resolveQuickAction(gitStatus, busy, isDefaultRef, hasPrimaryRemote);
          strings.add(quick.label);
          if (quick.hint !== undefined) strings.add(quick.hint);
          for (const item of buildMenuItems(gitStatus, busy, hasPrimaryRemote)) {
            strings.add(item.label);
            const reason = getGitActionDisabledReason({
              item,
              gitStatus,
              isBusy: busy,
              hasOriginRemote: hasPrimaryRemote,
            });
            if (reason !== null) strings.add(reason);
          }
        }
      }
    }
  }
  return [...strings];
}

describe("localizedGitActionString", () => {
  it("maps every emitted shared string to an en catalog value that matches it", () => {
    for (const value of sharedGitActionStrings()) {
      const key = SHARED_GIT_ACTION_STRING_KEYS[value];
      if (key === undefined) {
        throw new Error(`unmapped shared git string: ${value}`);
      }
      expect(en[key]).toBe(value);
    }
  });

  it("passes unmapped strings through raw", () => {
    expect(localizedGitActionString("A sentence the shared package does not send yet.")).toBe(
      "A sentence the shared package does not send yet.",
    );
  });

  it("translates to zh-CN", () => {
    setCurrentLanguage("zh-CN");
    try {
      expect(
        localizedGitActionString("Branch is behind upstream. Pull/rebase before pushing."),
      ).toBe("分支落后于上游，请先拉取/变基再推送。");
    } finally {
      setCurrentLanguage("en");
    }
  });
});

describe("localizedMenuItemLabel", () => {
  it("maps labels from the stable menu item ids", () => {
    const items = buildMenuItems(
      makeStatus({ hasWorkingTreeChanges: true, aheadCount: 1 }),
      false,
      true,
    );
    expect(items.map((item) => localizedMenuItemLabel(item))).toEqual([
      "Commit",
      "Push",
      "Create PR",
    ]);
  });

  it("maps the View PR label for open pull requests", () => {
    const items = buildMenuItems(makeStatus({ pr: OPEN_PR }), false, true);
    const prItem = items.find((item) => item.id === "pr");
    expect(prItem && localizedMenuItemLabel(prItem)).toBe("View PR");
  });
});

describe("localizedDefaultBranchActionDialogCopy", () => {
  it("localizes all four dialog variants (en)", () => {
    expect(
      localizedDefaultBranchActionDialogCopy({
        action: "commit_push",
        branchName: "main",
        includesCommit: true,
      }),
    ).toEqual({
      title: "Commit & push to default branch?",
      description:
        'This action will commit and push changes on "main". You can continue on this branch or create a feature branch and run the same action there.',
      continueLabel: "Commit & push to main",
    });
    expect(
      localizedDefaultBranchActionDialogCopy({
        action: "push",
        branchName: "main",
        includesCommit: false,
      }),
    ).toEqual({
      title: "Push to default branch?",
      description:
        'This action will push local commits on "main". You can continue on this branch or create a feature branch and run the same action there.',
      continueLabel: "Push to main",
    });
    expect(
      localizedDefaultBranchActionDialogCopy({
        action: "commit_push_pr",
        branchName: "main",
        includesCommit: true,
      }),
    ).toEqual({
      title: "Commit, push & create PR from default branch?",
      description:
        'This action will commit, push, and create a PR on "main". You can continue on this branch or create a feature branch and run the same action there.',
      continueLabel: "Commit, push & create PR",
    });
    expect(
      localizedDefaultBranchActionDialogCopy({
        action: "create_pr",
        branchName: "main",
        includesCommit: false,
      }),
    ).toEqual({
      title: "Push & create PR from default branch?",
      description:
        'This action will push local commits and create a PR on "main". You can continue on this branch or create a feature branch and run the same action there.',
      continueLabel: "Push & create PR",
    });
  });

  it("localizes dialog copy to zh-CN with the branch interpolated", () => {
    setCurrentLanguage("zh-CN");
    try {
      expect(
        localizedDefaultBranchActionDialogCopy({
          action: "push",
          branchName: "main",
          includesCommit: false,
        }),
      ).toEqual({
        title: "推送到默认分支？",
        description:
          "此操作将推送“main”上的本地提交。你可以继续在此分支上操作，也可以创建功能分支后执行相同操作。",
        continueLabel: "推送到 main",
      });
    } finally {
      setCurrentLanguage("en");
    }
  });
});
