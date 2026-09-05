import type {
  SpecWorkflowCapability,
  SpecWorkflowRoute,
  SpecWorkflowStage,
  SpecWorkflowState,
  SpecWorkflowIntentName,
  SpecWorkflowLoopConfig,
} from "@codework/contracts";

import { isSpecWorkflowStageAllowed } from "./SpecWorkflowDecider.ts";
import { SpecWorkflowDocumentNode } from "@codework/contracts";
import * as Schema from "effect/Schema";

const intentStages: Partial<Record<SpecWorkflowIntentName, SpecWorkflowStage>> = {
  research: "research",
  ask: "ask",
  design: "design",
  propose: "propose",
  revise: "revise",
  apply: "apply",
  fix: "apply",
  loop: "apply",
  verify: "verify",
  acceptance: "acceptance",
  archive: "archive",
  ship: "archive",
};

const route = (
  requestedIntent: SpecWorkflowIntentName,
  action: SpecWorkflowRoute["action"],
  targetStage: SpecWorkflowStage | null,
  corrected: boolean,
  reason: SpecWorkflowRoute["reason"],
): SpecWorkflowRoute => ({
  requestedIntent,
  action,
  targetStage,
  corrected,
  reason,
});

/** 只负责选择正确的下一入口，不执行命令；执行仍由 Decider 和后续 Service 负责。 */
export const routeSpecWorkflowIntent = (input: {
  readonly capability: SpecWorkflowCapability;
  readonly state?: SpecWorkflowState;
  readonly intent: SpecWorkflowIntentName;
  readonly loopConfig?: SpecWorkflowLoopConfig;
}): SpecWorkflowRoute => {
  const { capability, state, intent } = input;
  if (!capability.enabled) {
    return route(intent, "pass-through", null, false, "not-enabled");
  }
  if (
    capability.selectedIntent !== undefined &&
    capability.selectedIntent !== "workflow" &&
    capability.selectedIntent !== intent
  ) {
    return route(intent, "show-status", state?.stage ?? null, true, "node-not-selected");
  }

  if (intent === "status") {
    return route(
      intent,
      "show-status",
      state?.stage ?? null,
      false,
      state ? "already-at-target" : "workflow-not-started",
    );
  }
  if (
    state !== undefined &&
    capability.selectedIntent === intent &&
    Schema.is(SpecWorkflowDocumentNode)(intent)
  ) {
    if (state.status !== "active" || state.activeTaskId !== null)
      return route(intent, "show-status", state.stage, true, "invalid-current-stage");
    if ((intent === "design" || intent === "propose" || intent === "revise") && state.tbdCount > 0)
      return route(intent, "show-status", "ask", true, "tbd-remaining");
    return route(intent, "advance", intent, false, "requested-stage-allowed");
  }
  if (state === undefined) {
    return route(
      intent,
      "start",
      intent === "fix" ? "apply" : "research",
      intent !== "workflow",
      "workflow-not-started",
    );
  }
  if (intent === "loop" && input.loopConfig === undefined) {
    return route(intent, "show-status", state.stage, true, "loop-budget-required");
  }
  if (intent === "stash") {
    return state.status === "active"
      ? route(intent, "pause", state.stage, false, "requested-stage-allowed")
      : route(intent, "show-status", state.stage, true, "paused");
  }
  if (intent === "resume") {
    return state.status === "paused"
      ? route(intent, "resume", state.stage, false, "requested-stage-allowed")
      : route(intent, "show-status", state.stage, true, "not-paused");
  }
  const targetStage = intentStages[intent];
  if (targetStage === undefined) {
    return route(intent, "show-status", state.stage, true, "invalid-current-stage");
  }
  if (state.status === "paused") {
    return route(intent, "show-status", state.stage, true, "paused");
  }
  if (
    intent === "fix" &&
    state.stage === "apply" &&
    state.activeTaskId === null &&
    (state.mode === "fix" || !state.implementationCompleted)
  ) {
    return route(intent, "advance", "apply", false, "requested-stage-allowed");
  }
  if (
    intent === "loop" &&
    state.stage === "apply" &&
    state.activeTaskId === null &&
    !state.implementationCompleted
  ) {
    return route(intent, "advance", "apply", false, "requested-stage-allowed");
  }
  if (
    intent === "ship" &&
    state.mode === "fix" &&
    state.stage === "apply" &&
    state.activeTaskId === null &&
    state.implementationCompleted
  ) {
    return route(intent, "advance", "verify", true, "fix-batch-verification-required");
  }
  if (state.stage === targetStage) {
    return route(intent, "show-status", targetStage, false, "already-at-target");
  }
  if (
    (intent === "archive" || intent === "ship") &&
    state.stage === "verify" &&
    state.verificationStatus === "passed"
  ) {
    return route(intent, "advance", "acceptance", true, "acceptance-required");
  }
  if (isSpecWorkflowStageAllowed(state, targetStage)) {
    return route(intent, "advance", targetStage, false, "requested-stage-allowed");
  }
  if (intent === "propose" && state.stage === "research" && state.tbdCount > 0) {
    return route(intent, "advance", "ask", true, "tbd-remaining");
  }
  if (intent === "apply" && state.stage === "awaitingApproval") {
    return route(intent, "show-status", "awaitingApproval", true, "proposal-not-approved");
  }
  if (intent === "verify" && state.stage === "apply" && !state.implementationCompleted) {
    return route(intent, "show-status", "apply", true, "implementation-incomplete");
  }
  if (
    (intent === "archive" || intent === "ship") &&
    state.stage === "verify" &&
    state.verificationStatus === "failed"
  ) {
    return route(intent, "advance", "apply", true, "verification-failed");
  }
  return route(intent, "show-status", state.stage, true, "invalid-current-stage");
};
