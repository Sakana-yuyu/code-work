import type { WorkspaceScriptRpcError, WorkspaceScriptRun } from "@codework/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { WorkspaceScriptStopClaim } from "../persistence/Services/WorkspaceScriptStore.ts";
import type { TerminalSessionInspectionReceipt } from "../terminal/Manager.ts";
import {
  makeWorkspaceScriptTerminalOwner,
  type TerminalSessionOwner,
} from "../terminal/TerminalSessionOwnership.ts";
import type { WorkspaceScriptDependencyError } from "./WorkspaceScriptErrors.ts";
import {
  isFinishedWorkspaceScriptRun,
  makeWorkspaceScriptExited,
  makeWorkspaceScriptStopRetryable,
} from "./WorkspaceScriptStopState.ts";
import {
  assessWorkspaceScriptStopRecovery,
  type WorkspaceScriptStopRecoveryAssessment,
} from "./WorkspaceScriptStopRecoveryState.ts";

type ConfirmedStopReceipt = Extract<
  WorkspaceScriptStopRecoveryAssessment,
  { readonly _tag: "Confirmed" }
>;

export interface WorkspaceScriptStopExecutionOptions {
  readonly run: WorkspaceScriptRun;
  readonly stopOperationId: string;
  readonly stopClaim: WorkspaceScriptStopClaim;
  readonly currentTimeMillis: Effect.Effect<number>;
  readonly readRun: (
    workspaceScriptRunId: string,
  ) => Effect.Effect<Option.Option<WorkspaceScriptRun>, WorkspaceScriptRpcError>;
  readonly saveStopTransition: (input: {
    readonly run: WorkspaceScriptRun;
    readonly expectedRevision: number;
    readonly operationId: string;
    readonly claimOwnerId: string;
    readonly claimEpoch: number;
  }) => Effect.Effect<Option.Option<WorkspaceScriptRun>, WorkspaceScriptRpcError>;
  readonly makeSettledRun?: (
    run: WorkspaceScriptRun,
    observedAtUnixMs: number,
    assessment: ConfirmedStopReceipt,
  ) => WorkspaceScriptRun;
  readonly makeRetryableRun?: (
    run: WorkspaceScriptRun,
    observedAtUnixMs: number,
  ) => WorkspaceScriptRun;
  readonly terminal: {
    readonly kill: (input: {
      readonly threadId: string;
      readonly terminalId: string;
      readonly expectedOwner: TerminalSessionOwner;
    }) => Effect.Effect<void, WorkspaceScriptDependencyError>;
    readonly inspectSessionReceipt: (input: {
      readonly threadId: string;
      readonly terminalId: string;
      readonly expectedOwner: TerminalSessionOwner;
    }) => Effect.Effect<TerminalSessionInspectionReceipt, WorkspaceScriptDependencyError>;
  };
}

export type WorkspaceScriptStopExecutionOutcome =
  | { readonly _tag: "Settled"; readonly run: WorkspaceScriptRun }
  | {
      readonly _tag: "Retryable";
      readonly run: WorkspaceScriptRun;
      readonly killFailure: WorkspaceScriptDependencyError | null;
      readonly receiptFailure: WorkspaceScriptDependencyError | null;
      readonly receiptAssessment: WorkspaceScriptStopRecoveryAssessment | null;
    };

export const executeWorkspaceScriptStop = Effect.fn("WorkspaceScriptStopExecution.execute")(
  function* (options: WorkspaceScriptStopExecutionOptions) {
    const terminalOwner = makeWorkspaceScriptTerminalOwner({
      workspaceScriptRunId: options.run.workspaceScriptRunId,
      generation: options.run.requestedAtUnixMs,
    });
    const killResult = yield* options.terminal
      .kill({
        threadId: options.run.threadId,
        terminalId: options.run.terminalId,
        expectedOwner: terminalOwner,
      })
      .pipe(Effect.result);
    const receiptResult = yield* options.terminal
      .inspectSessionReceipt({
        threadId: options.run.threadId,
        terminalId: options.run.terminalId,
        expectedOwner: terminalOwner,
      })
      .pipe(Effect.result);
    const receiptAssessment =
      receiptResult._tag === "Success"
        ? assessWorkspaceScriptStopRecovery(receiptResult.success)
        : null;

    const saveFenced = (next: WorkspaceScriptRun) =>
      options.saveStopTransition({
        run: next,
        expectedRevision: options.run.revision,
        operationId: options.stopOperationId,
        claimOwnerId: options.stopClaim.ownerId,
        claimEpoch: options.stopClaim.epoch,
      });
    const readWinner = () =>
      options
        .readRun(options.run.workspaceScriptRunId)
        .pipe(Effect.map((current) => Option.getOrElse(current, () => options.run)));
    const observedAtUnixMs = Math.max(
      yield* options.currentTimeMillis,
      options.run.updatedAtUnixMs,
    );

    if (receiptAssessment?._tag === "Confirmed") {
      const next =
        options.makeSettledRun?.(options.run, observedAtUnixMs, receiptAssessment) ??
        makeWorkspaceScriptExited({
          run: options.run,
          stopOperationId: options.stopOperationId,
          observedAtUnixMs,
          exitCode: receiptAssessment.exitCode,
          exitSignal: receiptAssessment.exitSignal,
        });
      const settled = yield* saveFenced(next);
      if (Option.isSome(settled)) {
        return { _tag: "Settled", run: settled.value } as const;
      }
      const winner = yield* readWinner();
      if (isFinishedWorkspaceScriptRun(winner)) {
        return { _tag: "Settled", run: winner } as const;
      }
      return {
        _tag: "Retryable",
        run: winner,
        killFailure: killResult._tag === "Failure" ? killResult.failure : null,
        receiptFailure: null,
        receiptAssessment,
      } as const;
    }

    const retryableRun =
      options.makeRetryableRun?.(options.run, observedAtUnixMs) ??
      makeWorkspaceScriptStopRetryable(options.run, observedAtUnixMs);
    const retryable = yield* saveFenced(retryableRun);
    const winner = Option.isSome(retryable) ? retryable.value : yield* readWinner();
    if (isFinishedWorkspaceScriptRun(winner)) {
      return { _tag: "Settled", run: winner } as const;
    }
    return {
      _tag: "Retryable",
      run: winner,
      killFailure: killResult._tag === "Failure" ? killResult.failure : null,
      receiptFailure: receiptResult._tag === "Failure" ? receiptResult.failure : null,
      receiptAssessment,
    } as const;
  },
);
