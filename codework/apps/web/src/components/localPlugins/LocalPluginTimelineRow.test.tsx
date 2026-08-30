import { describe, expect, it } from "vite-plus/test";

import type { EnabledLocalPluginTimelineEntry } from "~/localPlugins/adapters/localPluginTimelineAdapter";
import { LocalPluginFailureJournal } from "~/localPlugins/localPluginFailureJournal";
import { recordLocalPluginTimelineRenderFailure } from "./LocalPluginTimelineRow";

const entry: EnabledLocalPluginTimelineEntry = {
  id: "local-plugin-timeline:event-1",
  pluginId: "acme.timeline",
  pluginName: "检查插件",
  contributionId: "checks",
  title: "检查结果",
  message: "类型检查通过",
  tone: "success",
  createdAt: "2026-08-30T06:00:00.000Z",
};

describe("LocalPluginTimelineRow", () => {
  it("把单条 Timeline 渲染失败记录到对应插件和 contribution", () => {
    const failures = new LocalPluginFailureJournal({
      now: () => 1,
      makeId: (sequence) => `failure-${sequence}`,
    });

    recordLocalPluginTimelineRenderFailure({
      failures,
      entry,
      error: new Error("render failed"),
    });

    expect(failures.getSnapshot()).toEqual([
      {
        id: "failure-1",
        pluginId: "acme.timeline",
        phase: "render",
        contributionKind: "timeline",
        contributionId: "checks",
        message: "render failed",
        occurredAtUnixMs: 1,
      },
    ]);
  });
});
