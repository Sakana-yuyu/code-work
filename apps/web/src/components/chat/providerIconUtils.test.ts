import { describe, expect, it } from "vite-plus/test";

import {
  getDisplayModelName,
  getTriggerDisplayModelLabel,
  type ModelEsque,
} from "./providerIconUtils";

const model = (overrides: Partial<ModelEsque> & Pick<ModelEsque, "name">): ModelEsque => ({
  slug: "adapter-1",
  ...overrides,
});

describe("getDisplayModelName", () => {
  it("分组名是模型 ID 前缀时保持完整模型名（glm/grok/kimi 等）", () => {
    expect(getDisplayModelName(model({ name: "glm-5.3", subProvider: "GLM" }))).toBe("glm-5.3");
    expect(getDisplayModelName(model({ name: "glm-5.3-flash", subProvider: "GLM" }))).toBe(
      "glm-5.3-flash",
    );
    expect(getDisplayModelName(model({ name: "grok-4.5", subProvider: "Grok" }))).toBe("grok-4.5");
    expect(getDisplayModelName(model({ name: "grok-4.6", subProvider: "Grok" }))).toBe("grok-4.6");
    expect(getDisplayModelName(model({ name: "grok-4.5", subProvider: "grok" }))).toBe("grok-4.5");
    expect(getDisplayModelName(model({ name: "kimi_k2", subProvider: "Kimi" }))).toBe("kimi_k2");
    expect(getDisplayModelName(model({ name: "GLM 5.3", subProvider: "GLM" }))).toBe("GLM 5.3");
  });

  it("不以分组名开头的模型名原样展示", () => {
    expect(getDisplayModelName(model({ name: "composer-2.5-fast", subProvider: "Grok" }))).toBe(
      "composer-2.5-fast",
    );
    expect(getDisplayModelName(model({ name: "deepseek-chat", subProvider: "DeepSeek官方" }))).toBe(
      "deepseek-chat",
    );
    expect(getDisplayModelName(model({ name: "GLM-5.3" }))).toBe("GLM-5.3");
  });

  it("显式标签前缀仍然剥掉，避免与次行的「实例 · 分组」重复", () => {
    expect(
      getDisplayModelName(model({ name: "GitHub Copilot: GPT-4o", subProvider: "GitHub Copilot" })),
    ).toBe("GPT-4o");
    expect(
      getDisplayModelName(
        model({ name: "DeepSeek官方 · deepseek-chat", subProvider: "DeepSeek官方" }),
      ),
    ).toBe("deepseek-chat");
    expect(
      getDisplayModelName(
        model({ name: "OpenRouter/deepseek/deepseek-v4", subProvider: "OpenRouter" }),
      ),
    ).toBe("deepseek/deepseek-v4");
    expect(getDisplayModelName(model({ name: "glm: glm-5.3", subProvider: "GLM" }))).toBe(
      "glm-5.3",
    );
  });

  it("剥完为空时回退完整模型名", () => {
    expect(getDisplayModelName(model({ name: "GLM:", subProvider: "GLM" }))).toBe("GLM:");
    expect(getDisplayModelName(model({ name: "GLM:", subProvider: "glm" }))).toBe("GLM:");
  });

  it("preferShortName 时优先短名", () => {
    expect(
      getDisplayModelName(model({ name: "glm-5.3", shortName: "5.3 Flash", subProvider: "GLM" }), {
        preferShortName: true,
      }),
    ).toBe("5.3 Flash");
  });
});

describe("getTriggerDisplayModelLabel", () => {
  it("输入框胶囊标签不剥分组名前缀", () => {
    expect(getTriggerDisplayModelLabel(model({ name: "glm-5.3", subProvider: "GLM" }))).toBe(
      "glm-5.3",
    );
    expect(getTriggerDisplayModelLabel(model({ name: "grok-4.5", subProvider: "Grok" }))).toBe(
      "grok-4.5",
    );
  });

  it("有短名时优先短名", () => {
    expect(getTriggerDisplayModelLabel(model({ name: "glm-5.3", shortName: "5.3 Flash" }))).toBe(
      "5.3 Flash",
    );
  });
});
