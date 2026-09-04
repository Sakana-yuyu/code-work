import { ProjectId } from "@codework/contracts";
import type { PullRequestListEntry, PullRequestThreadComment } from "@codework/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  mergePullRequestEntries,
  mergePullRequestThreadComments,
  pullRequestDiffFileChangeType,
  pullRequestDiffFilePaths,
  pullRequestReviewPositionForLine,
  pullRequestReviewPositionLine,
} from "./pullRequests.logic";

function entry(number: number): PullRequestListEntry {
  return {
    projectId: ProjectId.make("project-1"),
    repository: "owner/repo",
    number,
  } as PullRequestListEntry;
}

function comment(id: string): PullRequestThreadComment {
  return { id } as PullRequestThreadComment;
}

describe("pull request pagination merges", () => {
  it("appends only new pull requests while preserving the first page", () => {
    expect(mergePullRequestEntries([entry(1), entry(2)], [entry(2), entry(3)])).toEqual([
      entry(1),
      entry(2),
      entry(3),
    ]);
  });

  it("appends only new review-thread comments", () => {
    expect(mergePullRequestThreadComments([comment("a")], [comment("a"), comment("b")])).toEqual([
      comment("a"),
      comment("b"),
    ]);
  });

  it("maps diff lines to host review positions and rejects non-code rows", () => {
    expect(
      pullRequestReviewPositionForLine({
        id: "add",
        type: "add",
        oldLine: null,
        newLine: 7,
        content: "new",
      }),
    ).toEqual({ kind: "added", newLine: 7 });
    const context = pullRequestReviewPositionForLine({
      id: "context",
      type: "context",
      oldLine: 3,
      newLine: 4,
      content: "same",
    });
    expect(context).toEqual({ kind: "context", oldLine: 3, newLine: 4, side: "right" });
    expect(context && pullRequestReviewPositionLine(context)).toBe(4);
    expect(
      pullRequestReviewPositionForLine({
        id: "hunk",
        type: "hunk",
        oldLine: null,
        newLine: null,
        content: "@@ -1 +1 @@",
      }),
    ).toBeNull();
  });
});

describe("pull request diff file expansion", () => {
  it("normalizes missing sides and preserves rename semantics", () => {
    expect(pullRequestDiffFilePaths({ oldPath: null, newPath: "src/new.ts" })).toEqual({
      oldPath: "src/new.ts",
      newPath: "src/new.ts",
    });
    expect(
      pullRequestDiffFileChangeType({
        id: "new",
        oldPath: null,
        newPath: "src/new.ts",
        lines: [],
      }),
    ).toBe("new");
    expect(
      pullRequestDiffFileChangeType({
        id: "rename",
        oldPath: "src/old.ts",
        newPath: "src/new.ts",
        lines: [],
      }),
    ).toBe("rename-pure");
    expect(
      pullRequestDiffFileChangeType({
        id: "rename-changed",
        oldPath: "src/old.ts",
        newPath: "src/new.ts",
        lines: [
          {
            id: "add",
            type: "add",
            oldLine: null,
            newLine: 1,
            content: "changed",
          },
        ],
      }),
    ).toBe("rename-changed");
  });
});
