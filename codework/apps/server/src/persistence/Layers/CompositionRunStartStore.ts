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
  CompositionRunStartReplayPolicy,
  CompositionRunStartState,
  CompositionRunStartStore,
  CompositionRunStartStoreDomainError,
  type CompositionRunStartAcceptedInput,
  type CompositionRunStartClaimInput,
  type CompositionRunStartCompleteInput,
  type CompositionRunStartIntent,
  type CompositionRunStartPrepareInput,
  type CompositionRunStartReleaseInput,
  type CompositionRunStartStoreErrorCode,
  type CompositionRunStartStoreShape,
} from "../Services/CompositionRunStartStore.ts";

const RunStartRowSchema = Schema.Struct({
  runId: Schema.String,
  taskId: Schema.String,
  agentId: Schema.String,
  runtimeId: Schema.String,
  attempt: Schema.Number,
  replayPolicy: CompositionRunStartReplayPolicy,
  state: CompositionRunStartState,
  claimId: Schema.NullOr(Schema.String),
  claimedAtUnixMs: Schema.NullOr(Schema.Number),
  runtimeTaskId: Schema.NullOr(Schema.String),
  capabilityHandshakeId: Schema.NullOr(Schema.String),
  createdAtUnixMs: Schema.Number,
  updatedAtUnixMs: Schema.Number,
});
type RunStartRow = typeof RunStartRowSchema.Type;

const PrepareSchema = Schema.Struct({
  runId: Schema.String,
  taskId: Schema.String,
  agentId: Schema.String,
  runtimeId: Schema.String,
  attempt: Schema.Number,
  replayPolicy: CompositionRunStartReplayPolicy,
  createdAtUnixMs: Schema.Number,
});
const IdSchema = Schema.Struct({ runId: Schema.String });
const ClaimSchema = Schema.Struct({
  runId: Schema.String,
  claimId: Schema.String,
  claimedAtUnixMs: Schema.Number,
});
const ReleaseSchema = Schema.Struct({ runId: Schema.String, claimId: Schema.String });
const AcceptedSchema = Schema.Struct({
  runId: Schema.String,
  claimId: Schema.String,
  runtimeTaskId: Schema.NullOr(Schema.String),
  capabilityHandshakeId: Schema.NullOr(Schema.String),
  acceptedAtUnixMs: Schema.Number,
});
const CompleteSchema = Schema.Struct({ runId: Schema.String, completedAtUnixMs: Schema.Number });
const RecoverySchema = Schema.Struct({ recoveredAtUnixMs: Schema.Number });
const RecoveredRowSchema = Schema.Struct({ runId: Schema.String });

const toIntent = (row: RunStartRow): CompositionRunStartIntent => ({
  runId: row.runId,
  taskId: row.taskId,
  agentId: row.agentId,
  runtimeId: row.runtimeId,
  attempt: row.attempt,
  replayPolicy: row.replayPolicy,
  state: row.state,
  ...(row.runtimeTaskId === null ? {} : { runtimeTaskId: row.runtimeTaskId }),
  ...(row.capabilityHandshakeId === null
    ? {}
    : { capabilityHandshakeId: row.capabilityHandshakeId }),
  createdAtUnixMs: row.createdAtUnixMs,
  updatedAtUnixMs: row.updatedAtUnixMs,
});

const domainError = (
  code: CompositionRunStartStoreErrorCode,
  detail: string,
  metadata: { readonly runId?: string; readonly actualState?: CompositionRunStartIntent["state"] } = {},
) => new CompositionRunStartStoreDomainError({ code, detail, ...metadata });

const hasText = (value: string, maxLength = 512): boolean =>
  value.trim().length > 0 && value.length <= maxLength;
const validTime = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

const validatePrepare = (input: CompositionRunStartPrepareInput) =>
  hasText(input.runId) &&
  hasText(input.taskId) &&
  hasText(input.agentId) &&
  hasText(input.runtimeId) &&
  Number.isSafeInteger(input.attempt) &&
  input.attempt > 0 &&
  validTime(input.createdAtUnixMs)
    ? Effect.succeed(input)
    : Effect.fail(domainError("run_start_input_invalid", "Run Start 身份或创建时间无效。"));

const validateClaim = (input: CompositionRunStartClaimInput) =>
  hasText(input.runId) && hasText(input.claimId) && validTime(input.claimedAtUnixMs)
    ? Effect.succeed(input)
    : Effect.fail(domainError("run_start_input_invalid", "Run Start claim 身份或时间无效。"));

const validateRelease = (input: CompositionRunStartReleaseInput) =>
  hasText(input.runId) && hasText(input.claimId)
    ? Effect.succeed(input)
    : Effect.fail(domainError("run_start_input_invalid", "Run Start claim 释放身份无效。"));

const validateAccepted = (input: CompositionRunStartAcceptedInput) =>
  hasText(input.runId) &&
  hasText(input.claimId) &&
  validTime(input.acceptedAtUnixMs) &&
  (input.runtimeTaskId === undefined || hasText(input.runtimeTaskId, 2048)) &&
  (input.capabilityHandshakeId === undefined || hasText(input.capabilityHandshakeId, 2048))
    ? Effect.succeed(input)
    : Effect.fail(domainError("run_start_input_invalid", "Run Start accepted receipt 无效。"));

const validateComplete = (input: CompositionRunStartCompleteInput) =>
  hasText(input.runId) && validTime(input.completedAtUnixMs)
    ? Effect.succeed(input)
    : Effect.fail(domainError("run_start_input_invalid", "Run Start 完成时间无效。"));

const makeStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const getRow = SqlSchema.findOneOption({
    Request: IdSchema,
    Result: RunStartRowSchema,
    execute: ({ runId }) => sql`
      SELECT
        run_id AS "runId", task_id AS "taskId", agent_id AS "agentId",
        runtime_id AS "runtimeId", attempt, replay_policy AS "replayPolicy", state,
        claim_id AS "claimId", claimed_at_unix_ms AS "claimedAtUnixMs",
        runtime_task_id AS "runtimeTaskId",
        capability_handshake_id AS "capabilityHandshakeId",
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs"
      FROM composition_run_start_intents
      WHERE run_id = ${runId}
      LIMIT 1
    `,
  });
  const insertRow = SqlSchema.findOneOption({
    Request: PrepareSchema,
    Result: RunStartRowSchema,
    execute: (input) => sql`
      INSERT INTO composition_run_start_intents (
        run_id, task_id, agent_id, runtime_id, attempt, replay_policy, state,
        claim_id, claimed_at_unix_ms, runtime_task_id, capability_handshake_id,
        created_at_unix_ms, updated_at_unix_ms
      ) VALUES (
        ${input.runId}, ${input.taskId}, ${input.agentId}, ${input.runtimeId}, ${input.attempt},
        ${input.replayPolicy}, 'prepared', NULL, NULL, NULL, NULL,
        ${input.createdAtUnixMs}, ${input.createdAtUnixMs}
      )
      ON CONFLICT DO NOTHING
      RETURNING
        run_id AS "runId", task_id AS "taskId", agent_id AS "agentId",
        runtime_id AS "runtimeId", attempt, replay_policy AS "replayPolicy", state,
        claim_id AS "claimId", claimed_at_unix_ms AS "claimedAtUnixMs",
        runtime_task_id AS "runtimeTaskId",
        capability_handshake_id AS "capabilityHandshakeId",
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs"
    `,
  });
  const claimRow = SqlSchema.findOneOption({
    Request: ClaimSchema,
    Result: RunStartRowSchema,
    execute: (input) => sql`
      UPDATE composition_run_start_intents
      SET state = 'dispatching', claim_id = ${input.claimId},
        claimed_at_unix_ms = ${input.claimedAtUnixMs}
      WHERE run_id = ${input.runId} AND state = 'prepared'
        AND ${input.claimedAtUnixMs} >= updated_at_unix_ms
      RETURNING
        run_id AS "runId", task_id AS "taskId", agent_id AS "agentId",
        runtime_id AS "runtimeId", attempt, replay_policy AS "replayPolicy", state,
        claim_id AS "claimId", claimed_at_unix_ms AS "claimedAtUnixMs",
        runtime_task_id AS "runtimeTaskId",
        capability_handshake_id AS "capabilityHandshakeId",
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs"
    `,
  });
  const releaseRow = SqlSchema.findOneOption({
    Request: ReleaseSchema,
    Result: RunStartRowSchema,
    execute: (input) => sql`
      UPDATE composition_run_start_intents
      SET state = 'prepared', claim_id = NULL, claimed_at_unix_ms = NULL
      WHERE run_id = ${input.runId} AND state = 'dispatching' AND claim_id = ${input.claimId}
      RETURNING
        run_id AS "runId", task_id AS "taskId", agent_id AS "agentId",
        runtime_id AS "runtimeId", attempt, replay_policy AS "replayPolicy", state,
        claim_id AS "claimId", claimed_at_unix_ms AS "claimedAtUnixMs",
        runtime_task_id AS "runtimeTaskId",
        capability_handshake_id AS "capabilityHandshakeId",
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs"
    `,
  });
  const acceptRow = SqlSchema.findOneOption({
    Request: AcceptedSchema,
    Result: RunStartRowSchema,
    execute: (input) => sql`
      UPDATE composition_run_start_intents
      SET state = 'accepted', claim_id = NULL, claimed_at_unix_ms = NULL,
        runtime_task_id = ${input.runtimeTaskId},
        capability_handshake_id = ${input.capabilityHandshakeId},
        updated_at_unix_ms = ${input.acceptedAtUnixMs}
      WHERE run_id = ${input.runId} AND state = 'dispatching'
        AND claim_id = ${input.claimId} AND ${input.acceptedAtUnixMs} >= updated_at_unix_ms
      RETURNING
        run_id AS "runId", task_id AS "taskId", agent_id AS "agentId",
        runtime_id AS "runtimeId", attempt, replay_policy AS "replayPolicy", state,
        claim_id AS "claimId", claimed_at_unix_ms AS "claimedAtUnixMs",
        runtime_task_id AS "runtimeTaskId",
        capability_handshake_id AS "capabilityHandshakeId",
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs"
    `,
  });
  const completeRow = SqlSchema.findOneOption({
    Request: CompleteSchema,
    Result: RunStartRowSchema,
    execute: (input) => sql`
      UPDATE composition_run_start_intents
      SET state = 'completed', updated_at_unix_ms = ${input.completedAtUnixMs}
      WHERE run_id = ${input.runId} AND state = 'accepted'
        AND ${input.completedAtUnixMs} >= updated_at_unix_ms
      RETURNING
        run_id AS "runId", task_id AS "taskId", agent_id AS "agentId",
        runtime_id AS "runtimeId", attempt, replay_policy AS "replayPolicy", state,
        claim_id AS "claimId", claimed_at_unix_ms AS "claimedAtUnixMs",
        runtime_task_id AS "runtimeTaskId",
        capability_handshake_id AS "capabilityHandshakeId",
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs"
    `,
  });
  const recoverRows = SqlSchema.findAll({
    Request: RecoverySchema,
    Result: RecoveredRowSchema,
    execute: (input) => sql`
      UPDATE composition_run_start_intents
      SET state = CASE replay_policy WHEN 'idempotent' THEN 'prepared' ELSE 'indeterminate' END,
        claim_id = NULL, claimed_at_unix_ms = NULL,
        updated_at_unix_ms = ${input.recoveredAtUnixMs}
      WHERE state = 'dispatching' AND ${input.recoveredAtUnixMs} >= updated_at_unix_ms
      RETURNING run_id AS "runId"
    `,
  });

  const run = <A>(operation: string, effect: Effect.Effect<A, SqlError | Schema.SchemaError>) =>
    effect.pipe(
      Effect.mapError((cause): PersistenceSqlError | PersistenceDecodeError =>
        Schema.isSchemaError(cause)
          ? toPersistenceDecodeError(`${operation}:decode`)(cause)
          : toPersistenceSqlError(`${operation}:query`)(cause),
      ),
    );
  const readRow = (runId: string) => run("CompositionRunStartStore.getStart", getRow({ runId }));
  const getStart: CompositionRunStartStoreShape["getStart"] = (runId) =>
    readRow(runId).pipe(Effect.map(Option.map(toIntent)));
  const readRequired = (runId: string) =>
    Effect.flatMap(readRow(runId), (row) =>
      Option.isSome(row)
        ? Effect.succeed(row.value)
        : Effect.fail(domainError("run_start_missing", "Run Start 意图不存在。", { runId })),
    );

  const prepareStart: CompositionRunStartStoreShape["prepareStart"] = (input) =>
    Effect.gen(function* () {
      yield* validatePrepare(input);
      const inserted = yield* run("CompositionRunStartStore.prepareStart", insertRow(input));
      if (Option.isSome(inserted)) return toIntent(inserted.value);
      const existing = yield* readRequired(input.runId);
      if (
        existing.taskId !== input.taskId ||
        existing.agentId !== input.agentId ||
        existing.runtimeId !== input.runtimeId ||
        existing.attempt !== input.attempt ||
        existing.replayPolicy !== input.replayPolicy
      ) {
        return yield* domainError("run_start_identity_conflict", "Run Start 身份与既有意图不匹配。", {
          runId: input.runId,
          actualState: existing.state,
        });
      }
      return toIntent(existing);
    });

  const claimStart: CompositionRunStartStoreShape["claimStart"] = (input) =>
    Effect.gen(function* () {
      yield* validateClaim(input);
      const claimed = yield* run("CompositionRunStartStore.claimStart", claimRow(input));
      if (Option.isSome(claimed)) return toIntent(claimed.value);
      const current = yield* readRequired(input.runId);
      if (current.state === "dispatching") {
        if (current.claimId === input.claimId) return toIntent(current);
        return yield* domainError("run_start_in_progress", "Run Start 正由其他 owner 派发。", {
          runId: input.runId,
          actualState: current.state,
        });
      }
      if (current.state !== "prepared") return toIntent(current);
      return yield* domainError("run_start_input_invalid", "claim 时间早于 Run Start 最近更新时间。", {
        runId: input.runId,
        actualState: current.state,
      });
    });

  const releaseStart: CompositionRunStartStoreShape["releaseStart"] = (input) =>
    Effect.gen(function* () {
      yield* validateRelease(input);
      const released = yield* run("CompositionRunStartStore.releaseStart", releaseRow(input));
      if (Option.isSome(released)) return;
      const current = yield* readRequired(input.runId);
      if (current.state === "prepared" || current.state === "accepted" || current.state === "completed") return;
      if (current.state === "dispatching") {
        return yield* domainError("run_start_in_progress", "Run Start claim 属于其他 owner。", {
          runId: input.runId,
          actualState: current.state,
        });
      }
      return yield* domainError("run_start_phase_conflict", "当前 Run Start 状态不能释放 claim。", {
        runId: input.runId,
        actualState: current.state,
      });
    });

  const markAccepted: CompositionRunStartStoreShape["markAccepted"] = (input) =>
    Effect.gen(function* () {
      yield* validateAccepted(input);
      const accepted = yield* run(
        "CompositionRunStartStore.markAccepted",
        acceptRow({
          ...input,
          runtimeTaskId: input.runtimeTaskId ?? null,
          capabilityHandshakeId: input.capabilityHandshakeId ?? null,
        }),
      );
      if (Option.isSome(accepted)) return toIntent(accepted.value);
      const current = yield* readRequired(input.runId);
      if (
        (current.state === "accepted" || current.state === "completed") &&
        current.runtimeTaskId === input.runtimeTaskId &&
        current.capabilityHandshakeId === input.capabilityHandshakeId
      ) {
        return toIntent(current);
      }
      if (current.state === "dispatching") {
        return yield* domainError("run_start_in_progress", "Run Start claim 属于其他 owner。", {
          runId: input.runId,
          actualState: current.state,
        });
      }
      return yield* domainError("run_start_phase_conflict", "当前 Run Start 状态不能记录 accepted。", {
        runId: input.runId,
        actualState: current.state,
      });
    });

  const markCompleted: CompositionRunStartStoreShape["markCompleted"] = (input) =>
    Effect.gen(function* () {
      yield* validateComplete(input);
      const completed = yield* run("CompositionRunStartStore.markCompleted", completeRow(input));
      if (Option.isSome(completed)) return toIntent(completed.value);
      const current = yield* readRequired(input.runId);
      if (current.state === "completed") return toIntent(current);
      return yield* domainError("run_start_phase_conflict", "当前 Run Start 状态不能完成。", {
        runId: input.runId,
        actualState: current.state,
      });
    });

  const recoverInterruptedStarts: CompositionRunStartStoreShape["recoverInterruptedStarts"] =
    (input) =>
      Effect.gen(function* () {
        if (!validTime(input.recoveredAtUnixMs)) {
          return yield* domainError("run_start_input_invalid", "Run Start 恢复时间无效。");
        }
        const recovered = yield* run(
          "CompositionRunStartStore.recoverInterruptedStarts",
          recoverRows(input),
        );
        return {
          type: "composition.run_starts.recovered" as const,
          recoveredAtUnixMs: input.recoveredAtUnixMs,
          recoveredRunIds: recovered.map((row) => row.runId).sort(),
        };
      });

  const store = CompositionRunStartStore.of({
    prepareStart,
    getStart,
    claimStart,
    releaseStart,
    markAccepted,
    markCompleted,
    recoverInterruptedStarts,
  });
  const recovery = yield* store.recoverInterruptedStarts({
    recoveredAtUnixMs: yield* Clock.currentTimeMillis,
  });
  if (recovery.recoveredRunIds.length > 0) {
    yield* Effect.logWarning("已恢复重启前未完成的 Run Start claim", {
      recovered: recovery.recoveredRunIds.length,
    });
  }
  return store;
});

export const CompositionRunStartStoreLive = Layer.effect(CompositionRunStartStore, makeStore);
