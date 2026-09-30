import { describe, expect, it } from "vite-plus/test";
import {
  ACP_MODE_OPTION_ID,
  type SelectProviderOptionDescriptor,
  ProviderDriverKind,
  EventId,
  ProviderInstanceId,
  type OrchestrationThreadActivity,
  type ServerProvider,
  type ServerProviderModel,
} from "@codework/contracts";
import { applySessionModelCatalogs } from "./providerModels.ts";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionDescriptors,
} from "@codework/shared/model";

const model: ServerProviderModel = {
  slug: "new",
  name: "新模型",
  isCustom: false,
  capabilities: null,
};
const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("a"),
  driver: ProviderDriverKind.make("acpAgent"),
  enabled: true,
  installed: true,
  auth: { status: "authenticated", type: "none" },
  status: "ready",
  version: null,
  checkedAt: "2026-09-30T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};
const row = (payload: unknown): OrchestrationThreadActivity => ({
  id: EventId.make("models"),
  kind: "session.models.updated",
  tone: "info",
  summary: "模型",
  createdAt: "2026-09-30T00:00:00.000Z",
  turnId: null,
  payload,
});

describe("会话模型目录", () => {
  it("角色与权限保留空默认值编码，隔离实例并支持撤回，不覆盖模式", () => {
    const descriptor: SelectProviderOptionDescriptor = {
      id: "acpConfig:agent",
      label: "Agent",
      type: "select",
      currentValue: "value:",
      options: [
        { id: "value:", label: "Copilot" },
        { id: "value:reviewer", label: "审查角色" },
      ],
    };
    const original = { ...provider, models: [model] };
    const other = { ...original, instanceId: ProviderInstanceId.make("b") };
    const activity = {
      ...row({ providerInstanceId: "a", configOptions: [descriptor] }),
      kind: "session.config-options.updated",
    };
    const [result, isolated] = applySessionModelCatalogs([original, other], [activity]);
    expect(isolated).toBe(other);
    expect(result?.models[0]?.capabilities?.optionDescriptors).toEqual([descriptor]);
    expect(
      buildProviderOptionSelectionsFromDescriptors(
        getProviderOptionDescriptors({
          caps: result!.models[0]!.capabilities!,
          selections: [{ id: "acpConfig:agent", value: "value:removed" }],
        }),
      ),
    ).toEqual([{ id: "acpConfig:agent", value: "value:" }]);
    expect(
      applySessionModelCatalogs(
        [original],
        [activity, { ...activity, payload: { providerInstanceId: "a", configOptions: [] } }],
      )[0]?.models[0]?.capabilities?.optionDescriptors,
    ).toEqual([]);
    expect(
      applySessionModelCatalogs(
        [original],
        [activity, { ...activity, payload: { providerInstanceId: "a", configOptions: "bad" } }],
      )[0],
    ).toEqual(result);
  });
  it("模式合并静态、动态和自定义模型，原始 URI 可提交，撤回与坏快照不串实例", () => {
    const uri = "https://agentclientprotocol.com/protocol/session-modes#review";
    const mode: SelectProviderOptionDescriptor = {
      id: ACP_MODE_OPTION_ID,
      type: "select",
      label: "Agent 模式",
      currentValue: uri,
      options: [
        { id: uri, label: "审查" },
        { id: "code", label: "实施" },
      ],
    };
    const original = { ...provider, models: [model, { ...model, slug: "custom", isCustom: true }] };
    const activity = { ...row({ providerInstanceId: "a", mode }), kind: "session.mode.updated" };
    const other = { ...original, instanceId: ProviderInstanceId.make("b") };
    for (const history of [
      [activity],
      [row({ providerInstanceId: "a", models: [model] }), activity],
    ]) {
      const [result, isolated] = applySessionModelCatalogs([original, other], history);
      expect(isolated).toBe(other);
      expect(result?.models).toHaveLength(2);
      for (const resolved of result!.models) {
        const descriptors = getProviderOptionDescriptors({
          caps: resolved.capabilities,
          selections: [{ id: ACP_MODE_OPTION_ID, value: "removed" }],
        });
        expect(descriptors).toEqual([mode]);
        expect(buildProviderOptionSelectionsFromDescriptors(descriptors)).toEqual([
          { id: ACP_MODE_OPTION_ID, value: uri },
        ]);
      }
      expect(
        applySessionModelCatalogs(
          [original],
          [...history, { ...activity, payload: { providerInstanceId: "a", mode: "bad" } }],
        )[0]?.models,
      ).toEqual(result?.models);
      expect(
        applySessionModelCatalogs(
          [original],
          [...history, { ...activity, payload: { providerInstanceId: "a", mode: null } }],
        )[0]?.models.map((model) => model.capabilities?.optionDescriptors),
      ).toEqual([[], []]);
    }
  });
  it("相同模型保留已知能力，广告仍决定名称与候选列表", () => {
    const capabilities = { optionDescriptors: [] };
    const original = { ...provider, models: [{ ...model, name: "旧名称", capabilities }] };
    const result = applySessionModelCatalogs(
      [original],
      [row({ providerInstanceId: "a", models: [model] })],
    );
    expect(result[0]?.models[0]).toEqual({ ...model, capabilities });
  });
  it("撤回广告不删除用户显式配置的自定义模型", () => {
    const custom = { ...model, slug: "custom", isCustom: true };
    const original = { ...provider, models: [model, custom] };
    expect(
      applySessionModelCatalogs([original], [row({ providerInstanceId: "a", models: [] })])[0]
        ?.models,
    ).toEqual([custom]);
  });
  it("实例隔离且不修改全局目录，最近合法快照优先", () => {
    const other = { ...provider, instanceId: ProviderInstanceId.make("b") };
    const result = applySessionModelCatalogs(
      [provider, other],
      [
        row({ providerInstanceId: "a", models: [model] }),
        row({ providerInstanceId: "a", models: "bad" }),
      ],
    );
    expect(result[0]?.models).toEqual([model]);
    expect(result[1]).toBe(other);
    expect(provider.models).toEqual([]);
  });
  it("空列表撤回，null 重置到原始目录而不恢复旧快照", () => {
    const original = { ...provider, models: [{ ...model, slug: "configured" }] };
    const history = [row({ providerInstanceId: "a", models: [model] })];
    expect(
      applySessionModelCatalogs(
        [original],
        [...history, row({ providerInstanceId: "a", models: [] })],
      )[0]?.models,
    ).toEqual([]);
    expect(
      applySessionModelCatalogs(
        [original],
        [...history, row({ providerInstanceId: "a", models: null })],
      )[0],
    ).toBe(original);
  });
});
