import type { LocalPluginManifest } from "@codework/contracts";
import { describe, expect, it } from "vite-plus/test";

import { LocalPluginLifecycle } from "../localPluginLifecycle";
import { LocalPluginFailureJournal } from "../localPluginFailureJournal";
import { LocalPluginRegistry } from "../localPluginRegistry";
import {
  decodeLocalPluginStorageDocument,
  type LocalPluginStorage,
  type LocalPluginStorageCompareAndSwapInput,
  type LocalPluginStorageCompareAndSwapResult,
} from "../localPluginStorage";
import { LocalPluginTimelineJournal } from "../localPluginTimelineJournal";
import type { LocalPluginTimelineStorage } from "../localPluginTimelineStorage";
import {
  createLocalPluginTimelinePostPort,
  listEnabledLocalPluginTimelineEntries,
} from "./localPluginTimelineAdapter";

class MemoryStorage implements LocalPluginStorage, LocalPluginTimelineStorage {
  value: string | null = null;

  read(): string | null {
    return this.value;
  }

  write(value: string): void {
    this.value = value;
  }

  async compareAndSwap(
    input: LocalPluginStorageCompareAndSwapInput,
  ): Promise<LocalPluginStorageCompareAndSwapResult> {
    const revision =
      this.value === null ? 0 : (decodeLocalPluginStorageDocument(this.value).revision ?? 0);
    if (this.value !== input.expectedValue || revision !== input.expectedRevision) {
      return { swapped: false, currentValue: this.value };
    }
    this.write(input.nextValue);
    return { swapped: true, currentValue: this.value };
  }
}

const manifest = (id: string): LocalPluginManifest => ({
  manifestVersion: 1,
  apiVersion: { major: 1, minor: 0 },
  id,
  name: `插件 ${id}`,
  version: "1.0.0",
  permissions: ["timeline.write"],
  contributions: {
    timeline: [{ id: "checks", title: "检查结果", tone: "success" }],
    commands: [
      {
        id: "post",
        title: "记录检查",
        action: { type: "timeline.post", timelineId: "checks", message: "完成" },
      },
    ],
  },
});

function createHarness() {
  const registry = new LocalPluginRegistry();
  const failures = new LocalPluginFailureJournal({
    now: () => 1,
    makeId: (sequence) => `failure-${sequence}`,
  });
  const lifecycle = new LocalPluginLifecycle({
    registry,
    failures,
    storage: new MemoryStorage(),
    now: () => 1,
  });
  const timeline = new LocalPluginTimelineJournal({
    storage: new MemoryStorage(),
    now: () => Date.parse("2026-08-30T04:00:00.000Z"),
    makeId: (sequence) => `event-${sequence}`,
  });
  return { registry, lifecycle, timeline };
}

describe("localPluginTimelineAdapter", () => {
  it("把已启用插件的事件投影为当前线程的独立 Timeline 条目", async () => {
    const harness = createHarness();
    await harness.lifecycle.install(manifest("acme.enabled"));
    await harness.lifecycle.install(manifest("acme.disabled"));
    const post = createLocalPluginTimelinePostPort({
      registry: harness.registry,
      journal: harness.timeline,
      threadKey: "environment:thread-1",
    });

    await post("acme.enabled", "checks", "启用插件事件");
    await post("acme.disabled", "checks", "禁用前事件");
    await harness.lifecycle.disable("acme.disabled");

    expect(
      listEnabledLocalPluginTimelineEntries({
        registry: harness.registry,
        journal: harness.timeline,
        threadKey: "environment:thread-1",
      }),
    ).toEqual([
      {
        id: "local-plugin-timeline:event-1",
        pluginId: "acme.enabled",
        pluginName: "插件 acme.enabled",
        contributionId: "checks",
        title: "检查结果",
        message: "启用插件事件",
        tone: "success",
        createdAt: "2026-08-30T04:00:00.000Z",
      },
    ]);

    await harness.lifecycle.enable("acme.disabled");
    expect(
      listEnabledLocalPluginTimelineEntries({
        registry: harness.registry,
        journal: harness.timeline,
        threadKey: "environment:thread-1",
      }).map((entry) => entry.message),
    ).toEqual(["启用插件事件", "禁用前事件"]);
  });

  it("写入时重新检查启用状态、权限与 contribution", async () => {
    const harness = createHarness();
    await harness.lifecycle.install(manifest("acme.timeline"));
    const stalePost = createLocalPluginTimelinePostPort({
      registry: harness.registry,
      journal: harness.timeline,
      threadKey: "environment:thread-1",
    });

    await harness.lifecycle.disable("acme.timeline");
    await expect(stalePost("acme.timeline", "checks", "不会写入")).rejects.toThrow("插件已禁用");

    harness.registry.replace([
      {
        manifest: { ...manifest("acme.no-permission"), permissions: [] },
        enabled: true,
        installedAtUnixMs: 1,
        updatedAtUnixMs: 1,
      },
    ]);
    await expect(stalePost("acme.no-permission", "checks", "不会写入")).rejects.toThrow(
      "timeline.write",
    );

    harness.registry.replace([
      {
        manifest: { ...manifest("acme.missing"), contributions: {} },
        enabled: true,
        installedAtUnixMs: 1,
        updatedAtUnixMs: 1,
      },
    ]);
    await expect(stalePost("acme.missing", "checks", "不会写入")).rejects.toThrow(
      "Timeline 贡献不存在",
    );
    expect(harness.timeline.getSnapshot().events).toEqual([]);
  });
});
