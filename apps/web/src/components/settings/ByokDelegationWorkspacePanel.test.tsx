import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  environment: { environmentId: "env-1" } as { readonly environmentId: string } | null,
  settings: { providerInstances: {} },
  updateSettings: vi.fn(),
  submitCommand: Symbol("submit-delegation"),
  listCommand: Symbol("list-delegations"),
}));

vi.mock("~/hooks/useSettings", () => ({
  usePrimarySettings: () => mocks.settings,
  useUpdatePrimarySettings: () => mocks.updateSettings,
}));

vi.mock("~/state/environments", () => ({
  usePrimaryEnvironment: () => mocks.environment,
}));

vi.mock("~/state/server", () => ({
  byokEnvironment: {
    submitDelegation: mocks.submitCommand,
    listDelegations: mocks.listCommand,
  },
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => vi.fn(),
}));

import { t } from "~/i18n";
import { ByokDelegationWorkspacePanel, __testables } from "./ByokDelegationWorkspacePanel";

const renderPanel = () => renderToStaticMarkup(<ByokDelegationWorkspacePanel />);

describe("ByokDelegationWorkspacePanel", () => {
  beforeEach(() => {
    mocks.environment = { environmentId: "env-1" };
    mocks.settings = { providerInstances: {} };
    mocks.updateSettings.mockReset();
  });

  it("没有 BYOK 驱动时显示明确的空状态", () => {
    const html = renderPanel();

    expect(html).toContain(t("delegationWorkspace.noByokInstance"));
    expect(html).not.toContain("undefined");
  });

  it("展示已配置的 BYOK 驱动、模型和委派输入", () => {
    mocks.settings = {
      providerInstances: {
        "byok-primary": {
          driver: "byok",
          displayName: "Sakana Delegation",
          config: {
            adapters: [
              {
                id: "model-1",
                displayName: "Sakana Model",
                protocol: "openai",
                baseURL: "https://example.test/v1",
                modelId: "example-model",
              },
            ],
            delegation: {
              enabled: true,
              maxConcurrency: 3,
              queueTimeoutMs: 30_000,
              executionTimeoutMs: 120_000,
              modelGroups: [
                {
                  id: "default",
                  name: "Default",
                  enabled: true,
                  modelIds: ["model-1"],
                  defaultModelId: "model-1",
                },
              ],
              executorCommand: "node executor.mjs",
              executorEnvironmentVariables: [],
            },
          },
        },
      },
    };

    const html = renderPanel();

    expect(html).toContain("Sakana Delegation");
    expect(html).toContain("Sakana Model");
    expect(html).toContain(t("delegationWorkspace.ready"));
    expect(html).toContain(t("delegationSettings.globalTitle"));
    expect(html).toContain(t("delegationSettings.executorsTitle"));
    expect(html).toContain(t("delegationSettings.customExecutor"));
    expect(html).toContain(t("delegationSettings.configureExecutor"));
    expect(html).toContain(t("delegationSettings.taskTitle"));
    expect(html).toContain(t("delegationSettings.advancedTitle"));
    expect(html).toContain(t("delegationSettings.modelGroupsTitle"));
    expect(html).toContain(t("delegationSettings.subagentsTitle"));
    expect(html).toContain(`placeholder="${t("delegationWorkspace.taskPlaceholder")}"`);
    expect(html).toContain(t("delegationWorkspace.submit"));
  });

  it("只将 BYOK 实例纳入可委派驱动", () => {
    const instances = __testables.delegationInstancesFrom({
      byok: { driver: "byok", config: {} },
      codex: { driver: "codex", config: {} },
    } as never);

    expect(instances.map((instance) => instance.instanceId)).toEqual(["byok"]);
  });

  it("归一化委派配置，过滤无效环境变量并修正模型组默认模型", () => {
    const config = __testables.readDelegationConfig({
      delegation: {
        enabled: true,
        maxConcurrency: 99,
        modelGroups: [
          {
            id: "g1",
            name: "",
            enabled: true,
            modelIds: ["m1"],
            defaultModelId: "missing",
          },
        ],
        executorCommand: " node worker.mjs ",
        executorEnvironmentVariables: ["OPENAI_API_KEY", "bad-name", "CODEWORK_HOME"],
      },
    });

    expect(config.maxConcurrency).toBe(16);
    expect(config.executorCommand).toBe("node worker.mjs");
    expect(config.executorEnvironmentVariables).toEqual(["OPENAI_API_KEY", "CODEWORK_HOME"]);
    expect(config.modelGroups[0]?.defaultModelId).toBeUndefined();
    expect(config.modelGroups[0]?.name).toBe(
      t("delegationSettings.defaultGroupName", { index: 1 }),
    );
  });

  it("归一化执行器候选并钳制失败转移上限", () => {
    const config = __testables.readDelegationConfig({
      delegation: {
        enabled: true,
        executorFailoverLimit: 99,
        executors: [
          { id: "Bad Id", command: "x.mjs" },
          { id: "default", command: "reserved.mjs" },
          { id: "dup", command: "a.mjs" },
          { id: "dup", command: "b.mjs" },
          {
            id: "alpha",
            command: " node a.mjs ",
            priority: -3,
            environmentVariables: ["OPENAI_API_KEY", "bad name"],
          },
          { id: "empty-cmd", command: "   " },
        ],
      },
    });

    expect(config.executorFailoverLimit).toBe(5);
    expect(config.executors.map((row) => row.id)).toEqual(["dup", "alpha"]);
    expect(config.executors[0]?.command).toBe("a.mjs");
    expect(config.executors[1]?.priority).toBe(0);
    expect(config.executors[1]?.environmentVariables).toEqual(["OPENAI_API_KEY"]);
  });

  it("归一化监督策略与子代理角色配置", () => {
    const config = __testables.readDelegationConfig({
      delegation: {
        supervision: {
          enabled: true,
          supervisorModelId: " model-supervisor ",
          reviewerModelId: "",
          maxCorrections: 99,
          maxRounds: 0,
          allowReassign: false,
        },
        subagentProfiles: [
          { subagentType: " explore ", promptFragment: "只读探索" },
          { subagentType: "", promptFragment: "忽略" },
          "bad-row",
        ],
      },
    });

    expect(config.supervision.enabled).toBe(true);
    expect(config.supervision.supervisorModelId).toBe("model-supervisor");
    expect(config.supervision.maxCorrections).toBe(20);
    expect(config.supervision.maxRounds).toBe(1);
    expect(config.supervision.allowReassign).toBe(false);
    expect(config.supervision.allowEscalate).toBe(true);
    expect(config.subagentProfiles).toEqual([
      { subagentType: "explore", promptFragment: "只读探索" },
    ]);
  });

  it("切换模型时会保留有效默认模型并在必要时清空默认模型", () => {
    const group = {
      id: "g1",
      name: "Group",
      enabled: true,
      modelIds: ["m1", "m2"],
      defaultModelId: "m2",
    };

    expect(__testables.toggleModelInGroup(group, "m1", false)).toEqual({
      ...group,
      modelIds: ["m2"],
    });
    expect(__testables.toggleModelInGroup(group, "m2", false)).toEqual({
      ...group,
      modelIds: ["m1"],
      defaultModelId: "m1",
    });
    expect(__testables.toggleModelInGroup({ ...group, modelIds: ["m2"] }, "m2", false)).toEqual({
      id: "g1",
      name: "Group",
      enabled: true,
      modelIds: [],
    });
  });

  it("在界面使用秒编辑超时，保存回委派配置时仍是毫秒", () => {
    expect(__testables.millisecondsToSecondsText(120_000)).toBe("120");
    expect(__testables.secondsTextToMilliseconds("45", 120_000)).toBe(45_000);
    expect(__testables.secondsTextToMilliseconds("", 120_000)).toBe(120_000);
    expect(__testables.secondsTextToMilliseconds("999999", 120_000)).toBe(86_400_000);
  });
});
