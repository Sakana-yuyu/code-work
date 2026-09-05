import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, type ServerProviderModel } from "@codework/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { getCurrentLanguage, setCurrentLanguage } from "~/i18n/runtime";
import { TraitsMenuContent, TraitsPicker } from "./TraitsPicker";
import { effortOptionLabel } from "./EffortSlider";

const originalLanguage = getCurrentLanguage();
beforeEach(() => setCurrentLanguage("zh-CN"));
afterEach(() => setCurrentLanguage(originalLanguage));

const model: ServerProviderModel = {
  slug: "test-model",
  name: "Test model",
  isCustom: false,
  capabilities: {
    optionDescriptors: [
      {
        id: "effort",
        label: "Effort",
        type: "select",
        options: [
          { id: "low", label: "Low" },
          { id: "high", label: "High", isDefault: true },
          { id: "xhigh", label: "Extra High" },
        ],
      },
    ],
  },
};

function render(options: { model?: ServerProviderModel; effort?: string; prompt?: string } = {}) {
  return renderToStaticMarkup(
    <TraitsMenuContent
      provider={ProviderDriverKind.make("claudeAgent")}
      models={[options.model ?? model]}
      model={model.slug}
      prompt={options.prompt ?? ""}
      modelOptions={options.effort ? [{ id: "effort", value: options.effort }] : undefined}
      onPromptChange={() => {}}
      onModelOptionsChange={() => {}}
      planModeEnabled
      compactEffort
    />,
  );
}

describe("思考强度滑条", () => {
  it("中文界面可独立选择英文或中文强度标签", () => {
    expect(render({ effort: "xhigh" })).toContain('aria-valuetext="Extra High"');
    const option = { id: "xhigh", label: "Extra High" };
    expect(effortOptionLabel(option, "zh-CN")).toBe("极高");
    setCurrentLanguage("en");
    expect(effortOptionLabel(option, "zh-CN")).toBe("极高");
    expect(effortOptionLabel(option, "en")).toBe("Extra High");
    expect(effortOptionLabel({ id: "custom", label: "Custom" }, "zh-CN")).toBe("Custom");
  });
  it("保留原生键盘步进，视觉位置与星光密度跟随强度", () => {
    const middle = render({ effort: "high" });
    expect(middle).toContain('step="1"');
    expect(middle).toContain("transform:translateX(50%)");
    expect(middle).toContain('style="opacity:0.5"');
    expect(middle).toContain('style="opacity:0.125"');
    const low = render({ effort: "low" });
    expect(low).toContain('data-stars-paused="true"');
    expect(low).toContain('style="opacity:0"');
  });

  it("下方标签与面板使用同一强度配色，不再固定为灰色", () => {
    const trigger = renderToStaticMarkup(
      <TraitsPicker
        provider={ProviderDriverKind.make("claudeAgent")}
        models={[model]}
        model={model.slug}
        prompt=""
        modelOptions={[{ id: "effort", value: "xhigh" }]}
        onPromptChange={() => {}}
        onModelOptionsChange={() => {}}
        planModeEnabled
      />,
    );
    expect(trigger).toMatch(/class="[^"]*effort-tone[^"]*" data-effort="xhigh">Extra High/);
    expect(render({ effort: "xhigh" })).toMatch(
      /class="[^"]*effort-tone[^"]*" data-effort="xhigh"/,
    );
  });

  it("按实际能力确定档位，不给不支持 Ultra 的模型虚构档位", () => {
    const markup = render({ effort: "xhigh" });
    expect(markup).toContain('type="range"');
    expect(markup).toContain('max="2"');
    expect(markup).toContain('value="2"');
    expect(markup).toContain('aria-valuetext="Extra High"');
    expect(markup).toContain('data-ultra="false"');
    expect(markup).not.toContain("aria-pressed=");
  });

  it("切换模型后丢弃不支持的旧强度并显示模型默认值", () => {
    const markup = render({ effort: "ultra" });
    expect(markup).toContain('value="1"');
    expect(markup).toContain('aria-valuetext="High"');
  });

  it("保留 Claude 正文 ultrathink 对强度的控制及提示", () => {
    const markup = render({
      model: {
        ...model,
        capabilities: {
          optionDescriptors: [
            {
              id: "effort",
              label: "Effort",
              type: "select",
              options: [
                { id: "high", label: "High", isDefault: true },
                { id: "ultrathink", label: "Ultrathink" },
              ],
              promptInjectedValues: ["ultrathink"],
            },
          ],
        },
      },
      prompt: "Please ultrathink about this problem",
    });
    expect(markup).toContain('data-disabled="true"');
    expect(markup).toContain('data-ultra="true"');
    expect(markup).toContain('aria-valuetext="Ultrathink"');
  });
});
