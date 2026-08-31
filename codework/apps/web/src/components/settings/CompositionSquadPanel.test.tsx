import type { CompositionSquadListResult } from "@codework/contracts";
import { EnvironmentId } from "@codework/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { t } from "~/i18n";

const mocks = vi.hoisted(() => ({
  environment: null as { readonly environmentId: string } | null,
  settings: { providerInstances: {} } as never,
  squadsAtom: Symbol("squads"),
  squadsQuery: {
    data: null as CompositionSquadListResult | null,
    error: null as string | null,
    isPending: false,
    refresh: vi.fn(),
  },
  atoms: {
    create: Symbol("create"),
    update: Symbol("update"),
    duplicate: Symbol("duplicate"),
    archive: Symbol("archive"),
    restore: Symbol("restore"),
  },
  commands: {
    create: vi.fn(),
    update: vi.fn(),
    duplicate: vi.fn(),
    archive: vi.fn(),
    restore: vi.fn(),
  },
}));

vi.mock("~/state/environments", () => ({
  usePrimaryEnvironment: () => mocks.environment,
}));

vi.mock("~/hooks/useSettings", () => ({
  usePrimarySettings: () => mocks.settings,
}));

vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => mocks.squadsQuery,
}));

vi.mock("~/state/server", () => ({
  serverEnvironment: {
    compositionSquads: () => mocks.squadsAtom,
    createCompositionSquad: mocks.atoms.create,
    updateCompositionSquad: mocks.atoms.update,
    duplicateCompositionSquad: mocks.atoms.duplicate,
    archiveCompositionSquad: mocks.atoms.archive,
    restoreCompositionSquad: mocks.atoms.restore,
  },
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => {
    if (command === mocks.atoms.create) return mocks.commands.create;
    if (command === mocks.atoms.update) return mocks.commands.update;
    if (command === mocks.atoms.duplicate) return mocks.commands.duplicate;
    if (command === mocks.atoms.archive) return mocks.commands.archive;
    return mocks.commands.restore;
  },
}));

import { CompositionSquadPanel } from "./CompositionSquadPanel";

describe("CompositionSquadPanel", () => {
  beforeEach(() => {
    mocks.environment = null;
    mocks.settings = { providerInstances: {} } as never;
    mocks.squadsQuery.data = null;
    mocks.squadsQuery.error = null;
    mocks.squadsQuery.isPending = false;
    mocks.squadsQuery.refresh.mockReset();
    Object.values(mocks.commands).forEach((command) => command.mockReset());
  });

  it("未连接环境时显示不可操作的空状态", () => {
    const html = renderToStaticMarkup(<CompositionSquadPanel />);

    expect(html).toContain(t("squadBuilder.noEnvironment"));
    expect(html).not.toContain("data-squad-id");
  });

  it("显示真实 Squad 列表、revision 和归档状态", () => {
    mocks.environment = { environmentId: EnvironmentId.make("env-test") };
    mocks.squadsQuery.data = {
      squads: [
        {
          squadId: "squad-active",
          name: "Build Squad",
          leaderAgentId: "agent-lead",
          memberAgentIds: ["agent-lead"],
          revision: 3,
          collaborationMode: "serial",
          members: [
            {
              agentId: "agent-lead",
              role: "leader",
              order: 0,
              required: true,
              capabilityIds: ["fs.read"],
              maxConcurrentTasks: 1,
            },
          ],
          maxConcurrency: 1,
          failurePolicy: "fail_fast",
          partialSuccessPolicy: "reject",
        },
        {
          squadId: "squad-archived",
          name: "Archived Squad",
          leaderAgentId: "agent-old",
          memberAgentIds: ["agent-old"],
          revision: 2,
          archivedAtUnixMs: 20,
        },
      ],
    };

    const html = renderToStaticMarkup(<CompositionSquadPanel />);

    expect(html).toContain('data-squad-id="squad-active"');
    expect(html).toContain('data-squad-id="squad-archived"');
    expect(html).toContain("Build Squad");
    expect(html).toContain("Archived Squad");
    expect(html).toContain(t("squadBuilder.revision", { revision: 3 }));
    expect(html).toContain(t("squadBuilder.archived"));
  });

  it("首个活跃 Squad 自动进入编辑态并提供完整生命周期操作", () => {
    mocks.environment = { environmentId: EnvironmentId.make("env-test") };
    mocks.squadsQuery.data = {
      squads: [
        {
          squadId: "squad-active",
          name: "Build Squad",
          leaderAgentId: "agent-lead",
          memberAgentIds: ["agent-lead"],
          revision: 3,
          collaborationMode: "serial",
          members: [
            {
              agentId: "agent-lead",
              role: "leader",
              order: 0,
              required: true,
              capabilityIds: [],
              maxConcurrentTasks: 1,
            },
          ],
          maxConcurrency: 1,
          maxRetries: 0,
          failurePolicy: "fail_fast",
          partialSuccessPolicy: "reject",
        },
      ],
    };

    const html = renderToStaticMarkup(<CompositionSquadPanel />);

    expect(html).toContain('data-testid="squad-save"');
    expect(html).toContain('data-testid="squad-duplicate"');
    expect(html).toContain('data-testid="squad-archive"');
    expect(html).toContain('value="squad-active"');
    expect(html).toContain('value="Build Squad"');
    expect(html).toContain(`placeholder="${t("squadBuilder.capabilityIdsPlaceholder")}"`);
  });

  it("中文 Squad 角色与 Agent 字段使用本地化文案", () => {
    expect(t("squadBuilder.leader")).toBe("队长");
    expect(t("squadBuilder.agentId")).toBe("Agent 标识");
    expect(t("squadBuilder.role.leader")).toBe("队长");
  });

  it("将已配置的 BYOK adapter 暴露为成员模型候选，同时保留手动模型值", () => {
    mocks.environment = { environmentId: EnvironmentId.make("env-test") };
    mocks.settings = {
      providerInstances: {
        "byok-primary": {
          driver: "byok",
          config: {
            adapters: [
              {
                id: "adapter-deepseek",
                displayName: "DeepSeek",
                protocol: "openai",
                baseURL: "https://api.example.test/v1",
                apiKey: "",
                modelId: "deepseek-chat",
                contextWindowTokens: 128000,
              },
            ],
          },
        },
      },
    } as never;
    mocks.squadsQuery.data = {
      squads: [
        {
          squadId: "squad-byok",
          name: "BYOK Team",
          leaderAgentId: "agent-lead",
          memberAgentIds: ["agent-lead"],
          revision: 1,
          collaborationMode: "serial",
          members: [
            {
              agentId: "agent-lead",
              role: "leader",
              order: 0,
              required: true,
              model: "legacy-model",
              capabilityIds: [],
              maxConcurrentTasks: 1,
            },
          ],
          maxConcurrency: 1,
          maxRetries: 0,
          failurePolicy: "fail_fast",
          partialSuccessPolicy: "reject",
        },
      ],
    };

    const html = renderToStaticMarkup(<CompositionSquadPanel />);

    expect(html).toContain('value="legacy-model"');
    expect(html).toContain('value="adapter-deepseek"');
    expect(html).toContain('label="DeepSeek · deepseek-chat"');
  });
});
