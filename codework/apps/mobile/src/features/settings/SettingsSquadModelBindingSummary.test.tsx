import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
} from "@codework/contracts";
import type { ReactNode } from "react";
// @ts-expect-error Mobile 已依赖 react-dom，但当前包未安装 DOM 类型；此测试仅做服务端静态渲染。
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  View: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("../../components/AppText", () => ({
  AppText: ({ children }: { readonly children: ReactNode }) => <span>{children}</span>,
}));

vi.mock("../../i18n", () => ({
  t: (key: string, params?: Readonly<Record<string, string | number>>) =>
    params === undefined ? key : `${key}:${JSON.stringify(params)}`,
}));

import { SettingsSquadModelBindingSummary } from "./SettingsSquadModelBindingSummary";

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

describe("SettingsSquadModelBindingSummary", () => {
  it("展示 BYOK 保存快照与漂移状态且不渲染密钥", () => {
    const html = renderToStaticMarkup(
      <SettingsSquadModelBindingSummary
        scope="team"
        providerInstances={providerInstances}
        binding={{
          kind: "byok",
          providerInstanceId,
          adapterId: "adapter-deepseek",
          modelId: "deepseek-chat-v1",
        }}
      />,
    );

    expect(html).toContain("主 BYOK");
    expect(html).toContain("DeepSeek Chat");
    expect(html).toContain("deepseek-chat-v1");
    expect(html).toContain("squadBuilder.modelBinding.availability.model_changed");
    expect(html).not.toContain("sk-never-render");
  });

  it("成员继承团队默认时显示继承关系", () => {
    const html = renderToStaticMarkup(
      <SettingsSquadModelBindingSummary
        scope="member"
        providerInstances={providerInstances}
        binding={{ kind: "team_default" }}
      />,
    );

    expect(html).toContain("squadBuilder.modelBinding.summary.team_default");
  });
});
