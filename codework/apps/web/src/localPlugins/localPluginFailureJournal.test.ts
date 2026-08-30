import { describe, expect, it, vi } from "vite-plus/test";

import { type LocalPluginFailure, LocalPluginFailureJournal } from "./localPluginFailureJournal";
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

    journal.record({
      pluginId: "one",
      phase: "invoke",
      code: "contribution-invoke-failed",
      error: new Error("first"),
    });
    journal.record({
      pluginId: "two",
      phase: "invoke",
      code: "contribution-invoke-failed",
      error: new Error("second"),
    });
    journal.record({
      pluginId: "one",
      phase: "render",
      code: "contribution-render-failed",
      error: new Error("third"),
    });

    expect(journal.getSnapshot().map((failure) => failure.message)).toEqual(["second", "third"]);
    expect(journal.getSnapshot().map((failure) => failure.code)).toEqual([
      "contribution-invoke-failed",
      "contribution-render-failed",
    ]);
    journal.clear("one");
    expect(journal.getSnapshot().map((failure) => failure.pluginId)).toEqual(["two"]);
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it("隔离订阅者异常，并保持记录返回值与清理状态稳定", () => {
    const journal = new LocalPluginFailureJournal({
      now: () => 1,
      makeId: (sequence) => `failure-${sequence}`,
    });
    const throwingListener = vi.fn(() => {
      throw new Error("listener failed");
    });
    const healthyListener = vi.fn();
    journal.subscribe(throwingListener);
    journal.subscribe(healthyListener);
    let recorded: LocalPluginFailure | undefined;

    expect(() => {
      recorded = journal.record({
        pluginId: "one",
        phase: "enable",
        code: "storage-write-failed",
        error: new Error("storage unavailable"),
      });
    }).not.toThrow();

    expect(recorded).toMatchObject({
      id: "failure-1",
      pluginId: "one",
      phase: "enable",
      code: "storage-write-failed",
      message: "storage unavailable",
    });
    expect(journal.getSnapshot()).toEqual([recorded]);
    expect(() => journal.clear("one")).not.toThrow();
    expect(journal.getSnapshot()).toEqual([]);
    expect(throwingListener).toHaveBeenCalledTimes(2);
    expect(healthyListener).toHaveBeenCalledTimes(2);
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
      failure: {
        phase: "render",
        code: "contribution-render-failed",
        message: "render failed",
      },
    });
  });
});
