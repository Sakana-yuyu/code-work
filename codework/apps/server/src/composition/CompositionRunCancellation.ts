import type {
  CompositionTask,
  CompositionTaskRun,
  CompositionTaskStatus,
} from "@codework/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

const terminalStatuses: ReadonlySet<CompositionTaskStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);

export type CompositionTerminalTaskStatus = "completed" | "failed" | "cancelled" | "timed_out";

const isTerminalStatus = (status: CompositionTaskStatus): status is CompositionTerminalTaskStatus =>
  terminalStatuses.has(status);

export type CompositionRunCancellationReceipt =
  | {
      readonly taskId: string;
      readonly runId: string;
      readonly outcome: "terminal";
      readonly terminalStatus: CompositionTerminalTaskStatus;
    }
  | {
      readonly taskId: string;
      readonly runId: string;
      readonly outcome: "not_owned";
    }
  | {
      readonly taskId: string;
      readonly runId: string;
      readonly outcome: "pending" | "timeout" | "cancel_failed" | "ownership_unverified";
      readonly failureCode: string;
    };

export interface CompositionCancellationReceipt<
  TRun extends CompositionRunCancellationReceipt = CompositionRunCancellationReceipt,
> {
  readonly runs: ReadonlyArray<TRun>;
  readonly complete: boolean;
}

export interface CompositionCancellationReport<
  TReceipt extends CompositionCancellationReceipt = CompositionCancellationReceipt,
> {
  readonly trigger: "interrupted" | "business_failure";
  readonly receipt: TReceipt;
}

export const isCompositionRunCancellationConfirmed = (
  receipt: CompositionRunCancellationReceipt,
): boolean => receipt.outcome === "terminal" || receipt.outcome === "not_owned";

export const makeCompositionCancellationReceipt = <TRun extends CompositionRunCancellationReceipt>(
  runs: ReadonlyArray<TRun>,
): CompositionCancellationReceipt<TRun> => ({
  runs,
  complete: runs.every(isCompositionRunCancellationConfirmed),
});

export interface CancelCompositionRunOptions {
  readonly taskId: string;
  readonly runId: string;
  readonly reason: string;
  readonly timeoutMs: number;
  readonly ownership: "candidate" | "confirmed";
  readonly getTask?: (
    taskId: string,
  ) => Effect.Effect<Option.Option<CompositionTask>, Error, never>;
  readonly getRun?: (
    runId: string,
  ) => Effect.Effect<Option.Option<CompositionTaskRun>, Error, never>;
  readonly matchesPersistedIdentity: (task: CompositionTask, run: CompositionTaskRun) => boolean;
  readonly cancelTask: (input: {
    readonly taskId: string;
    readonly runId: string;
    readonly reason: string;
  }) => Effect.Effect<
    {
      readonly task: CompositionTask;
      readonly run: CompositionTaskRun;
      readonly status: "cancelled" | "cancel_requested" | "already_terminal";
    },
    Error,
    never
  >;
  readonly awaitTaskCompletion: (input: {
    readonly taskId: string;
    readonly runId: string;
  }) => Effect.Effect<CompositionTaskRun, Error, never>;
}

export const cancelCompositionRun = (
  options: CancelCompositionRunOptions,
): Effect.Effect<CompositionRunCancellationReceipt> => {
  const receiptBase = {
    taskId: options.taskId,
    runId: options.runId,
  } as const;
  const terminalReceipt = (
    status: CompositionTerminalTaskStatus,
  ): CompositionRunCancellationReceipt => ({
    ...receiptBase,
    outcome: "terminal",
    terminalStatus: status,
  });
  const incompleteReceipt = (
    outcome: "pending" | "timeout" | "cancel_failed" | "ownership_unverified",
    failureCode: string,
  ): CompositionRunCancellationReceipt => ({
    ...receiptBase,
    outcome,
    failureCode,
  });
  const matchesTargetIdentity = (task: CompositionTask, run: CompositionTaskRun): boolean =>
    task.taskId === options.taskId &&
    run.runId === options.runId &&
    run.taskId === options.taskId &&
    options.matchesPersistedIdentity(task, run);
  const matchesRunIdentity = (actual: CompositionTaskRun, expected: CompositionTaskRun): boolean =>
    actual.runId === expected.runId &&
    actual.taskId === expected.taskId &&
    actual.agentId === expected.agentId &&
    actual.runtimeId === expected.runtimeId &&
    actual.attempt === expected.attempt;
  const cleanup = Effect.gen(function* () {
    if (options.ownership === "candidate") {
      if (options.getTask === undefined || options.getRun === undefined) {
        return incompleteReceipt("ownership_unverified", "ownership_lookup_unavailable");
      }
      const ownership = yield* Effect.exit(
        Effect.all([options.getTask(options.taskId), options.getRun(options.runId)]),
      );
      if (ownership._tag === "Failure") {
        return incompleteReceipt("ownership_unverified", "ownership_lookup_failed");
      }
      const [taskOption, runOption] = ownership.value;
      if (Option.isNone(taskOption) && Option.isNone(runOption)) {
        return {
          ...receiptBase,
          outcome: "not_owned",
        } satisfies CompositionRunCancellationReceipt;
      }
      if (Option.isNone(taskOption) || Option.isNone(runOption)) {
        return incompleteReceipt("ownership_unverified", "ownership_state_incomplete");
      }
      const task = taskOption.value;
      const run = runOption.value;
      if (!matchesTargetIdentity(task, run)) {
        return {
          ...receiptBase,
          outcome: "not_owned",
        } satisfies CompositionRunCancellationReceipt;
      }
      if (isTerminalStatus(run.status)) return terminalReceipt(run.status);
      if (isTerminalStatus(task.status)) {
        return incompleteReceipt("ownership_unverified", "ownership_state_inconsistent");
      }
    }

    const cancelled = yield* Effect.exit(
      options.cancelTask({
        taskId: options.taskId,
        runId: options.runId,
        reason: options.reason,
      }),
    );
    if (cancelled._tag === "Failure") {
      return incompleteReceipt("cancel_failed", "cancel_failed");
    }
    if (!matchesTargetIdentity(cancelled.value.task, cancelled.value.run)) {
      return incompleteReceipt("ownership_unverified", "cancel_response_identity_mismatch");
    }
    if (cancelled.value.status !== "cancel_requested") {
      if (isTerminalStatus(cancelled.value.run.status)) {
        return terminalReceipt(cancelled.value.run.status);
      }
      return incompleteReceipt("ownership_unverified", "cancel_terminal_status_unconfirmed");
    }

    const confirmed = yield* Effect.exit(
      options.awaitTaskCompletion({ taskId: options.taskId, runId: options.runId }),
    );
    if (confirmed._tag === "Failure") {
      return incompleteReceipt("pending", "cancel_confirmation_failed");
    }
    if (
      !matchesTargetIdentity(cancelled.value.task, confirmed.value) ||
      !matchesRunIdentity(confirmed.value, cancelled.value.run)
    ) {
      return incompleteReceipt("ownership_unverified", "cancel_confirmation_identity_mismatch");
    }
    return isTerminalStatus(confirmed.value.status)
      ? terminalReceipt(confirmed.value.status)
      : incompleteReceipt("pending", "cancel_terminal_status_unconfirmed");
  });

  return cleanup.pipe(
    Effect.timeoutOption(options.timeoutMs),
    Effect.map(Option.getOrElse(() => incompleteReceipt("timeout", "cancel_timeout"))),
  );
};
