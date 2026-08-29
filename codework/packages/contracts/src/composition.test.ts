import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ApprovalRequestId } from "./baseSchemas.ts";

import {
  CompositionAgentLoopRequest,
  CompositionAgentLoopRunRequest,
  CompositionAgentLoopRunResult,
  CompositionCapabilityDescriptor,
  CompositionCapabilityGrant,
  CompositionCapabilityAuditEvent,
  CompositionCapabilityPolicyDecision,
  CompositionSquad,
  CompositionSquadCreateRequest,
  CompositionSquadDuplicateRequest,
  CompositionSquadExecution,
  CompositionSquadExecutionRequest,
  CompositionSquadExecutionResult,
  CompositionSquadListRequest,
  CompositionSquadListResult,
  CompositionSquadRevisionListResult,
  CompositionSquadRevisionMutationRequest,
  CompositionSquadUpdateRequest,
  validateCompositionSquadConfiguration,
  validateCompositionSquadExecution,
  CompositionTaskCancelRequest,
  CompositionTaskDispatchRequest,
  CompositionTaskGraphExecutionRequest,
  CompositionTaskGraphExecutionResult,
  CompositionTaskEventsResult,
  CompositionTaskListResult,
  CompositionTaskListRequest,
  CompositionTaskReviewRequest,
  CompositionTaskRetryRequest,
  CompositionTaskResumeRequest,
  CompositionTaskResumeResult,
  CompositionTaskEvent,
  CompositionToolInvocation,
  CompositionToolResult,
  CompositionRuntimeToolInvocation,
  CompositionRuntimeToolCancellation,
  CompositionControlCenterTask,
  isCompositionSquadExecutionStatusTransitionAllowed,
  isByokResumeRedispatchable,
  isByokDelegationControlTask,
} from "./composition.ts";

const decodeAgentLoopRequest = Schema.decodeUnknownSync(CompositionAgentLoopRequest);
const decodeCapability = Schema.decodeUnknownSync(CompositionCapabilityDescriptor);
const decodeCapabilityGrant = Schema.decodeUnknownSync(CompositionCapabilityGrant);
const decodeCapabilityAuditEvent = Schema.decodeUnknownSync(CompositionCapabilityAuditEvent);
const decodePolicyDecision = Schema.decodeUnknownSync(CompositionCapabilityPolicyDecision);
const decodeSquad = Schema.decodeUnknownSync(CompositionSquad);
const decodeSquadCreate = Schema.decodeUnknownSync(CompositionSquadCreateRequest);
const decodeSquadDuplicate = Schema.decodeUnknownSync(CompositionSquadDuplicateRequest);
const decodePersistedSquadExecution = Schema.decodeUnknownSync(CompositionSquadExecution);
const decodeSquadExecution = Schema.decodeUnknownSync(CompositionSquadExecutionRequest);
const decodeSquadExecutionResult = Schema.decodeUnknownSync(CompositionSquadExecutionResult);
const decodeSquadList = Schema.decodeUnknownSync(CompositionSquadListRequest);
const decodeSquadListResult = Schema.decodeUnknownSync(CompositionSquadListResult);
const decodeSquadRevisionListResult = Schema.decodeUnknownSync(CompositionSquadRevisionListResult);
const decodeSquadRevisionMutation = Schema.decodeUnknownSync(
  CompositionSquadRevisionMutationRequest,
);
const decodeSquadUpdate = Schema.decodeUnknownSync(CompositionSquadUpdateRequest);
const decodeTaskEvent = Schema.decodeUnknownSync(CompositionTaskEvent);
const decodeTaskDispatch = Schema.decodeUnknownSync(CompositionTaskDispatchRequest);
const decodeTaskGraph = Schema.decodeUnknownSync(CompositionTaskGraphExecutionRequest);
const decodeTaskGraphResult = Schema.decodeUnknownSync(CompositionTaskGraphExecutionResult);
const decodeTaskCancel = Schema.decodeUnknownSync(CompositionTaskCancelRequest);
const decodeTaskEvents = Schema.decodeUnknownSync(CompositionTaskEventsResult);
const decodeTaskListResult = Schema.decodeUnknownSync(CompositionTaskListResult);
const decodeTaskList = Schema.decodeUnknownSync(CompositionTaskListRequest);
const decodeTaskReview = Schema.decodeUnknownSync(CompositionTaskReviewRequest);
const decodeTaskRetry = Schema.decodeUnknownSync(CompositionTaskRetryRequest);
const decodeTaskResume = Schema.decodeUnknownSync(CompositionTaskResumeRequest);
const decodeTaskResumeResult = Schema.decodeUnknownSync(CompositionTaskResumeResult);
const decodeToolInvocation = Schema.decodeUnknownSync(CompositionToolInvocation);
const decodeToolResult = Schema.decodeUnknownSync(CompositionToolResult);
const decodeRuntimeToolInvocation = Schema.decodeUnknownSync(CompositionRuntimeToolInvocation);
const decodeRuntimeToolCancellation = Schema.decodeUnknownSync(CompositionRuntimeToolCancellation);
const decodeAgentLoopRunRequest = Schema.decodeUnknownSync(CompositionAgentLoopRunRequest);
const decodeAgentLoopRunResult = Schema.decodeUnknownSync(CompositionAgentLoopRunResult);
const decodeApprovalRequestId = Schema.decodeUnknownSync(ApprovalRequestId);

const validSquadConfiguration = {
  squadId: "squad-validation",
  name: "校验协同组",
  leaderAgentId: "agent-leader",
  memberAgentIds: ["agent-leader", "agent-worker", "agent-reviewer"],
  revision: 1,
  collaborationMode: "review_critic" as const,
  members: [
    {
      agentId: "agent-leader",
      role: "leader" as const,
      order: 0,
      required: true,
      capabilityIds: ["t3.workspace.read_file"],
      maxConcurrentTasks: 1,
    },
    {
      agentId: "agent-worker",
      role: "worker" as const,
      order: 1,
      required: true,
      capabilityIds: ["t3.workspace.write_file"],
      maxConcurrentTasks: 2,
    },
    {
      agentId: "agent-reviewer",
      role: "reviewer" as const,
      order: 2,
      required: true,
      capabilityIds: ["t3.workspace.read_file"],
      maxConcurrentTasks: 1,
    },
  ],
  maxConcurrency: 3,
  maxRetries: 1,
  failurePolicy: "continue_independent" as const,
  partialSuccessPolicy: "require_review" as const,
  approvalStages: ["before_finalize" as const],
  createdAtUnixMs: 10,
  updatedAtUnixMs: 20,
};

describe("composition contracts", () => {
  it("保留可版本化 Squad 的成员角色、运行约束和审批配置", () => {
    const decoded = decodeSquad({
      squadId: "squad-native",
      name: "原生协同组",
      leaderAgentId: "agent-leader",
      memberAgentIds: ["agent-leader", "agent-worker", "agent-reviewer"],
      revision: 3,
      collaborationMode: "review_critic",
      members: [
        {
          agentId: "agent-leader",
          role: "leader",
          order: 0,
          required: true,
          model: "provider/leader-model",
          workspaceRoot: "C:/workspace/leader",
          capabilityIds: ["t3.workspace.read_file"],
          maxConcurrentTasks: 1,
        },
        {
          agentId: "agent-worker",
          role: "worker",
          order: 1,
          required: true,
          capabilityIds: ["t3.workspace.read_file", "t3.workspace.write_file"],
          maxConcurrentTasks: 2,
        },
        {
          agentId: "agent-reviewer",
          role: "reviewer",
          order: 2,
          required: true,
          capabilityIds: ["t3.workspace.read_file"],
          maxConcurrentTasks: 1,
        },
      ],
      maxConcurrency: 3,
      maxRetries: 2,
      failurePolicy: "continue_independent",
      partialSuccessPolicy: "require_review",
      approvalStages: ["before_mutating_tool", "before_finalize"],
      createdAtUnixMs: 10,
      updatedAtUnixMs: 20,
    });

    expect(decoded.revision).toBe(3);
    expect(decoded.collaborationMode).toBe("review_critic");
    expect(decoded.members?.[0]).toMatchObject({
      role: "leader",
      model: "provider/leader-model",
      workspaceRoot: "C:/workspace/leader",
      maxConcurrentTasks: 1,
    });
    expect(decoded.members?.[1]?.capabilityIds).toEqual([
      "t3.workspace.read_file",
      "t3.workspace.write_file",
    ]);
    expect(decoded.maxConcurrency).toBe(3);
    expect(decoded.maxRetries).toBe(2);
    expect(decoded.failurePolicy).toBe("continue_independent");
    expect(decoded.partialSuccessPolicy).toBe("require_review");
    expect(decoded.approvalStages).toEqual(["before_mutating_tool", "before_finalize"]);
  });

  it("拒绝零并发的 Squad 配置", () => {
    expect(() =>
      decodeSquad({
        squadId: "squad-invalid-concurrency",
        name: "错误配置",
        leaderAgentId: "agent-leader",
        memberAgentIds: ["agent-leader"],
        maxConcurrency: 0,
      }),
    ).toThrow();
  });

  it("拒绝重复成员、顺序和成员能力", () => {
    const duplicateMember = {
      ...validSquadConfiguration,
      members: [
        ...validSquadConfiguration.members,
        { ...validSquadConfiguration.members[1], order: 3 },
      ],
    };
    const duplicateOrder = {
      ...validSquadConfiguration,
      members: validSquadConfiguration.members.map((member, index) =>
        index === 2 ? { ...member, order: 1 } : member,
      ),
    };
    const duplicateCapability = {
      ...validSquadConfiguration,
      members: validSquadConfiguration.members.map((member, index) =>
        index === 1
          ? {
              ...member,
              capabilityIds: ["t3.workspace.write_file", "t3.workspace.write_file"],
            }
          : member,
      ),
    };

    expect(() => decodeSquad(duplicateMember)).toThrow();
    expect(() => decodeSquad(duplicateOrder)).toThrow();
    expect(() => decodeSquad(duplicateCapability)).toThrow();
  });

  it("拒绝 Leader 不一致及协同模式缺少必要角色", () => {
    const mismatchedLeader = {
      ...validSquadConfiguration,
      leaderAgentId: "agent-worker",
    };
    const missingReviewer = {
      ...validSquadConfiguration,
      members: validSquadConfiguration.members.filter((member) => member.role !== "reviewer"),
      memberAgentIds: ["agent-leader", "agent-worker"],
    };
    const missingWorker = {
      ...validSquadConfiguration,
      collaborationMode: "leader_workers" as const,
      members: validSquadConfiguration.members.filter((member) => member.role !== "worker"),
      memberAgentIds: ["agent-leader", "agent-reviewer"],
    };

    expect(() => decodeSquad(mismatchedLeader)).toThrow();
    expect(() => decodeSquad(missingReviewer)).toThrow();
    expect(() => decodeSquad(missingWorker)).toThrow();
  });

  it("拒绝超出成员容量、成员投影不一致和倒序时间", () => {
    const capacityExceeded = {
      ...validSquadConfiguration,
      maxConcurrency: 5,
    };
    const memberProjectionMismatch = {
      ...validSquadConfiguration,
      memberAgentIds: ["agent-leader", "agent-worker"],
    };
    const timeReversed = {
      ...validSquadConfiguration,
      updatedAtUnixMs: 9,
    };

    expect(() => decodeSquad(capacityExceeded)).toThrow();
    expect(() => decodeSquad(memberProjectionMismatch)).toThrow();
    expect(() => decodeSquad(timeReversed)).toThrow();
  });

  it("为 Squad Builder 返回稳定的跨字段校验码和字段路径", () => {
    const issues = validateCompositionSquadConfiguration({
      ...validSquadConfiguration,
      maxConcurrency: 5,
      approvalStages: ["before_finalize", "before_finalize"],
    });

    expect(issues).toEqual([
      { code: "concurrency_exceeded", path: "maxConcurrency" },
      { code: "duplicate_approval_stage", path: "approvalStages" },
    ]);
  });

  it("定义由服务端维护 revision 和成员投影的 Squad 生命周期合同", () => {
    const create = decodeSquadCreate({
      squadId: "squad-rpc",
      name: "RPC 协同组",
      leaderAgentId: "agent-leader",
      instructions: "先并行实现，再由 Reviewer 验收。",
      collaborationMode: "review_critic",
      members: validSquadConfiguration.members,
      maxConcurrency: 3,
      maxRetries: 1,
      failurePolicy: "continue_independent",
      partialSuccessPolicy: "require_review",
      approvalStages: ["before_finalize"],
    });
    const update = decodeSquadUpdate({ ...create, expectedRevision: 4 });
    const duplicate = decodeSquadDuplicate({
      sourceSquadId: "squad-rpc",
      squadId: "squad-rpc-copy",
      name: "RPC 协同组副本",
    });
    const lifecycle = decodeSquadRevisionMutation({
      squadId: "squad-rpc",
      expectedRevision: 4,
    });

    expect(create).not.toHaveProperty("revision");
    expect(create).not.toHaveProperty("memberAgentIds");
    expect(update.expectedRevision).toBe(4);
    expect(duplicate.sourceSquadId).toBe("squad-rpc");
    expect(lifecycle).toEqual({ squadId: "squad-rpc", expectedRevision: 4 });
  });

  it("定义 Squad 列表、不可变 revision 历史与结构化运行合同", () => {
    const list = decodeSquadList({ includeArchived: true });
    const listResult = decodeSquadListResult({ squads: [validSquadConfiguration] });
    const revisions = decodeSquadRevisionListResult({
      revisions: [
        {
          squadId: "squad-validation",
          revision: 1,
          configuration: validSquadConfiguration,
          createdAtUnixMs: 20,
        },
      ],
    });
    const execution = decodeSquadExecution({
      executionId: "execution-1",
      squadId: "squad-validation",
      squadRevision: 1,
      projectId: "project-1",
      threadId: "thread-1",
      goal: "完成合同和服务端接线",
      workspaceRoot: "E:/workspace",
      plan: [
        {
          nodeId: "contracts",
          agentId: "agent-worker",
          prompt: "完成合同定义并验证。",
          dependsOnNodeIds: [],
        },
        {
          nodeId: "review",
          agentId: "agent-reviewer",
          prompt: "审查合同兼容性。",
          dependsOnNodeIds: ["contracts"],
        },
      ],
    });
    const executionResult = decodeSquadExecutionResult({
      executionId: "execution-1",
      squadId: "squad-validation",
      squadRevision: 1,
      graph: {
        leader: {
          task: {
            taskId: "leader-task",
            projectId: "project-1",
            assigneeKind: "squad",
            assigneeId: "squad-validation",
            mode: "review",
            status: "completed",
            promptDigest: "sha256:leader",
            dependsOnTaskIds: ["contracts-task"],
            createdAtUnixMs: 1,
            updatedAtUnixMs: 2,
          },
          run: {
            runId: "leader-run",
            taskId: "leader-task",
            agentId: "agent-leader",
            runtimeId: "runtime-1",
            status: "completed",
            attempt: 1,
            capabilityGrantIds: [],
          },
        },
        children: [],
      },
    });

    expect(list.includeArchived).toBe(true);
    expect(listResult.squads).toHaveLength(1);
    expect(revisions.revisions[0]?.configuration?.revision).toBe(1);
    expect(execution.plan?.[1]?.dependsOnNodeIds).toEqual(["contracts"]);
    expect(executionResult.graph.leader.run.status).toBe("completed");
  });

  it("定义可跨重启查询和恢复的 Squad execution 记录", () => {
    const running = decodePersistedSquadExecution({
      executionId: "execution-persisted-1",
      squadId: "squad-validation",
      squadRevision: 1,
      projectId: "project-1",
      threadId: "thread-1",
      goalDigest: "sha256:execution-goal",
      goalTaskId: "execution-persisted-1:task:leader-plan",
      workspaceRoot: "E:/workspace",
      workspaceRootDigest: "sha256:workspace",
      status: "running",
      revision: 3,
      pendingApprovals: [
        {
          approvalRequestId: "approval-tool-contracts",
          stage: "before_mutating_tool",
          nodeId: "contracts",
          taskId: "execution-persisted-1:task:contracts",
          runId: "execution-persisted-1:run:contracts:1",
          agentId: "agent-worker",
          capabilityId: "t3.workspace.write_file",
          toolCallId: "tool-contracts-1",
          requestedAtUnixMs: 160,
        },
        {
          approvalRequestId: "approval-tool-tests",
          stage: "before_mutating_tool",
          nodeId: "tests",
          taskId: "execution-persisted-1:task:tests",
          runId: "execution-persisted-1:run:tests:1",
          agentId: "agent-reviewer",
          capabilityId: "t3.workspace.write_file",
          toolCallId: "tool-tests-1",
          requestedAtUnixMs: 170,
        },
      ],
      nodes: [
        {
          nodeId: "contracts",
          agentId: "agent-worker",
          taskId: "execution-persisted-1:task:contracts",
          runId: "execution-persisted-1:run:contracts:1",
          promptDigest: "sha256:contracts-prompt",
          dependsOnNodeIds: [],
        },
        {
          nodeId: "tests",
          agentId: "agent-reviewer",
          taskId: "execution-persisted-1:task:tests",
          runId: "execution-persisted-1:run:tests:1",
          promptDigest: "sha256:tests-prompt",
          dependsOnNodeIds: ["contracts"],
        },
      ],
      leaderTaskId: "execution-persisted-1:leader",
      leaderRunId: "execution-persisted-1:leader:run:1",
      createdAtUnixMs: 100,
      startedAtUnixMs: 120,
      updatedAtUnixMs: 180,
    });
    const paused = decodePersistedSquadExecution({
      ...running,
      status: "paused",
      revision: 4,
      pausedFromStatus: "running",
      pausedAtUnixMs: 200,
      updatedAtUnixMs: 200,
    });
    const awaitingApproval = decodePersistedSquadExecution({
      ...running,
      status: "awaiting_approval",
      revision: 5,
      pendingApprovals: [
        {
          approvalRequestId: "approval-before-finalize",
          stage: "before_finalize",
          requestedAtUnixMs: 210,
        },
      ],
      updatedAtUnixMs: 210,
    });
    const completed = decodePersistedSquadExecution({
      ...running,
      status: "completed",
      revision: 6,
      pendingApprovals: [],
      resultSummary: "合同、持久化和控制面均已完成。",
      finishedAtUnixMs: 260,
      updatedAtUnixMs: 260,
    });

    expect(running.nodes?.[0]).toMatchObject({
      nodeId: "contracts",
      runId: "execution-persisted-1:run:contracts:1",
    });
    expect(running).not.toHaveProperty("goal");
    expect(running).not.toHaveProperty("workspaceRoot");
    expect(running.nodes?.[0]).not.toHaveProperty("prompt");
    expect(running.pendingApprovals).toHaveLength(2);
    expect(paused.pausedFromStatus).toBe("running");
    expect(awaitingApproval.pendingApprovals[0]?.stage).toBe("before_finalize");
    expect(completed.resultSummary).toContain("控制面");
  });

  it("拒绝时间线、暂停、审批和终态字段不一致的 Squad execution", () => {
    const base = {
      executionId: "execution-invalid-1",
      squadId: "squad-validation",
      squadRevision: 1,
      projectId: "project-1",
      goalDigest: "sha256:invalid-goal",
      goalTaskId: "execution-invalid-1:task:leader-plan",
      workspaceRoot: "E:/workspace",
      workspaceRootDigest: "sha256:invalid-workspace",
      status: "running" as const,
      revision: 2,
      pendingApprovals: [],
      nodes: [
        {
          nodeId: "contracts",
          agentId: "agent-worker",
          taskId: "execution-invalid-1:task:contracts",
          runId: "execution-invalid-1:run:contracts:1",
          promptDigest: "sha256:invalid-contracts-prompt",
          dependsOnNodeIds: [],
        },
      ],
      leaderTaskId: "execution-invalid-1:leader",
      leaderRunId: "execution-invalid-1:leader:run:1",
      createdAtUnixMs: 100,
      startedAtUnixMs: 120,
      updatedAtUnixMs: 180,
    };

    expect(() =>
      decodePersistedSquadExecution({
        ...base,
        workspaceRootDigest: undefined,
      }),
    ).toThrow();
    expect(() =>
      decodePersistedSquadExecution({
        ...base,
        status: "paused",
        pausedAtUnixMs: 170,
      }),
    ).toThrow();
    expect(() =>
      decodePersistedSquadExecution({
        ...base,
        status: "awaiting_approval",
      }),
    ).toThrow();
    expect(() =>
      decodePersistedSquadExecution({
        ...base,
        status: "completed",
        finishedAtUnixMs: 180,
      }),
    ).toThrow();
    expect(() =>
      decodePersistedSquadExecution({
        ...base,
        status: "failed",
        finishedAtUnixMs: 180,
      }),
    ).toThrow();
    expect(() =>
      decodePersistedSquadExecution({
        ...base,
        updatedAtUnixMs: 110,
      }),
    ).toThrow();
    expect(() =>
      decodePersistedSquadExecution({
        ...base,
        pendingApprovals: [
          {
            approvalRequestId: "approval-missing-node-identity",
            stage: "before_mutating_tool",
            requestedAtUnixMs: 150,
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      decodePersistedSquadExecution({
        ...base,
        nodes: undefined,
      }),
    ).toThrow();
    expect(() =>
      decodePersistedSquadExecution({
        ...base,
        leaderTaskId: undefined,
      }),
    ).toThrow();
    expect(() =>
      decodePersistedSquadExecution({
        ...base,
        status: "completed",
        resultSummary: "错误时间线",
        finishedAtUnixMs: 110,
      }),
    ).toThrow();
    expect(() =>
      decodePersistedSquadExecution({
        ...base,
        status: "paused",
        pausedFromStatus: "running",
        pausedAtUnixMs: 110,
      }),
    ).toThrow();
    expect(
      validateCompositionSquadExecution({
        ...base,
        status: "paused",
        pausedFromStatus: "queued",
        pausedAtUnixMs: 180,
      }),
    ).toContainEqual({ code: "start_state_invalid", path: "startedAtUnixMs" });
    const approvalBeforeStartIssues = validateCompositionSquadExecution({
      ...base,
      status: "awaiting_approval",
      pendingApprovals: [
        {
          approvalRequestId: decodeApprovalRequestId("approval-before-start"),
          stage: "before_finalize",
          requestedAtUnixMs: 110,
        },
      ],
    });
    expect(() =>
      decodePersistedSquadExecution({
        ...base,
        status: "cancelled",
        cancelRequestedAtUnixMs: 170,
        finishedAtUnixMs: 160,
      }),
    ).toThrow();
    expect(() =>
      decodePersistedSquadExecution({
        executionId: "execution-cancelling-before-start",
        squadId: "squad-validation",
        squadRevision: 1,
        projectId: "project-1",
        goalDigest: "sha256:cancelling-before-start-goal",
        goalTaskId: "execution-cancelling-before-start:task:goal-input",
        workspaceRoot: "E:/workspace",
        workspaceRootDigest: "sha256:cancelling-before-start-workspace",
        status: "cancelling",
        revision: 2,
        leaderTaskId: "execution-cancelling-before-start:task:leader",
        leaderRunId: "execution-cancelling-before-start:run:leader:1",
        pendingApprovals: [],
        createdAtUnixMs: 100,
        cancelRequestedAtUnixMs: 120,
        updatedAtUnixMs: 120,
      }),
    ).toThrow();

    const runningWithGlobalApproval = validateCompositionSquadExecution({
      ...base,
      pendingApprovals: [
        {
          approvalRequestId: decodeApprovalRequestId("approval-before-dispatch-too-late"),
          stage: "before_dispatch",
          requestedAtUnixMs: 150,
        },
      ],
    });
    const orphanToolApproval = validateCompositionSquadExecution({
      ...base,
      pendingApprovals: [
        {
          approvalRequestId: decodeApprovalRequestId("approval-orphan-node"),
          stage: "before_mutating_tool",
          nodeId: "foreign-node",
          taskId: "foreign-task",
          runId: "foreign-run",
          agentId: "foreign-agent",
          capabilityId: "t3.workspace.write_file",
          toolCallId: "foreign-tool-call",
          requestedAtUnixMs: 150,
        },
      ],
    });

    expect(runningWithGlobalApproval).toContainEqual({
      code: "approval_state_invalid",
      path: "pendingApprovals",
    });
    expect(orphanToolApproval).toContainEqual({
      code: "approval_projection_invalid",
      path: "pendingApprovals.0.nodeId",
    });
    expect(approvalBeforeStartIssues).toContainEqual({
      code: "timestamp_order_invalid",
      path: "pendingApprovals.0.requestedAtUnixMs",
    });
  });

  it("拒绝不可恢复的节点图、身份碰撞和跨 Run 审批", () => {
    const running = decodePersistedSquadExecution({
      executionId: "execution-contract-invariants",
      squadId: "squad-validation",
      squadRevision: 1,
      projectId: "project-1",
      goalDigest: "sha256:contract-invariants-goal",
      goalTaskId: "execution-contract-invariants:task:goal-input",
      workspaceRoot: "E:/workspace",
      workspaceRootDigest: "sha256:contract-invariants-workspace",
      status: "running",
      revision: 3,
      nodes: [
        {
          nodeId: "contracts",
          agentId: "agent-worker",
          taskId: "execution-contract-invariants:task:contracts",
          runId: "execution-contract-invariants:run:contracts:1",
          promptDigest: "sha256:contracts-prompt",
          dependsOnNodeIds: [],
        },
        {
          nodeId: "review",
          agentId: "agent-reviewer",
          taskId: "execution-contract-invariants:task:review",
          runId: "execution-contract-invariants:run:review:1",
          promptDigest: "sha256:review-prompt",
          dependsOnNodeIds: ["contracts"],
        },
      ],
      leaderTaskId: "execution-contract-invariants:task:leader",
      leaderRunId: "execution-contract-invariants:run:leader:1",
      pendingApprovals: [],
      createdAtUnixMs: 100,
      startedAtUnixMs: 120,
      updatedAtUnixMs: 180,
    });
    const [contracts, review] = running.nodes ?? [];
    expect(contracts).toBeDefined();
    expect(review).toBeDefined();

    const duplicateDependencyIssues = validateCompositionSquadExecution({
      ...running,
      nodes: [
        { ...contracts!, dependsOnNodeIds: ["review", "review"] },
        { ...review!, dependsOnNodeIds: [] },
      ],
    });
    const dependencyCycleIssues = validateCompositionSquadExecution({
      ...running,
      nodes: [
        { ...contracts!, dependsOnNodeIds: ["review"] },
        { ...review!, dependsOnNodeIds: ["contracts"] },
      ],
    });
    const foreignRunApprovalIssues = validateCompositionSquadExecution({
      ...running,
      pendingApprovals: [
        {
          approvalRequestId: decodeApprovalRequestId("approval-foreign-run"),
          stage: "before_mutating_tool",
          nodeId: "contracts",
          taskId: "execution-contract-invariants:task:contracts",
          runId: "foreign-execution:run:contracts:1",
          agentId: "agent-worker",
          capabilityId: "t3.workspace.write_file",
          toolCallId: "tool-foreign-run",
          requestedAtUnixMs: 150,
        },
      ],
    });
    const leaderTaskCollisionIssues = validateCompositionSquadExecution({
      ...running,
      leaderTaskId: "execution-contract-invariants:task:contracts",
    });
    const goalTaskCollisionIssues = validateCompositionSquadExecution({
      ...running,
      goalTaskId: "execution-contract-invariants:task:contracts",
    });
    const leaderRunCollisionIssues = validateCompositionSquadExecution({
      ...running,
      leaderRunId: "execution-contract-invariants:run:contracts:1",
    });
    const awaitingToolApprovalIssues = validateCompositionSquadExecution({
      ...running,
      status: "awaiting_approval",
      pendingApprovals: [
        {
          approvalRequestId: decodeApprovalRequestId("approval-awaiting-tool"),
          stage: "before_mutating_tool",
          nodeId: "contracts",
          taskId: "execution-contract-invariants:task:contracts",
          runId: "execution-contract-invariants:run:contracts:1",
          agentId: "agent-worker",
          capabilityId: "t3.workspace.write_file",
          toolCallId: "tool-awaiting",
          requestedAtUnixMs: 150,
        },
      ],
    });

    expect(duplicateDependencyIssues).toContainEqual({
      code: "node_projection_invalid",
      path: "nodes.0.dependsOnNodeIds",
    });
    expect(dependencyCycleIssues).toContainEqual({
      code: "node_projection_invalid",
      path: "nodes.0.dependsOnNodeIds",
    });
    expect(foreignRunApprovalIssues).toContainEqual({
      code: "approval_projection_invalid",
      path: "pendingApprovals.0.runId",
    });
    expect(leaderTaskCollisionIssues).toContainEqual({
      code: "graph_identity_invalid",
      path: "leaderTaskId",
    });
    expect(goalTaskCollisionIssues).toContainEqual({
      code: "graph_identity_invalid",
      path: "goalTaskId",
    });
    expect(leaderRunCollisionIssues).toContainEqual({
      code: "graph_identity_invalid",
      path: "leaderRunId",
    });
    expect(awaitingToolApprovalIssues).toContainEqual({
      code: "approval_state_invalid",
      path: "pendingApprovals",
    });
  });

  it("保留取消失败的请求事实并拒绝重复审批身份", () => {
    const cancelledAsFailure = decodePersistedSquadExecution({
      executionId: "execution-cancel-failed",
      squadId: "squad-validation",
      squadRevision: 1,
      projectId: "project-1",
      goalDigest: "sha256:cancel-failed-goal",
      goalTaskId: "execution-cancel-failed:task:leader-plan",
      workspaceRoot: "E:/workspace",
      workspaceRootDigest: "sha256:cancel-failed-workspace",
      status: "failed",
      revision: 4,
      pendingApprovals: [],
      leaderTaskId: "execution-cancel-failed:leader",
      leaderRunId: "execution-cancel-failed:leader:run:1",
      failureCode: "squad_cancel_cleanup_failed",
      failureDetail: "一个子任务未确认取消。",
      createdAtUnixMs: 100,
      startedAtUnixMs: 110,
      cancelRequestedAtUnixMs: 160,
      finishedAtUnixMs: 180,
      updatedAtUnixMs: 180,
    });

    expect(cancelledAsFailure.cancelRequestedAtUnixMs).toBe(160);
    expect(() =>
      decodePersistedSquadExecution({
        ...cancelledAsFailure,
        status: "running",
        revision: 5,
        failureCode: undefined,
        failureDetail: undefined,
        finishedAtUnixMs: undefined,
        cancelRequestedAtUnixMs: undefined,
        nodes: [
          {
            nodeId: "contracts",
            agentId: "agent-worker",
            taskId: "execution-cancel-failed:task:contracts",
            runId: "execution-cancel-failed:run:contracts:1",
            promptDigest: "sha256:duplicate-approval-prompt",
            dependsOnNodeIds: [],
          },
        ],
        pendingApprovals: [
          {
            approvalRequestId: "approval-duplicate",
            stage: "before_mutating_tool",
            nodeId: "contracts",
            taskId: "execution-cancel-failed:task:contracts",
            runId: "execution-cancel-failed:run:contracts:1",
            agentId: "agent-worker",
            capabilityId: "t3.workspace.write_file",
            toolCallId: "tool-duplicate-1",
            requestedAtUnixMs: 150,
          },
          {
            approvalRequestId: "approval-duplicate",
            stage: "before_mutating_tool",
            nodeId: "contracts",
            taskId: "execution-cancel-failed:task:contracts",
            runId: "execution-cancel-failed:run:contracts:2",
            agentId: "agent-worker",
            capabilityId: "t3.workspace.write_file",
            toolCallId: "tool-duplicate-2",
            requestedAtUnixMs: 155,
          },
        ],
      }),
    ).toThrow();

    const duplicateIssues = validateCompositionSquadExecution({
      ...cancelledAsFailure,
      status: "running",
      revision: 5,
      failureCode: undefined,
      failureDetail: undefined,
      finishedAtUnixMs: undefined,
      cancelRequestedAtUnixMs: undefined,
      nodes: [
        {
          nodeId: "contracts",
          agentId: "agent-worker",
          taskId: "execution-cancel-failed:task:contracts",
          runId: "execution-cancel-failed:run:contracts:1",
          promptDigest: "sha256:duplicate-approval-prompt",
          dependsOnNodeIds: [],
        },
      ],
      pendingApprovals: [
        {
          approvalRequestId: decodeApprovalRequestId("approval-duplicate"),
          stage: "before_mutating_tool",
          nodeId: "contracts",
          taskId: "execution-cancel-failed:task:contracts",
          runId: "execution-cancel-failed:run:contracts:1",
          agentId: "agent-worker",
          capabilityId: "t3.workspace.write_file",
          toolCallId: "tool-duplicate-1",
          requestedAtUnixMs: 150,
        },
        {
          approvalRequestId: decodeApprovalRequestId("approval-duplicate"),
          stage: "before_mutating_tool",
          nodeId: "contracts",
          taskId: "execution-cancel-failed:task:contracts",
          runId: "execution-cancel-failed:run:contracts:2",
          agentId: "agent-worker",
          capabilityId: "t3.workspace.write_file",
          toolCallId: "tool-duplicate-2",
          requestedAtUnixMs: 155,
        },
      ],
    });
    expect(duplicateIssues).toContainEqual({
      code: "duplicate_approval_request",
      path: "pendingApprovals.approvalRequestId",
    });
  });

  it("只允许状态机声明的 Squad execution 状态迁移", () => {
    expect(
      isCompositionSquadExecutionStatusTransitionAllowed({ from: "queued", to: "planning" }),
    ).toBe(true);
    expect(
      isCompositionSquadExecutionStatusTransitionAllowed({
        from: "planning",
        to: "awaiting_approval",
      }),
    ).toBe(true);
    expect(
      isCompositionSquadExecutionStatusTransitionAllowed({
        from: "running",
        to: "paused",
        pausedFromStatus: "running",
      }),
    ).toBe(true);
    expect(
      isCompositionSquadExecutionStatusTransitionAllowed({
        from: "queued",
        to: "paused",
        pausedFromStatus: "running",
      }),
    ).toBe(false);
    expect(
      isCompositionSquadExecutionStatusTransitionAllowed({ from: "running", to: "paused" }),
    ).toBe(false);
    expect(
      isCompositionSquadExecutionStatusTransitionAllowed({
        from: "paused",
        to: "running",
        pausedFromStatus: "running",
      }),
    ).toBe(true);
    expect(
      isCompositionSquadExecutionStatusTransitionAllowed({
        from: "paused",
        to: "awaiting_approval",
        pausedFromStatus: "awaiting_approval",
      }),
    ).toBe(true);
    expect(
      isCompositionSquadExecutionStatusTransitionAllowed({ from: "running", to: "cancelling" }),
    ).toBe(true);
    expect(
      isCompositionSquadExecutionStatusTransitionAllowed({ from: "cancelling", to: "cancelled" }),
    ).toBe(true);
    expect(
      isCompositionSquadExecutionStatusTransitionAllowed({ from: "queued", to: "failed" }),
    ).toBe(false);
    expect(
      isCompositionSquadExecutionStatusTransitionAllowed({ from: "queued", to: "cancelling" }),
    ).toBe(false);
    expect(
      isCompositionSquadExecutionStatusTransitionAllowed({ from: "queued", to: "cancelled" }),
    ).toBe(true);
    expect(
      isCompositionSquadExecutionStatusTransitionAllowed({
        from: "paused",
        to: "cancelled",
        pausedFromStatus: "queued",
      }),
    ).toBe(true);
    expect(
      isCompositionSquadExecutionStatusTransitionAllowed({
        from: "paused",
        to: "cancelling",
        pausedFromStatus: "queued",
      }),
    ).toBe(false);

    expect(
      isCompositionSquadExecutionStatusTransitionAllowed({
        from: "paused",
        to: "running",
        pausedFromStatus: "awaiting_approval",
      }),
    ).toBe(false);
    expect(
      isCompositionSquadExecutionStatusTransitionAllowed({ from: "running", to: "running" }),
    ).toBe(false);
    expect(
      isCompositionSquadExecutionStatusTransitionAllowed({ from: "running", to: "cancelled" }),
    ).toBe(false);
    expect(
      isCompositionSquadExecutionStatusTransitionAllowed({ from: "paused", to: "completed" }),
    ).toBe(false);
    expect(
      isCompositionSquadExecutionStatusTransitionAllowed({ from: "completed", to: "running" }),
    ).toBe(false);
    expect(
      isCompositionSquadExecutionStatusTransitionAllowed({ from: "cancelled", to: "queued" }),
    ).toBe(false);
  });

  it("定义 Leader、依赖节点和 retry 次数的 Task Graph RPC 合同", () => {
    const decoded = decodeTaskGraph({
      leader: {
        taskId: "leader-task",
        runId: "leader-run",
        projectId: "project-1",
        assigneeKind: "agent",
        assigneeId: "leader-agent",
        promptDigest: "sha256:leader",
        prompt: "汇总结果",
        workspaceRoot: "C:/workspace",
      },
      children: [
        {
          nodeId: "child-a",
          taskId: "child-task-a",
          runId: "child-run-a",
          projectId: "project-1",
          assigneeKind: "agent",
          assigneeId: "agent-a",
          mode: "parallel",
          promptDigest: "sha256:a",
          prompt: "执行 A",
          workspaceRoot: "C:/workspace",
          dependsOnNodeIds: [],
          maxAttempts: 2,
        },
      ],
      schedule: "parallel",
      maxConcurrency: 2,
      failurePolicy: "continue_independent",
      partialSuccessPolicy: "require_review",
    });

    expect(decoded.children[0]?.dependsOnNodeIds).toEqual([]);
    expect(decoded.children[0]?.maxAttempts).toBe(2);
    expect(decoded.maxConcurrency).toBe(2);
    expect(decoded.failurePolicy).toBe("continue_independent");
    expect(decoded.partialSuccessPolicy).toBe("require_review");

    const decodedResult = decodeTaskGraphResult({
      leader: {
        task: {
          taskId: "leader-task",
          projectId: "project-1",
          assigneeKind: "agent",
          assigneeId: "leader-agent",
          mode: "review",
          status: "in_review",
          promptDigest: "sha256:leader",
          dependsOnTaskIds: ["child-task-a"],
          createdAtUnixMs: 1,
          updatedAtUnixMs: 2,
        },
        run: {
          runId: "leader-run",
          taskId: "leader-task",
          agentId: "leader-agent",
          runtimeId: "runtime-1",
          status: "in_review",
          attempt: 1,
          capabilityGrantIds: [],
        },
      },
      children: [],
      failures: [
        {
          nodeId: "child-failed",
          kind: "failed",
          failureCode: "worker_failed",
          detail: "子任务失败",
        },
      ],
    });
    expect(decodedResult.leader.run.status).toBe("in_review");
    expect(decodedResult.failures?.[0]?.failureCode).toBe("worker_failed");
  });

  it("定义显式的 review approve/reject 合同", () => {
    const approved = decodeTaskReview({
      taskId: "task-review",
      runId: "run-review",
      decision: "approve",
      reason: "Reviewer 已确认结果可合并",
    });
    const rejected = decodeTaskReview({
      taskId: "task-review",
      runId: "run-review",
      decision: "reject",
      reason: "缺少回归测试",
    });

    expect(approved.decision).toBe("approve");
    expect(rejected.decision).toBe("reject");
  });

  it("要求重试使用新的 runId，并可显式重派到目标 Agent", () => {
    const decoded = decodeTaskRetry({
      taskId: "task-retry",
      previousRunId: "run-old",
      runId: "run-retry-2",
      agentId: "agent-replacement",
      reason: "修复审核反馈后重试",
      capabilityIds: ["t3.workspace.read_file"],
    });

    expect(decoded.previousRunId).toBe("run-old");
    expect(decoded.runId).toBe("run-retry-2");
    expect(decoded.agentId).toBe("agent-replacement");
    expect(decoded.capabilityIds).toEqual(["t3.workspace.read_file"]);

    const retriedWithOriginalAgent = decodeTaskRetry({
      taskId: "task-retry",
      previousRunId: "run-old",
      runId: "run-retry-3",
      reason: "继续使用原 Agent 重试",
      capabilityIds: ["t3.workspace.read_file"],
    });
    expect(retriedWithOriginalAgent.agentId).toBeUndefined();
  });

  it("定义同一 Run 的 Runtime Resume 合同", () => {
    const request = decodeTaskResume({
      taskId: "task-resume",
      runId: "run-resume",
      reason: "连接恢复后继续执行",
    });
    const result = decodeTaskResumeResult({
      task: {
        taskId: "task-resume",
        projectId: "project-1",
        assigneeKind: "agent",
        assigneeId: "agent-1",
        mode: "serial",
        status: "running",
        promptDigest: "sha256:resume",
        dependsOnTaskIds: [],
        createdAtUnixMs: 1,
        updatedAtUnixMs: 2,
      },
      run: {
        runId: "run-resume",
        taskId: "task-resume",
        agentId: "agent-1",
        runtimeId: "runtime-1",
        runtimeTaskId: "runtime-task-resume",
        capabilityHandshakeId: "handshake-resume",
        status: "running",
        attempt: 1,
        capabilityGrantIds: ["grant-resume"],
      },
      status: "accepted",
    });

    expect(request.runId).toBe(result.run.runId);
    expect(result.run.capabilityGrantIds).toEqual(["grant-resume"]);
  });
  it("描述 task-scoped capability grant 和脱敏审计事件", () => {
    const grant = decodeCapabilityGrant({
      grantId: "grant-1",
      taskId: "task-1",
      agentId: "agent-1",
      capabilityId: "t3.workspace.read_file",
      issuedAtUnixMs: 100,
      expiresAtUnixMs: 200,
      revokedAtUnixMs: undefined,
    });
    const audit = decodeCapabilityAuditEvent({
      auditId: "audit-1",
      grantId: "grant-1",
      taskId: "task-1",
      runId: "run-1",
      agentId: "agent-1",
      capabilityId: "t3.workspace.read_file",
      operation: "read",
      outcome: "allowed",
      occurredAtUnixMs: 150,
    });

    expect(grant.expiresAtUnixMs).toBe(200);
    expect(audit.outcome).toBe("allowed");
    expect((audit as Record<string, unknown>).arguments).toBeUndefined();
  });

  it("accepts a legacy text request without agent identity", () => {
    const decoded = decodeAgentLoopRequest({
      mode: "legacy_text",
      providerInstanceId: "byok",
      modelId: "gpt-4o-mini",
      threadId: "thread-1",
    });

    expect(decoded.mode).toBe("legacy_text");
    expect("taskId" in decoded).toBe(false);
    expect("agentId" in decoded).toBe(false);
  });

  it("requires task, agent, and grants for agent_loop requests", () => {
    expect(() =>
      decodeAgentLoopRequest({
        mode: "agent_loop",
        providerInstanceId: "byok",
        modelId: "gpt-4o-mini",
        threadId: "thread-1",
      }),
    ).toThrow();

    const decoded = decodeAgentLoopRequest({
      mode: "agent_loop",
      providerInstanceId: "byok",
      modelId: "gpt-4o-mini",
      threadId: "thread-1",
      taskId: "task-1",
      agentId: "agent-1",
      capabilityGrantIds: ["grant-1"],
    });

    if (decoded.mode === "agent_loop") {
      expect(decoded.capabilityGrantIds).toEqual(["grant-1"]);
    }
  });

  it("keeps capability status separate from grant and approval state", () => {
    const decoded = decodeCapability({
      capabilityId: "workspace.read",
      kind: "tool",
      status: "available",
      grants: {
        read: true,
        execute: false,
        mutate: false,
      },
      approval: "never",
      source: "t3",
    });

    expect(decoded.status).toBe("available");
    expect(decoded.grants.read).toBe(true);
    expect(decoded.grants.mutate).toBe(false);
  });

  it("accepts explicit policy outcomes and rejects unknown decisions", () => {
    expect(
      decodePolicyDecision({
        decision: "approval_required",
        reasonCode: "tool_approval_required",
        approvalRequestId: "approval-1",
      }).decision,
    ).toBe("approval_required");

    expect(() =>
      decodePolicyDecision({
        decision: "maybe",
        reasonCode: "unknown",
      }),
    ).toThrow();
  });

  it("enforces ordered task event metadata and bounded progress", () => {
    const decoded = decodeTaskEvent({
      taskId: "task-1",
      runId: "run-1",
      agentId: "agent-1",
      status: "running",
      sequence: 3,
      eventType: "progress",
      summary: "读取工作区",
      progress: 25,
    });

    expect(decoded.sequence).toBe(3);
    expect(decoded.progress).toBe(25);
    expect(() =>
      decodeTaskEvent({
        taskId: "task-1",
        runId: "run-1",
        agentId: "agent-1",
        status: "running",
        sequence: 4,
        eventType: "progress",
        summary: "超出范围",
        progress: 101,
      }),
    ).toThrow();
  });

  it("keeps tool invocation and result identities stable", () => {
    const invocation = decodeToolInvocation({
      taskId: "task-1",
      runId: "run-1",
      agentId: "agent-1",
      toolCallId: "call-1",
      canonicalToolName: "workspace.read",
      arguments: { relativePath: "README.md" },
      idempotencyKey: "idem-1",
    });
    const result = decodeToolResult({
      invocationId: "invocation-1",
      taskId: "task-1",
      runId: "run-1",
      toolCallId: invocation.toolCallId,
      canonicalToolName: invocation.canonicalToolName,
      status: "succeeded",
      result: { contents: "ok" },
    });

    expect(result.toolCallId).toBe(invocation.toolCallId);
    expect(result.canonicalToolName).toBe(invocation.canonicalToolName);
  });

  it("keeps runtime tool calls scoped and does not accept an external workspace root", () => {
    const decoded = decodeRuntimeToolInvocation({
      schemaVersion: 1,
      runtimeId: "runtime-1",
      taskId: "task-1",
      runId: "run-1",
      agentId: "agent-1",
      capabilityHandshakeId: "handshake-1",
      toolCallId: "call-1",
      canonicalToolName: "workspace.read_file",
      arguments: { cwd: "runtime-controlled-path", relativePath: "README.md" },
      idempotencyKey: "idem-1",
      capabilityGrantIds: ["grant-1"],
    });

    expect(decoded.runtimeId).toBe("runtime-1");
    expect("workspaceRoot" in decoded).toBe(false);
    expect(() =>
      decodeRuntimeToolInvocation({
        runtimeId: "runtime-1",
        taskId: "task-1",
        runId: "run-1",
        agentId: "agent-1",
        toolCallId: "call-1",
        canonicalToolName: "workspace.read_file",
        arguments: {},
        idempotencyKey: "idem-1",
        capabilityGrantIds: [],
      }),
    ).toThrow();
  });

  it("keeps runtime tool cancellation on the same task/run/grant contract", () => {
    const decoded = decodeRuntimeToolCancellation({
      schemaVersion: 1,
      runtimeId: "runtime-1",
      taskId: "task-1",
      runId: "run-1",
      agentId: "agent-1",
      capabilityHandshakeId: "handshake-1",
      toolCallId: "call-1",
      canonicalToolName: "terminal.open",
      idempotencyKey: "idem-cancel-1",
      capabilityGrantIds: ["grant-1"],
    });

    expect(decoded.idempotencyKey).toBe("idem-cancel-1");
    expect(decoded.capabilityGrantIds).toEqual(["grant-1"]);
  });

  it("keeps the explicit agent loop RPC payload separate from legacy text turns", () => {
    const decoded = decodeAgentLoopRunRequest({
      mode: "agent_loop",
      providerInstanceId: "byok",
      modelId: "openai/gpt-5",
      taskId: "task-1",
      runId: "run-1",
      agentId: "agent-1",
      workspaceRoot: "C:/workspace",
      prompt: "检查项目",
      capabilityGrantIds: ["t3.workspace.read_file"],
      tools: [],
      maxContextMessages: 9,
      maxToolResultChars: 12_000,
    });

    expect(decoded.mode).toBe("agent_loop");
    expect(decoded.maxContextMessages).toBe(9);
    expect(decoded.maxToolResultChars).toBe(12_000);
    expect(() =>
      decodeAgentLoopRunRequest({
        ...decoded,
        maxContextMessages: 2,
      }),
    ).toThrow();
    expect(() =>
      decodeAgentLoopRunRequest({
        ...decoded,
        maxContextMessages: 66,
      }),
    ).toThrow();
    expect(() =>
      decodeAgentLoopRunRequest({
        ...decoded,
        maxToolResultChars: 127,
      }),
    ).toThrow();
    expect(() =>
      decodeAgentLoopRunRequest({
        ...decoded,
        maxToolResultChars: 120_001,
      }),
    ).toThrow();
    expect(decodeAgentLoopRunResult({ text: "完成", rounds: 1 }).rounds).toBe(1);
  });

  it("keeps the full dispatch prompt transient while exposing stable task identities", () => {
    const dispatch = decodeTaskDispatch({
      taskId: "task-1",
      runId: "run-1",
      projectId: "project-1",
      assigneeKind: "agent",
      assigneeId: "provider:codex",
      mode: "serial",
      promptDigest: "sha256:prompt",
      prompt: "检查工作区",
      workspaceRoot: "C:/workspace",
      dependsOnTaskIds: [],
    });
    expect(dispatch.prompt).toBe("检查工作区");
    expect(decodeTaskCancel({ taskId: "task-1", runId: "run-1", reason: "用户取消" }).reason).toBe(
      "用户取消",
    );
    expect(
      decodeTaskEvents({
        taskId: "task-1",
        runId: "run-1",
        events: [],
      }).events,
    ).toEqual([]);
    expect(decodeTaskList({ projectId: "project-1" }).projectId).toBe("project-1");
    expect(
      decodeTaskListResult({
        tasks: [
          {
            task: {
              taskId: "task-1",
              projectId: "project-1",
              assigneeKind: "agent",
              assigneeId: "agent-1",
              mode: "parallel",
              status: "running",
              promptDigest: "sha256:prompt",
              dependsOnTaskIds: [],
              createdAtUnixMs: 1,
              updatedAtUnixMs: 2,
            },
            latestRun: {
              runId: "run-1",
              taskId: "task-1",
              agentId: "agent-1",
              runtimeId: "runtime-1",
              status: "running",
              attempt: 1,
              capabilityGrantIds: [],
            },
          },
        ],
      }).tasks[0]?.latestRun?.runId,
    ).toBe("run-1");
  });
});

const controlCenterTask = (
  overrides: Partial<CompositionControlCenterTask> = {},
): CompositionControlCenterTask => ({
  taskId: "task-1",
  status: "failed",
  agentId: "agent-1",
  updatedAtUnixMs: 0,
  dependsOnTaskIds: [],
  ...overrides,
});

const controlCenterRun = (
  overrides: Partial<NonNullable<CompositionControlCenterTask["latestRun"]>> = {},
): NonNullable<CompositionControlCenterTask["latestRun"]> => ({
  runId: "run-1",
  status: "failed",
  attempt: 1,
  ...overrides,
});

describe("isByokResumeRedispatchable", () => {
  it("requires a latest run and rejects already-settled redispatch rows", () => {
    expect(
      isByokResumeRedispatchable(
        controlCenterTask({
          latestRun: controlCenterRun({ failureCode: "byok_resume_interrupted" }),
        }),
      ),
    ).toBe(true);
    expect(
      isByokResumeRedispatchable(
        controlCenterTask({
          latestRun: controlCenterRun(),
          byokResume: {
            runId: "run-1",
            checkpointCount: 1,
            recoveredUtf8Bytes: 8,
            recoverable: true,
            redispatchSettled: false,
          },
        }),
      ),
    ).toBe(true);
    expect(
      isByokResumeRedispatchable(
        controlCenterTask({
          latestRun: controlCenterRun(),
          byokResume: {
            runId: "run-1",
            checkpointCount: 1,
            recoveredUtf8Bytes: 0,
            recoverable: false,
            redispatchSettled: false,
            recoveryFailureCode: "digest_mismatch",
          },
        }),
      ),
    ).toBe(false);
    expect(
      isByokResumeRedispatchable(
        controlCenterTask({
          latestRun: controlCenterRun({ failureCode: "byok_resume_interrupted" }),
          byokResume: {
            runId: "run-1",
            checkpointCount: 1,
            recoveredUtf8Bytes: 8,
            recoverable: true,
            redispatchSettled: true,
          },
        }),
      ),
    ).toBe(false);
    expect(isByokResumeRedispatchable(controlCenterTask({ latestRun: controlCenterRun() }))).toBe(
      false,
    );
    expect(
      isByokResumeRedispatchable(
        controlCenterTask({
          byokResume: {
            runId: "run-1",
            checkpointCount: 1,
            recoveredUtf8Bytes: 8,
            recoverable: true,
            redispatchSettled: false,
          },
        }),
      ),
    ).toBe(false);
  });
});

describe("isByokDelegationControlTask", () => {
  it("treats the optional byokDelegation field as the discriminator", () => {
    expect(isByokDelegationControlTask(controlCenterTask())).toBe(false);
    expect(
      isByokDelegationControlTask(
        controlCenterTask({
          byokDelegation: {
            runId: "run-1",
            delegationId: "delegation-1",
            status: "running",
            attempt: 1,
          },
        }),
      ),
    ).toBe(true);
  });
});
