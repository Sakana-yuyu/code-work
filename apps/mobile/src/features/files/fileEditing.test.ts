import { describe, expect, it } from "vite-plus/test";

import { canEditWorkspaceFile } from "./fileEditing";

describe("canEditWorkspaceFile", () => {
  it("allows a loaded, complete source file", () => {
    expect(
      canEditWorkspaceFile({
        relativePath: "src/example.ts",
        fileLoaded: true,
        truncated: false,
        isCanvas: false,
        viewMode: "source",
      }),
    ).toBe(true);
  });

  it.each([
    ["missing", { relativePath: null, fileLoaded: false, truncated: false, isCanvas: false }],
    [
      "truncated",
      { relativePath: "large.log", fileLoaded: true, truncated: true, isCanvas: false },
    ],
    [
      "canvas",
      { relativePath: ".codework/canvas.md", fileLoaded: true, truncated: false, isCanvas: true },
    ],
    ["preview", { relativePath: "README.md", fileLoaded: true, truncated: false, isCanvas: false }],
  ])("keeps %s files read-only", (_label, value) => {
    expect(
      canEditWorkspaceFile({
        ...value,
        viewMode: _label === "preview" ? "preview" : "source",
      }),
    ).toBe(false);
  });
});
