import { describe, expect, it } from "vite-plus/test";
import {
  capabilityChanged,
  IDE_RELOAD_LIMIT,
  planSessionReload,
  proxyOriginFromBaseUrl,
  type ReloadHistoryStore,
} from "./sessionWatchdog";

function memoryStore(
  initial: string | null = null,
): ReloadHistoryStore & { dump(): string | null } {
  let value = initial;
  return {
    getItem: (key) => (key === "codework.ideReloads" ? value : null),
    setItem: (key, next) => {
      if (key === "codework.ideReloads") value = next;
    },
    dump: () => value,
  };
}

describe("会话重绑定判定", () => {
  it("仅当两侧 capability 实际不同时要求重载", () => {
    expect(capabilityChanged("/api/ide/a", "/api/ide/a/")).toBe(false);
    expect(capabilityChanged(null, "/api/ide/a")).toBe(false);
    expect(capabilityChanged("/api/ide/a", null)).toBe(false);
    expect(capabilityChanged("/api/ide/aaaa", "/api/ide/bbbb")).toBe(true);
  });
});

describe("环境代理 origin 解析", () => {
  it("远程环境使用其自身 origin，主环境回落页面 origin", () => {
    const pageOrigin = "http://localhost:5735";
    expect(proxyOriginFromBaseUrl("http://localhost:5736", pageOrigin)).toBe(
      "http://localhost:5736",
    );
    expect(proxyOriginFromBaseUrl("https://ide.example.net:8443/sub", pageOrigin)).toBe(
      "https://ide.example.net:8443",
    );
    // Relative base URL: the environment is served by this very page origin.
    expect(proxyOriginFromBaseUrl(null, pageOrigin)).toBe(pageOrigin);
    expect(proxyOriginFromBaseUrl("not a url", pageOrigin)).toBe(pageOrigin);
  });
});

describe("受控重载限额", () => {
  it("窗口内放行前几次并在达到上限后暂停", () => {
    const store = memoryStore();
    const start = 1_000_000;
    for (let attempt = 0; attempt < IDE_RELOAD_LIMIT; attempt += 1) {
      expect(planSessionReload(store, start + attempt)).toBe(true);
    }
    // Same window: the limit holds and nothing is written.
    expect(planSessionReload(store, start + 60_000)).toBe(false);
    expect(store.dump()).toBe(JSON.stringify([start, start + 1, start + 2]));
    // Old entries age out of the window and recovery resumes.
    expect(planSessionReload(store, start + 11 * 60_000)).toBe(true);
  });

  it("忽略损坏的历史记录", () => {
    const store = memoryStore("not-json{");
    expect(planSessionReload(store, 5)).toBe(true);
    expect(store.dump()).toBe(JSON.stringify([5]));
  });
});
