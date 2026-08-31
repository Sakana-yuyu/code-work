import { ORCHESTRATION_WS_METHODS } from "@codework/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createEnvironmentThreadGoalAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const lifecycleScheduler = createAtomCommandScheduler();
  const lifecycleConcurrency = {
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
      label: "environment-data:thread-goal:get",
      tag: ORCHESTRATION_WS_METHODS.getThreadGoal,
      staleTimeMs: 0,
    }),
    events: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:thread-goal:events",
      tag: ORCHESTRATION_WS_METHODS.subscribeThreadGoal,
      idleTtlMs: 0,
    }),
    set: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:thread-goal:set",
      tag: ORCHESTRATION_WS_METHODS.setThreadGoal,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    pause: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:thread-goal:pause",
      tag: ORCHESTRATION_WS_METHODS.pauseThreadGoal,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    resume: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:thread-goal:resume",
      tag: ORCHESTRATION_WS_METHODS.resumeThreadGoal,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    clear: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:thread-goal:clear",
      tag: ORCHESTRATION_WS_METHODS.clearThreadGoal,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
  };
}

export type EnvironmentThreadGoalAtoms<R, E> = ReturnType<
  typeof createEnvironmentThreadGoalAtoms<R, E>
>;
