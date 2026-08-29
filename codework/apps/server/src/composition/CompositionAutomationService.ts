import * as NodeCrypto from "node:crypto";

import {
  CompositionAutomation as CompositionAutomationSchema,
  type CompositionAutomation,
  type CompositionAutomationCreateRequest,
  type CompositionAutomationDeleteResult,
  type CompositionAutomationListRequest,
  type CompositionAutomationRetryRequest,
  type CompositionAutomationRevisionMutationRequest,
  type CompositionAutomationRun,
  type CompositionAutomationRunListRequest,
  type CompositionAutomationRunListResult,
  type CompositionAutomationRunOnceRequest,
  type CompositionAutomationUpdateRequest,
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
import {
  CompositionAutomationRunExecutor,
  type CompositionAutomationRunExecutorShape,
} from "./CompositionAutomationScheduler.ts";

const decodeAutomation = Schema.decodeUnknownEffect(CompositionAutomationSchema);

export type CompositionAutomationServiceErrorCode =
  | "automation_not_found"
  | "automation_already_exists"
  | "automation_revision_conflict"
  | "automation_invalid_state"
  | "automation_schedule_invalid"
  | "automation_validation_failed"
  | "automation_timezone_invalid"
  | "automation_cron_invalid"
  | "automation_timestamp_out_of_range"
  | "automation_run_not_found"
  | "automation_run_retry_pending"
  | "automation_persistence_failed";

export class CompositionAutomationServiceError extends Schema.TaggedErrorClass<CompositionAutomationServiceError>()(
  "CompositionAutomationServiceError",
  {
    code: Schema.String,
    automationId: Schema.String,
    automationRunId: Schema.optional(Schema.String),
    detail: Schema.String,
    expectedRevision: Schema.optional(Schema.Number),
    actualRevision: Schema.optional(Schema.Number),
  },
) {
  override get message(): string {
    return `Automation 服务失败：${this.code}: ${this.detail}`;
  }
}

export interface CompositionAutomationServiceShape {
  readonly create: (
    request: CompositionAutomationCreateRequest,
  ) => Effect.Effect<CompositionAutomation, CompositionAutomationServiceError>;
  readonly update: (
    request: CompositionAutomationUpdateRequest,
  ) => Effect.Effect<CompositionAutomation, CompositionAutomationServiceError>;
  readonly get: (
    automationId: string,
  ) => Effect.Effect<CompositionAutomation, CompositionAutomationServiceError>;
  readonly list: (
    request?: CompositionAutomationListRequest,
  ) => Effect.Effect<ReadonlyArray<CompositionAutomation>, CompositionAutomationServiceError>;
  readonly pause: (
    request: CompositionAutomationRevisionMutationRequest,
  ) => Effect.Effect<CompositionAutomation, CompositionAutomationServiceError>;
  readonly resume: (
    request: CompositionAutomationRevisionMutationRequest,
  ) => Effect.Effect<CompositionAutomation, CompositionAutomationServiceError>;
  readonly delete: (
    request: CompositionAutomationRevisionMutationRequest,
  ) => Effect.Effect<CompositionAutomationDeleteResult, CompositionAutomationServiceError>;
  readonly listRuns: (
    request: CompositionAutomationRunListRequest,
  ) => Effect.Effect<CompositionAutomationRunListResult, CompositionAutomationServiceError>;
  readonly runOnce: (
    request: CompositionAutomationRunOnceRequest,
  ) => Effect.Effect<CompositionAutomationRun, CompositionAutomationServiceError>;
  readonly retry: (
    request: CompositionAutomationRetryRequest,
  ) => Effect.Effect<CompositionAutomationRun, CompositionAutomationServiceError>;
}

export class CompositionAutomationService extends Context.Service<
  CompositionAutomationService,
  CompositionAutomationServiceShape
>()("codework/composition/CompositionAutomationService") {}

export interface CompositionAutomationServiceOptions {
  readonly store: CompositionAutomationStoreShape;
  readonly executor: Pick<CompositionAutomationRunExecutorShape, "ensureStarted">;
  readonly now?: () => number;
}

const serviceError = (
  code: CompositionAutomationServiceErrorCode,
  automationId: string,
  detail: string,
  correlation: {
    readonly automationRunId?: string;
    readonly expectedRevision?: number;
    readonly actualRevision?: number;
  } = {},
): CompositionAutomationServiceError =>
  new CompositionAutomationServiceError({
    code,
    automationId,
    detail,
    ...correlation,
  });

const persistenceError = (
  operation: string,
  automationId: string,
  cause: CompositionAutomationStoreError,
): CompositionAutomationServiceError => {
  if (cause._tag === "CompositionAutomationStoreDomainError") {
    if (
      cause.code === "automation_not_found" ||
      cause.code === "automation_already_exists" ||
      cause.code === "automation_revision_conflict"
    ) {
      return serviceError(
        cause.code,
        automationId,
        cause.detail,
        cause.expectedRevision === undefined || cause.actualRevision === undefined
          ? undefined
          : {
              expectedRevision: cause.expectedRevision,
              actualRevision: cause.actualRevision,
            },
      );
    }
  }
  return serviceError(
    "automation_persistence_failed",
    automationId,
    `${operation}失败：${cause.message}`,
  );
};

const manualRunPersistenceError = (
  operation: string,
  automationId: string,
  cause: CompositionAutomationStoreError,
): CompositionAutomationServiceError => {
  if (
    cause._tag === "CompositionAutomationStoreDomainError" &&
    cause.code === "automation_run_status_conflict"
  ) {
    return serviceError(
      "automation_invalid_state",
      automationId,
      cause.detail,
      cause.automationRunId === undefined ? {} : { automationRunId: cause.automationRunId },
    );
  }
  return persistenceError(operation, automationId, cause);
};

const cadenceError = (
  cause: CompositionAutomationCadenceError,
): CompositionAutomationServiceError => serviceError(cause.code, cause.automationId, cause.detail);

export const makeCompositionAutomationService = (
  options: CompositionAutomationServiceOptions,
): CompositionAutomationServiceShape => {
  const currentTimeMillis =
    options.now === undefined ? Clock.currentTimeMillis : Effect.sync(options.now);

  const validate = (automation: CompositionAutomation) =>
    decodeAutomation(automation).pipe(
      Effect.mapError((cause) =>
        serviceError("automation_validation_failed", automation.automationId, cause.message),
      ),
    );

  const getOption = (operation: string, automationId: string) =>
    options.store
      .getAutomation(automationId)
      .pipe(Effect.mapError((cause) => persistenceError(operation, automationId, cause)));

  const get = Effect.fn("CompositionAutomationService.get")(function* (automationId: string) {
    const automation = yield* getOption("读取 Automation", automationId);
    if (Option.isNone(automation)) {
      return yield* serviceError("automation_not_found", automationId, "Automation 不存在。");
    }
    return automation.value;
  });

  const getRun = Effect.fn("CompositionAutomationService.getRun")(function* (
    automationId: string,
    automationRunId: string,
  ) {
    const run = yield* options.store
      .getRun(automationRunId)
      .pipe(
        Effect.mapError((cause) => persistenceError("读取 Automation Run", automationId, cause)),
      );
    if (Option.isNone(run) || run.value.automationId !== automationId) {
      return yield* serviceError(
        "automation_run_not_found",
        automationId,
        "Automation Run 不存在。",
        { automationRunId },
      );
    }
    return run.value;
  });

  const getRunRevision = Effect.fn("CompositionAutomationService.getRunRevision")(function* (
    run: CompositionAutomationRun,
  ) {
    const revision = yield* options.store
      .getAutomationRevision(run.automationId, run.automationRevision)
      .pipe(
        Effect.mapError((cause) =>
          persistenceError("读取 Automation Run revision", run.automationId, cause),
        ),
      );
    if (Option.isNone(revision)) {
      return yield* serviceError(
        "automation_persistence_failed",
        run.automationId,
        `Automation revision ${run.automationRevision} 不存在。`,
        { automationRunId: run.automationRunId },
      );
    }
    return revision.value;
  });

  const checkRevision = (
    automation: CompositionAutomation,
    expectedRevision: number,
  ): Effect.Effect<void, CompositionAutomationServiceError> =>
    automation.revision === expectedRevision
      ? Effect.void
      : Effect.fail(
          serviceError(
            "automation_revision_conflict",
            automation.automationId,
            `预期 revision ${expectedRevision}，实际为 ${automation.revision}。`,
            { expectedRevision, actualRevision: automation.revision },
          ),
        );

  const checkMutableSchedule = (
    automationId: string,
    nowUnixMs: number,
    expiresAtUnixMs: number | null,
    maxRuns: number | null,
    runCount: number,
  ): Effect.Effect<void, CompositionAutomationServiceError> => {
    if (expiresAtUnixMs !== null && expiresAtUnixMs <= nowUnixMs) {
      return Effect.fail(
        serviceError("automation_schedule_invalid", automationId, "expiresAt 必须晚于当前时间。"),
      );
    }
    if (maxRuns !== null && runCount >= maxRuns) {
      return Effect.fail(
        serviceError(
          "automation_schedule_invalid",
          automationId,
          `maxRuns 必须大于当前运行次数 ${runCount}。`,
        ),
      );
    }
    return Effect.void;
  };

  const calculateNext = Effect.fn("CompositionAutomationService.calculateNext")(function* (
    automationId: string,
    cadence: CompositionAutomation["cadence"],
    nowUnixMs: number,
    expiresAtUnixMs: number | null,
  ) {
    const nextRunAtUnixMs = yield* calculateNextCompositionAutomationRun({
      automationId,
      cadence,
      afterUnixMs: nowUnixMs,
      expiresAtUnixMs,
    }).pipe(Effect.mapError(cadenceError));
    if (nextRunAtUnixMs === null) {
      return yield* serviceError(
        "automation_schedule_invalid",
        automationId,
        "当前 cadence 在 expiresAt 前没有可运行的计划点。",
      );
    }
    return nextRunAtUnixMs;
  });

  const validateCadence = Effect.fn("CompositionAutomationService.validateCadence")(function* (
    automationId: string,
    cadence: CompositionAutomation["cadence"],
    nowUnixMs: number,
  ) {
    yield* calculateNextCompositionAutomationRun({
      automationId,
      cadence,
      afterUnixMs: nowUnixMs,
      expiresAtUnixMs: null,
    }).pipe(Effect.mapError(cadenceError));
  });

  const saveRevision = (
    operation: string,
    automation: CompositionAutomation,
    expectedRevision: number,
  ) =>
    options.store
      .saveAutomationRevision({ automation, expectedRevision })
      .pipe(
        Effect.mapError((cause) => persistenceError(operation, automation.automationId, cause)),
      );

  const create = Effect.fn("CompositionAutomationService.create")(function* (
    request: CompositionAutomationCreateRequest,
  ) {
    const nowUnixMs = yield* currentTimeMillis;
    yield* checkMutableSchedule(
      request.automationId,
      nowUnixMs,
      request.expiresAtUnixMs,
      request.maxRuns,
      0,
    );
    const nextRunAtUnixMs = request.runOnCreate
      ? yield* validateCadence(request.automationId, request.cadence, nowUnixMs).pipe(
          Effect.as(nowUnixMs),
        )
      : yield* calculateNext(
          request.automationId,
          request.cadence,
          nowUnixMs,
          request.expiresAtUnixMs,
        );
    const automation = yield* validate({
      automationId: request.automationId,
      projectId: request.projectId,
      name: request.name,
      prompt: request.prompt,
      cadence: request.cadence,
      target: request.target,
      status: "active",
      revision: 1,
      maxRuns: request.maxRuns,
      runCount: 0,
      createdAtUnixMs: nowUnixMs,
      updatedAtUnixMs: nowUnixMs,
      nextRunAtUnixMs,
      lastRunAtUnixMs: null,
      pausedAtUnixMs: null,
      expiresAtUnixMs: request.expiresAtUnixMs,
    });
    return yield* options.store
      .createAutomation(automation)
      .pipe(
        Effect.mapError((cause) =>
          persistenceError("创建 Automation", request.automationId, cause),
        ),
      );
  });

  const update = Effect.fn("CompositionAutomationService.update")(function* (
    request: CompositionAutomationUpdateRequest,
  ) {
    const current = yield* get(request.automationId);
    yield* checkRevision(current, request.expectedRevision);
    if (current.status === "completed") {
      return yield* serviceError(
        "automation_invalid_state",
        request.automationId,
        "completed Automation 不允许编辑或重新激活。",
      );
    }

    const nowUnixMs = yield* currentTimeMillis;
    const cadence = request.cadence ?? current.cadence;
    const expiresAtUnixMs =
      request.expiresAtUnixMs === undefined ? current.expiresAtUnixMs : request.expiresAtUnixMs;
    const maxRuns = request.maxRuns === undefined ? current.maxRuns : request.maxRuns;
    yield* checkMutableSchedule(
      request.automationId,
      nowUnixMs,
      expiresAtUnixMs,
      maxRuns,
      current.runCount,
    );
    const nextRunAtUnixMs =
      current.status === "active"
        ? yield* calculateNext(request.automationId, cadence, nowUnixMs, expiresAtUnixMs)
        : yield* calculateNext(request.automationId, cadence, nowUnixMs, expiresAtUnixMs).pipe(
            Effect.as(null),
          );
    const automation = yield* validate({
      ...current,
      ...(request.name === undefined ? {} : { name: request.name }),
      ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
      ...(request.target === undefined ? {} : { target: request.target }),
      cadence,
      maxRuns,
      expiresAtUnixMs,
      revision: current.revision + 1,
      updatedAtUnixMs: nowUnixMs,
      nextRunAtUnixMs,
    });
    return yield* saveRevision("编辑 Automation", automation, request.expectedRevision);
  });

  const pause = Effect.fn("CompositionAutomationService.pause")(function* (
    request: CompositionAutomationRevisionMutationRequest,
  ) {
    const current = yield* get(request.automationId);
    yield* checkRevision(current, request.expectedRevision);
    if (current.status !== "active") {
      return yield* serviceError(
        "automation_invalid_state",
        request.automationId,
        `只有 active Automation 可以暂停，当前状态为 ${current.status}。`,
      );
    }
    const nowUnixMs = yield* currentTimeMillis;
    const automation = yield* validate({
      ...current,
      status: "paused",
      revision: current.revision + 1,
      updatedAtUnixMs: nowUnixMs,
      nextRunAtUnixMs: null,
      pausedAtUnixMs: nowUnixMs,
    });
    return yield* saveRevision("暂停 Automation", automation, request.expectedRevision);
  });

  const resume = Effect.fn("CompositionAutomationService.resume")(function* (
    request: CompositionAutomationRevisionMutationRequest,
  ) {
    const current = yield* get(request.automationId);
    yield* checkRevision(current, request.expectedRevision);
    if (current.status !== "paused") {
      return yield* serviceError(
        "automation_invalid_state",
        request.automationId,
        `只有 paused Automation 可以恢复，当前状态为 ${current.status}。`,
      );
    }
    const nowUnixMs = yield* currentTimeMillis;
    yield* checkMutableSchedule(
      request.automationId,
      nowUnixMs,
      current.expiresAtUnixMs,
      current.maxRuns,
      current.runCount,
    );
    const nextRunAtUnixMs = yield* calculateNext(
      request.automationId,
      current.cadence,
      nowUnixMs,
      current.expiresAtUnixMs,
    );
    const automation = yield* validate({
      ...current,
      status: "active",
      revision: current.revision + 1,
      updatedAtUnixMs: nowUnixMs,
      nextRunAtUnixMs,
      pausedAtUnixMs: null,
    });
    return yield* saveRevision("恢复 Automation", automation, request.expectedRevision);
  });

  const deleteAutomation = Effect.fn("CompositionAutomationService.delete")(function* (
    request: CompositionAutomationRevisionMutationRequest,
  ) {
    const current = yield* get(request.automationId);
    yield* checkRevision(current, request.expectedRevision);
    const deletedAtUnixMs = yield* currentTimeMillis;
    return yield* options.store
      .deleteAutomation({ ...request, deletedAtUnixMs })
      .pipe(
        Effect.mapError((cause) =>
          persistenceError("删除 Automation", request.automationId, cause),
        ),
      );
  });

  const executeManualRun = Effect.fn("CompositionAutomationService.executeManualRun")(function* (
    run: CompositionAutomationRun,
  ) {
    if (
      run.status === "succeeded" ||
      run.status === "failed" ||
      run.status === "cancelled" ||
      run.status === "skipped"
    ) {
      return run;
    }

    let running = run;
    if (run.status === "queued") {
      const observedAtUnixMs = yield* currentTimeMillis;
      const execution = yield* options.store
        .claimRunExecution({
          ...run,
          status: "running",
          startedAtUnixMs: Math.max(observedAtUnixMs, run.requestedAtUnixMs),
          compositionTaskId: `${run.automationRunId}:task`,
          compositionRunId: `${run.automationRunId}:run`,
        })
        .pipe(
          Effect.mapError((cause) =>
            manualRunPersistenceError("领取手动 Automation Run 执行权", run.automationId, cause),
          ),
        );
      running = execution.run;
    }

    const automation = yield* getRunRevision(running);
    const started = yield* Effect.result(
      options.executor.ensureStarted({ automation, run: running }),
    );
    if (started._tag === "Success") return running;
    if (started.failure.retryable) {
      return yield* serviceError(
        "automation_run_retry_pending",
        running.automationId,
        `${started.failure.code}: ${started.failure.detail}`,
        { automationRunId: running.automationRunId },
      );
    }

    const failedAtUnixMs = yield* currentTimeMillis;
    return yield* options.store
      .saveRunTransition({
        expectedStatus: "running",
        run: {
          ...running,
          status: "failed",
          finishedAtUnixMs: Math.max(
            failedAtUnixMs,
            running.startedAtUnixMs ?? running.requestedAtUnixMs,
          ),
          errorCode: started.failure.code,
          errorDetail: started.failure.detail,
        },
      })
      .pipe(
        Effect.mapError((cause) =>
          manualRunPersistenceError("记录手动 Automation Run 失败", running.automationId, cause),
        ),
      );
  });

  const makeManualRunId = (automationId: string, operationId: string): string =>
    `composition-automation-manual:${NodeCrypto.createHash("sha256")
      .update(automationId)
      .update("\0")
      .update(operationId)
      .digest("hex")}`;

  const runOnce = Effect.fn("CompositionAutomationService.runOnce")(function* (
    request: CompositionAutomationRunOnceRequest,
  ) {
    const current = yield* get(request.automationId);
    if (current.status === "completed") {
      return yield* serviceError(
        "automation_invalid_state",
        request.automationId,
        "completed Automation 不允许立即运行。",
      );
    }
    const requestedAtUnixMs = yield* currentTimeMillis;
    const claim = yield* options.store
      .claimManualRun({
        automationRunId: makeManualRunId(request.automationId, request.operationId),
        automationId: request.automationId,
        expectedAutomationRevision: request.expectedRevision,
        automationRevision: request.expectedRevision,
        operationId: request.operationId,
        trigger: "run_once",
        requestedAtUnixMs,
        attempt: 1,
      })
      .pipe(
        Effect.mapError((cause) =>
          manualRunPersistenceError("认领立即运行 operation", request.automationId, cause),
        ),
      );
    return yield* executeManualRun(claim.run);
  });

  const retry = Effect.fn("CompositionAutomationService.retry")(function* (
    request: CompositionAutomationRetryRequest,
  ) {
    yield* get(request.automationId);
    const source = yield* getRun(request.automationId, request.automationRunId);
    if (source.status !== "failed") {
      return yield* serviceError(
        "automation_invalid_state",
        request.automationId,
        `只有 failed Automation Run 可以重试，当前状态为 ${source.status}。`,
        { automationRunId: source.automationRunId },
      );
    }
    if (source.attempt >= Number.MAX_SAFE_INTEGER) {
      return yield* serviceError(
        "automation_validation_failed",
        request.automationId,
        "Automation Run attempt 已达到安全整数上限。",
        { automationRunId: source.automationRunId },
      );
    }

    const requestedAtUnixMs = yield* currentTimeMillis;
    const claim = yield* options.store
      .claimManualRun({
        automationRunId: makeManualRunId(request.automationId, request.operationId),
        automationId: request.automationId,
        expectedAutomationRevision: request.expectedRevision,
        automationRevision: source.automationRevision,
        operationId: request.operationId,
        trigger: "retry",
        sourceAutomationRunId: source.automationRunId,
        requestedAtUnixMs,
        attempt: source.attempt + 1,
      })
      .pipe(
        Effect.mapError((cause) =>
          manualRunPersistenceError("认领失败重试 operation", request.automationId, cause),
        ),
      );
    return yield* executeManualRun(claim.run);
  });

  return {
    create,
    update,
    get,
    list: (request = {}) =>
      options.store
        .listAutomations(request)
        .pipe(Effect.mapError((cause) => persistenceError("列出 Automation", "*", cause))),
    pause,
    resume,
    delete: deleteAutomation,
    runOnce,
    retry,
    listRuns: (request) =>
      options.store
        .listRuns(request)
        .pipe(
          Effect.mapError((cause) =>
            persistenceError("列出 Automation 运行历史", request.automationId, cause),
          ),
        ),
  };
};

const live = Effect.gen(function* () {
  const store = yield* CompositionAutomationStore;
  const executor = yield* CompositionAutomationRunExecutor;
  return makeCompositionAutomationService({ store, executor });
});

export const CompositionAutomationServiceLive = Layer.effect(CompositionAutomationService, live);
