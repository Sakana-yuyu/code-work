import { describe, expect, it } from "vite-plus/test";

import type { ModelCapabilities } from "@codework/contracts";

import {
  applyProviderOptionSelection,
  providerOptionValueLabels,
  resolveProviderOptionDescriptors,
} from "./providerOptions";

const CODEX_CAPABILITIES: ModelCapabilities = {
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "medium", label: "Medium", isDefault: true },
        { id: "high", label: "High" },
      ],
      currentValue: "medium",
    },
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard", isDefault: true },
        { id: "priority", label: "Fast" },
      ],
      currentValue: "default",
    },
  ],
};

describe("mobile provider options", () => {
  it("原生模式按广告显示与发送，撤回值不进入模型设置", () => {
    const capabilities: ModelCapabilities = {
      optionDescriptors: [
        {
          id: "codexCollaborationMode",
          label: "模式",
          type: "select",
          currentValue: "default",
          options: [
            { id: "default", label: "原生默认" },
            { id: "plan", label: "原生计划" },
          ],
        },
      ],
    };
    const descriptors = resolveProviderOptionDescriptors({
      capabilities,
      selections: [{ id: "codexCollaborationMode", value: "plan" }],
    });
    expect(providerOptionValueLabels(descriptors)).toEqual(["原生计划"]);
    expect(
      applyProviderOptionSelection(descriptors, { id: "codexCollaborationMode", value: "default" }),
    ).toEqual([{ id: "codexCollaborationMode", value: "default" }]);
    expect(
      applyProviderOptionSelection(descriptors, { id: "codexCollaborationMode", value: "future" }),
    ).toBeNull();
    expect(
      resolveProviderOptionDescriptors({
        capabilities: { optionDescriptors: [] },
        selections: [{ id: "codexCollaborationMode", value: "plan" }],
      }),
    ).toEqual([]);
  });
  it("summarizes the option values currently in effect", () => {
    const descriptors = resolveProviderOptionDescriptors({
      capabilities: CODEX_CAPABILITIES,
      selections: undefined,
    });

    expect(providerOptionValueLabels(descriptors)).toEqual(["Medium", "Standard"]);
  });

  it("updates generic select options without knowing provider-specific ids", () => {
    const descriptors = resolveProviderOptionDescriptors({
      capabilities: CODEX_CAPABILITIES,
      selections: undefined,
    });

    expect(
      applyProviderOptionSelection(descriptors, { id: "serviceTier", value: "priority" }),
    ).toEqual([
      { id: "reasoningEffort", value: "medium" },
      { id: "serviceTier", value: "priority" },
    ]);
    // Choices the model doesn't advertise are rejected, not stored.
    expect(
      applyProviderOptionSelection(descriptors, { id: "serviceTier", value: "turbo" }),
    ).toBeNull();
    expect(applyProviderOptionSelection(descriptors, { id: "unknown", value: "high" })).toBeNull();
  });

  it("treats an unspecified boolean capability as off", () => {
    const descriptors = resolveProviderOptionDescriptors({
      capabilities: {
        optionDescriptors: [{ id: "fastMode", label: "Fast Mode", type: "boolean" }],
      },
      selections: undefined,
    });

    expect(providerOptionValueLabels(descriptors)).toEqual([]);
    expect(applyProviderOptionSelection(descriptors, { id: "fastMode", value: true })).toEqual([
      { id: "fastMode", value: true },
    ]);
  });
});
