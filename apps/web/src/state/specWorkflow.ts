import { createSpecWorkflowView } from "@codework/client-runtime/state/spec-workflow-view";

import { connectionAtomRuntime } from "../connection/runtime";

const view = createSpecWorkflowView({ runtime: connectionAtomRuntime, labelPrefix: "web" });

export const specWorkflowEnvironment = view.specWorkflowEnvironment;
export const useSpecWorkflowCapability = view.useSpecWorkflowCapability;
export const useSpecWorkflowState = view.useSpecWorkflowState;
export const useSpecWorkflowController = view.useSpecWorkflowController;
export type {
  SpecWorkflowCapabilityState,
  SpecWorkflowStateView,
  SpecWorkflowCapabilityController,
} from "@codework/client-runtime/state/spec-workflow-view";
