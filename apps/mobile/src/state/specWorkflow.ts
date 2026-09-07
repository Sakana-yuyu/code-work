import { createSpecWorkflowView } from "@codework/client-runtime/state/spec-workflow-view";

import { connectionAtomRuntime } from "../connection/runtime";

const view = createSpecWorkflowView({ runtime: connectionAtomRuntime, labelPrefix: "mobile" });

export const specWorkflowEnvironment = view.specWorkflowEnvironment;
export const useSpecWorkflowController = view.useSpecWorkflowController;
export type {
  SpecWorkflowCapabilityState as SpecWorkflowCapabilityView,
  SpecWorkflowCapabilityController as SpecWorkflowMobileController,
} from "@codework/client-runtime/state/spec-workflow-view";
