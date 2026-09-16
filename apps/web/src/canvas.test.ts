import { describe, expect, it } from "vite-plus/test";

import {
  canvasReferenceFromArtifactPath,
  isCodeworkCanvasArtifactPath,
  mergeRecentCanvasSurfaces,
  parseCanvasDocument,
  resolveCanvasReferenceForFiles,
  type CanvasSurface,
} from "./canvas";

describe("Canvas artifact detection", () => {
  it("recognizes managed Canvas files and ignores ordinary project JSON", () => {
    expect(isCodeworkCanvasArtifactPath(".codework\\canvases\\thread\\analysis.canvas.json")).toBe(
      true,
    );
    expect(isCodeworkCanvasArtifactPath("src/config.json")).toBe(false);
    expect(
      canvasReferenceFromArtifactPath(".codework/canvases/thread/项目分析.canvas.json"),
    ).toEqual({
      canvasId: "项目分析",
      title: "项目分析",
      relativePath: ".codework/canvases/thread/项目分析.canvas.json",
    });
    expect(canvasReferenceFromArtifactPath(".codework/canvases/thread/legacy.json")).toEqual({
      canvasId: "legacy",
      title: "legacy",
      relativePath: ".codework/canvases/thread/legacy.json",
    });
  });

  it("prefers the persisted reference while matching path separators", () => {
    const reference = {
      canvasId: "project-analysis",
      title: "Project analysis",
      relativePath: ".codework/canvases/thread/Project-analysis.canvas.json",
    };

    expect(
      resolveCanvasReferenceForFiles(
        [{ path: ".codework\\canvases\\thread\\Project-analysis.canvas.json" }],
        [reference],
      ),
    ).toBe(reference);
  });
});

describe("mergeRecentCanvasSurfaces", () => {
  const live = (canvasId: string, title = canvasId): CanvasSurface => ({
    id: `canvas:${canvasId}`,
    kind: "canvas" as const,
    canvasId,
    title,
    relativePath: `.codework/canvases/thread-a/${canvasId}.canvas.json`,
  });
  const disk = (canvasId: string, updatedAt: number, thread = "thread-b") => ({
    canvasId,
    title: canvasId,
    relativePath: `.codework/canvases/${thread}/${canvasId}.canvas.json`,
    updatedAt,
  });

  it("keeps live surfaces and appends disk-only canvases without duplicates", () => {
    const liveAlpha = live("alpha");
    const merged = mergeRecentCanvasSurfaces(
      [liveAlpha],
      [disk("alpha", 9), disk("beta", 2), disk("gamma", 1)],
    );

    expect(merged.map((canvas) => canvas.canvasId)).toEqual(["alpha", "beta", "gamma"]);
    expect(merged[0]).toBe(liveAlpha);
  });

  it("returns an empty list when neither source has canvases", () => {
    expect(mergeRecentCanvasSurfaces([], [])).toEqual([]);
  });
});

describe("parseCanvasDocument block types", () => {
  const base = {
    schemaVersion: 1,
    canvasId: "review",
    title: "Review",
    relativePath: ".codework/canvases/t/review.canvas.json",
    createdAt: 1,
    updatedAt: 2,
  };

  it("decodes the Cursor-parity block inventory end to end", () => {
    const document = parseCanvasDocument(
      JSON.stringify({
        ...base,
        blocks: [
          { type: "callout", tone: "risk", title: "最大风险", body: "api 层 1,230 行路由。" },
          {
            type: "todo",
            title: "后续行动",
            items: [
              { text: "拆分 api 层", status: "pending" },
              { text: "补齐迁移测试", status: "in_progress" },
              { text: "清理遗留 SQL", status: "done" },
            ],
          },
          { type: "code", language: "ts", code: "const x = 1;" },
          { type: "divider" },
          { type: "badges", items: [{ label: "Spring Boot 3", tone: "info" }] },
          {
            type: "usage",
            label: "语言构成",
            segments: [
              { label: "Java", value: 60, tone: "info" },
              { label: "Vue", value: 40, tone: "success" },
            ],
          },
          {
            type: "chart_bar",
            title: "模块行数",
            points: [
              { label: "api", value: 1230 },
              { label: "service", value: 980 },
            ],
          },
          {
            type: "chart_line",
            title: "趋势",
            labels: ["1月", "2月", "3月"],
            series: [{ label: "缺陷", points: [5, 3, 1] }],
          },
          {
            type: "chart_pie",
            title: "测试分布",
            slices: [
              { label: "pytest", value: 125 },
              { label: "spring", value: 538 },
            ],
          },
          {
            type: "diff",
            path: "src/a.ts",
            lines: [
              { type: "context", text: "const a = 1;" },
              { type: "del", text: "const b = 2;" },
              { type: "add", text: "const b = 3;" },
            ],
          },
          { type: "disclose", summary: "方法说明", body: "抽样方式：每目录 3 个文件。" },
        ],
      }),
    );

    expect(document).not.toBeNull();
    expect(document?.blocks.map((block) => block.type)).toEqual([
      "callout",
      "todo",
      "code",
      "divider",
      "badges",
      "usage",
      "chart_bar",
      "chart_line",
      "chart_pie",
      "diff",
      "disclose",
    ]);
  });

  it("still rejects unknown tones and statuses", () => {
    expect(
      parseCanvasDocument(
        JSON.stringify({
          ...base,
          blocks: [{ type: "callout", tone: "critical", body: "x" }],
        }),
      ),
    ).toBeNull();
    expect(
      parseCanvasDocument(
        JSON.stringify({
          ...base,
          blocks: [{ type: "todo", items: [{ text: "x", status: "blocked" }] }],
        }),
      ),
    ).toBeNull();
  });
});
