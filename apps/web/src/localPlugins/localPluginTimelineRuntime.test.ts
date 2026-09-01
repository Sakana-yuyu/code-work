import { describe, expect, it } from "vite-plus/test";

import { LocalPluginFailureJournal } from "./localPluginFailureJournal";
import { createLocalPluginTimelineRuntime } from "./localPluginTimelineRuntime";
import type { LocalPluginTimelineStorage } from "./localPluginTimelineStorage";

describe("createLocalPluginTimelineRuntime", () => {
  it("隔离损坏的持久化数据，并把恢复失败写入插件 journal", () => {
    const failures = new LocalPluginFailureJournal({
      now: () => 1,
      makeId: (sequence) => `failure-${sequence}`,
    });
    const storage: LocalPluginTimelineStorage = {
      read: () => '{"version":2,"events":[]}',
      write: () => undefined,
    };

    const timeline = createLocalPluginTimelineRuntime({
      storage,
      failures,
      now: () => 1,
      makeId: (sequence) => `event-${sequence}`,
    });

    expect(timeline.getSnapshot()).toEqual({ events: [] });
    expect(failures.getSnapshot()).toMatchObject([
      {
        pluginId: "local-plugin-timeline",
        phase: "restore",
        contributionKind: "timeline",
      },
    ]);
  });
});
