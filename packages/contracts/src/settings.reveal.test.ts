import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ServerSettings, ServerSettingsPatch } from "./settings.ts";
import { ServerConfig } from "./server.ts";

const decodeSettings = Schema.decodeUnknownSync(ServerSettings);
const encodeSettings = Schema.encodeSync(ServerSettings);
const decodePatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const decodeFeatures = Schema.decodeUnknownSync(
  Schema.Struct({ features: ServerConfig.fields.features }),
);

describe("文字节奏的可选合同", () => {
  it("旧设置仍解码，省略开关不生成必需字段", () => {
    const settings = decodeSettings({});
    expect(settings.responseTextPacing).toBeUndefined();
    expect(encodeSettings(settings)).not.toHaveProperty("responseTextPacing");
  });

  it.each([true, false])("保存和补丁保留 %s，其他字段不受影响", (responseTextPacing) => {
    const settings = decodeSettings({ responseTextPacing });
    expect(encodeSettings(settings)).toHaveProperty("responseTextPacing", responseTextPacing);
    expect(decodePatch({ responseTextPacing })).toEqual({
      responseTextPacing,
    });
  });

  it.each(["true", 1, null])("拒绝非法开关 %s", (responseTextPacing) => {
    expect(() => decodePatch({ responseTextPacing })).toThrow();
  });

  it("功能声明保持可选且不依赖其他新控制", () => {
    expect(decodeFeatures({})).toEqual({});
    expect(decodeFeatures({ features: { responseTextReveal: true } })).toEqual({
      features: { responseTextReveal: true },
    });
  });
});
