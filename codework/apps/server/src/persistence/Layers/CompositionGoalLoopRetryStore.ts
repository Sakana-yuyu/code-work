import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import type { SqlError } from "effect/unstable/sql/SqlError";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type PersistenceDecodeError,
  type PersistenceSqlError,
} from "../Errors.ts";
import {
  CompositionGoalLoopRetryPhase,
  CompositionGoalLoopRetryStore,
  CompositionGoalLoopRetryStoreDomainError,
  type CompositionGoalLoopRetryAdvanceInput,
  type CompositionGoalLoopRetryDispatchClaimInput,
  type CompositionGoalLoopRetryDispatchCompleteInput,
  type CompositionGoalLoopRetryDispatchReleaseInput,
  type CompositionGoalLoopRetryIntent,
  type CompositionGoalLoopRetryPrepareInput,
  type CompositionGoalLoopRetryRecoveryInput,
  type CompositionGoalLoopRetryStoreErrorCode,
  type CompositionGoalLoopRetryStoreShape,
} from "../Services/CompositionGoalLoopRetryStore.ts";

const RetryIntentRowSchema = Schema.Struct({
  taskId: Schema.String,
  previousRunId: Schema.String,
  newRunId: Schema.String,
  phase: CompositionGoalLoopRetryPhase,
  revision: Schema.Number,
  createdAtUnixMs: Schema.Number,
  updatedAtUnixMs: Schema.Number,
  dispatchClaimId: Schema.NullOr(Schema.String),
  dispatchClaimedAtUnixMs: Schema.NullOr(Schema.Number),
});
type RetryIntentRow = typeof RetryIntentRowSchema.Type;

const RetryIntentPrepareSchema = Schema.Struct({
  taskId: Schema.String,
  previousRunId: Schema.String,
  newRunId: Schema.String,
  createdAtUnixMs: Schema.Number,
});
const RetryIntentIdSchema = Schema.Struct({ previousRunId: Schema.String });
const RetryIntentNewRunIdSchema = Schema.Struct({ newRunId: Schema.String });
const RetryIntentPendingSchema = Schema.Struct({});
const RetryIntentAdvanceSchema = Schema.Struct({
  previousRunId: Schema.String,
  updatedAtUnixMs: Schema.Number,
});
const RetryIntentClaimSchema = Schema.Struct({
  previousRunId: Schema.String,
  claimId: Schema.String,
  claimedAtUnixMs: Schema.Number,
});
const RetryIntentReleaseSchema = Schema.Struct({
  previousRunId: Schema.String,
  claimId: Schema.String,
});
const RetryIntentCompleteSchema = Schema.Struct({
  previousRunId: Schema.String,
  claimId: Schema.String,
  updatedAtUnixMs: Schema.Number,
});
const RetryIntentRecoverySchema = Schema.Struct({ recoveredAtUnixMs: Schema.Number });
const RetryIntentRecoveredRowSchema = Schema.Struct({ previousRunId: Schema.String });

const toIntent = (row: RetryIntentRow): CompositionGoalLoopRetryIntent => ({
  taskId: row.taskId,
  previousRunId: row.previousRunId,
  newRunId: row.newRunId,
  phase: row.phase,
  revision: row.revision,
  createdAtUnixMs: row.createdAtUnixMs,
  updatedAtUnixMs: row.updatedAtUnixMs,
});

const domainError = (
  code: CompositionGoalLoopRetryStoreErrorCode,
  detail: string,
  metadata: {
    readonly previousRunId?: string;
    readonly newRunId?: string;
    readonly actualPhase?: CompositionGoalLoopRetryIntent["phase"];
  } = {},
) => new CompositionGoalLoopRetryStoreDomainError({ code, detail, ...metadata });

const hasTextWithin = (value: string, maxLength: number): boolean =>
  value.trim().length > 0 && value.length <= maxLength;

const validateTimestamp = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

const validatePrepareInput = (input: CompositionGoalLoopRetryPrepareInput) =>
  hasTextWithin(input.taskId, 512) &&
  hasTextWithin(input.previousRunId, 512) &&
  hasTextWithin(input.newRunId, 512) &&
  input.previousRunId !== input.newRunId &&
  validateTimestamp(input.createdAtUnixMs)
    ? Effect.succeed(input)
    : Effect.fail(
        domainError("goal_loop_retry_input_invalid", "retry 身份字段或创建时间无效。", {
          previousRunId: input.previousRunId,
          newRunId: input.newRunId,
        }),
      );

const validateAdvanceInput = (input: CompositionGoalLoopRetryAdvanceInput) =>
  hasTextWithin(input.previousRunId, 512) && validateTimestamp(input.updatedAtUnixMs)
    ? Effect.succeed(input)
    : Effect.fail(
        domainError("goal_loop_retry_input_invalid", "旧 Run 标识或阶段更新时间无效。", {
          previousRunId: input.previousRunId,
        }),
      );

const validateClaimInput = (input: CompositionGoalLoopRetryDispatchClaimInput) =>
  hasTextWithin(input.previousRunId, 512) &&
  hasTextWithin(input.claimId, 512) &&
  validateTimestamp(input.claimedAtUnixMs)
    ? Effect.succeed(input)
    : Effect.fail(
        domainError("goal_loop_retry_input_invalid", "dispatch claim 身份或时间无效。", {
          previousRunId: input.previousRunId,
        }),
      );

const validateReleaseInput = (input: CompositionGoalLoopRetryDispatchReleaseInput) =>
  hasTextWithin(input.previousRunId, 512) && hasTextWithin(input.claimId, 512)
    ? Effect.succeed(input)
    : Effect.fail(
        domainError("goal_loop_retry_input_invalid", "dispatch claim 释放身份无效。", {
          previousRunId: input.previousRunId,
        }),
      );

const validateCompleteInput = (input: CompositionGoalLoopRetryDispatchCompleteInput) =>
  hasTextWithin(input.previousRunId, 512) &&
  hasTextWithin(input.claimId, 512) &&
  validateTimestamp(input.updatedAtUnixMs)
    ? Effect.succeed(input)
    : Effect.fail(
        domainError("goal_loop_retry_input_invalid", "dispatch 收口身份或时间无效。", {
          previousRunId: input.previousRunId,
        }),
      );

const validateRecoveryInput = (input: CompositionGoalLoopRetryRecoveryInput) =>
  validateTimestamp(input.recoveredAtUnixMs)
    ? Effect.succeed(input)
    : Effect.fail(domainError("goal_loop_retry_input_invalid", "dispatch 启动恢复时间无效。"));

const makeStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const getIntentRow = SqlSchema.findOneOption({
    Request: RetryIntentIdSchema,
    Result: RetryIntentRowSchema,
    execute: ({ previousRunId }) => sql`
      SELECT
        task_id AS "taskId", previous_run_id AS "previousRunId",
        new_run_id AS "newRunId", phase, revision,
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs",
        dispatch_claim_id AS "dispatchClaimId",
        dispatch_claimed_at_unix_ms AS "dispatchClaimedAtUnixMs"
      FROM composition_goal_loop_retry_intents
      WHERE previous_run_id = ${previousRunId}
      LIMIT 1
    `,
  });
  const getIntentByNewRunRow = SqlSchema.findOneOption({
    Request: RetryIntentNewRunIdSchema,
    Result: RetryIntentRowSchema,
    execute: ({ newRunId }) => sql`
      SELECT
        task_id AS "taskId", previous_run_id AS "previousRunId",
        new_run_id AS "newRunId", phase, revision,
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs",
        dispatch_claim_id AS "dispatchClaimId",
        dispatch_claimed_at_unix_ms AS "dispatchClaimedAtUnixMs"
      FROM composition_goal_loop_retry_intents
      WHERE new_run_id = ${newRunId}
      LIMIT 1
    `,
  });
  const listPendingIntentRows = SqlSchema.findAll({
    Request: RetryIntentPendingSchema,
    Result: RetryIntentRowSchema,
    execute: () => sql`
      SELECT
        task_id AS "taskId", previous_run_id AS "previousRunId",
        new_run_id AS "newRunId", phase, revision,
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs",
        dispatch_claim_id AS "dispatchClaimId",
        dispatch_claimed_at_unix_ms AS "dispatchClaimedAtUnixMs"
      FROM composition_goal_loop_retry_intents
      WHERE phase IN ('prepared', 'settled')
      ORDER BY created_at_unix_ms ASC, previous_run_id ASC
    `,
  });
  const insertIntentRow = SqlSchema.findOneOption({
    Request: RetryIntentPrepareSchema,
    Result: RetryIntentRowSchema,
    execute: (input) => sql`
      INSERT INTO composition_goal_loop_retry_intents (
        previous_run_id, task_id, new_run_id, phase, revision,
        created_at_unix_ms, updated_at_unix_ms,
        dispatch_claim_id, dispatch_claimed_at_unix_ms
      ) VALUES (
        ${input.previousRunId}, ${input.taskId}, ${input.newRunId},
        'prepared', 1, ${input.createdAtUnixMs}, ${input.createdAtUnixMs}, NULL, NULL
      )
      ON CONFLICT DO NOTHING
      RETURNING
        task_id AS "taskId", previous_run_id AS "previousRunId",
        new_run_id AS "newRunId", phase, revision,
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs",
        dispatch_claim_id AS "dispatchClaimId",
        dispatch_claimed_at_unix_ms AS "dispatchClaimedAtUnixMs"
    `,
  });
  const settleIntentRow = SqlSchema.findOneOption({
    Request: RetryIntentAdvanceSchema,
    Result: RetryIntentRowSchema,
    execute: (input) => sql`
      UPDATE composition_goal_loop_retry_intents
      SET phase = 'settled', revision = 2, updated_at_unix_ms = ${input.updatedAtUnixMs}
      WHERE previous_run_id = ${input.previousRunId}
        AND phase = 'prepared'
        AND ${input.updatedAtUnixMs} >= updated_at_unix_ms
      RETURNING
        task_id AS "taskId", previous_run_id AS "previousRunId",
        new_run_id AS "newRunId", phase, revision,
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs",
        dispatch_claim_id AS "dispatchClaimId",
        dispatch_claimed_at_unix_ms AS "dispatchClaimedAtUnixMs"
    `,
  });
  const claimDispatchRow = SqlSchema.findOneOption({
    Request: RetryIntentClaimSchema,
    Result: RetryIntentRowSchema,
    execute: (input) => sql`
      UPDATE composition_goal_loop_retry_intents
      SET dispatch_claim_id = ${input.claimId},
        dispatch_claimed_at_unix_ms = ${input.claimedAtUnixMs}
      WHERE previous_run_id = ${input.previousRunId}
        AND phase = 'settled'
        AND dispatch_claim_id IS NULL
        AND ${input.claimedAtUnixMs} >= updated_at_unix_ms
      RETURNING
        task_id AS "taskId", previous_run_id AS "previousRunId",
        new_run_id AS "newRunId", phase, revision,
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs",
        dispatch_claim_id AS "dispatchClaimId",
        dispatch_claimed_at_unix_ms AS "dispatchClaimedAtUnixMs"
    `,
  });
  const releaseDispatchRow = SqlSchema.findOneOption({
    Request: RetryIntentReleaseSchema,
    Result: RetryIntentRowSchema,
    execute: (input) => sql`
      UPDATE composition_goal_loop_retry_intents
      SET dispatch_claim_id = NULL, dispatch_claimed_at_unix_ms = NULL
      WHERE previous_run_id = ${input.previousRunId}
        AND phase = 'settled'
        AND dispatch_claim_id = ${input.claimId}
      RETURNING
        task_id AS "taskId", previous_run_id AS "previousRunId",
        new_run_id AS "newRunId", phase, revision,
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs",
        dispatch_claim_id AS "dispatchClaimId",
        dispatch_claimed_at_unix_ms AS "dispatchClaimedAtUnixMs"
    `,
  });
  const dispatchIntentRow = SqlSchema.findOneOption({
    Request: RetryIntentCompleteSchema,
    Result: RetryIntentRowSchema,
    execute: (input) => sql`
      UPDATE composition_goal_loop_retry_intents
      SET phase = 'dispatched', revision = 3, updated_at_unix_ms = ${input.updatedAtUnixMs},
        dispatch_claim_id = NULL, dispatch_claimed_at_unix_ms = NULL
      WHERE previous_run_id = ${input.previousRunId}
        AND phase = 'settled'
        AND dispatch_claim_id = ${input.claimId}
        AND ${input.updatedAtUnixMs} >= updated_at_unix_ms
      RETURNING
        task_id AS "taskId", previous_run_id AS "previousRunId",
        new_run_id AS "newRunId", phase, revision,
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs",
        dispatch_claim_id AS "dispatchClaimId",
        dispatch_claimed_at_unix_ms AS "dispatchClaimedAtUnixMs"
    `,
  });
  const recoverDispatchRows = SqlSchema.findAll({
    Request: RetryIntentRecoverySchema,
    Result: RetryIntentRecoveredRowSchema,
    execute: () => sql`
      UPDATE composition_goal_loop_retry_intents
      SET dispatch_claim_id = NULL, dispatch_claimed_at_unix_ms = NULL
      WHERE phase = 'settled' AND dispatch_claim_id IS NOT NULL
      RETURNING previous_run_id AS "previousRunId"
    `,
  });

  const run = <A>(
    operation: string,
    effect: Effect.Effect<A, SqlError | Schema.SchemaError>,
  ): Effect.Effect<A, PersistenceSqlError | PersistenceDecodeError> =>
    effect.pipe(
      Effect.mapError((cause) =>
        Schema.isSchemaError(cause)
          ? toPersistenceDecodeError(`${operation}:decode`)(cause)
          : toPersistenceSqlError(`${operation}:query`)(cause),
      ),
    );

  const getStoredIntent = (previousRunId: string) =>
    run("CompositionGoalLoopRetryStore.getIntent", getIntentRow({ previousRunId }));

  const getIntent: CompositionGoalLoopRetryStoreShape["getIntent"] = (previousRunId) =>
    getStoredIntent(previousRunId).pipe(Effect.map(Option.map(toIntent)));

  const listPendingIntents: CompositionGoalLoopRetryStoreShape["listPendingIntents"] = () =>
    run("CompositionGoalLoopRetryStore.listPendingIntents", listPendingIntentRows({})).pipe(
      Effect.map((rows) => rows.map(toIntent)),
    );

  const missingIntent = (previousRunId: string) =>
    domainError("goal_loop_retry_intent_missing", "Goal Loop retry 意图不存在。", {
      previousRunId,
    });

  const phaseConflict = (row: RetryIntentRow) =>
    domainError("goal_loop_retry_phase_conflict", "Goal Loop retry 阶段不允许当前推进。", {
      previousRunId: row.previousRunId,
      newRunId: row.newRunId,
      actualPhase: row.phase,
    });

  const dispatchInProgress = (row: RetryIntentRow) =>
    domainError("goal_loop_retry_dispatch_in_progress", "Goal Loop retry 正由其他调用重派。", {
      previousRunId: row.previousRunId,
      newRunId: row.newRunId,
      actualPhase: row.phase,
    });

  const prepareIntent: CompositionGoalLoopRetryStoreShape["prepareIntent"] = (input) =>
    Effect.gen(function* () {
      yield* validatePrepareInput(input);
      const inserted = yield* run(
        "CompositionGoalLoopRetryStore.prepareIntent",
        insertIntentRow(input),
      );
      if (Option.isSome(inserted)) return toIntent(inserted.value);

      const existing = yield* getIntent(input.previousRunId);
      if (Option.isSome(existing)) {
        if (existing.value.taskId !== input.taskId) {
          return yield* domainError(
            "goal_loop_retry_identity_conflict",
            "同一旧 Run 已绑定到其他 Task。",
            { previousRunId: input.previousRunId, newRunId: existing.value.newRunId },
          );
        }
        return existing.value;
      }

      const newRunOwner = yield* run(
        "CompositionGoalLoopRetryStore.getIntentByNewRun",
        getIntentByNewRunRow({ newRunId: input.newRunId }),
      );
      return yield* domainError(
        "goal_loop_retry_identity_conflict",
        Option.isSome(newRunOwner)
          ? `新 Run ${input.newRunId} 已由旧 Run ${newRunOwner.value.previousRunId} 占用。`
          : "retry 意图写入被冲突拒绝，且无法读取稳定身份。",
        { previousRunId: input.previousRunId, newRunId: input.newRunId },
      );
    });

  const readAfterAdvance = (
    input: CompositionGoalLoopRetryAdvanceInput,
    allowedPhases: ReadonlySet<CompositionGoalLoopRetryIntent["phase"]>,
  ) =>
    Effect.flatMap(getIntent(input.previousRunId), (current) => {
      if (Option.isNone(current)) return Effect.fail(missingIntent(input.previousRunId));
      return allowedPhases.has(current.value.phase)
        ? Effect.succeed(current.value)
        : Effect.fail(
            domainError("goal_loop_retry_phase_conflict", "Goal Loop retry 阶段不允许当前推进。", {
              previousRunId: input.previousRunId,
              newRunId: current.value.newRunId,
              actualPhase: current.value.phase,
            }),
          );
    });

  const markSettled: CompositionGoalLoopRetryStoreShape["markSettled"] = (input) =>
    Effect.gen(function* () {
      yield* validateAdvanceInput(input);
      const updated = yield* run(
        "CompositionGoalLoopRetryStore.markSettled",
        settleIntentRow(input),
      );
      return Option.isSome(updated)
        ? toIntent(updated.value)
        : yield* readAfterAdvance(input, new Set(["settled", "dispatched"]));
    });

  const claimDispatch: CompositionGoalLoopRetryStoreShape["claimDispatch"] = (input) =>
    Effect.gen(function* () {
      yield* validateClaimInput(input);
      const claimed = yield* run(
        "CompositionGoalLoopRetryStore.claimDispatch",
        claimDispatchRow(input),
      );
      if (Option.isSome(claimed)) return toIntent(claimed.value);

      const current = yield* getStoredIntent(input.previousRunId);
      if (Option.isNone(current)) return yield* missingIntent(input.previousRunId);
      if (current.value.phase === "dispatched") return toIntent(current.value);
      if (current.value.phase !== "settled") return yield* phaseConflict(current.value);
      if (current.value.dispatchClaimId === input.claimId) return toIntent(current.value);
      if (current.value.dispatchClaimId !== null) return yield* dispatchInProgress(current.value);
      return yield* domainError(
        "goal_loop_retry_input_invalid",
        "dispatch claim 时间不能早于 retry intent 最近阶段时间。",
        { previousRunId: input.previousRunId, newRunId: current.value.newRunId },
      );
    });

  const releaseDispatch: CompositionGoalLoopRetryStoreShape["releaseDispatch"] = (input) =>
    Effect.gen(function* () {
      yield* validateReleaseInput(input);
      const released = yield* run(
        "CompositionGoalLoopRetryStore.releaseDispatch",
        releaseDispatchRow(input),
      );
      if (Option.isSome(released)) return;

      const current = yield* getStoredIntent(input.previousRunId);
      if (Option.isNone(current)) return yield* missingIntent(input.previousRunId);
      if (current.value.phase === "dispatched") return;
      if (current.value.phase !== "settled") return yield* phaseConflict(current.value);
      if (current.value.dispatchClaimId === null) return;
      return yield* dispatchInProgress(current.value);
    });

  const markDispatched: CompositionGoalLoopRetryStoreShape["markDispatched"] = (input) =>
    Effect.gen(function* () {
      yield* validateCompleteInput(input);
      const updated = yield* run(
        "CompositionGoalLoopRetryStore.markDispatched",
        dispatchIntentRow(input),
      );
      if (Option.isSome(updated)) return toIntent(updated.value);

      const current = yield* getStoredIntent(input.previousRunId);
      if (Option.isNone(current)) return yield* missingIntent(input.previousRunId);
      if (current.value.phase === "dispatched") return toIntent(current.value);
      if (current.value.phase !== "settled") return yield* phaseConflict(current.value);
      if (current.value.dispatchClaimId !== null) return yield* dispatchInProgress(current.value);
      return yield* phaseConflict(current.value);
    });

  const recoverInterruptedDispatches: CompositionGoalLoopRetryStoreShape["recoverInterruptedDispatches"] =
    (input) =>
      Effect.gen(function* () {
        yield* validateRecoveryInput(input);
        const recovered = yield* run(
          "CompositionGoalLoopRetryStore.recoverInterruptedDispatches",
          recoverDispatchRows(input),
        );
        return {
          type: "composition.goal_loop_retry_dispatches.recovered" as const,
          recoveredAtUnixMs: input.recoveredAtUnixMs,
          recoveredCount: recovered.length,
          previousRunIds: recovered.map((row) => row.previousRunId),
        };
      });

  const store = CompositionGoalLoopRetryStore.of({
    prepareIntent,
    getIntent,
    listPendingIntents,
    markSettled,
    claimDispatch,
    releaseDispatch,
    markDispatched,
    recoverInterruptedDispatches,
  });
  const recovery = yield* store.recoverInterruptedDispatches({
    recoveredAtUnixMs: yield* Clock.currentTimeMillis,
  });
  if (recovery.recoveredCount > 0) {
    yield* Effect.logWarning("已释放重启前未完成的 Goal Loop retry dispatch claim", {
      recovered: recovery.recoveredCount,
    });
  }
  return store;
});

export const CompositionGoalLoopRetryStoreLive = Layer.effect(
  CompositionGoalLoopRetryStore,
  makeStore,
);
