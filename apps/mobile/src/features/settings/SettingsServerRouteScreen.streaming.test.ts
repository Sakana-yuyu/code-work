import { RESPONSE_STREAMING_MODES } from "@codework/contracts";
import { describe, expect, it } from "vite-plus/test";
import { responseStreamingModePatch } from "./SettingsServerRouteScreen.logic";

describe("手机回复输出模式的能力门控", () => {
  it.each(RESPONSE_STREAMING_MODES)("支持该功能的环境保存 %s 单一设置", (mode) => {
    expect(
      responseStreamingModePatch(mode, { features: { responseStreamingModes: true } }),
    ).toEqual({ responseStreamingMode: mode });
  });

  it.each([null, {}, { features: {} }, { features: { responseStreamingModes: false } }])(
    "没有能力声明的环境不发送新字段 %j",
    (config) => {
      expect(responseStreamingModePatch("paragraph", config)).toBeUndefined();
    },
  );
});
