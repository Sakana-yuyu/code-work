import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  CompositionAgentLoopRequest,
  CompositionAgentLoopRunRequest,
  CompositionAgentLoopRunResult,
  CompositionCapabilityDescriptor,
  CompositionCapabilityGrant,
  CompositionCapabilityAuditEvent,
  CompositionCapabilityPolicyDecision,
  CompositionSquad,
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
  isByokResumeRedispatchable,
  isByokDelegationControlTask,
} from "./composition.ts";

const decodeAgentLoopRequest = Schema.decodeUnknownSync(CompositionAgentLoopRequest);
const decodeCapability = Schema.decodeUnknownSync(CompositionCapabilityDescriptor);
const decodeCapabilityGrant = Schema.decodeUnknownSync(CompositionCapabilityGrant);
const decodeCapabilityAuditEvent = Schema.decodeUnknownSync(CompositionCapabilityAuditEvent);
const decodePolicyDecision = Schema.decodeUnknownSync(CompositionCapabilityPolicyDecision);
const decodeSquad = Schema.decodeUnknownSync(CompositionSquad);
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
    });

    expect(decoded.children[0]?.dependsOnNodeIds).toEqual([]);
    expect(decoded.children[0]?.maxAttempts).toBe(2);

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
    });
    expect(decodedResult.leader.run.status).toBe("in_review");
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

  it("要求重试使用新的 runId，并显式声明本次 capabilityIds", () => {
    const decoded = decodeTaskRetry({
      taskId: "task-retry",
      previousRunId: "run-old",
      runId: "run-retry-2",
      reason: "修复审核反馈后重试",
      capabilityIds: ["t3.workspace.read_file"],
    });

    expect(decoded.previousRunId).toBe("run-old");
    expect(decoded.runId).toBe("run-retry-2");
    expect(decoded.capabilityIds).toEqual(["t3.workspace.read_file"]);
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
