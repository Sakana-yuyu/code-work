import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
} from "@codework/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildCompositionSquadByokProviderOptions,
  compositionSquadByokBindingAvailability,
  compositionSquadByokBindingForAdapter,
  compositionSquadByokBindingForProvider,
  firstSelectableCompositionSquadByokBinding,
} from "./CompositionSquadModelBindingPicker.logic";

const primaryId = ProviderInstanceId.make("byok-primary");
const disabledId = ProviderInstanceId.make("byok-disabled");
const byokDriver = ProviderDriverKind.make("byok");

const providerInstances: Readonly<Record<ProviderInstanceId, ProviderInstanceConfig>> = {
  [disabledId]: {
    driver: byokDriver,
    enabled: false,
    config: {
      adapters: [
        {
          id: "adapter-disabled",
          displayName: "停用模型",
          modelId: "disabled-model",
          apiKey: "disabled-secret",
        },
      ],
    },
  },
  [primaryId]: {
    driver: byokDriver,
    displayName: "主 BYOK",
    enabled: true,
    config: {
      adapters: [
        {
          id: "adapter-deepseek",
          displayName: "DeepSeek Chat",
          modelId: "deepseek-chat",
          apiKey: "sk-sensitive",
          balanceAccessToken: "balance-sensitive",
        },
        {
          id: "adapter-review",
          displayName: "Review Model",
          modelId: "review-model",
        },
      ],
    },
  },
  [ProviderInstanceId.make("codex")]: {
    driver: ProviderDriverKind.make("codex"),
    config: {},
  },
};

describe("CompositionSquadModelBindingPicker logic", () => {
  it("只投影 BYOK 稳定引用并剔除密钥", () => {
    const providers = buildCompositionSquadByokProviderOptions(providerInstances);

    expect(providers).toEqual([
      {
        providerInstanceId: disabledId,
        displayName: disabledId,
        enabled: false,
        adapters: [
          {
            adapterId: "adapter-disabled",
            displayName: "停用模型",
            modelId: "disabled-model",
          },
        ],
      },
      {
        providerInstanceId: primaryId,
        displayName: "主 BYOK",
        enabled: true,
        adapters: [
          {
            adapterId: "adapter-deepseek",
            displayName: "DeepSeek Chat",
            modelId: "deepseek-chat",
          },
          {
            adapterId: "adapter-review",
            displayName: "Review Model",
            modelId: "review-model",
          },
        ],
      },
    ]);
    expect(JSON.stringify(providers)).not.toContain("sk-sensitive");
    expect(JSON.stringify(providers)).not.toContain("balance-sensitive");
  });

  it("新选择跳过停用供应商并固定 Adapter 对应模型", () => {
    const providers = buildCompositionSquadByokProviderOptions(providerInstances);

    expect(firstSelectableCompositionSquadByokBinding(providers)).toEqual({
      kind: "byok",
      providerInstanceId: primaryId,
      adapterId: "adapter-deepseek",
      modelId: "deepseek-chat",
    });
    expect(compositionSquadByokBindingForProvider(providers, disabledId)).toBeNull();
    expect(compositionSquadByokBindingForAdapter(providers, primaryId, "adapter-review")).toEqual({
      kind: "byok",
      providerInstanceId: primaryId,
      adapterId: "adapter-review",
      modelId: "review-model",
    });
  });

  it("区分供应商停用、Adapter 缺失与模型漂移", () => {
    const providers = buildCompositionSquadByokProviderOptions(providerInstances);

    expect(
      compositionSquadByokBindingAvailability(
        {
          kind: "byok",
          providerInstanceId: disabledId,
          adapterId: "adapter-disabled",
          modelId: "disabled-model",
        },
        providers,
      ),
    ).toBe("provider_disabled");
    expect(
      compositionSquadByokBindingAvailability(
        {
          kind: "byok",
          providerInstanceId: primaryId,
          adapterId: "adapter-missing",
          modelId: "missing-model",
        },
        providers,
      ),
    ).toBe("adapter_missing");
    expect(
      compositionSquadByokBindingAvailability(
        {
          kind: "byok",
          providerInstanceId: primaryId,
          adapterId: "adapter-deepseek",
          modelId: "old-model",
        },
        providers,
      ),
    ).toBe("model_changed");
  });
});
