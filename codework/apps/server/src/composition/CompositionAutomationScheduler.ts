import {
  makeCompositionAutomationRunIdempotencyKey,
  type CompositionAutomation,
  type CompositionAutomationRun,
} from "@codework/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  CompositionAutomationStore,
  type CompositionAutomationStoreError,
  type CompositionAutomationStoreShape,
} from "../persistence/Services/CompositionAutomationStore.ts";
import {
  calculateNextCompositionAutomationRun,
  type CompositionAutomationCadenceError,
} from "./CompositionAutomationCadence.ts";

export interface CompositionAutomationRunExecutionInput {
  readonly automation: CompositionAutomation;
  readonly run: CompositionAutomationRun;
}

export class CompositionAutomationRunExecutorError extends Schema.TaggedErrorClass<CompositionAutomationRunExecutorError>()(
  "CompositionAutomationRunExecutorError",
  {
    code: Schema.String,
    detail: Schema.String,
    retryable: Schema.Boolean,
  },
) {
  override get message(): string {
    return `Automation 执行适配失败：${this.code}: ${this.detail}`;
  }
}

export interface CompositionAutomationRunExecutorShape {
  /** 使用 run 中的稳定 Composition ID 幂等确保外部任务已启动。 */
  readonly ensureStarted: (
    input: CompositionAutomationRunExecutionInput,
  ) => Effect.Effect<void, CompositionAutomationRunExecutorError>;
}

export class CompositionAutomationRunExecutor extends Context.Service<
  CompositionAutomationRunExecutor,
  CompositionAutomationRunExecutorShape
>()("codework/composition/CompositionAutomationScheduler/CompositionAutomationRunExecutor") {}

export type CompositionAutomationSchedulerOutcomeStatus =
  | "started"
  | "recovered"
  | "deduplicated"
  | "retry_pending"
  | "failed";

export interface CompositionAutomationSchedulerOutcome {
  readonly automationId: string;
  readonly automationRunId: string;
  readonly status: CompositionAutomationSchedulerOutcomeStatus;
  readonly errorCode?: string;
}

export interface CompositionAutomationSchedulerBatchResult {
  readonly outcomes: ReadonlyArray<CompositionAutomationSchedulerOutcome>;
}

export class CompositionAutomationSchedulerError extends Schema.TaggedErrorClass<CompositionAutomationSchedulerError>()(
  "CompositionAutomationSchedulerError",
  {
    code: Schema.String,
    detail: Schema.String,
    automationId: Schema.optional(Schema.String),
    automationRunId: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return `Automation Scheduler 失败：${this.code}: ${this.detail}`;
  }
}

export interface CompositionAutomationSchedulerShape {
  readonly tick: () => Effect.Effect<
    CompositionAutomationSchedulerBatchResult,
    CompositionAutomationSchedulerError
  >;
  readonly recover: () => Effect.Effect<
    CompositionAutomationSchedulerBatchResult,
    CompositionAutomationSchedulerError
  >;
}

export class CompositionAutomationScheduler extends Context.Service<
  CompositionAutomationScheduler,
  CompositionAutomationSchedulerShape
>()("codework/composition/CompositionAutomationScheduler") {}

export interface CompositionAutomationSchedulerOptions {
  readonly store: CompositionAutomationStoreShape;
  readonly executor: CompositionAutomationRunExecutorShape;
  readonly now?: () => number;
  readonly batchSize?: number;
}

export const makeCompositionAutomationRunId = (input: {
  readonly automationId: string;
  readonly scheduledForUnixMs: number;
}): string => `composition-automation-run:${input.automationId}:${input.scheduledForUnixMs}`;

const schedulerError = (
  code: string,
  detail: string,
  correlation: { readonly automationId?: string; readonly automationRunId?: string } = {},
): CompositionAutomationSchedulerError =>
  new CompositionAutomationSchedulerError({ code, detail, ...correlation });

const persistenceError = (
  operation: string,
  cause: CompositionAutomationStoreError,
  correlation: { readonly automationId?: string; readonly automationRunId?: string } = {},
): CompositionAutomationSchedulerError =>
  schedulerError(
    "automation_persistence_failed",
    `${operation} 失败：${cause.message}`,
    correlation,
  );

const makeQueuedRun = (
  automation: CompositionAutomation,
  scheduledForUnixMs: number,
): CompositionAutomationRun => {
  const automationRunId = makeCompositionAutomationRunId({
    automationId: automation.automationId,
    scheduledForUnixMs,
  });
  return {
    automationRunId,
    automationId: automation.automationId,
    automationRevision: automation.revision,
    scheduledForUnixMs,
    idempotencyKey: makeCompositionAutomationRunIdempotencyKey({
      automationId: automation.automationId,
      scheduledForUnixMs,
    }),
    trigger: "scheduled",
    status: "queued",
    attempt: 1,
    requestedAtUnixMs: scheduledForUnixMs,
    startedAtUnixMs: null,
    finishedAtUnixMs: null,
    compositionTaskId: null,
    compositionRunId: null,
    outputSummary: null,
    errorCode: null,
    errorDetail: null,
  };
};

const makeRunningRun = (
  run: CompositionAutomationRun,
  startedAtUnixMs: number,
): CompositionAutomationRun => ({
  ...run,
  status: "running",
  startedAtUnixMs,
  compositionTaskId: `${run.automationRunId}:task`,
  compositionRunId: `${run.automationRunId}:run`,
});

const makeFailedRun = (
  run: CompositionAutomationRun,
  failedAtUnixMs: number,
  errorCode: string,
  errorDetail: string,
): CompositionAutomationRun => ({
  ...run,
  status: "failed",
  startedAtUnixMs: run.startedAtUnixMs ?? failedAtUnixMs,
  finishedAtUnixMs: failedAtUnixMs,
  errorCode,
  errorDetail,
});

const makeNextAutomation = (
  automation: CompositionAutomation,
  observedAtUnixMs: number,
  nextRunAtUnixMs: number | null,
): CompositionAutomation => {
  const runCount = automation.runCount + 1;
  const completed =
    nextRunAtUnixMs === null || (automation.maxRuns !== null && runCount >= automation.maxRuns);
  return {
    ...automation,
    status: completed ? "completed" : "active",
    runCount,
    updatedAtUnixMs: observedAtUnixMs,
    nextRunAtUnixMs: completed ? null : nextRunAtUnixMs,
    lastRunAtUnixMs: automation.nextRunAtUnixMs,
    pausedAtUnixMs: null,
  };
};

export const makeCompositionAutomationScheduler = (
  options: CompositionAutomationSchedulerOptions,
): CompositionAutomationSchedulerShape => {
  const batchSize = options.batchSize ?? 50;
  const currentTimeMillis =
    options.now === undefined ? Clock.currentTimeMillis : Effect.sync(options.now);

  const getRevision = Effect.fn("CompositionAutomationScheduler.getRevision")(function* (
    run: CompositionAutomationRun,
  ) {
    const revision = yield* options.store
      .getAutomationRevision(run.automationId, run.automationRevision)
      .pipe(
        Effect.mapError((cause) =>
          persistenceError("读取 Automation revision", cause, {
            automationId: run.automationId,
            automationRunId: run.automationRunId,
          }),
        ),
      );
    if (Option.isNone(revision)) {
      return yield* schedulerError(
        "automation_revision_missing",
        `Automation revision ${run.automationRevision} 不存在。`,
        { automationId: run.automationId, automationRunId: run.automationRunId },
      );
    }
    return revision.value;
  });

  const recordPermanentFailure = Effect.fn("CompositionAutomationScheduler.recordPermanentFailure")(
    function* (
      run: CompositionAutomationRun,
      failedAtUnixMs: number,
      code: string,
      detail: string,
    ) {
      const failed = makeFailedRun(run, failedAtUnixMs, code, detail);
      return yield* options.store
        .saveRunTransition({ run: failed, expectedStatus: run.status })
        .pipe(
          Effect.mapError((cause) =>
            persistenceError("记录 Automation Run 失败", cause, {
              automationId: run.automationId,
              automationRunId: run.automationRunId,
            }),
          ),
        );
    },
  );

  const ensureStarted = Effect.fn("CompositionAutomationScheduler.ensureStarted")(function* (
    run: CompositionAutomationRun,
    observedAtUnixMs: number,
  ) {
    const automation = yield* getRevision(run);
    let running = run;
    let claimed = false;
    if (run.status === "queued") {
      const executionClaim = yield* options.store
        .claimRunExecution(makeRunningRun(run, observedAtUnixMs))
        .pipe(
          Effect.mapError((cause) =>
            persistenceError("领取 Automation Run 执行权", cause, {
              automationId: run.automationId,
              automationRunId: run.automationRunId,
            }),
          ),
        );
      running = executionClaim.run;
      claimed = executionClaim.claimed;
      if (!claimed) {
        return {
          automationId: run.automationId,
          automationRunId: run.automationRunId,
          status: "deduplicated" as const,
        };
      }
    } else if (run.status !== "running") {
      return {
        automationId: run.automationId,
        automationRunId: run.automationRunId,
        status: "deduplicated" as const,
      };
    }

    const started = yield* Effect.result(
      options.executor.ensureStarted({ automation, run: running }),
    );
    if (started._tag === "Success") {
      return {
        automationId: run.automationId,
        automationRunId: run.automationRunId,
        status: run.status === "running" ? ("recovered" as const) : ("started" as const),
      };
    }
    if (started.failure.retryable) {
      return {
        automationId: run.automationId,
        automationRunId: run.automationRunId,
        status: "retry_pending" as const,
        errorCode: started.failure.code,
      };
    }
    yield* recordPermanentFailure(
      running,
      observedAtUnixMs,
      started.failure.code,
      started.failure.detail,
    );
    return {
      automationId: run.automationId,
      automationRunId: run.automationRunId,
      status: "failed" as const,
      errorCode: started.failure.code,
    };
  });

  const processDueAutomation = Effect.fn("CompositionAutomationScheduler.processDueAutomation")(
    function* (automation: CompositionAutomation, nowUnixMs: number) {
      const scheduledForUnixMs = automation.nextRunAtUnixMs;
      if (scheduledForUnixMs === null) {
        return yield* schedulerError(
          "automation_schedule_invalid",
          "active Automation 缺少 nextRunAt。",
          { automationId: automation.automationId },
        );
      }
      const observedAtUnixMs = Math.max(nowUnixMs, automation.updatedAtUnixMs, scheduledForUnixMs);
      const run = makeQueuedRun(automation, scheduledForUnixMs);
      const limitReached =
        automation.maxRuns !== null && automation.runCount + 1 >= automation.maxRuns;
      const cadenceResult: Effect.Effect<number | null, CompositionAutomationCadenceError> =
        limitReached
          ? Effect.succeed<number | null>(null)
          : calculateNextCompositionAutomationRun({
              automationId: automation.automationId,
              cadence: automation.cadence,
              afterUnixMs: observedAtUnixMs,
              expiresAtUnixMs: automation.expiresAtUnixMs,
            });
      const nextResult = yield* Effect.result(cadenceResult);
      const nextAutomation = makeNextAutomation(
        automation,
        observedAtUnixMs,
        nextResult._tag === "Success" ? nextResult.success : null,
      );
      const claim = yield* options.store.claimScheduledRun({ run, nextAutomation }).pipe(
        Effect.mapError((cause) =>
          persistenceError("认领 Automation 计划点", cause, {
            automationId: automation.automationId,
            automationRunId: run.automationRunId,
          }),
        ),
      );

      if (nextResult._tag === "Failure") {
        yield* recordPermanentFailure(
          claim.run,
          observedAtUnixMs,
          nextResult.failure.code,
          nextResult.failure.detail,
        );
        return {
          automationId: automation.automationId,
          automationRunId: claim.run.automationRunId,
          status: "failed" as const,
          errorCode: nextResult.failure.code,
        };
      }
      if (claim.run.status !== "queued") {
        return {
          automationId: automation.automationId,
          automationRunId: claim.run.automationRunId,
          status: "deduplicated" as const,
        };
      }
      return yield* ensureStarted(claim.run, observedAtUnixMs);
    },
  );

  const tick: CompositionAutomationSchedulerShape["tick"] = () =>
    Effect.gen(function* () {
      const nowUnixMs = yield* currentTimeMillis;
      const due = yield* options.store
        .listDueAutomations({ nowUnixMs, limit: batchSize })
        .pipe(Effect.mapError((cause) => persistenceError("列出到期 Automation", cause)));
      const outcomes = yield* Effect.forEach(
        due,
        (automation) => processDueAutomation(automation, nowUnixMs),
        { concurrency: Math.min(batchSize, 4) },
      );
      return { outcomes };
    });

  const recover: CompositionAutomationSchedulerShape["recover"] = () =>
    Effect.gen(function* () {
      const nowUnixMs = yield* currentTimeMillis;
      const runs = yield* options.store
        .listRecoverableRuns({ limit: batchSize })
        .pipe(Effect.mapError((cause) => persistenceError("列出待恢复 Automation Run", cause)));
      const outcomes = yield* Effect.forEach(
        runs,
        (run) => ensureStarted(run, Math.max(nowUnixMs, run.requestedAtUnixMs)),
        { concurrency: Math.min(batchSize, 4) },
      );
      return { outcomes };
    });

  return { tick, recover };
};

const live = Effect.gen(function* () {
  const store = yield* CompositionAutomationStore;
  const executor = yield* CompositionAutomationRunExecutor;
  return makeCompositionAutomationScheduler({ store, executor });
});

export const CompositionAutomationSchedulerLive = Layer.effect(
  CompositionAutomationScheduler,
  live,
);
