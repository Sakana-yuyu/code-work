import { assert, it } from "@effect/vitest";

import {
  ProjectId,
  ThreadId,
  type CompositionTaskRun,
  type SpecWorkflowState,
} from "@codework/contracts";
import { reactSpecWorkflowTaskCompletion } from "./SpecWorkflowReactor.ts";

const state = (overrides: Partial<SpecWorkflowState> = {}): SpecWorkflowState => ({
  workflowId: "workflow-reactor",
  projectId: ProjectId.make("project-reactor"),
  threadId: ThreadId.make("thread-reactor"),
  changeName: "reactor-change",
  mode: "full",
  stage: "apply",
  status: "active",
  revision: 6,
  tbdCount: 0,
  proposalStatus: "approved",
  implementationCompleted: true,
  verificationStatus: "pending",
  acceptanceStatus: "pending",
  activeTaskId: null,
  loopConfig: null,
  lastError: null,
  updatedAt: 7,
  ...overrides,
});

const run: CompositionTaskRun = {
  runId: "run-reactor",
  taskId: "task-reactor",
  agentId: "implementer",
  runtimeId: "runtime-reactor",
  status: "completed",
  attempt: 0,
  capabilityGrantIds: [],
};

it("apply 完成且有独立验证者时只产生 verify 派发动作", () => {
  const reaction = reactSpecWorkflowTaskCompletion({
    state: state(),
    completedStage: "apply",
    run,
    handoff: {
      workflowId: "workflow-reactor",
      projectId: state().projectId,
      threadId: state().threadId,
      changeName: "reactor-change",
      mode: "full",
      workspaceRoot: "C:/workspace/reactor",
      assigneeId: "implementer",
      prompt: "验证工作流。",
      promptDigest: "sha256:reactor",
      implementationAssigneeId: "implementer",
      independentVerifierId: "verifier",
    },
  });

  assert.equal(reaction.type, "dispatch");
  if (reaction.type === "dispatch") {
    assert.equal(reaction.intent, "verify");
    assert.equal(reaction.input.assigneeId, "verifier");
  }
});

it("verify 完成只推进到人工 acceptance，暂停或缺验证者不自动调用", () => {
  const acceptance = reactSpecWorkflowTaskCompletion({
    state: state({
      stage: "verify",
      implementationCompleted: true,
      verificationStatus: "passed",
    }),
    completedStage: "verify",
    run,
  });
  assert.deepEqual(acceptance, { type: "advance-acceptance" });

  assert.deepEqual(
    reactSpecWorkflowTaskCompletion({
      state: state({ status: "paused" }),
      completedStage: "apply",
      run,
    }),
    { type: "none", reason: "workflow-not-active" },
  );
  assert.deepEqual(
    reactSpecWorkflowTaskCompletion({ state: state(), completedStage: "apply", run }),
    { type: "none", reason: "independent-verifier-required" },
  );
});

it("fix 批次逐项完成后等待 ship，不对每一项自动独立验证", () => {
  assert.deepEqual(
    reactSpecWorkflowTaskCompletion({
      state: state({ mode: "fix" }),
      completedStage: "apply",
      run,
      handoff: {
        workflowId: "workflow-reactor",
        projectId: state().projectId,
        threadId: state().threadId,
        changeName: "reactor-change",
        mode: "fix",
        workspaceRoot: "C:/workspace/reactor",
        assigneeId: "implementer",
        prompt: "记录一个轻量修复。",
        promptDigest: "sha256:fix",
        implementationAssigneeId: "implementer",
        independentVerifierId: "verifier",
      },
    }),
    { type: "none", reason: "fix-batch-awaiting-ship" },
  );
});
