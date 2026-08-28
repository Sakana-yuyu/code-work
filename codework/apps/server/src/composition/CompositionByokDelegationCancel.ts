import {
  BYOK_DELEGATION_PROJECT_ID,
  type ByokDelegationStatus,
  type CompositionTaskCancelRequest,
  type CompositionTaskCancelResult,
  type CompositionTaskStatus,
} from "@codework/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type {
  CompositionTaskStoreError,
  CompositionTaskStoreShape,
} from "../persistence/Services/CompositionTaskStore.ts";
import {
  projectByokDelegationTransition,
  type ByokDelegationProjectionScope,
  type ByokDelegationProjectionTransition,
} from "./CompositionByokDelegationProjection.ts";

const TERMINAL_STATUSES: ReadonlySet<CompositionTaskStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);

export type ByokDelegationRuntimeCancelResult =
  | { readonly status: "cancelled" }
  | {
      readonly status: "already_terminal";
      readonly transition: ByokDelegationProjectionTransition;
    }
  | { readonly status: "not_found" };

export type ByokDelegationRuntimeCancelPort = (input: {
  readonly taskId: string;
  readonly runId: string;
  readonly instanceId: string;
  readonly delegationId: string;
}) => ByokDelegationRuntimeCancelResult;

const instanceIdOf = (agentId: string, runtimeId: string): string => {
  const providerPrefix = "provider:";
  if (agentId.startsWith(providerPrefix) && agentId.length > providerPrefix.length) {
    return agentId.slice(providerPrefix.length);
  }
  const runtimePrefix = "byok-delegation:";
  if (runtimeId.startsWith(runtimePrefix) && runtimeId.length > runtimePrefix.length) {
    return runtimeId.slice(runtimePrefix.length);
  }
  return "unknown";
};

const resultStatusOf = (
  transition: ByokDelegationProjectionTransition,
): CompositionTaskCancelResult["status"] =>
  transition.status === "cancelled" ? "cancelled" : "already_terminal";

/**
 * 把控制中心的 Composition cancel 映射到 BYOK 委派调度器，并严格落委派终态投影。
 * 非委派 Task 返回 undefined，由调用方继续走通用 Composition Orchestrator。
 */
export const cancelProjectedByokDelegationTask = (options: {
  readonly store: Pick<
    CompositionTaskStoreShape,
    "appendEventIfNew" | "getTask" | "getRun" | "upsertTask" | "upsertRun"
  >;
  readonly input: CompositionTaskCancelRequest;
  readonly cancelRuntime: ByokDelegationRuntimeCancelPort;
  readonly nowUnixMs: number;
}): Effect.Effect<CompositionTaskCancelResult | undefined, CompositionTaskStoreError> =>
  Effect.gen(function* () {
    const taskOption = yield* options.store.getTask(options.input.taskId);
    const runOption = yield* options.store.getRun(options.input.runId);
    if (Option.isNone(taskOption) || Option.isNone(runOption)) return undefined;

    const task = taskOption.value;
    const run = runOption.value;
    if (task.projectId !== BYOK_DELEGATION_PROJECT_ID || run.taskId !== task.taskId) {
      return undefined;
    }
    if (TERMINAL_STATUSES.has(task.status) || TERMINAL_STATUSES.has(run.status)) {
      return { task, run, status: "already_terminal" };
    }

    const delegationId = run.runtimeTaskId ?? "unknown";
    const instanceId = instanceIdOf(run.agentId, run.runtimeId);
    const runtimeResult = options.cancelRuntime({
      taskId: task.taskId,
      runId: run.runId,
      instanceId,
      delegationId,
    });
    const transition: ByokDelegationProjectionTransition =
      runtimeResult.status === "already_terminal"
        ? runtimeResult.transition
        : { status: "cancelled" };
    const scope: ByokDelegationProjectionScope = {
      instanceId,
      delegationId,
      taskId: task.taskId,
      runId: run.runId,
      agentId: run.agentId,
      runtimeId: run.runtimeId,
      promptDigest: task.promptDigest,
    };

    yield* projectByokDelegationTransition({
      store: options.store,
      scope,
      transition,
      nowUnixMs: options.nowUnixMs,
    });

    const projectedTask = yield* options.store.getTask(task.taskId);
    const projectedRun = yield* options.store.getRun(run.runId);
    return {
      task: Option.getOrElse(projectedTask, () => task),
      run: Option.getOrElse(projectedRun, () => run),
      status: resultStatusOf(transition),
    };
  });

export const isTerminalByokDelegationStatus = (
  status: ByokDelegationStatus,
): status is Exclude<ByokDelegationStatus, "queued" | "running"> =>
  status !== "queued" && status !== "running";
