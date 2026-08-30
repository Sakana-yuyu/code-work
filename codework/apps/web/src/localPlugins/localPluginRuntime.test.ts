import type { LocalPluginManifest } from "@codework/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { createLocalPluginRuntime } from "./localPluginRuntime";
import type { LocalPluginStorage, StoredLocalPlugin } from "./localPluginStorage";

const storedPlugin = (id: string): StoredLocalPlugin => ({
  manifest: {
    manifestVersion: 1,
    apiVersion: { major: 1, minor: 0 },
    id,
    name: id,
    version: "1.0.0",
    permissions: [],
    contributions: {},
  } satisfies LocalPluginManifest,
  enabled: true,
  installedAtUnixMs: 1,
  updatedAtUnixMs: 1,
});

class MemoryStorage implements LocalPluginStorage {
  constructor(public value: string | null) {}
  readonly write = vi.fn((value: string) => {
    this.value = value;
  });

  read(): string | null {
    return this.value;
  }
}

describe("createLocalPluginRuntime", () => {
  it("保留冷启动恢复结果，并记录可供设置页展示的全局失败", () => {
    const duplicate = storedPlugin("acme.duplicate");
    const storage = new MemoryStorage(
      JSON.stringify({ version: 1, plugins: [duplicate, duplicate] }),
    );

    const runtime = createLocalPluginRuntime({ storage, now: () => 1 });

    expect(runtime.restoreResult).toMatchObject({
      ok: false,
      error: { code: "storage-duplicate-id" },
    });
    expect(runtime.failures.getSnapshot()).toEqual([
      expect.objectContaining({ pluginId: "unknown-plugin", phase: "restore" }),
    ]);
    expect(runtime.registry.getSnapshot().plugins).toEqual([]);
    expect(storage.write).not.toHaveBeenCalled();
  });
});
