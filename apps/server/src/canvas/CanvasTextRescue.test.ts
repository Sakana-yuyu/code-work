import { describe, expect, it } from "@effect/vitest";

import { extractRescuableCanvas, normalizeRescuedCanvas } from "./CanvasTextRescue.ts";

describe("extractRescuableCanvas", () => {
  it("extracts a canvas-shaped fenced json block from prose", () => {
    const text = [
      "评审完成，以下是画布：",
      "",
      "```json",
      JSON.stringify({ title: "架构评审", blocks: [{ type: "divider" }] }),
      "```",
      "",
      "如需深入某个模块请继续提问。",
    ].join("\n");
    const raw = extractRescuableCanvas(text);
    expect(raw).toEqual({ title: "架构评审", blocks: [{ type: "divider" }] });
  });

  it("ignores fenced json that is not a canvas document", () => {
    const text = '```json\n{"name": "package.json", "blocks": "none"}\n```';
    expect(extractRescuableCanvas(text)).toBeUndefined();
  });

  it("ignores non-json fences and prose without blocks", () => {
    expect(extractRescuableCanvas("```ts\nconst a = 1;\n```")).toBeUndefined();
    expect(extractRescuableCanvas("没有代码块，只有结论。")).toBeUndefined();
  });
});

describe("normalizeRescuedCanvas", () => {
  it("normalizes the duplicate-type stat pattern models emit", () => {
    // 模型真实输出：同一对象里先写 section 再写 stat，JSON.parse 取最后一个 type。
    const raw = JSON.parse(
      `{"type": "section", "heading": "依赖数量", "type": "stat", "label": "Go Modules", "value": "35"}`,
    );
    const input = normalizeRescuedCanvas(
      { title: "评审", canvasId: "review-1", blocks: [raw] },
      "E:/workspace/demo",
    );
    expect(input?.blocks).toEqual([{ type: "stat", label: "Go Modules", value: "35" }]);
    expect(input?.cwd).toBe("E:/workspace/demo");
    expect(input?.canvasId).toBe("review-1");
  });

  it("coerces numeric strings and defaults tones/statuses", () => {
    const input = normalizeRescuedCanvas(
      {
        title: "量化",
        blocks: [
          {
            type: "chart_bar",
            points: [
              { label: "A", value: "12" },
              { label: "B", value: 3 },
            ],
          },
          { type: "callout", body: "核心结论" },
          { type: "todo", items: [{ text: "跟进 CI" }, { text: "修 bug", status: "done" }] },
        ],
      },
      "E:/workspace/demo",
    );
    expect(input?.blocks).toEqual([
      {
        type: "chart_bar",
        points: [
          { label: "A", value: 12 },
          { label: "B", value: 3 },
        ],
      },
      { type: "callout", tone: "info", body: "核心结论" },
      {
        type: "todo",
        items: [
          { text: "跟进 CI", status: "pending" },
          { text: "修 bug", status: "done" },
        ],
      },
    ]);
  });

  it("infers diff line types from +/- prefixes and keeps optional path", () => {
    const input = normalizeRescuedCanvas(
      {
        title: "diff",
        blocks: [
          {
            type: "diff",
            path: "src/a.ts",
            lines: ["+ added", "- removed", "  context"],
          },
        ],
      },
      "E:/workspace/demo",
    );
    expect(input?.blocks).toEqual([
      {
        type: "diff",
        path: "src/a.ts",
        lines: [
          { type: "add", text: "+ added" },
          { type: "del", text: "- removed" },
          { type: "context", text: "context" },
        ],
      },
    ]);
  });

  it("drops invalid blocks and returns undefined when nothing survives", () => {
    expect(
      normalizeRescuedCanvas(
        { title: "x", blocks: [{ type: "section", heading: "缺正文" }, { type: "mystery" }] },
        "E:/workspace/demo",
      ),
    ).toBeUndefined();
  });

  it("caps blocks and sanitizes the canvasId", () => {
    const blocks = Array.from({ length: 40 }, (_, index) => ({
      type: "divider",
      marker: index,
    }));
    const input = normalizeRescuedCanvas(
      { title: "t", canvasId: "../evil id!", blocks },
      "E:/workspace/demo",
    );
    expect(input?.blocks.length).toBe(32);
    expect(input?.canvasId).toBe("evil-id");
  });
});
