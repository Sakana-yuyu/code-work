import { DEFAULT_SERVER_SETTINGS, resolveResponseStreamingMode } from "@codework/contracts";
import { describe, expect, it } from "vite-plus/test";
import { applyServerSettingsPatch } from "./serverSettings.ts";

describe("新旧客户端交替修改回复输出模式", () => {
  it("其它设置补丁不会把默认段落输出变成遗留模式", () => {
    const next = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      enableProviderUpdateChecks: false,
    });
    expect(resolveResponseStreamingMode(next)).toBe("paragraph");
  });

  it("旧客户端开关能够覆盖之前保存的新模式", () => {
    const paragraph = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      responseStreamingMode: "paragraph",
    });
    const token = applyServerSettingsPatch(paragraph, { enableLegacyTokenStreaming: true });
    expect(resolveResponseStreamingMode(token)).toBe("token");
    const turn = applyServerSettingsPatch(token, { enableLegacyTokenStreaming: false });
    expect(resolveResponseStreamingMode(turn)).toBe("turn");
  });

  it("新模式优先并同步旧开关，支持恢复默认", () => {
    const token = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      responseStreamingMode: "token",
    });
    expect(token.enableLegacyTokenStreaming).toBe(true);
    const paragraph = applyServerSettingsPatch(token, {
      responseStreamingMode: "paragraph",
      enableLegacyTokenStreaming: true,
    });
    expect(resolveResponseStreamingMode(paragraph)).toBe("paragraph");
    expect(paragraph.enableLegacyTokenStreaming).toBe(false);
  });
});
