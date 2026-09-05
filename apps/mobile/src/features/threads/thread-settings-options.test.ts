import type { ProviderOptionDescriptor } from "@codework/contracts";
import { describe, expect, it } from "vite-plus/test";

import { providerOptionDisplayLabel, selectableChoices } from "./thread-settings-options";

const effortDescriptor: Extract<ProviderOptionDescriptor, { type: "select" }> = {
  id: "effort",
  label: "Reasoning",
  type: "select",
  options: [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium", isDefault: true },
    { id: "high", label: "High" },
    { id: "ultrathink", label: "Ultrathink" },
    { id: "ultracode", label: "Ultracode" },
  ],
  currentValue: "high",
  promptInjectedValues: ["ultrathink"],
};

describe("selectableChoices", () => {
  it("按本机偏好翻译强度，保留未知选项和其他模型参数的名称", () => {
    expect(providerOptionDisplayLabel(effortDescriptor)).toBe("High");
    expect(providerOptionDisplayLabel(effortDescriptor, "zh-CN")).toBe("高");
    expect(providerOptionDisplayLabel(effortDescriptor, "zh-CN", "low")).toBe("轻度");
    expect(providerOptionDisplayLabel(effortDescriptor, "zh-CN", "ultrathink")).toBe("Ultrathink");
    expect(
      providerOptionDisplayLabel({ ...effortDescriptor, id: "reasoningEffort" }, "zh-CN"),
    ).toBe("高");
    expect(providerOptionDisplayLabel({ ...effortDescriptor, id: "serviceTier" }, "zh-CN")).toBe(
      "High",
    );
    expect(effortDescriptor.currentValue).toBe("high");
  });
  it("hides prompt-injected and workflow-trigger choices, keeping declared order", () => {
    expect(selectableChoices(effortDescriptor).map((choice) => choice.id)).toEqual([
      "low",
      "medium",
      "high",
    ]);
  });
});
