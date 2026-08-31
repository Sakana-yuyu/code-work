import type { WorkspaceScriptRpcError, WorkspaceScriptRun } from "@codework/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type {
  StoredWorkspaceScriptRun,
  WorkspaceScriptStopClaimInput,
  WorkspaceScriptStopClaimResult,
  WorkspaceScriptStoreError,
  WorkspaceScriptStopTransitionInput,
} from "../persistence/Services/WorkspaceScriptStore.ts";
import {
  isWorkspaceScriptStartTerminationOperationId,
  makeWorkspaceScriptStartFailed,
  makeWorkspaceScriptStartTerminationRetryable,
} from "./WorkspaceScriptStartState.ts";
import {
  executeWorkspaceScriptStop,
  type WorkspaceScriptStopExecutionOptions,
} from "./WorkspaceScriptStopExecution.ts";
import { isFinishedWorkspaceScriptRun } from "./WorkspaceScriptStopState.ts";

interface WorkspaceScriptStopRecoveryOptions {
  readonly currentTimeMillis: Effect.Effect<number>;
  readonly getActiveRunByTerminal: (
    threadId: string,
    terminalId: string,
  ) => Effect.Effect<Option.Option<StoredWorkspaceScriptRun>, WorkspaceScriptRpcError>;
  readonly readRun: WorkspaceScriptStopExecutionOptions["readRun"];
  readonly makeStopClaimInput: (
    run: WorkspaceScriptRun,
    operationId: string,
  ) => Effect.Effect<
    Pick<
      WorkspaceScriptStopClaimInput,
      "claimOwnerId" | "claimedAtUnixMs" | "claimExpiresAtUnixMs"
    >,
    WorkspaceScriptRpcError
  >;
  readonly claimStop: (
    input: WorkspaceScriptStopClaimInput,
  ) => Effect.Effect<WorkspaceScriptStopClaimResult, WorkspaceScriptStoreError>;
  readonly saveStopTransition: (
    input: WorkspaceScriptStopTransitionInput,
  ) => Effect.Effect<Option.Option<WorkspaceScriptRun>, WorkspaceScriptRpcError>;
  readonly terminal: WorkspaceScriptStopExecutionOptions["terminal"];
  /** 瞬态失败后的重试间隔，与停止 claim 的 TTL 保持同一量级。 */
  readonly retryDelayMillis?: number;
}

export type WorkspaceScriptStopRecoveryOutcome =
  | { readonly _tag: "Completed" }
  | { readonly _tag: "Deferred"; readonly retryAtUnixMs: number };

export const recoverWorkspaceScriptStop = Effect.fn("WorkspaceScriptStopRecovery.recover")(
  function* (stored: StoredWorkspaceScriptRun, options: WorkspaceScriptStopRecoveryOptions) {
    const stopOperationId = stored.stopOperationId;
    if (stopOperationId === null) return { _tag: "Completed" } as const;

    const retryDelayMillis = options.retryDelayMillis ?? 30_000;
    const deferredRetryAt = Effect.map(
      options.currentTimeMillis,
      (nowUnixMs) => Math.max(nowUnixMs, stored.run.updatedAtUnixMs) + retryDelayMillis,
    );

    const currentResult = yield* options
      .getActiveRunByTerminal(stored.run.threadId, stored.run.terminalId)
      .pipe(Effect.result);
    if (currentResult._tag === "Failure") {
      yield* Effect.logWarning("Workspace Script 停止恢复读取失败", {
        workspaceScriptRunId: stored.run.workspaceScriptRunId,
        cause: currentResult.failure,
      });
      return { _tag: "Deferred", retryAtUnixMs: yield* deferredRetryAt } as const;
    }
    const current = currentResult.success;
    if (
      Option.isNone(current) ||
      current.value.run.workspaceScriptRunId !== stored.run.workspaceScriptRunId ||
      current.value.stopOperationId !== stopOperationId ||
      isFinishedWorkspaceScriptRun(current.value.run)
    ) {
      return { _tag: "Completed" } as const;
    }

    const startTermination = isWorkspaceScriptStartTerminationOperationId(
      current.value.run.workspaceScriptRunId,
      stopOperationId,
    );
    if (startTermination && current.value.run.status !== "starting") {
      return { _tag: "Completed" } as const;
    }
    if (
      !startTermination &&
      current.value.run.status !== "running" &&
      current.value.run.status !== "stopping"
    ) {
      return { _tag: "Completed" } as const;
    }

    const claimInput = yield* options.makeStopClaimInput(current.value.run, stopOperationId);
    const claimResult = yield* options
      .claimStop({
        run: startTermination
          ? {
              ...current.value.run,
              revision: current.value.run.revision + 1,
              updatedAtUnixMs: Math.max(
                claimInput.claimedAtUnixMs,
                current.value.run.updatedAtUnixMs,
              ),
            }
          : {
              ...current.value.run,
              status: "stopping",
              revision: current.value.run.revision + 1,
              startedAtUnixMs:
                current.value.run.startedAtUnixMs ?? current.value.run.requestedAtUnixMs,
              updatedAtUnixMs: Math.max(
                claimInput.claimedAtUnixMs,
                current.value.run.updatedAtUnixMs,
              ),
            },
        operationId: stopOperationId,
        expectedRevision: current.value.run.revision,
        ...claimInput,
      })
      .pipe(Effect.result);
    if (claimResult._tag === "Failure") {
      yield* Effect.logWarning("Workspace Script 停止恢复领取失败", {
        workspaceScriptRunId: stored.run.workspaceScriptRunId,
        cause: claimResult.failure,
      });
      return { _tag: "Deferred", retryAtUnixMs: yield* deferredRetryAt } as const;
    }
    if (!claimResult.success.claimed) {
      const activeClaim = claimResult.success.stopClaim;
      return activeClaim !== null && activeClaim.expiresAtUnixMs > claimInput.claimedAtUnixMs
        ? ({ _tag: "Deferred", retryAtUnixMs: activeClaim.expiresAtUnixMs } as const)
        : ({ _tag: "Completed" } as const);
    }
    if (claimResult.success.stopClaim === null) {
      yield* Effect.logWarning("Workspace Script 停止恢复缺少持久 claim", {
        workspaceScriptRunId: stored.run.workspaceScriptRunId,
        stopOperationId,
      });
      return { _tag: "Completed" } as const;
    }

    const outcome = yield* executeWorkspaceScriptStop({
      run: claimResult.success.run,
      stopOperationId,
      stopClaim: claimResult.success.stopClaim,
      currentTimeMillis: options.currentTimeMillis,
      readRun: options.readRun,
      saveStopTransition: options.saveStopTransition,
      terminal: options.terminal,
      ...(startTermination
        ? {
            makeSettledRun: (run: WorkspaceScriptRun, observedAtUnixMs: number) =>
              makeWorkspaceScriptStartFailed(run, observedAtUnixMs),
            makeRetryableRun: makeWorkspaceScriptStartTerminationRetryable,
          }
        : {}),
    });
    if (outcome._tag === "Retryable") {
      yield* Effect.logWarning("Workspace Script 停止恢复仍待重试", {
        workspaceScriptRunId: outcome.run.workspaceScriptRunId,
        stopOperationId,
        cause: outcome.killFailure,
        receiptCause: outcome.receiptFailure,
        receiptReason:
          outcome.receiptAssessment?._tag === "Unconfirmed"
            ? outcome.receiptAssessment.reason
            : undefined,
      });
      return {
        _tag: "Deferred",
        retryAtUnixMs:
          Math.max(yield* options.currentTimeMillis, outcome.run.updatedAtUnixMs) +
          retryDelayMillis,
      } as const;
    }
    return { _tag: "Completed" } as const;
  },
);
