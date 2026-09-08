import { describe, expect, it } from "vite-plus/test";

import { parseTurnDiffFilesFromUnifiedDiff } from "./Diffs.ts";

describe("parseTurnDiffFilesFromUnifiedDiff", () => {
  it("returns empty list for empty diff", () => {
    expect(parseTurnDiffFilesFromUnifiedDiff("")).toEqual([]);
  });

  it("parses per-file additions and deletions", () => {
    const diff = [
      "diff --git a/a.txt b/a.txt",
      "index 1111111..2222222 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,2 +1,3 @@",
      " one",
      "-two",
      "+two updated",
      "+three",
      "diff --git a/src/b.ts b/src/b.ts",
      "index 3333333..4444444 100644",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -3,2 +3,0 @@",
      "-old",
      "-stale",
      "",
    ].join("\n");

    expect(parseTurnDiffFilesFromUnifiedDiff(diff)).toEqual([
      { path: "a.txt", kind: "modified", additions: 2, deletions: 1 },
      { path: "src/b.ts", kind: "modified", additions: 0, deletions: 2 },
    ]);
  });

  it("parses rename-only diffs with zero line changes", () => {
    const diff = [
      "diff --git a/src/old.ts b/src/new.ts",
      "similarity index 100%",
      "rename from src/old.ts",
      "rename to src/new.ts",
      "",
    ].join("\n");

    expect(parseTurnDiffFilesFromUnifiedDiff(diff)).toEqual([
      { path: "src/new.ts", kind: "renamed", additions: 0, deletions: 0 },
    ]);
  });

  it("normalizes CRLF input before parsing", () => {
    const diff = [
      "diff --git a/a.txt b/a.txt",
      "index 1111111..2222222 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1,2 @@",
      "-one",
      "+one updated",
      "+two",
      "",
    ].join("\r\n");

    expect(parseTurnDiffFilesFromUnifiedDiff(diff)).toEqual([
      { path: "a.txt", kind: "modified", additions: 2, deletions: 1 },
    ]);
  });

  it("保留新增和删除文件的真实类型", () => {
    const diff = [
      "diff --git a/new.html b/new.html",
      "new file mode 100644",
      "index 0000000..1111111",
      "--- /dev/null",
      "+++ b/new.html",
      "@@ -0,0 +1 @@",
      "+<p>new</p>",
      "diff --git a/old.html b/old.html",
      "deleted file mode 100644",
      "index 2222222..0000000",
      "--- a/old.html",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-<p>old</p>",
      "",
    ].join("\n");

    expect(parseTurnDiffFilesFromUnifiedDiff(diff)).toEqual([
      { path: "new.html", kind: "added", additions: 1, deletions: 0 },
      { path: "old.html", kind: "deleted", additions: 0, deletions: 1 },
    ]);
  });

  it("重命名并修改内容仍标记为 renamed", () => {
    const diff = [
      "diff --git a/old.html b/new.html",
      "similarity index 75%",
      "rename from old.html",
      "rename to new.html",
      "index 1111111..2222222 100644",
      "--- a/old.html",
      "+++ b/new.html",
      "@@ -1,2 +1,2 @@",
      " <main>",
      "-old",
      "+new",
      "",
    ].join("\n");

    expect(parseTurnDiffFilesFromUnifiedDiff(diff)).toEqual([
      { path: "new.html", kind: "renamed", additions: 1, deletions: 1 },
    ]);
  });
});
