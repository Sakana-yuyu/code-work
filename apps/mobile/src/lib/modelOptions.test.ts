import { describe, expect, it } from "vite-plus/test";

import {
  ProviderInstanceId,
  EventId,
  type ServerConfig,
  type OrchestrationThreadActivity,
} from "@codework/contracts";

import {
  buildModelOptions,
  groupByProvider,
  getThreadProviderGroups,
  resolveDefaultableModelSelection,
  resolveSelectableModelSelection,
  resolveModelInteractionSettings,
  resolveThreadModelOption,
} from "./modelOptions";

describe("当前线程模型目录", () => {
  const instanceId = ProviderInstanceId.make("acp-test");
  const uri = "https://agentclientprotocol.com/protocol/session-modes#review";
  const selection = {
    instanceId,
    model: "old",
    options: [
      { id: "acpMode", value: uri },
      { id: "reasoningEffort", value: "medium" },
    ],
  };
  const config = {
    providers: [
      {
        instanceId,
        driver: "acpAgent",
        enabled: true,
        installed: true,
        auth: { status: "authenticated" },
        models: [{ slug: "old", name: "旧模型", capabilities: null }],
      },
      {
        instanceId: ProviderInstanceId.make("other"),
        driver: "acpAgent",
        enabled: true,
        installed: true,
        auth: { status: "authenticated" },
        models: [{ slug: "other-default", name: "其他实例", isDefault: true, capabilities: null }],
      },
    ],
  } as unknown as ServerConfig;
  const activity = (models: unknown): OrchestrationThreadActivity => ({
    id: EventId.make("models"),
    kind: "session.models.updated",
    tone: "info",
    summary: "模型目录",
    createdAt: "2026-10-14T00:00:00.000Z",
    turnId: null,
    payload: { providerInstanceId: instanceId, models },
  });
  const model = (slug: string, isDefault = false) => ({
    slug,
    name: slug,
    isDefault,
    isCustom: false,
    capabilities: null,
  });

  it("被撤回模型采用同实例默认项，界面和设置使用同一个选择", () => {
    const options = buildModelOptions(config, selection, [
      activity([model("first"), model("current", true)]),
    ]);
    const resolved = resolveThreadModelOption(options, selection);
    expect(resolved?.label).toBe("current");
    expect(resolved?.selection).toEqual({ instanceId, model: "current" });
    expect(selection.model).toBe("old");
    expect(selection.options).toHaveLength(2);
  });

  it("没有默认项时采用同实例首项，完整空目录不能借用另一实例", () => {
    expect(
      resolveThreadModelOption(
        buildModelOptions(config, selection, [activity([model("first"), model("next")])]),
        selection,
      )?.selection.model,
    ).toBe("first");
    expect(
      resolveThreadModelOption(buildModelOptions(config, selection, [activity([])]), selection),
    ).toBeNull();
  });

  it("回落保留兼容的URI与推理选项，失效值按当前广告校正", () => {
    const current = {
      ...model("current", true),
      capabilities: {
        optionDescriptors: [
          {
            id: "acpMode",
            label: "模式",
            type: "select",
            currentValue: "code",
            options: [
              { id: uri, label: "审查" },
              { id: "code", label: "实施" },
            ],
          },
          {
            id: "reasoningEffort",
            label: "推理",
            type: "select",
            currentValue: "high",
            options: [
              { id: "medium", label: "中" },
              { id: "high", label: "高" },
            ],
          },
        ],
      },
    };
    expect(
      resolveThreadModelOption(
        buildModelOptions(config, selection, [activity([current])]),
        selection,
      )?.selection.options,
    ).toEqual(selection.options);
    const invalid = { ...selection, options: [{ id: "acpMode", value: "removed" }] };
    expect(
      resolveThreadModelOption(buildModelOptions(config, invalid, [activity([current])]), invalid)
        ?.selection.options,
    ).toEqual([
      { id: "acpMode", value: "code" },
      { id: "reasoningEffort", value: "high" },
    ]);
  });

  it("模型仍可用时不切默认，离线或未知目录保留原选择", () => {
    const options = buildModelOptions(config, selection, [
      activity([model("current", true), model("old")]),
    ]);
    expect(resolveThreadModelOption(options, selection)).toBe(
      options.find((option) => option.selection.model === "old"),
    );
    expect(resolveThreadModelOption(buildModelOptions(null, selection), selection)?.selection).toBe(
      selection,
    );
    const unknown = { ...selection, model: "unknown" };
    expect(resolveThreadModelOption(buildModelOptions(config, unknown), unknown)?.selection).toBe(
      unknown,
    );
  });

  it("仅模式或配置更新仍保留未知模型，null撤销模型覆盖也保留", () => {
    const unknown = { ...selection, model: "unknown" };
    for (const activities of [
      [
        {
          ...activity(null),
          kind: "session.mode.updated",
          payload: { providerInstanceId: instanceId, mode: null },
        },
      ],
      [
        {
          ...activity(null),
          kind: "session.config-options.updated",
          payload: { providerInstanceId: instanceId, configOptions: [] },
        },
      ],
      [activity([]), activity(null)],
    ]) {
      expect(
        resolveThreadModelOption(buildModelOptions(config, unknown, activities), unknown)
          ?.selection,
      ).toBe(unknown);
    }
  });
});

describe("新任务模型与规范模式", () => {
  const instanceId = ProviderInstanceId.make("codex");
  const selection = {
    instanceId,
    model: "fixture-model",
    options: [
      { id: "reasoningEffort", value: "medium" },
      { id: "codexCollaborationMode", value: "plan" },
    ],
  };
  const config = (modes: ReadonlyArray<string> | null): ServerConfig =>
    ({
      providers: [
        {
          instanceId,
          driver: "codex",
          enabled: true,
          installed: true,
          showInteractionModeToggle: false,
          auth: { status: "authenticated" },
          models: [
            {
              slug: "fixture-model",
              name: "测试模型",
              capabilities:
                modes === null
                  ? null
                  : {
                      optionDescriptors: [
                        {
                          id: "reasoningEffort",
                          label: "思考",
                          type: "select",
                          currentValue: "medium",
                          options: [{ id: "medium", label: "Medium" }],
                        },
                        {
                          id: "codexCollaborationMode",
                          label: "模式",
                          type: "select",
                          currentValue: "default",
                          options: modes.map((id) => ({ id, label: id })),
                        },
                      ],
                    },
            },
          ],
        },
      ],
    }) as unknown as ServerConfig;

  it("旧版Plan关闭时，明确原生Plan仍同时写入原生与规范模式", () => {
    const result = resolveModelInteractionSettings(
      config(["default", "plan"]),
      selection,
      "default",
    );
    expect(result).toEqual({ modelSelection: selection, interactionMode: "plan" });
  });

  it("旧版Plan开启时，明确原生默认仍使用规范default", () => {
    const requested = {
      ...selection,
      options: [
        { id: "reasoningEffort", value: "medium" },
        { id: "codexCollaborationMode", value: "default" },
      ],
    };
    expect(resolveModelInteractionSettings(config(["default", "plan"]), requested, "plan")).toEqual(
      { modelSelection: requested, interactionMode: "default" },
    );
  });

  it("目录撤回Plan时同时清理原生选择，保留推理且不修改草稿", () => {
    const before = structuredClone(selection);
    expect(resolveModelInteractionSettings(config(["default"]), selection, "plan")).toEqual({
      modelSelection: {
        ...selection,
        options: [
          { id: "reasoningEffort", value: "medium" },
          { id: "codexCollaborationMode", value: "default" },
        ],
      },
      interactionMode: "default",
    });
    expect(selection).toEqual(before);
  });

  it("在线旧模型没有能力广告时清除原生Plan", () => {
    expect(resolveModelInteractionSettings(config(null), selection, "plan")).toEqual({
      modelSelection: { ...selection, options: [{ id: "reasoningEffort", value: "medium" }] },
      interactionMode: "default",
    });
  });

  it("不借用另一实例的原生广告", () => {
    const requested = { ...selection, instanceId: ProviderInstanceId.make("another") };
    expect(
      resolveModelInteractionSettings(config(["default", "plan"]), requested, "default"),
    ).toEqual({ modelSelection: requested, interactionMode: "default" });
  });

  it("离线无配置保留已有模式和选项", () => {
    expect(resolveModelInteractionSettings(null, selection, "plan")).toEqual({
      modelSelection: selection,
      interactionMode: "plan",
    });
  });

  it.each([
    ["byok", false, "default"],
    ["claudeAgent", true, "plan"],
  ] as const)("%s沿用真实两态声明，不受Codex原生广告影响", (driver, enabled, expected) => {
    const provider = config(null).providers[0]!;
    const current = {
      providers: [{ ...provider, driver, showInteractionModeToggle: enabled }],
    } as unknown as ServerConfig;
    const requested = { instanceId, model: "fixture-model" };
    expect(resolveModelInteractionSettings(current, requested, "plan")).toEqual({
      modelSelection: requested,
      interactionMode: expected,
    });
  });
});

describe("mobile model options", () => {
  it("会话模式进入手机选项并保留 URI 默认值，撤回后清除历史选项", () => {
    const uri = "https://agentclientprotocol.com/protocol/session-modes#review";
    const config = {
      providers: [
        {
          instanceId: "acpAgent",
          driver: "acpAgent",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [{ slug: "default", name: "默认", capabilities: null }],
        },
      ],
    } as unknown as ServerConfig;
    const selection = {
      instanceId: ProviderInstanceId.make("acpAgent"),
      model: "default",
      options: [{ id: "acpMode", value: "removed" }],
    };
    const mode = {
      id: "acpMode",
      label: "Agent 模式",
      type: "select",
      currentValue: uri,
      options: [{ id: uri, label: "审查" }],
    };
    const activity: OrchestrationThreadActivity = {
      id: EventId.make("mode"),
      kind: "session.mode.updated",
      tone: "info",
      summary: "模式",
      createdAt: "2026-09-30T00:00:00.000Z",
      turnId: null,
      payload: { providerInstanceId: "acpAgent", mode },
    };
    const [option] = buildModelOptions(config, selection, [activity]);
    expect(option?.capabilities?.optionDescriptors).toEqual([mode]);
    expect(option?.selection.options).toEqual([{ id: "acpMode", value: uri }]);
    const [withdrawn] = buildModelOptions(config, selection, [
      activity,
      { ...activity, payload: { providerInstanceId: "acpAgent", mode: null } },
    ]);
    expect(withdrawn?.capabilities?.optionDescriptors).toEqual([]);
    expect(withdrawn?.selection.options).toBeUndefined();
  });
  it("线程模型通知替换菜单，撤回后不补回历史选择，重连 null 恢复全局目录", () => {
    const config = {
      providers: [
        {
          instanceId: "acpAgent",
          driver: "acpAgent",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [{ slug: "old", name: "旧模型", capabilities: null }],
        },
      ],
    } as unknown as ServerConfig;
    const selection = { instanceId: ProviderInstanceId.make("acpAgent"), model: "old" };
    const activity = (models: unknown): OrchestrationThreadActivity => ({
      id: EventId.make("models"),
      kind: "session.models.updated",
      tone: "info",
      summary: "模型",
      createdAt: "2026-09-30T00:00:00.000Z",
      turnId: null,
      payload: { providerInstanceId: "acpAgent", models },
    });
    const history = [
      activity([{ slug: "new", name: "新模型", isCustom: false, capabilities: null }]),
    ];
    expect(
      buildModelOptions(config, selection, history).map((model) => model.selection.model),
    ).toEqual(["new"]);
    expect(buildModelOptions(config, selection, [...history, activity([])])).toEqual([]);
    expect(
      buildModelOptions(config, selection, [...history, activity(null)]).map(
        (model) => model.selection.model,
      ),
    ).toEqual(["old"]);
  });
  it("共享 BYOK 渠道不把历史原生模型补回列表或默认选择", () => {
    const config = {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          enabled: true,
          installed: true,
          auth: { status: "authenticated", type: "byok" },
          models: [{ slug: "gateway-model", name: "Gemini", capabilities: null }],
        },
      ],
    } as unknown as ServerConfig;
    const selection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" };
    expect(buildModelOptions(config, selection).map((model) => model.selection.model)).toEqual([
      "gateway-model",
    ]);
    expect(resolveSelectableModelSelection(config, selection)).toBeNull();
    expect(
      resolveSelectableModelSelection(config, { ...selection, model: "gateway-model" }),
    ).toEqual({ ...selection, model: "gateway-model" });
  });

  it("空闲的 BYOK 聊天可以选择 Codex 并保留完整模型分组", () => {
    const groups = [
      { providerKey: "byok", providerLabel: "BYOK", models: [] },
      { providerKey: "codex", providerLabel: "Codex", models: [] },
      { providerKey: "codex_personal", providerLabel: "Codex Personal", models: [] },
    ];
    expect(getThreadProviderGroups(groups, "byok", { isRunning: false, isStarted: false })).toBe(
      groups,
    );
    expect(getThreadProviderGroups(groups, "byok", { isRunning: true, isStarted: false })).toEqual([
      groups[0],
    ]);
  });

  it("已开始的对话锁定在当前 Agent 分组，实例缺失时退回全部分组", () => {
    const groups = [
      { providerKey: "byok", providerLabel: "BYOK", models: [] },
      { providerKey: "codex", providerLabel: "Codex", models: [] },
    ];
    expect(getThreadProviderGroups(groups, "byok", { isRunning: false, isStarted: true })).toEqual([
      groups[0],
    ]);
    expect(
      getThreadProviderGroups(groups, "removed_instance", { isRunning: false, isStarted: true }),
    ).toBe(groups);
  });

  it("labels model groups by driver instead of falling back to instance ids", () => {
    const drivers = [
      ["piAgent", "Pi"],
      ["ompAgent", "OhMyPi"],
      ["zcodeAgent", "ZCode"],
      ["acpAgent", "ACP Agent"],
      ["cursor", "Cursor"],
      ["grok", "Grok"],
      ["kimi", "Kimi"],
      ["antigravity", "Antigravity"],
      ["opencode", "OpenCode"],
      ["byok", "Custom model service"],
    ] as const;
    const providers = drivers.map(([driver], index) => ({
      instanceId: `instance_${index}`,
      driver,
      enabled: true,
      installed: true,
      auth: { status: "authenticated" },
      models: [{ slug: "model-a", name: "Model A", isCustom: false, capabilities: null }],
    }));
    const groups = groupByProvider(
      buildModelOptions({ providers } as unknown as ServerConfig, null),
    );
    expect(groups.map((group) => [group.providerKey, group.providerLabel])).toEqual(
      drivers.map(([driver, label]) => [
        `instance_${drivers.findIndex((d) => d[0] === driver)}`,
        label,
      ]),
    );
    // displayName 永远优先于 driver 默认名。
    const named = groupByProvider(
      buildModelOptions(
        {
          providers: [
            {
              instanceId: "omp_main",
              driver: "ompAgent",
              displayName: "我的 OhMyPi",
              enabled: true,
              installed: true,
              auth: { status: "authenticated" },
              models: [{ slug: "m", name: "M", isCustom: false, capabilities: null }],
            },
          ],
        } as unknown as ServerConfig,
        null,
      ),
    );
    expect(named[0]?.providerLabel).toBe("我的 OhMyPi");
  });

  it("groups models by provider and flags legacy entries", () => {
    const config = {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          displayName: "Codex",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            {
              slug: "gpt-5.6-sol",
              name: "GPT-5.6 Sol",
              isCustom: false,
              capabilities: null,
            },
            {
              slug: "gpt-5.4",
              name: "GPT-5.4",
              isCustom: false,
              isLegacy: true,
              capabilities: null,
            },
          ],
        },
      ],
    } as unknown as ServerConfig;

    expect(groupByProvider(buildModelOptions(config, null))).toMatchObject([
      {
        providerKey: "codex",
        providerLabel: "Codex",
        models: [
          { key: "codex:gpt-5.6-sol", label: "GPT-5.6 Sol", isLegacy: false },
          { key: "codex:gpt-5.4", label: "GPT-5.4", isLegacy: true },
        ],
      },
    ]);
  });

  it("normalizes a legacy fallback selection against current capabilities", () => {
    const config = {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          displayName: "Codex",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            {
              slug: "gpt-test",
              name: "GPT Test",
              isCustom: false,
              capabilities: {
                optionDescriptors: [
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
              },
            },
          ],
        },
      ],
    } as unknown as ServerConfig;

    const [option] = buildModelOptions(config, {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-test",
      options: [{ id: "fastMode", value: true }],
    });

    expect(option?.capabilities?.optionDescriptors?.[0]?.id).toBe("serviceTier");
    expect(option?.selection.options).toEqual([{ id: "serviceTier", value: "default" }]);
  });

  it("rejects stored selections whose provider is not usable", () => {
    const config = {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [],
        },
        {
          instanceId: "claudeAgent",
          driver: "claudeAgent",
          enabled: false,
          installed: true,
          auth: { status: "authenticated" },
          models: [],
        },
      ],
    } as unknown as ServerConfig;

    const usable = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.6-sol",
    };
    const disabled = {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-sonnet-5",
    };
    const removed = {
      instanceId: ProviderInstanceId.make("codex_personal"),
      model: "gpt-5.6-sol",
    };

    expect(resolveSelectableModelSelection(config, usable)).toBe(usable);
    expect(resolveSelectableModelSelection(config, disabled)).toBeNull();
    expect(resolveSelectableModelSelection(config, removed)).toBeNull();
    // No config (environment offline) — nothing to validate against.
    expect(resolveSelectableModelSelection(null, disabled)).toBe(disabled);
  });

  it("keeps legacy models out of implicit defaults", () => {
    const config = {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          displayName: "Codex",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            { slug: "gpt-5.6-sol", name: "GPT-5.6 Sol", isCustom: false, capabilities: null },
            {
              slug: "gpt-5.4",
              name: "GPT-5.4",
              isCustom: false,
              isLegacy: true,
              capabilities: null,
            },
          ],
        },
      ],
    } as unknown as ServerConfig;

    const current = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" };
    const legacy = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };

    expect(resolveDefaultableModelSelection(config, current)).toBe(current);
    // A legacy last-used selection falls through to the provider default.
    expect(resolveDefaultableModelSelection(config, legacy)).toBeNull();
    // Offline: nothing to validate against, selection passes through.
    expect(resolveDefaultableModelSelection(null, legacy)).toBe(legacy);
  });
});

describe("synchronized mobile model visibility", () => {
  const provider = ProviderInstanceId.make("codex_work");
  const other = ProviderInstanceId.make("codex_personal");
  const models = [
    { slug: "hidden", name: "Hidden", isCustom: false, capabilities: null },
    { slug: "first", name: "First", isCustom: false, capabilities: null },
    { slug: "second", name: "Second", isCustom: false, capabilities: null },
    { slug: "custom", name: "Custom", isCustom: true, capabilities: null },
  ];
  const config = {
    settings: {
      providerModelPreferences: {
        [provider]: {
          hiddenModels: ["hidden", "custom", "missing"],
          modelOrder: ["second", "first"],
        },
      },
    },
    providers: [provider, other].map((instanceId) => ({
      instanceId,
      driver: "codex",
      enabled: true,
      installed: true,
      auth: { status: "authenticated" },
      models,
    })),
  } as unknown as ServerConfig;

  it("applies server visibility and ordering independently to each provider instance", () => {
    const options = buildModelOptions(config, null);
    expect(
      options
        .filter((option) => option.providerKey === provider)
        .map((option) => option.selection.model),
    ).toEqual(["second", "first", "custom"]);
    expect(
      options
        .filter((option) => option.providerKey === other)
        .map((option) => option.selection.model),
    ).toEqual(["hidden", "first", "second", "custom"]);
  });

  it("exposes hidden built-ins for management without offering custom visibility controls", () => {
    const options = buildModelOptions(config, { instanceId: provider, model: "hidden" }, [], true);
    const providerModels = options.filter((option) => option.providerKey === provider);
    expect(providerModels.map((option) => option.selection.model)).toEqual([
      "second",
      "first",
      "hidden",
      "custom",
    ]);
    expect(providerModels.find((option) => option.selection.model === "hidden")).toMatchObject({
      isHidden: true,
      canHide: true,
    });
    expect(providerModels.find((option) => option.selection.model === "custom")).toMatchObject({
      isHidden: false,
      canHide: false,
    });
  });

  it.each(["hidden", "missing"])("does not resurrect the hidden fallback %s", (model) => {
    expect(
      buildModelOptions(config, { instanceId: provider, model })
        .filter((option) => option.providerKey === provider)
        .map((option) => option.selection.model),
    ).toEqual(["second", "first", "custom"]);
  });

  it("keeps custom models visible and restores built-in models when the server clears hidden models", () => {
    expect(
      buildModelOptions(config, { instanceId: provider, model: "custom" })
        .filter((option) => option.providerKey === provider)
        .map((option) => option.selection.model),
    ).toContain("custom");
    const cleared = {
      ...config,
      settings: { ...config.settings, providerModelPreferences: {} },
    } as unknown as ServerConfig;
    expect(
      buildModelOptions(cleared, null)
        .filter((option) => option.providerKey === provider)
        .map((option) => option.selection.model),
    ).toEqual(["hidden", "first", "second", "custom"]);
  });

  it("carries update-required models onto each option's provider group", () => {
    const gated = {
      settings: {},
      providers: [
        {
          instanceId: provider,
          driver: "claudeAgent",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [{ slug: "opus", name: "Opus", isCustom: false, capabilities: null }],
          updateRequiredModels: [{ slug: "opus-8", name: "Claude Opus 8", minVersion: "9.9.9" }],
        },
      ],
    } as unknown as ServerConfig;

    const [group] = groupByProvider(buildModelOptions(gated, null));
    expect(group?.updateRequired).toMatchObject({
      driver: "claudeAgent",
      updateRequiredModels: [{ slug: "opus-8" }],
    });
  });

  it("marks a gated fallback selection unavailable without dropping it", () => {
    const gated = {
      providers: [
        {
          instanceId: provider,
          driver: "claudeAgent",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [{ slug: "opus", name: "Opus", isCustom: false, capabilities: null }],
          updateRequiredModels: [{ slug: "opus-8", name: "Claude Opus 8", minVersion: "9.9.9" }],
        },
      ],
    } as unknown as ServerConfig;
    const selection = { instanceId: provider, model: "opus-8" };

    const option = buildModelOptions(gated, selection).find(
      (candidate) => candidate.selection.model === "opus-8",
    );
    expect(option).toMatchObject({ isUnavailable: true });
  });
});
