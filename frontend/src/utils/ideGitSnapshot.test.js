import assert from "node:assert/strict";
import test from "node:test";
import { gitChangeStatusLabel, normalizeGitSnapshot } from "./ideGitSnapshot.js";

test("git change status labels stay in Chinese source text", () => {
  assert.equal(gitChangeStatusLabel("modified"), "已修改");
  assert.equal(gitChangeStatusLabel("untracked"), "未跟踪");
  assert.equal(gitChangeStatusLabel("unknown"), "已变更");
});

test("normalizeGitSnapshot fills empty snapshots without host paths", () => {
  const snapshot = normalizeGitSnapshot({
    available: true,
    branch: "main",
    ahead: 1,
    behind: 2,
    changes: [{ path: "src/main.go", status: "modified" }],
    remotes: [{ name: "origin", url: "https://github.com/org/repo.git" }],
    diff: "+needle",
    diffTruncated: false,
  });
  assert.equal(snapshot.available, true);
  assert.equal(snapshot.branch, "main");
  assert.equal(JSON.stringify(snapshot).includes("C:"), false);
  assert.equal(JSON.stringify(snapshot).includes("/Users/"), false);
  assert.equal(normalizeGitSnapshot(null).available, false);
});
