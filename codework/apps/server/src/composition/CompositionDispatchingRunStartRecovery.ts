import type { CompositionTaskRetryResult } from "@codework/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { CompositionRunStartIntent } from "../persistence/Services/CompositionRunStartStore.ts";
import type { CompositionTaskStoreShape } from "../persistence/Services/CompositionTaskStore.ts";
import type { CompositionAgentDriver } from "./CompositionOrchestrator.ts";
import type { CompositionRunStartLifecycle } from "./CompositionRunStartLifecycle.ts";
import { isCompositionRunStartedProjectionStatus } from "./CompositionRunStartProjectionStatus.ts";
import { validateCompositionRunStartReceipt } from "./CompositionRunStartReceiptPolicy.ts";
import type { CompositionRetryTaskError } from "./CompositionRetryTaskTypes.ts";

export type CompositionDispatchingRunStartRecoveryDecision =
  | {
      readonly _tag: "Replay";
      readonly task: CompositionTaskRetryResult["task"];
      readonly run: CompositionTaskRetryResult["run"];
    }
  | {
      readonly _tag: "Completed";
      readonly result: CompositionTaskRetryResult;
    };

const matchesIntent = (
  intent: CompositionRunStartIntent,
  task: CompositionTaskRetryResult["task"],
  run: CompositionTaskRetryResult["run"],
): boolean =>
  task.taskId === intent.taskId &&
  task.assigneeKind === "agent" &&
  task.assigneeId === intent.agentId &&
  run.runId === intent.runId &&
  run.taskId === intent.taskId &&
  run.agentId === intent.agentId &&
  run.runtimeId === intent.runtimeId &&
  run.attempt === intent.attempt;

export const recoverCompositionDispatchingRunStart = Effect.fn(
  "CompositionDispatchingRunStartRecovery.recover",
)(function* (options: {
  readonly intent: CompositionRunStartIntent;
  readonly store: CompositionTaskStoreShape;
  readonly driver: CompositionAgentDriver;
  readonly lifecycle: CompositionRunStartLifecycle;
  readonly makeInvalid: (reason: string) => CompositionRetryTaskError;
  readonly resolvePersistedStart: (
    intent: CompositionRunStartIntent,
  ) => Effect.Effect<CompositionTaskRetryResult, CompositionRetryTaskError>;
}) {
  const quarantine = (outcomeCode: string) =>
    options.lifecycle
      .markIndeterminate(options.intent, outcomeCode)
      .pipe(
        Effect.flatMap((intent) =>
          Effect.fail(options.makeInvalid(`run_start_indeterminate_${intent.outcomeCode}`)),
        ),
      );

  const policy = options.driver.startRecoveryPolicy;
  if (policy === undefined) {
    return yield* quarantine("driver_start_recovery_policy_missing");
  }

  const taskOption = yield* options.store.getTask(options.intent.taskId);
  const runOption = yield* options.store.getRun(options.intent.runId);
  if (Option.isNone(taskOption) || Option.isNone(runOption)) {
    if (policy.mode === "fail-closed") {
      return yield* quarantine(policy.reasonCode);
    }
    return yield* quarantine("run_start_dispatching_projection_missing");
  }
  const task = taskOption.value;
  const run = runOption.value;
  if (
    options.driver.agentId !== options.intent.agentId ||
    options.driver.runtimeId !== options.intent.runtimeId ||
    !matchesIntent(options.intent, task, run) ||
    task.status !== run.status
  ) {
    return yield* quarantine("run_start_dispatching_projection_identity_conflict");
  }

  const queued = task.status === "queued" && run.status === "queued";
  const projected = isCompositionRunStartedProjectionStatus(task.status);
  const receiptError = validateCompositionRunStartReceipt({
    policy,
    capabilityGrantIds: run.capabilityGrantIds ?? [],
    receipt: {
      ...(run.runtimeTaskId === undefined ? {} : { runtimeTaskId: run.runtimeTaskId }),
      ...(run.capabilityHandshakeId === undefined
        ? {}
        : { capabilityHandshakeId: run.capabilityHandshakeId }),
    },
  });
  const settleProjected = () =>
    options.lifecycle
      .accept(options.intent, {
        ...(run.runtimeTaskId === undefined ? {} : { runtimeTaskId: run.runtimeTaskId }),
        ...(run.capabilityHandshakeId === undefined
          ? {}
          : { capabilityHandshakeId: run.capabilityHandshakeId }),
      })
      .pipe(
        Effect.flatMap(options.resolvePersistedStart),
        Effect.map((result) => ({ _tag: "Completed" as const, result })),
      );

  if (projected && receiptError !== undefined) {
    return yield* quarantine(receiptError);
  }
  if (projected) return yield* settleProjected();
  if (!queued) {
    return yield* quarantine("run_start_dispatching_projection_incomplete");
  }
  if (policy.mode === "fail-closed") {
    return yield* quarantine(policy.reasonCode);
  }
  if (policy.mode === "reconcile-only") {
    return yield* quarantine("run_start_reconcile_projection_missing");
  }
  if (
    (run.capabilityGrantIds?.length ?? 0) > 0 &&
    policy.capabilityGrantReplay?.mode !== "verified"
  ) {
    return yield* quarantine(
      policy.capabilityGrantReplay?.reasonCode ?? "driver_capability_grant_replay_not_verified",
    );
  }
  return { _tag: "Replay" as const, task, run };
});
