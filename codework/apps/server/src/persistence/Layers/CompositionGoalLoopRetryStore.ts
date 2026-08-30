import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type PersistenceDecodeError,
  type PersistenceSqlError,
} from "../Errors.ts";
import {
  CompositionGoalLoopRetryStore,
  type CompositionGoalLoopRetryAdvanceInput,
  type CompositionGoalLoopRetryIntent,
  type CompositionGoalLoopRetryStoreShape,
} from "../Services/CompositionGoalLoopRetryStore.ts";
import {
  decodeGoalLoopRetryIntent,
  type GoalLoopRetryIntentRow,
  retryDomainError,
  retryPhaseConflict,
  retryRevisionConflict,
  validateGoalLoopRetryAdvance,
  validateGoalLoopRetryPage,
  validateGoalLoopRetryPrepare,
  validateGoalLoopRetryQuarantine,
} from "./CompositionGoalLoopRetryStoreInternal.ts";
import { makeCompositionGoalLoopRetryStoreStatements } from "./CompositionGoalLoopRetryStoreStatements.ts";

const makeStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const statements = makeCompositionGoalLoopRetryStoreStatements(sql);

  const mapQueryError =
    (operation: string): ((cause: unknown) => PersistenceSqlError | PersistenceDecodeError) =>
    (cause) =>
      Schema.isSchemaError(cause)
        ? toPersistenceDecodeError(`${operation}:decode`)(cause)
        : toPersistenceSqlError(`${operation}:query`)(cause);

  const query = <A, E, R>(operation: string, effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.mapError(mapQueryError(operation)));

  const withTransaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    sql
      .withTransaction(effect)
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(
            toPersistenceSqlError("CompositionGoalLoopRetryStore.withTransaction")(cause),
          ),
        ),
      );

  const decodeRow = (operation: string, row: GoalLoopRetryIntentRow) =>
    decodeGoalLoopRetryIntent(row).pipe(
      Effect.mapError(toPersistenceDecodeError(`${operation}:intent`)),
    );

  const readIntent = (previousRunId: string) =>
    query(
      "CompositionGoalLoopRetryStore.getIntent",
      statements.getIntentRow({ previousRunId }),
    ).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(Option.none<CompositionGoalLoopRetryIntent>()),
          onSome: (row) =>
            decodeRow("CompositionGoalLoopRetryStore.getIntent", row).pipe(Effect.map(Option.some)),
        }),
      ),
    );

  const readRequired = (previousRunId: string) =>
    readIntent(previousRunId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              retryDomainError("goal_loop_retry_intent_missing", "Goal Loop retry 意图不存在。", {
                previousRunId,
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );

  const getIntent: CompositionGoalLoopRetryStoreShape["getIntent"] = readIntent;

  const prepareIntent: CompositionGoalLoopRetryStoreShape["prepareIntent"] = (input) =>
    withTransaction(
      Effect.gen(function* () {
        const valid = yield* validateGoalLoopRetryPrepare(input);
        const inserted = yield* query(
          "CompositionGoalLoopRetryStore.prepareIntent.insert",
          statements.insertIntentRow(valid),
        );
        if (Option.isSome(inserted)) {
          return yield* decodeRow(
            "CompositionGoalLoopRetryStore.prepareIntent.insert",
            inserted.value,
          );
        }

        const existing = yield* readIntent(valid.previousRunId);
        if (Option.isSome(existing)) {
          if (existing.value.taskId === valid.taskId) return existing.value;
          return yield* retryDomainError(
            "goal_loop_retry_identity_conflict",
            "同一旧 Run 已绑定到其他 Task。",
            {
              previousRunId: valid.previousRunId,
              newRunId: existing.value.newRunId,
            },
          );
        }

        const newRunOwner = yield* query(
          "CompositionGoalLoopRetryStore.prepareIntent.getByNewRun",
          statements.getIntentByNewRunRow({ newRunId: valid.newRunId }),
        );
        return yield* retryDomainError(
          "goal_loop_retry_identity_conflict",
          Option.isSome(newRunOwner)
            ? `新 Run ${valid.newRunId} 已由旧 Run ${newRunOwner.value.previousRunId} 占用。`
            : "retry 意图写入被冲突拒绝，且无法读取稳定身份。",
          { previousRunId: valid.previousRunId, newRunId: valid.newRunId },
        );
      }),
    );

  const listRecoverableIntents: CompositionGoalLoopRetryStoreShape["listRecoverableIntents"] = (
    input,
  ) =>
    Effect.gen(function* () {
      const valid = yield* validateGoalLoopRetryPage(input);
      const rows = yield* query(
        "CompositionGoalLoopRetryStore.listRecoverableIntents",
        valid.after === undefined
          ? statements.listRecoverableRows({ limit: valid.limit })
          : statements.listRecoverableRowsAfter({
              limit: valid.limit,
              afterUpdatedAtUnixMs: valid.after.updatedAtUnixMs,
              afterPreviousRunId: valid.after.previousRunId,
            }),
      );
      return yield* Effect.forEach(rows, (row) =>
        decodeRow("CompositionGoalLoopRetryStore.listRecoverableIntents", row),
      );
    });

  const advance = (
    input: CompositionGoalLoopRetryAdvanceInput,
    targetPhase: "settled" | "dispatched",
  ) =>
    withTransaction(
      Effect.gen(function* () {
        const valid = yield* validateGoalLoopRetryAdvance(input);
        const updated = yield* query(
          `CompositionGoalLoopRetryStore.mark${targetPhase}`,
          targetPhase === "settled"
            ? statements.settleIntentRow(valid)
            : statements.dispatchIntentRow(valid),
        );
        if (Option.isSome(updated)) {
          return yield* decodeRow(
            `CompositionGoalLoopRetryStore.mark${targetPhase}`,
            updated.value,
          );
        }

        const current = yield* readRequired(valid.previousRunId);
        if (current.quarantineCode !== null) {
          return yield* retryDomainError(
            "goal_loop_retry_quarantined",
            "Goal Loop retry 已进入 quarantine，拒绝继续自动推进。",
            {
              previousRunId: current.previousRunId,
              newRunId: current.newRunId,
              actualRevision: current.revision,
              actualPhase: current.phase,
            },
          );
        }
        if (
          current.phase === targetPhase &&
          current.revision === valid.expectedRevision + 1 &&
          current.updatedAtUnixMs === valid.updatedAtUnixMs
        ) {
          return current;
        }
        if (current.revision !== valid.expectedRevision) {
          return yield* retryRevisionConflict(current, valid.expectedRevision);
        }
        const expectedPhase = targetPhase === "settled" ? "prepared" : "settled";
        if (current.phase !== expectedPhase) {
          return yield* retryPhaseConflict(current, expectedPhase);
        }
        return yield* retryDomainError(
          "goal_loop_retry_timestamp_conflict",
          "retry 阶段时间不能早于当前账本更新时间。",
          {
            previousRunId: current.previousRunId,
            newRunId: current.newRunId,
            expectedRevision: valid.expectedRevision,
            actualRevision: current.revision,
            actualPhase: current.phase,
          },
        );
      }),
    );

  const markSettled: CompositionGoalLoopRetryStoreShape["markSettled"] = (input) =>
    advance(input, "settled");

  const markDispatched: CompositionGoalLoopRetryStoreShape["markDispatched"] = (input) =>
    advance(input, "dispatched");

  const quarantineIntent: CompositionGoalLoopRetryStoreShape["quarantineIntent"] = (input) =>
    withTransaction(
      Effect.gen(function* () {
        const valid = yield* validateGoalLoopRetryQuarantine(input);
        const inserted = yield* query(
          "CompositionGoalLoopRetryStore.quarantineIntent.insert",
          statements.insertQuarantineRow(valid),
        );
        if (Option.isSome(inserted)) return yield* readRequired(valid.previousRunId);

        const existingQuarantine = yield* query(
          "CompositionGoalLoopRetryStore.quarantineIntent.get",
          statements.getQuarantineRow({ previousRunId: valid.previousRunId }),
        );
        if (Option.isSome(existingQuarantine)) {
          if (
            existingQuarantine.value.outcomeCode === valid.outcomeCode &&
            existingQuarantine.value.quarantinedAtUnixMs === valid.quarantinedAtUnixMs
          ) {
            return yield* readRequired(valid.previousRunId);
          }
          const current = yield* readRequired(valid.previousRunId);
          return yield* retryDomainError(
            "goal_loop_retry_quarantine_conflict",
            "同一 retry intent 已记录不同的 quarantine 诊断。",
            {
              previousRunId: current.previousRunId,
              newRunId: current.newRunId,
              expectedRevision: valid.expectedRevision,
              actualRevision: current.revision,
              actualPhase: current.phase,
            },
          );
        }

        const current = yield* readRequired(valid.previousRunId);
        if (current.revision !== valid.expectedRevision) {
          return yield* retryRevisionConflict(current, valid.expectedRevision);
        }
        return yield* retryPhaseConflict(current, "prepared or settled");
      }),
    );

  return CompositionGoalLoopRetryStore.of({
    prepareIntent,
    getIntent,
    listRecoverableIntents,
    markSettled,
    markDispatched,
    quarantineIntent,
  });
});

export const CompositionGoalLoopRetryStoreLive = Layer.effect(
  CompositionGoalLoopRetryStore,
  makeStore,
);
