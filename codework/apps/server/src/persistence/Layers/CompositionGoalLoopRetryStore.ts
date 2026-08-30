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
  type CompositionGoalLoopRetryIntent,
  type CompositionGoalLoopRetryPrepareInput,
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
});
const RetryIntentPrepareSchema = Schema.Struct({
  taskId: Schema.String,
  previousRunId: Schema.String,
  newRunId: Schema.String,
  createdAtUnixMs: Schema.Number,
});
const RetryIntentIdSchema = Schema.Struct({ previousRunId: Schema.String });
const RetryIntentNewRunIdSchema = Schema.Struct({ newRunId: Schema.String });
const RetryIntentAdvanceSchema = Schema.Struct({
  previousRunId: Schema.String,
  updatedAtUnixMs: Schema.Number,
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

const makeStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const getIntentRow = SqlSchema.findOneOption({
    Request: RetryIntentIdSchema,
    Result: RetryIntentRowSchema,
    execute: ({ previousRunId }) => sql`
      SELECT
        task_id AS "taskId", previous_run_id AS "previousRunId",
        new_run_id AS "newRunId", phase, revision,
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs"
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
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs"
      FROM composition_goal_loop_retry_intents
      WHERE new_run_id = ${newRunId}
      LIMIT 1
    `,
  });
  const insertIntentRow = SqlSchema.findOneOption({
    Request: RetryIntentPrepareSchema,
    Result: RetryIntentRowSchema,
    execute: (input) => sql`
      INSERT INTO composition_goal_loop_retry_intents (
        previous_run_id, task_id, new_run_id, phase, revision,
        created_at_unix_ms, updated_at_unix_ms
      ) VALUES (
        ${input.previousRunId}, ${input.taskId}, ${input.newRunId},
        'prepared', 1, ${input.createdAtUnixMs}, ${input.createdAtUnixMs}
      )
      ON CONFLICT DO NOTHING
      RETURNING
        task_id AS "taskId", previous_run_id AS "previousRunId",
        new_run_id AS "newRunId", phase, revision,
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs"
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
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs"
    `,
  });
  const dispatchIntentRow = SqlSchema.findOneOption({
    Request: RetryIntentAdvanceSchema,
    Result: RetryIntentRowSchema,
    execute: (input) => sql`
      UPDATE composition_goal_loop_retry_intents
      SET phase = 'dispatched', revision = 3, updated_at_unix_ms = ${input.updatedAtUnixMs}
      WHERE previous_run_id = ${input.previousRunId}
        AND phase = 'settled'
        AND ${input.updatedAtUnixMs} >= updated_at_unix_ms
      RETURNING
        task_id AS "taskId", previous_run_id AS "previousRunId",
        new_run_id AS "newRunId", phase, revision,
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs"
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

  const getIntent: CompositionGoalLoopRetryStoreShape["getIntent"] = (previousRunId) =>
    run("CompositionGoalLoopRetryStore.getIntent", getIntentRow({ previousRunId }));

  const prepareIntent: CompositionGoalLoopRetryStoreShape["prepareIntent"] = (input) =>
    Effect.gen(function* () {
      yield* validatePrepareInput(input);
      const inserted = yield* run(
        "CompositionGoalLoopRetryStore.prepareIntent",
        insertIntentRow(input),
      );
      if (Option.isSome(inserted)) return inserted.value;

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
      if (Option.isNone(current)) {
        return Effect.fail(
          domainError("goal_loop_retry_intent_missing", "Goal Loop retry 意图不存在。", {
            previousRunId: input.previousRunId,
          }),
        );
      }
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
        ? updated.value
        : yield* readAfterAdvance(input, new Set(["settled", "dispatched"]));
    });

  const markDispatched: CompositionGoalLoopRetryStoreShape["markDispatched"] = (input) =>
    Effect.gen(function* () {
      yield* validateAdvanceInput(input);
      const updated = yield* run(
        "CompositionGoalLoopRetryStore.markDispatched",
        dispatchIntentRow(input),
      );
      return Option.isSome(updated)
        ? updated.value
        : yield* readAfterAdvance(input, new Set(["dispatched"]));
    });

  return CompositionGoalLoopRetryStore.of({
    prepareIntent,
    getIntent,
    markSettled,
    markDispatched,
  });
});

export const CompositionGoalLoopRetryStoreLive = Layer.effect(
  CompositionGoalLoopRetryStore,
  makeStore,
);
