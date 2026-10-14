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
import {
  applySessionModelCatalogs,
  hasSessionModelCatalog,
  canUseProviderInteractionModes,
  resolveProviderInteractionMode,
  resolveCodexPlanFollowUpSelection,
  startedSessionModelChangeGate,
} from "./providerModels.ts";
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
  it("最新有效模型快照决定撤回，空数组生效而null清除覆盖", () => {
    const snapshot = row({ providerInstanceId: "a", models: [] });
    expect(hasSessionModelCatalog([snapshot], provider.instanceId)).toBe(true);
    expect(
      hasSessionModelCatalog(
        [snapshot, row({ providerInstanceId: "a", models: null })],
        provider.instanceId,
      ),
    ).toBe(false);
    expect(
      hasSessionModelCatalog(
        [snapshot, row({ providerInstanceId: "a", models: "invalid" })],
        provider.instanceId,
      ),
    ).toBe(true);
    expect(
      hasSessionModelCatalog(
        [snapshot, row({ providerInstanceId: "b", models: null })],
        provider.instanceId,
      ),
    ).toBe(true);
  });

  it("仅模式或配置更新不能作为模型目录撤回依据", () => {
    expect(
      hasSessionModelCatalog(
        [
          { ...row({ providerInstanceId: "a", mode: null }), kind: "session.mode.updated" },
          {
            ...row({ providerInstanceId: "a", configOptions: [] }),
            kind: "session.config-options.updated",
          },
          row({ providerInstanceId: "b", models: [] }),
          row({ providerInstanceId: "a", models: [{}] }),
        ],
        provider.instanceId,
      ),
    ).toBe(false);
  });

  it("Codex原生选择同步规范模式，实施计划明确改为default，未知广告拒绝", () => {
    const current = {
      ...provider,
      driver: ProviderDriverKind.make("codex"),
      showInteractionModeToggle: false,
    };
    const capabilities = {
      optionDescriptors: [
        {
          id: "codexCollaborationMode",
          label: "模式",
          type: "select" as const,
          currentValue: "default",
          options: [
            { id: "plan", label: "计划" },
            { id: "default", label: "默认" },
          ],
        },
      ],
    };
    const selection = {
      instanceId: current.instanceId,
      model: "new",
      options: [{ id: "codexCollaborationMode", value: "plan" }],
    };
    expect(
      resolveProviderInteractionMode({
        providers: [current],
        instanceId: current.instanceId,
        capabilities,
        interactionMode: "default",
        modelSelection: selection,
      }),
    ).toBe("plan");
    const implementation = resolveCodexPlanFollowUpSelection(selection, capabilities, "default");
    expect(implementation?.options).toEqual([{ id: "codexCollaborationMode", value: "default" }]);
    expect(
      resolveProviderInteractionMode({
        providers: [current],
        instanceId: current.instanceId,
        capabilities,
        interactionMode: "plan",
        ...(implementation ? { modelSelection: implementation } : {}),
      }),
    ).toBe("default");
    expect(
      resolveCodexPlanFollowUpSelection(selection, { optionDescriptors: [] }, "plan"),
    ).toBeNull();
    expect(
      resolveCodexPlanFollowUpSelection(selection, { optionDescriptors: [] }, "default")?.options,
    ).toEqual([]);
    expect(
      resolveCodexPlanFollowUpSelection(
        selection,
        {
          optionDescriptors: [
            { ...capabilities.optionDescriptors[0]!, options: [{ id: "plan", label: "计划" }] },
          ],
        },
        "default",
      ),
    ).toBeNull();
  });
  it("OpenCode 原生 agent 目录独立控制模式，不与旧两态推断重复", () => {
    const current = {
      ...provider,
      driver: ProviderDriverKind.make("opencode"),
      showInteractionModeToggle: true,
    };
    const capabilities = {
      optionDescriptors: [
        {
          id: "agent",
          label: "Agent",
          type: "select" as const,
          currentValue: "plan",
          options: [
            { id: "build", label: "Build" },
            { id: "plan", label: "Plan" },
          ],
        },
      ],
    };
    expect(canUseProviderInteractionModes([current], current.instanceId, capabilities)).toBe(false);
    expect(
      resolveProviderInteractionMode({
        providers: [current],
        instanceId: current.instanceId,
        capabilities,
        interactionMode: "plan",
      }),
    ).toBe("default");
    expect(
      buildProviderOptionSelectionsFromDescriptors(
        getProviderOptionDescriptors({
          caps: capabilities,
          selections: [{ id: "agent", value: "plan" }],
        }),
      ),
    ).toEqual([{ id: "agent", value: "plan" }]);
    expect(canUseProviderInteractionModes([current], current.instanceId, null)).toBe(true);
    expect(canUseProviderInteractionModes([provider], provider.instanceId, capabilities)).toBe(
      true,
    );
  });
  it("两态能力按当前实例隔离，缺省声明兼容但缺失实例不显示控制", () => {
    const disabled = { ...provider, showInteractionModeToggle: false };
    const allowed = {
      ...provider,
      instanceId: ProviderInstanceId.make("b"),
      showInteractionModeToggle: true,
    };
    for (const providers of [
      [disabled, allowed],
      [allowed, disabled],
    ]) {
      expect(canUseProviderInteractionModes(providers, disabled.instanceId)).toBe(false);
      expect(canUseProviderInteractionModes(providers, allowed.instanceId)).toBe(true);
      expect(
        resolveProviderInteractionMode({
          providers,
          instanceId: disabled.instanceId,
          interactionMode: "plan",
        }),
      ).toBe("default");
      expect(
        resolveProviderInteractionMode({
          providers,
          instanceId: allowed.instanceId,
          interactionMode: "plan",
        }),
      ).toBe("plan");
    }
    expect(canUseProviderInteractionModes([provider], provider.instanceId)).toBe(true);
    expect(canUseProviderInteractionModes([allowed], provider.instanceId)).toBe(false);
    expect(
      resolveProviderInteractionMode({
        providers: [],
        instanceId: provider.instanceId,
        interactionMode: "plan",
      }),
    ).toBe("plan");
  });
  it("原生模式广告关闭两态推断，撤回广告后恢复实例声明并保留原始 ID", () => {
    const mode: SelectProviderOptionDescriptor = {
      id: ACP_MODE_OPTION_ID,
      label: "模式",
      type: "select",
      currentValue: "review",
      options: [{ id: "review", label: "审查" }],
    };
    const original = { ...provider, models: [model], showInteractionModeToggle: true };
    const activity = {
      ...row({ providerInstanceId: provider.instanceId, mode }),
      kind: "session.mode.updated",
    };
    const active = applySessionModelCatalogs([original], [activity]);
    expect(
      canUseProviderInteractionModes(
        active,
        provider.instanceId,
        active[0]!.models[0]!.capabilities,
      ),
    ).toBe(false);
    expect(
      resolveProviderInteractionMode({
        providers: active,
        instanceId: provider.instanceId,
        capabilities: active[0]!.models[0]!.capabilities,
        interactionMode: "plan",
      }),
    ).toBe("default");
    expect(active[0]!.models[0]!.capabilities!.optionDescriptors![0]!.id).toBe(ACP_MODE_OPTION_ID);
    const withdrawn = applySessionModelCatalogs(
      [original],
      [activity, { ...activity, payload: { providerInstanceId: provider.instanceId, mode: null } }],
    );
    expect(
      canUseProviderInteractionModes(
        withdrawn,
        provider.instanceId,
        withdrawn[0]!.models[0]!.capabilities,
      ),
    ).toBe(true);
  });
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
          caps: resolved.capabilities!,
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

  it("三个会话目录覆盖所有实例后停止读取更早活动", () => {
    let olderReads = 0;
    const older = new Proxy(row({ providerInstanceId: "a", models: [] }), {
      get(target, key) {
        olderReads += 1;
        return Reflect.get(target, key);
      },
    });
    const history = [
      older,
      row({ providerInstanceId: "a", models: [model] }),
      { ...row({ providerInstanceId: "a", mode: null }), kind: "session.mode.updated" },
      {
        ...row({ providerInstanceId: "a", configOptions: [] }),
        kind: "session.config-options.updated",
      },
    ];
    expect(applySessionModelCatalogs([provider], history)[0]?.models).toEqual([
      { ...model, capabilities: { optionDescriptors: [] } },
    ]);
    expect(olderReads).toBe(0);
  });
});

describe("startedSessionModelChangeGate", () => {
  const base = {
    currentModelSelection: { instanceId: ProviderInstanceId.make("a"), model: "m1" },
    nextModelSelection: { instanceId: ProviderInstanceId.make("a"), model: "m2" },
  };

  it("未开始的会话不需要门控", () => {
    expect(
      startedSessionModelChangeGate({
        providers: [{ ...provider, sessionModelSwitch: "restart-continue" }],
        hasStartedSession: false,
        ...base,
      }),
    ).toBeNull();
  });

  it("restart-continue 实例的异模型切换需要确认", () => {
    expect(
      startedSessionModelChangeGate({
        providers: [{ ...provider, sessionModelSwitch: "restart-continue" }],
        hasStartedSession: true,
        ...base,
      }),
    ).toBe("confirm-restart");
  });

  it("requiresNewThreadForModelChange 优先于重启续接确认", () => {
    expect(
      startedSessionModelChangeGate({
        providers: [
          {
            ...provider,
            requiresNewThreadForModelChange: true,
            sessionModelSwitch: "restart-continue",
          },
        ],
        hasStartedSession: true,
        ...base,
      }),
    ).toBe("blocked");
  });

  it("in-session 或缺省声明不需要确认；同模型与跨实例切换不触发", () => {
    expect(
      startedSessionModelChangeGate({
        providers: [provider],
        hasStartedSession: true,
        ...base,
      }),
    ).toBeNull();
    expect(
      startedSessionModelChangeGate({
        providers: [{ ...provider, sessionModelSwitch: "restart-continue" }],
        hasStartedSession: true,
        ...base,
        nextModelSelection: { instanceId: ProviderInstanceId.make("a"), model: "m1" },
      }),
    ).toBeNull();
    expect(
      startedSessionModelChangeGate({
        providers: [
          { ...provider, sessionModelSwitch: "restart-continue" },
          {
            ...provider,
            instanceId: ProviderInstanceId.make("b"),
            sessionModelSwitch: "restart-continue",
          },
        ],
        hasStartedSession: true,
        ...base,
        nextModelSelection: { instanceId: ProviderInstanceId.make("b"), model: "m2" },
      }),
    ).toBeNull();
  });
});
