import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
} from "@codework/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { t } from "~/i18n";

import { CompositionSquadModelBindingPicker } from "./CompositionSquadModelBindingPicker";

const providerInstanceId = ProviderInstanceId.make("byok-primary");
const providerInstances: Readonly<Record<ProviderInstanceId, ProviderInstanceConfig>> = {
  [providerInstanceId]: {
    driver: ProviderDriverKind.make("byok"),
    displayName: "主 BYOK",
    enabled: true,
    config: {
      adapters: [
        {
          id: "adapter-deepseek",
          displayName: "DeepSeek Chat",
          modelId: "deepseek-chat-v2",
          apiKey: "sk-never-render",
        },
      ],
    },
  },
};

describe("CompositionSquadModelBindingPicker", () => {
  it("模型漂移时保留旧快照并提供显式接受动作", () => {
    const html = renderToStaticMarkup(
      <CompositionSquadModelBindingPicker
        scope="team"
        idPrefix="team-model"
        providerInstances={providerInstances}
        value={{
          kind: "byok",
          providerInstanceId,
          adapterId: "adapter-deepseek",
          modelId: "deepseek-chat-v1",
        }}
        disabled={false}
        onChange={vi.fn()}
      />,
    );

    expect(html).toContain("deepseek-chat-v1");
    expect(html).toContain(t("squadBuilder.modelBinding.availability.model_changed"));
    expect(html).toContain(t("squadBuilder.modelBinding.acceptCurrentModel"));
    expect(html).not.toContain("sk-never-render");
  });

  it("旧版成员模型保持原值，页面加载不会自动转换", () => {
    const html = renderToStaticMarkup(
      <CompositionSquadModelBindingPicker
        scope="member"
        idPrefix="member-model"
        providerInstances={providerInstances}
        value={null}
        legacyModel="legacy-model"
        disabled={false}
        onChange={vi.fn()}
        onLegacyModelChange={vi.fn()}
      />,
    );

    expect(html).toContain(t("squadBuilder.modelBinding.mode.legacy"));
    expect(html).toContain('value="legacy-model"');
  });
});
