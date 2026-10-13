import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@codework/contracts";
import { describe, expect, it } from "vite-plus/test";
import { getProviderInteractionModeToggle } from "./providerModels.ts";

const provider = (instanceId: string, showInteractionModeToggle: boolean): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  status: "ready",
  auth: { status: "authenticated" },
  version: null,
  checkedAt: "2026-10-13T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  showInteractionModeToggle,
});

describe("实例模式控制", () => {
  for (const defaultEnabled of [true, false]) {
    it(`默认实例 ${defaultEnabled} 不覆盖当前自定义实例的相反声明`, () => {
      const builtin = provider("codex", defaultEnabled);
      const custom = provider("codex-custom", !defaultEnabled);
      expect(getProviderInteractionModeToggle([builtin, custom], custom.instanceId)).toBe(
        !defaultEnabled,
      );
      expect(getProviderInteractionModeToggle([custom, builtin], builtin.instanceId)).toBe(
        defaultEnabled,
      );
    });
  }
  it("同一实例按选中模型的原生模式广告决定，其他模型不串能力", () => {
    const entry = provider("codex-custom", true);
    const modes: ServerProvider = {
      ...entry,
      models: [
        {
          slug: "native",
          name: "原生模式",
          isCustom: false,
          capabilities: {
            optionDescriptors: [
              {
                id: "acpMode",
                label: "模式",
                type: "select",
                currentValue: "review",
                options: [{ id: "review", label: "审查" }],
              },
            ],
          },
        },
        { slug: "ordinary", name: "普通", isCustom: false, capabilities: null },
      ],
    };
    expect(getProviderInteractionModeToggle([modes], modes.instanceId, "native")).toBe(false);
    expect(getProviderInteractionModeToggle([modes], modes.instanceId, "ordinary")).toBe(true);
    expect(getProviderInteractionModeToggle([modes], ProviderInstanceId.make("missing"))).toBe(
      false,
    );
  });
});
