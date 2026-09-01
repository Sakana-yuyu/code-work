import type { CompositionSquad } from "@codework/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildCompositionSquadCreateRequest,
  createEmptyCompositionSquadDraft,
  draftFromCompositionSquad,
} from "./CompositionSquadPanel.logic";

describe("CompositionSquadPanel logic", () => {
  it("新建草稿从一个串行 Leader 开始", () => {
    expect(createEmptyCompositionSquadDraft()).toEqual({
      squadId: "",
      name: "",
      instructions: "",
      collaborationMode: "serial",
      maxConcurrencyText: "1",
      maxRetriesText: "0",
      failurePolicy: "fail_fast",
      partialSuccessPolicy: "reject",
      approvalStages: [],
      defaultModelBinding: { kind: "runtime_native" },
      members: [
        {
          clientId: "member-0",
          agentId: "",
          role: "leader",
          required: true,
          model: "",
          modelBinding: { kind: "team_default" },
          workspaceRoot: "",
          capabilityIdsText: "",
          maxConcurrentTasksText: "1",
        },
      ],
    });
  });

  it("生成请求时修剪文本并保留 capability 顺序", () => {
    const draft = createEmptyCompositionSquadDraft();
    draft.squadId = " squad-review ";
    draft.name = " Review Squad ";
    draft.instructions = " 先实现，再审查。 ";
    draft.approvalStages = ["before_finalize"];
    draft.defaultModelBinding = null;
    draft.members[0] = {
      ...draft.members[0]!,
      agentId: " leader-codex ",
      model: " gpt-5 ",
      modelBinding: null,
      workspaceRoot: " E:/repo ",
      capabilityIdsText: " fs.read, shell.exec , git.diff ",
    };

    const result = buildCompositionSquadCreateRequest(draft);

    expect(result.issues).toEqual([]);
    expect(result.request).toEqual({
      squadId: "squad-review",
      name: "Review Squad",
      leaderAgentId: "leader-codex",
      instructions: "先实现，再审查。",
      collaborationMode: "serial",
      members: [
        {
          agentId: "leader-codex",
          role: "leader",
          order: 0,
          required: true,
          model: "gpt-5",
          workspaceRoot: "E:/repo",
          capabilityIds: ["fs.read", "shell.exec", "git.diff"],
          maxConcurrentTasks: 1,
        },
      ],
      maxConcurrency: 1,
      maxRetries: 0,
      failurePolicy: "fail_fast",
      partialSuccessPolicy: "reject",
      approvalStages: ["before_finalize"],
    });
  });

  it("实时拒绝多个 Leader 和超过成员容量的并发量", () => {
    const draft = createEmptyCompositionSquadDraft();
    draft.squadId = "squad-invalid";
    draft.name = "Invalid Squad";
    draft.maxConcurrencyText = "3";
    draft.members[0] = { ...draft.members[0]!, agentId: "leader-a" };
    draft.members.push({
      clientId: "member-1",
      agentId: "leader-b",
      role: "leader",
      required: true,
      model: "",
      modelBinding: { kind: "team_default" },
      workspaceRoot: "",
      capabilityIdsText: "",
      maxConcurrentTasksText: "1",
    });

    const result = buildCompositionSquadCreateRequest(draft);

    expect(result.request).toBeNull();
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "leader_mismatch", path: "leaderAgentId" }),
        expect.objectContaining({ code: "concurrency_exceeded", path: "maxConcurrency" }),
      ]),
    );
  });

  it("从已保存 Squad 回填全部可编辑字段", () => {
    const squad: CompositionSquad = {
      squadId: "squad-1",
      name: "Build and Review",
      leaderAgentId: "agent-lead",
      memberAgentIds: ["agent-lead", "agent-review"],
      instructions: "保持提交可回滚。",
      revision: 3,
      collaborationMode: "review_critic",
      members: [
        {
          agentId: "agent-lead",
          role: "leader",
          order: 0,
          required: true,
          model: "gpt-5",
          workspaceRoot: "E:/repo",
          capabilityIds: ["fs.read", "git.diff"],
          maxConcurrentTasks: 2,
        },
        {
          agentId: "agent-review",
          role: "reviewer",
          order: 1,
          required: true,
          capabilityIds: ["fs.read"],
          maxConcurrentTasks: 1,
        },
      ],
      maxConcurrency: 2,
      maxRetries: 1,
      failurePolicy: "continue_independent",
      partialSuccessPolicy: "require_review",
      approvalStages: ["before_dispatch", "before_finalize"],
      createdAtUnixMs: 10,
      updatedAtUnixMs: 20,
    };

    expect(draftFromCompositionSquad(squad)).toEqual({
      squadId: "squad-1",
      name: "Build and Review",
      instructions: "保持提交可回滚。",
      collaborationMode: "review_critic",
      maxConcurrencyText: "2",
      maxRetriesText: "1",
      failurePolicy: "continue_independent",
      partialSuccessPolicy: "require_review",
      approvalStages: ["before_dispatch", "before_finalize"],
      defaultModelBinding: null,
      members: [
        {
          clientId: "member-0-agent-lead",
          agentId: "agent-lead",
          role: "leader",
          required: true,
          model: "gpt-5",
          modelBinding: null,
          workspaceRoot: "E:/repo",
          capabilityIdsText: "fs.read, git.diff",
          maxConcurrentTasksText: "2",
        },
        {
          clientId: "member-1-agent-review",
          agentId: "agent-review",
          role: "reviewer",
          required: true,
          model: "",
          modelBinding: null,
          workspaceRoot: "",
          capabilityIdsText: "fs.read",
          maxConcurrentTasksText: "1",
        },
      ],
    });
  });

  it("结构化绑定在 Builder 中保持稳定往返且不复制密钥", () => {
    const draft = createEmptyCompositionSquadDraft();
    draft.squadId = "squad-byok";
    draft.name = "BYOK Squad";
    draft.defaultModelBinding = {
      kind: "byok",
      providerInstanceId: "byok-primary",
      adapterId: "adapter-deepseek",
      modelId: "deepseek-chat",
    };
    draft.members[0] = {
      ...draft.members[0]!,
      agentId: "provider:byok-primary",
      modelBinding: { kind: "team_default" },
    };

    const result = buildCompositionSquadCreateRequest(draft);

    expect(result.issues).toEqual([]);
    expect(result.request?.defaultModelBinding).toEqual(draft.defaultModelBinding);
    expect(result.request?.members[0]?.modelBinding).toEqual({ kind: "team_default" });
    expect(JSON.stringify(result.request)).not.toContain("apiKey");
    expect(
      draftFromCompositionSquad({
        ...result.request!,
        revision: 1,
        memberAgentIds: result.request!.members.map((member) => member.agentId),
      }),
    ).toMatchObject({
      defaultModelBinding: draft.defaultModelBinding,
      members: [expect.objectContaining({ modelBinding: { kind: "team_default" } })],
    });
  });
});
