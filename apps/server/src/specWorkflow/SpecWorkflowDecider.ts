import {
  SpecWorkflowState,
  SpecWorkflowStage,
  SpecWorkflowStartInput,
  type SpecWorkflowCommand,
  type SpecWorkflowStateEvent,
  type SpecWorkflowTransitionAction,
} from "@codework/contracts";
import * as Schema from "effect/Schema";

export const SpecWorkflowTransitionErrorCode = Schema.Literals([
  "invalid-transition",
  "gate-blocked",
  "revision-conflict",
  "invalid-state",
]);
export type SpecWorkflowTransitionErrorCode = typeof SpecWorkflowTransitionErrorCode.Type;

export class SpecWorkflowTransitionError extends Schema.TaggedErrorClass<SpecWorkflowTransitionError>()(
  "SpecWorkflowTransitionError",
  {
    code: SpecWorkflowTransitionErrorCode,
    detail: Schema.String,
    from: SpecWorkflowStage,
    to: Schema.optional(SpecWorkflowStage),
  },
) {
  override get message(): string {
    return `Spec Workflow 状态转换失败：${this.code}: ${this.detail}`;
  }
}

const reject = (
  code: SpecWorkflowTransitionErrorCode,
  detail: string,
  from: SpecWorkflowStage,
  to?: SpecWorkflowStage,
): never => {
  throw new SpecWorkflowTransitionError({
    code,
    detail,
    from,
    ...(to === undefined ? {} : { to }),
  });
};

export const isSpecWorkflowStageAllowed = (
  state: SpecWorkflowState,
  to: SpecWorkflowStage,
): boolean => {
  switch (state.stage) {
    case "research":
      return state.tbdCount > 0 ? to === "ask" : to === "design" || to === "propose";
    case "ask":
      return state.tbdCount === 0 && to === "research";
    case "design":
      return to === "propose";
    case "propose":
      return to === "awaitingApproval";
    case "awaitingApproval":
      return (
        (state.proposalStatus === "approved" && to === "apply") ||
        (state.proposalStatus === "rejected" && to === "revise")
      );
    case "revise":
      return to === "awaitingApproval";
    case "apply":
      return (
        (state.implementationCompleted && to === "verify") ||
        (state.activeTaskId === null &&
          (state.mode === "fix" || !state.implementationCompleted) &&
          to === "apply")
      );
    case "verify":
      return (
        (state.verificationStatus === "failed" && to === "apply") ||
        (state.verificationStatus === "passed" && to === "acceptance")
      );
    case "acceptance":
      return state.acceptanceStatus === "passed" && to === "archive";
    default:
      return false;
  }
};

const withRevision = (
  state: SpecWorkflowState,
  now: number,
  patch: Partial<SpecWorkflowState>,
  action: SpecWorkflowTransitionAction,
): SpecWorkflowStateEvent => ({
  type: "state-changed",
  action,
  state: {
    ...state,
    ...patch,
    revision: state.revision + 1,
    updatedAt: now,
  },
});

export const startSpecWorkflow = (input: SpecWorkflowStartInput): SpecWorkflowStateEvent => ({
  type: "started",
  state: {
    workflowId: input.workflowId,
    projectId: input.projectId,
    threadId: input.threadId,
    changeName: input.changeName,
    mode: input.mode,
    stage: input.mode === "fix" ? "apply" : "research",
    status: "active",
    revision: 1,
    tbdCount: 0,
    proposalStatus: "pending",
    implementationCompleted: false,
    verificationStatus: "pending",
    acceptanceStatus: "pending",
    activeTaskId: null,
    lastError: null,
    updatedAt: input.updatedAt,
  },
});

export const transitionSpecWorkflowState = (
  state: SpecWorkflowState,
  command: SpecWorkflowCommand,
  now: number,
): SpecWorkflowStateEvent => {
  if (state.revision !== command.expectedRevision) {
    return reject("revision-conflict", "工作流状态已被其他操作更新，请刷新后重试。", state.stage);
  }
  if (state.status === "completed") {
    return reject("invalid-state", "已归档的工作流不能继续修改。", state.stage);
  }
  if (
    state.status === "paused" &&
    command.type !== "resume" &&
    command.type !== "record-task-result"
  ) {
    return reject("gate-blocked", "工作流已暂停，请先恢复后再执行阶段操作。", state.stage);
  }

  switch (command.type) {
    case "advance":
      if (!isSpecWorkflowStageAllowed(state, command.to)) {
        return reject(
          state.stage === "research" && state.tbdCount > 0 ? "gate-blocked" : "invalid-transition",
          state.stage === "research" && state.tbdCount > 0
            ? "研究阶段仍有未处理的 TBD，必须先进入澄清阶段。"
            : `不能从 ${state.stage} 进入 ${command.to}。`,
          state.stage,
          command.to,
        );
      }
      return withRevision(
        state,
        now,
        {
          stage: command.to,
          ...(command.activeTaskId === undefined ? {} : { activeTaskId: command.activeTaskId }),
          ...(command.loopConfig === undefined ? {} : { loopConfig: command.loopConfig }),
          ...(command.to === "awaitingApproval" ? { proposalStatus: "pending" as const } : {}),
          ...(command.to === "revise" ? { proposalStatus: "rejected" as const } : {}),
          ...(command.to === "apply" && state.stage === "verify"
            ? { implementationCompleted: false }
            : {}),
          ...(command.to === "apply" && state.mode === "fix" && state.stage === "apply"
            ? {
                implementationCompleted: false,
                verificationStatus: "pending" as const,
                acceptanceStatus: "pending" as const,
                lastError: null,
              }
            : {}),
          ...(command.to === "archive" ? { status: "completed" as const } : {}),
        },
        "advance",
      );
    case "set-tbd-count":
      if (state.stage !== "research" && state.stage !== "ask") {
        return reject("invalid-transition", "只有研究或澄清阶段可以更新 TBD 数量。", state.stage);
      }
      return withRevision(state, now, { tbdCount: command.tbdCount }, "set-tbd-count");
    case "approve-proposal":
      if (state.stage !== "awaitingApproval") {
        return reject("gate-blocked", "只有等待方案确认时才能批准方案。", state.stage);
      }
      return withRevision(state, now, { proposalStatus: "approved" }, "approve-proposal");
    case "reject-proposal":
      if (state.stage !== "awaitingApproval") {
        return reject("gate-blocked", "只有等待方案确认时才能拒绝方案。", state.stage);
      }
      return withRevision(state, now, { proposalStatus: "rejected" }, "reject-proposal");
    case "mark-implementation-complete":
      if (state.stage !== "apply") {
        return reject("gate-blocked", "只有实施阶段可以提交实施完成。", state.stage);
      }
      return withRevision(
        state,
        now,
        { implementationCompleted: true },
        "mark-implementation-complete",
      );
    case "record-verification":
      if (state.stage !== "verify") {
        return reject("gate-blocked", "只有独立验证阶段可以记录验证结果。", state.stage);
      }
      return withRevision(
        state,
        now,
        { verificationStatus: command.passed ? "passed" : "failed" },
        "record-verification",
      );
    case "complete-acceptance":
      if (state.stage !== "acceptance") {
        return reject("gate-blocked", "只有最终验收阶段可以完成验收。", state.stage);
      }
      return withRevision(state, now, { acceptanceStatus: "passed" }, "complete-acceptance");
    case "record-task-result": {
      if (state.activeTaskId !== command.taskId) {
        return reject("invalid-state", "任务结果与当前工作流的 active Task 不匹配。", state.stage);
      }
      const succeeded = command.status === "completed";
      const error =
        command.error ??
        (command.status === "cancelled"
          ? "Composition Task 已取消。"
          : command.status === "timed_out"
            ? "Composition Task 执行超时。"
            : "Composition Task 执行失败。");
      if (state.stage === "apply") {
        return withRevision(
          state,
          now,
          {
            implementationCompleted: succeeded,
            activeTaskId: null,
            loopConfig: null,
            lastError: succeeded ? null : error,
          },
          "record-task-result",
        );
      }
      if (state.stage === "verify") {
        return withRevision(
          state,
          now,
          {
            verificationStatus: succeeded ? "passed" : "failed",
            activeTaskId: null,
            loopConfig: null,
            lastError: succeeded ? null : error,
          },
          "record-task-result",
        );
      }
      return reject(
        "invalid-state",
        "只有 apply 或 verify 阶段可以接收 Composition Task 结果。",
        state.stage,
      );
    }
    case "pause":
      if (state.status !== "active") {
        return reject("invalid-transition", "只有 active 工作流可以暂停。", state.stage);
      }
      return withRevision(state, now, { status: "paused" }, "pause");
    case "resume":
      if (state.status !== "paused") {
        return reject("invalid-transition", "只有 paused 工作流可以恢复。", state.stage);
      }
      return withRevision(state, now, { status: "active" }, "resume");
  }
};
