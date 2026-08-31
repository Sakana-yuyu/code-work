import type {
  CompositionTask,
  CompositionTaskRetryResult,
  CompositionTaskRun,
} from "@codework/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type {
  CompositionRunStartIntent,
  CompositionRunStartStoreShape,
} from "../persistence/Services/CompositionRunStartStore.ts";
import type { CompositionTaskRecoveryInput } from "../persistence/Services/CompositionTaskInputStore.ts";
import type { CompositionAgentDriver } from "./CompositionOrchestrator.ts";
import { CompositionAgentDriverFailure } from "./CompositionOrchestratorErrors.ts";
import type { CompositionRunStartLifecycle } from "./CompositionRunStartLifecycle.ts";
import { validateCompositionRunStartReceipt } from "./CompositionRunStartReceiptPolicy.ts";
import type {
  CompositionRetryTaskError,
  CompositionRetryTaskOperations,
} from "./CompositionRetryTaskTypes.ts";

export const dispatchCompositionClaimedRunStart = Effect.fn("CompositionClaimedRunStart.dispatch")(
  function* (options: {
    readonly task: CompositionTask;
    readonly run: CompositionTaskRun;
    readonly driver: CompositionAgentDriver;
    readonly intent: CompositionRunStartIntent;
    readonly recoveryInput: CompositionTaskRecoveryInput;
    readonly startStore: CompositionRunStartStoreShape;
    readonly lifecycle: CompositionRunStartLifecycle;
    readonly recoverAccepted: (
      intent: CompositionRunStartIntent,
    ) => Effect.Effect<CompositionTaskRetryResult, CompositionRetryTaskError>;
    readonly persistStartedRun: CompositionRetryTaskOperations["persistStartedRun"];
  }) {
    const startResult = yield* Effect.result(
      options.driver.startTask({
        task: options.task,
        run: options.run,
        prompt: options.recoveryInput.prompt,
        workspaceRoot: options.recoveryInput.workspaceRoot,
        ...(options.recoveryInput.workspaceRootDigest === undefined
          ? {}
          : { workspaceRootDigest: options.recoveryInput.workspaceRootDigest }),
        ...(options.recoveryInput.model === undefined
          ? {}
          : { model: options.recoveryInput.model }),
        capabilityGrantIds: options.run.capabilityGrantIds,
      }),
    );
    if (startResult._tag === "Failure") {
      yield* options.lifecycle.markIndeterminate(
        options.intent,
        "driver_start_result_indeterminate",
      );
      return yield* startResult.failure;
    }

    const receiptError = validateCompositionRunStartReceipt({
      policy: options.driver.startRecoveryPolicy,
      capabilityGrantIds: options.run.capabilityGrantIds ?? [],
      receipt: startResult.success,
    });
    if (receiptError !== undefined) {
      yield* options.lifecycle.markIndeterminate(options.intent, receiptError);
      return yield* new CompositionAgentDriverFailure({
        code: receiptError,
        detail: `Agent Driver 返回的 Run Start receipt 不满足恢复策略：${receiptError}`,
      });
    }

    const acceptedResult = yield* Effect.result(
      options.lifecycle.accept(options.intent, startResult.success),
    );
    if (acceptedResult._tag === "Failure") {
      const currentIntent = yield* options.startStore.getStart(options.intent.runId);
      if (
        Option.isSome(currentIntent) &&
        (currentIntent.value.state === "accepted" || currentIntent.value.state === "settled") &&
        currentIntent.value.claimId === options.intent.claimId
      ) {
        // 另一个并发恢复者已确认同一 receipt：以持久赢家为准补齐投影。
        return yield* options.recoverAccepted(currentIntent.value);
      }
      if (
        Option.isSome(currentIntent) &&
        currentIntent.value.state === "dispatching" &&
        currentIntent.value.claimId === options.intent.claimId
      ) {
        yield* options.lifecycle.markIndeterminate(
          currentIntent.value,
          "driver_acceptance_receipt_persist_failed",
        );
      }
      return yield* acceptedResult.failure;
    }

    const persisted = yield* options.persistStartedRun({
      task: options.task,
      run: options.run,
      runtimeId: options.driver.runtimeId,
      startResult: startResult.success,
      summary: "重试任务已交给 Agent Driver 执行",
    });
    // accept 命中幂等分支时可能直接返回其他恢复者已 settle 的意图；此时无需重复 settle。
    if (acceptedResult.success.state !== "settled") {
      yield* options.lifecycle.settle(acceptedResult.success);
    }
    return persisted;
  },
);
