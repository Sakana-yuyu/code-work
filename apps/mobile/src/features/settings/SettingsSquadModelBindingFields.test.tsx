import {
  createEmptyCompositionSquadDraft,
  type CompositionSquadDraft,
} from "@codework/client-runtime/composition/squad-builder";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
} from "@codework/contracts";
import type { ReactNode } from "react";
// @ts-expect-error Mobile 已依赖 react-dom，但当前包未安装 DOM 类型；此测试仅做服务端静态渲染。
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const pressables = vi.hoisted(
  () =>
    [] as Array<{
      readonly accessibilityLabel?: string;
      readonly onPress?: () => void;
    }>,
);

vi.mock("react-native", () => ({
  Pressable: ({
    accessibilityLabel,
    children,
    onPress,
  }: {
    readonly accessibilityLabel?: string;
    readonly children: ReactNode;
    readonly onPress?: () => void;
  }) => {
    pressables.push({ accessibilityLabel, onPress });
    return <button aria-label={accessibilityLabel}>{children}</button>;
  },
  View: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("../../components/AppText", () => ({
  AppText: ({ children }: { readonly children: ReactNode }) => <span>{children}</span>,
  AppTextInput: ({ value }: { readonly value?: string }) => <input readOnly value={value ?? ""} />,
}));

vi.mock("../../i18n", () => ({
  t: (key: string) => key,
}));

vi.mock("../../lib/uuid", () => ({
  uuidv4: () => "test-uuid",
}));

import { SettingsSquadBuilderForm } from "./SettingsSquadBuilderForm";
import { SettingsSquadModelBindingFields } from "./SettingsSquadModelBindingFields";

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

const validDraft = (): CompositionSquadDraft => {
  const draft = createEmptyCompositionSquadDraft();
  draft.squadId = "mobile-squad";
  draft.name = "Mobile Squad";
  draft.members[0] = { ...draft.members[0]!, agentId: "provider:byok-primary" };
  return draft;
};

describe("SettingsSquadModelBindingFields", () => {
  beforeEach(() => {
    pressables.length = 0;
  });

  it("模型漂移时保留旧快照并提供显式接受动作，且不渲染密钥", () => {
    const html = renderToStaticMarkup(
      <SettingsSquadModelBindingFields
        scope="team"
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
    expect(html).toContain("squadBuilder.modelBinding.availability.model_changed");
    expect(html).toContain("squadBuilder.modelBinding.acceptCurrentModel");
    expect(html).not.toContain("sk-never-render");
  });

  it("旧版成员模型保持原值，初次渲染不自动迁移", () => {
    const onChange = vi.fn();
    const onLegacyModelChange = vi.fn();
    const html = renderToStaticMarkup(
      <SettingsSquadModelBindingFields
        scope="member"
        providerInstances={providerInstances}
        value={null}
        legacyModel="legacy-model"
        disabled={false}
        onChange={onChange}
        onLegacyModelChange={onLegacyModelChange}
      />,
    );

    expect(html).toContain("squadBuilder.modelBinding.mode.legacy");
    expect(html).toContain('value="legacy-model"');
    expect(onChange).not.toHaveBeenCalled();
    expect(onLegacyModelChange).not.toHaveBeenCalled();
  });

  it("成员主动选择 BYOK 时生成首个稳定绑定并清空旧模型", () => {
    const onChange = vi.fn();
    const onLegacyModelChange = vi.fn();
    renderToStaticMarkup(
      <SettingsSquadModelBindingFields
        scope="member"
        providerInstances={providerInstances}
        value={null}
        legacyModel="legacy-model"
        disabled={false}
        onChange={onChange}
        onLegacyModelChange={onLegacyModelChange}
      />,
    );

    const byokOption = pressables.find(
      (pressable) => pressable.accessibilityLabel === "squadBuilder.modelBinding.mode.byok",
    );
    expect(byokOption?.onPress).toBeDefined();
    byokOption?.onPress?.();

    expect(onLegacyModelChange).toHaveBeenCalledWith("");
    expect(onChange).toHaveBeenCalledWith({
      kind: "byok",
      providerInstanceId,
      adapterId: "adapter-deepseek",
      modelId: "deepseek-chat-v2",
    });
  });

  it("Squad 表单展示团队默认与成员模型入口，不暴露供应商密钥", () => {
    const html = renderToStaticMarkup(
      <SettingsSquadBuilderForm
        variant="create"
        draft={validDraft()}
        issues={[]}
        providerInstances={providerInstances}
        pending={false}
        onDraftChange={vi.fn()}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(html).toContain("squadBuilder.modelBinding.teamTitle");
    expect(html).toContain("squadBuilder.modelBinding.teamDescription");
    expect(html).toContain("squadBuilder.modelBinding.mode.team_default");
    expect(html).not.toContain("sk-never-render");
  });

  it("表单写入结构化成员绑定时不会被旧草稿恢复自由文本模型", () => {
    const draft = validDraft();
    draft.members[0] = {
      ...draft.members[0]!,
      model: "legacy-model",
      modelBinding: null,
    };
    const onDraftChange = vi.fn();
    renderToStaticMarkup(
      <SettingsSquadBuilderForm
        variant="edit"
        draft={draft}
        issues={[]}
        providerInstances={providerInstances}
        pending={false}
        onDraftChange={onDraftChange}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const byokOptions = pressables.filter(
      (pressable) => pressable.accessibilityLabel === "squadBuilder.modelBinding.mode.byok",
    );
    expect(byokOptions).toHaveLength(2);
    byokOptions[1]?.onPress?.();

    const finalDraft = onDraftChange.mock.lastCall?.[0] as CompositionSquadDraft | undefined;
    expect(finalDraft?.members[0]).toMatchObject({
      model: "",
      modelBinding: {
        kind: "byok",
        providerInstanceId,
        adapterId: "adapter-deepseek",
        modelId: "deepseek-chat-v2",
      },
    });
  });
});
