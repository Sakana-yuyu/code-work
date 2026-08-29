import {
  CompositionAutomation as CompositionAutomationSchema,
  type CompositionAutomation,
  type CompositionAutomationCreateRequest,
  type CompositionAutomationDeleteResult,
  type CompositionAutomationListRequest,
  type CompositionAutomationRevisionMutationRequest,
  type CompositionAutomationRunListRequest,
  type CompositionAutomationRunListResult,
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
  | "automation_persistence_failed";

export class CompositionAutomationServiceError extends Schema.TaggedErrorClass<CompositionAutomationServiceError>()(
  "CompositionAutomationServiceError",
  {
    code: Schema.String,
    automationId: Schema.String,
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
}

export class CompositionAutomationService extends Context.Service<
  CompositionAutomationService,
  CompositionAutomationServiceShape
>()("codework/composition/CompositionAutomationService") {}

export interface CompositionAutomationServiceOptions {
  readonly store: CompositionAutomationStoreShape;
  readonly now?: () => number;
}

const serviceError = (
  code: CompositionAutomationServiceErrorCode,
  automationId: string,
  detail: string,
  revisions?: { readonly expectedRevision: number; readonly actualRevision: number },
): CompositionAutomationServiceError =>
  new CompositionAutomationServiceError({
    code,
    automationId,
    detail,
    ...(revisions === undefined ? {} : revisions),
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
  return makeCompositionAutomationService({ store });
});

export const CompositionAutomationServiceLive = Layer.effect(CompositionAutomationService, live);
