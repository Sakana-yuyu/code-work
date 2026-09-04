import { ORCHESTRATION_WS_METHODS } from "@codework/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/** 线程级 Spec Workflow 能力状态，供 Web、Desktop 和 Mobile 共享。 */
export function createEnvironmentSpecWorkflowAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const capabilityScheduler = createAtomCommandScheduler();
  const capabilityConcurrency = {
    mode: "serial" as const,
    key: ({
      environmentId,
      input,
    }: {
      environmentId: string;
      input: { readonly threadId: string };
    }) => JSON.stringify([environmentId, input.threadId]),
  };

  return {
    get: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:spec-workflow:get",
      tag: ORCHESTRATION_WS_METHODS.getSpecWorkflow,
      staleTimeMs: 0,
    }),
    events: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:spec-workflow:events",
      tag: ORCHESTRATION_WS_METHODS.subscribeSpecWorkflow,
      idleTtlMs: 0,
    }),
    state: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:spec-workflow:state",
      tag: ORCHESTRATION_WS_METHODS.getSpecWorkflowState,
      staleTimeMs: 0,
    }),
    stateEvents: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:spec-workflow:state-events",
      tag: ORCHESTRATION_WS_METHODS.subscribeSpecWorkflowState,
      idleTtlMs: 0,
    }),
    set: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:spec-workflow:set",
      tag: ORCHESTRATION_WS_METHODS.setSpecWorkflow,
      scheduler: capabilityScheduler,
      concurrency: capabilityConcurrency,
    }),
    reviewProposal: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:spec-workflow:review-proposal",
      tag: ORCHESTRATION_WS_METHODS.reviewSpecWorkflowProposal,
      scheduler: capabilityScheduler,
      concurrency: capabilityConcurrency,
    }),
    completeAcceptance: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:spec-workflow:complete-acceptance",
      tag: ORCHESTRATION_WS_METHODS.completeSpecWorkflowAcceptance,
      scheduler: capabilityScheduler,
      concurrency: capabilityConcurrency,
    }),
    pause: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:spec-workflow:pause",
      tag: ORCHESTRATION_WS_METHODS.pauseSpecWorkflow,
      scheduler: capabilityScheduler,
      concurrency: capabilityConcurrency,
    }),
    resume: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:spec-workflow:resume",
      tag: ORCHESTRATION_WS_METHODS.resumeSpecWorkflow,
      scheduler: capabilityScheduler,
      concurrency: capabilityConcurrency,
    }),
  };
}

export type EnvironmentSpecWorkflowAtoms<R, E> = ReturnType<
  typeof createEnvironmentSpecWorkflowAtoms<R, E>
>;
