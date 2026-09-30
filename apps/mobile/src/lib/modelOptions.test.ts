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
} from "./modelOptions";

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
