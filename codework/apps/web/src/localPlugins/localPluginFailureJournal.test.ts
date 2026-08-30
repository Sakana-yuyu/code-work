import { describe, expect, it, vi } from "vite-plus/test";

import { LocalPluginFailureJournal } from "./localPluginFailureJournal";
import { runIsolatedLocalPluginContribution } from "./localPluginIsolation";

describe("LocalPluginFailureJournal", () => {
  it("限制失败记录数量、支持按插件清理并通知订阅者", () => {
    const listener = vi.fn();
    const journal = new LocalPluginFailureJournal({
      now: () => 1,
      makeId: (sequence) => `failure-${sequence}`,
      maxEntries: 2,
    });
    journal.subscribe(listener);

    journal.record({ pluginId: "one", phase: "invoke", error: new Error("first") });
    journal.record({ pluginId: "two", phase: "invoke", error: new Error("second") });
    journal.record({ pluginId: "one", phase: "render", error: new Error("third") });

    expect(journal.getSnapshot().map((failure) => failure.message)).toEqual(["second", "third"]);
    journal.clear("one");
    expect(journal.getSnapshot().map((failure) => failure.pluginId)).toEqual(["two"]);
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it("把同步异常转换为失败结果", async () => {
    const journal = new LocalPluginFailureJournal({
      now: () => 1,
      makeId: (sequence) => `failure-${sequence}`,
    });

    const result = await runIsolatedLocalPluginContribution({
      failures: journal,
      pluginId: "one",
      contributionKind: "workspacePanels",
      contributionId: "overview",
      phase: "render",
      run: () => {
        throw new Error("render failed");
      },
    });

    expect(result).toMatchObject({
      ok: false,
      failure: { phase: "render", message: "render failed" },
    });
  });
});
