import { describe, expect, it } from "vite-plus/test";

import {
  applyCodeGraphOutput,
  getCodeGraphIndexProgress,
  parseCodeGraphProgressLine,
  setCodeGraphProgress,
} from "./codeGraphProgress.ts";

describe("parseCodeGraphProgressLine", () => {
  it("maps the four upstream phase lines", () => {
    expect(parseCodeGraphProgressLine("Scanning files...")?.phase).toBe("scanning");
    expect(parseCodeGraphProgressLine("Parsing code...")?.phase).toBe("parsing");
    expect(parseCodeGraphProgressLine("Resolving refs...")?.phase).toBe("resolving");
    expect(parseCodeGraphProgressLine("Linking dynamic dispatch...")?.phase).toBe("linking");
  });

  it("strips ANSI escapes and clack chrome before matching", () => {
    expect(parseCodeGraphProgressLine("\x1b[36m◆  Scanning files...\x1b[39m")?.phase).toBe(
      "scanning",
    );
    expect(parseCodeGraphProgressLine("└ Done")?.phase).toBe("complete");
  });

  it("reads the completion summary as complete with its stats as detail", () => {
    const parsed = parseCodeGraphProgressLine("● 13 nodes, 10 edges in 948ms");
    expect(parsed?.phase).toBe("complete");
    expect(parsed?.detail).toContain("13 nodes");
  });

  it("ignores noise lines, blanks, and progress spinner redraws", () => {
    expect(parseCodeGraphProgressLine("some random npm notice")).toBeNull();
    expect(parseCodeGraphProgressLine("   ")).toBeNull();
    expect(parseCodeGraphProgressLine("\x1b[1G\x1b[2K")).toBeNull();
  });
});

describe("applyCodeGraphOutput", () => {
  it("stores the latest phase per root, case-insensitively on Windows", () => {
    const root =
      process.platform === "win32" ? "Z:\\codegraph-progress-demo" : "/tmp/codegraph-progress-demo";
    setCodeGraphProgress(root, "queued");
    expect(applyCodeGraphOutput(root, "Scanning files...\n")).toBe(false);
    expect(getCodeGraphIndexProgress(root.toUpperCase())?.phase).toBe("scanning");

    applyCodeGraphOutput(root, "Parsing code...\nResolving refs...\n");
    expect(getCodeGraphIndexProgress(root)?.phase).toBe("resolving");
  });

  it("keeps the stats detail when the trailing Done line arrives later", () => {
    const root =
      process.platform === "win32"
        ? "Z:\\codegraph-progress-detail"
        : "/tmp/codegraph-progress-detail";
    expect(applyCodeGraphOutput(root, "● 7 nodes, 6 edges in 120ms\n")).toBe(true);
    expect(applyCodeGraphOutput(root, "└ Done\n")).toBe(true);
    const progress = getCodeGraphIndexProgress(root);
    expect(progress?.phase).toBe("complete");
    expect(progress?.detail).toContain("7 nodes");
  });

  it("merges a second completion summary instead of dropping it", () => {
    const root =
      process.platform === "win32"
        ? "Z:\\codegraph-progress-merge"
        : "/tmp/codegraph-progress-merge";
    applyCodeGraphOutput(root, "● 7 nodes, 6 edges in 120ms\n");
    applyCodeGraphOutput(root, "● 9 nodes, 8 edges in 200ms\n");
    const detail = getCodeGraphIndexProgress(root)?.detail ?? "";
    expect(detail).toContain("7 nodes");
    expect(detail).toContain("9 nodes");
  });

  it("treats CR spinner redraws as line boundaries for full phase lines", () => {
    const root =
      process.platform === "win32"
        ? "Z:\\codegraph-progress-chunks"
        : "/tmp/codegraph-progress-chunks";
    // 无行缓冲是刻意取舍：被 chunk 劈开的半行不匹配，整行（哪怕用 \r 分隔）照常落位。
    applyCodeGraphOutput(root, "Scanning files...\rParsing code...\rResolving refs...\r");
    expect(getCodeGraphIndexProgress(root)?.phase).toBe("resolving");
  });

  it("ignores non-string non-buffer chunks and empty strings", () => {
    const root =
      process.platform === "win32"
        ? "Z:\\codegraph-progress-ignore"
        : "/tmp/codegraph-progress-ignore";
    setCodeGraphProgress(root, "queued");
    expect(applyCodeGraphOutput(root, 42)).toBe(false);
    expect(applyCodeGraphOutput(root, "")).toBe(false);
    expect(getCodeGraphIndexProgress(root)?.phase).toBe("queued");
  });
});
