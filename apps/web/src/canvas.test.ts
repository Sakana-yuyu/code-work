import { describe, expect, it } from "vite-plus/test";

import {
  canvasReferenceFromArtifactPath,
  isCodeworkCanvasArtifactPath,
  mergeRecentCanvasSurfaces,
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
