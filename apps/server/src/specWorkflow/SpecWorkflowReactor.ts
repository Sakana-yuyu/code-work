import type {
  CompositionTaskRun,
  SpecWorkflowDispatchInput,
  SpecWorkflowState,
  SpecWorkflowIntentName,
} from "@codework/contracts";

export type SpecWorkflowStageHandoff = Omit<SpecWorkflowDispatchInput, "intent">;

export type SpecWorkflowReactorAction =
  | {
      readonly type: "dispatch";
      readonly intent: SpecWorkflowIntentName;
      readonly input: SpecWorkflowStageHandoff;
    }
  | { readonly type: "advance-acceptance" }
  | { readonly type: "none"; readonly reason: string };

/**
 * 只决定任务终态后的下一步，不执行派发或写库。
 * apply 只有在明确提供独立验证者时才自动唤醒 verify；verify 只推进到人工验收。
 */
export const reactSpecWorkflowTaskCompletion = (input: {
  readonly state: SpecWorkflowState;
  readonly completedStage: "apply" | "verify";
  readonly run: CompositionTaskRun;
  readonly handoff?: SpecWorkflowStageHandoff;
}): SpecWorkflowReactorAction => {
  if (input.run.status !== "completed") return { type: "none", reason: "task-not-completed" };
  if (input.state.status !== "active") return { type: "none", reason: "workflow-not-active" };

  if (input.completedStage === "verify") {
    return input.state.stage === "verify" && input.state.verificationStatus === "passed"
      ? { type: "advance-acceptance" }
      : { type: "none", reason: "verification-state-not-ready" };
  }

  if (input.state.stage !== "apply" || !input.state.implementationCompleted) {
    return { type: "none", reason: "implementation-state-not-ready" };
  }
  if (input.state.mode === "fix") {
    return { type: "none", reason: "fix-batch-awaiting-ship" };
  }
  const handoff = input.handoff;
  if (
    handoff === undefined ||
    handoff.implementationAssigneeId === undefined ||
    handoff.independentVerifierId === undefined ||
    handoff.independentVerifierId === handoff.implementationAssigneeId
  ) {
    return { type: "none", reason: "independent-verifier-required" };
  }
  return {
    type: "dispatch",
    intent: "verify",
    input: {
      ...handoff,
      assigneeId: handoff.independentVerifierId,
    },
  };
};
