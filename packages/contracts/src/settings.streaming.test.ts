import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_SERVER_SETTINGS,
  RESPONSE_STREAMING_MODES,
  resolveResponseStreamingMode,
  ServerSettings,
  ServerSettingsPatch,
} from "./settings.ts";
import { ServerConfig } from "./server.ts";

const decodeSettings = Schema.decodeUnknownSync(ServerSettings);
const decodePatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const encodeSettings = Schema.encodeSync(ServerSettings);
const decodeFeatures = Schema.decodeUnknownSync(
  Schema.Struct({ features: ServerConfig.fields.features }),
);

describe("回复输出模式的配置兼容", () => {
  it("未配置的新环境默认按段落输出，新字段可缺省", () => {
    expect(resolveResponseStreamingMode(DEFAULT_SERVER_SETTINGS)).toBe("paragraph");
    const settings = decodeSettings({});
    expect(settings.responseStreamingMode).toBeUndefined();
    expect(resolveResponseStreamingMode(settings)).toBe("paragraph");
    expect(decodePatch({})).not.toHaveProperty("responseStreamingMode");
  });

  it.each([
    [true, "token"],
    [false, "turn"],
  ] as const)("保留旧开关 %s 的明确选择", (legacy, mode) => {
    const settings = decodeSettings({ enableLegacyTokenStreaming: legacy });
    expect(resolveResponseStreamingMode(settings)).toBe(mode);
  });

  it.each(RESPONSE_STREAMING_MODES)("新模式 %s 优先于旧开关且能够编码往返", (mode) => {
    const settings = decodeSettings({
      responseStreamingMode: mode,
      enableLegacyTokenStreaming: true,
    });
    expect(resolveResponseStreamingMode(settings)).toBe(mode);
    const encoded = encodeSettings(settings);
    expect(resolveResponseStreamingMode(decodeSettings(encoded))).toBe(mode);
    expect(decodePatch({ responseStreamingMode: mode }).responseStreamingMode).toBe(mode);
  });

  it("拒绝无效模式", () => {
    expect(() => decodePatch({ responseStreamingMode: "line" })).toThrow();
  });

  it("旧服务端可缺省功能声明，未知功能成员不导致新客户端拒绝整个配置", () => {
    expect(decodeFeatures({})).toEqual({});
    expect(
      decodeFeatures({ features: { responseStreamingModes: true, futureFeature: true } }),
    ).toEqual({ features: { responseStreamingModes: true } });
  });
});
