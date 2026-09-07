// @effect-diagnostics globalDate:off - 冷却断言对照墙上时间。
import { describe, expect, it } from "vite-plus/test";
import { createLocalPoolUsageStore, parseLocalPoolUsageState } from "./LocalPoolUsage.ts";

describe("LocalPoolUsage", () => {
  it("记录请求成败与 token，并按请求数排序", () => {
    const store = createLocalPoolUsageStore();
    store.recordRequest("a", "codex", true);
    store.recordRequest("a", "codex", false);
    store.recordTokens("a", 100, 20);
    store.recordRequest("b", "claude", true);
    store.recordRequest("b", "claude", true);
    store.recordRequest("b", "claude", true);
    const list = store.list();
    expect(list.map((entry) => entry.id)).toEqual(["b", "a"]);
    expect(list[1]).toMatchObject({ requests: 2, failed: 1, inputTokens: 100, outputTokens: 20 });
    expect(list[1]?.lastUsedAt).toBeTruthy();
  });
  it("takeDirtySnapshot 只在有变更时返回，序列化可往返", () => {
    const store = createLocalPoolUsageStore();
    expect(store.takeDirtySnapshot()).toBeUndefined();
    store.recordRequest("a", "codex", true);
    const snapshot = store.takeDirtySnapshot();
    expect(snapshot?.accounts.a?.requests).toBe(1);
    expect(store.takeDirtySnapshot()).toBeUndefined();
    const restored = createLocalPoolUsageStore();
    restored.hydrate(parseLocalPoolUsageState(JSON.stringify(snapshot))!);
    expect(restored.list()[0]).toMatchObject({ id: "a", provider: "codex", requests: 1 });
  });
  it("水合按最大值合并，不覆盖启动后的新增记录", () => {
    const store = createLocalPoolUsageStore();
    store.recordRequest("a", "codex", true);
    store.hydrate({
      version: 1,
      accounts: {
        a: {
          provider: "codex",
          requests: 5,
          failed: 1,
          inputTokens: 50,
          outputTokens: 5,
          lastUsedAt: "2026-09-05T00:00:00.000Z",
        },
      },
    });
    expect(store.list()[0]).toMatchObject({ requests: 5, failed: 1, inputTokens: 50 });
  });
  it("parseLocalPoolUsageState 拒绝非对象 JSON", () => {
    expect(parseLocalPoolUsageState("not json")).toBeUndefined();
    expect(parseLocalPoolUsageState("[1]")).toBeUndefined();
    expect(parseLocalPoolUsageState('{"accounts":[]}')).toBeUndefined();
  });
  it("setCooldown 记录并清除冷却，快照可跨存储往返", () => {
    const store = createLocalPoolUsageStore();
    store.setCooldown("fresh", Date.now() + 60_000);
    expect(store.cooldownUntilUnixMs("fresh")).toBeGreaterThan(Date.now());
    // 冷却先于首次请求到达时也建最小条目，冷却随落盘恢复。
    expect(store.list()[0]).toMatchObject({ id: "fresh", requests: 0, provider: "" });
    const snapshot = store.takeDirtySnapshot();
    const restored = createLocalPoolUsageStore();
    restored.hydrate(parseLocalPoolUsageState(JSON.stringify(snapshot))!);
    expect(restored.cooldownUntilUnixMs("fresh")).toBe(store.cooldownUntilUnixMs("fresh"));
    store.setCooldown("fresh", null);
    expect(store.cooldownUntilUnixMs("fresh") ?? 0).toBeLessThanOrEqual(0);
  });
});
