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
  CompositionRunStartStore,
  type CompositionRunStartClaimResult,
  type CompositionRunStartIntent,
  type CompositionRunStartStoreShape,
} from "../Services/CompositionRunStartStore.ts";
import {
  decodeRunStartIntent,
  type RunStartRow,
  runStartClaimConflict,
  runStartDomainError,
  runStartReleaseConflict,
  runStartRevisionConflict,
  runStartStateConflict,
  runStartTimestampConflict,
  sameRunStartIdentity,
  validateRunStartAccepted,
  validateRunStartClaim,
  validateRunStartIndeterminate,
  validateRunStartPrepare,
  validateRunStartRelease,
  validateRunStartSettle,
  validateRunStartUnsettledList,
} from "./CompositionRunStartStoreInternal.ts";
import { makeCompositionRunStartStoreStatements } from "./CompositionRunStartStoreStatements.ts";

const makeStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const statements = makeCompositionRunStartStoreStatements(sql);

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
          Effect.fail(toPersistenceSqlError("CompositionRunStartStore.withTransaction")(cause)),
        ),
      );

  const decodeRow = (operation: string, row: RunStartRow) =>
    decodeRunStartIntent(row).pipe(
      Effect.mapError(toPersistenceDecodeError(`${operation}:intent`)),
    );

  const readStart = (runId: string) =>
    query("CompositionRunStartStore.getStart", statements.getRow({ runId })).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(Option.none<CompositionRunStartIntent>()),
          onSome: (row) =>
            decodeRow("CompositionRunStartStore.getStart", row).pipe(Effect.map(Option.some)),
        }),
      ),
    );

  const readRequired = (runId: string) =>
    readStart(runId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              runStartDomainError("run_start_not_found", "Run Start 意图不存在。", { runId }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );

  const readByTaskAttempt = (taskId: string, attempt: number) =>
    query(
      "CompositionRunStartStore.getByTaskAttempt",
      statements.getByTaskAttemptRow({ taskId, attempt }),
    ).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(Option.none<CompositionRunStartIntent>()),
          onSome: (row) =>
            decodeRow("CompositionRunStartStore.getByTaskAttempt", row).pipe(
              Effect.map(Option.some),
            ),
        }),
      ),
    );

  const readByClaim = (claimId: string) =>
    query("CompositionRunStartStore.getByClaim", statements.getByClaimRow({ claimId })).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(Option.none<CompositionRunStartIntent>()),
          onSome: (row) =>
            decodeRow("CompositionRunStartStore.getByClaim", row).pipe(Effect.map(Option.some)),
        }),
      ),
    );

  const readByRuntimeTask = (runtimeId: string, runtimeTaskId: string) =>
    query(
      "CompositionRunStartStore.getByRuntimeTask",
      statements.getByRuntimeTaskRow({ runtimeId, runtimeTaskId }),
    ).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(Option.none<CompositionRunStartIntent>()),
          onSome: (row) =>
            decodeRow("CompositionRunStartStore.getByRuntimeTask", row).pipe(
              Effect.map(Option.some),
            ),
        }),
      ),
    );

  const readByReleaseOperation = (releaseOperationId: string) =>
    query(
      "CompositionRunStartStore.getByReleaseOperation",
      statements.getByReleaseOperationRow({ releaseOperationId }),
    ).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(Option.none<CompositionRunStartIntent>()),
          onSome: (row) =>
            decodeRow("CompositionRunStartStore.getByReleaseOperation", row).pipe(
              Effect.map(Option.some),
            ),
        }),
      ),
    );

  const getStart: CompositionRunStartStoreShape["getStart"] = readStart;

  const listUnsettledStarts: CompositionRunStartStoreShape["listUnsettledStarts"] = (input) =>
    Effect.gen(function* () {
      const valid = yield* validateRunStartUnsettledList(input);
      const rows = yield* query(
        "CompositionRunStartStore.listUnsettledStarts",
        statements.listUnsettledRows(valid),
      );
      return yield* Effect.forEach(rows, (row) =>
        decodeRow("CompositionRunStartStore.listUnsettledStarts", row),
      );
    });

  const prepareStart: CompositionRunStartStoreShape["prepareStart"] = (input) =>
    withTransaction(
      Effect.gen(function* () {
        const valid = yield* validateRunStartPrepare(input);
        const inserted = yield* query(
          "CompositionRunStartStore.prepareStart.insert",
          statements.insertRow(valid),
        );
        if (Option.isSome(inserted)) {
          return yield* decodeRow("CompositionRunStartStore.prepareStart.insert", inserted.value);
        }

        const byRun = yield* readStart(valid.runId);
        if (Option.isSome(byRun)) {
          if (sameRunStartIdentity(byRun.value, valid)) return byRun.value;
          return yield* runStartDomainError(
            "run_start_identity_conflict",
            "同一 runId 已绑定到不同的 Driver start 身份或摘要。",
            { runId: valid.runId, actualState: byRun.value.state },
          );
        }

        const byTaskAttempt = yield* readByTaskAttempt(valid.taskId, valid.attempt);
        return yield* runStartDomainError(
          "run_start_identity_conflict",
          Option.isSome(byTaskAttempt)
            ? "同一 Task attempt 已由其他 Run Start 意图占用。"
            : "Run Start 唯一身份竞争失败，且未找到可安全重放的记录。",
          { runId: valid.runId },
        );
      }),
    );

  const claimStart: CompositionRunStartStoreShape["claimStart"] = (input) =>
    withTransaction(
      Effect.gen(function* () {
        const valid = yield* validateRunStartClaim(input);
        const updated = yield* query(
          "CompositionRunStartStore.claimStart.update",
          statements.claimRow(valid),
        );
        if (Option.isSome(updated)) {
          return {
            intent: yield* decodeRow("CompositionRunStartStore.claimStart.update", updated.value),
            claimed: true,
          } satisfies CompositionRunStartClaimResult;
        }

        const current = yield* readRequired(valid.runId);
        if (
          current.state === "dispatching" &&
          current.revision === valid.expectedRevision + 1 &&
          current.claimId === valid.claimId &&
          current.claimedAtUnixMs === valid.claimedAtUnixMs
        ) {
          return { intent: current, claimed: false } satisfies CompositionRunStartClaimResult;
        }
        if (current.state !== "prepared") {
          return { intent: current, claimed: false } satisfies CompositionRunStartClaimResult;
        }
        if (current.revision !== valid.expectedRevision) {
          return yield* runStartRevisionConflict(current, valid.expectedRevision);
        }
        if (valid.claimedAtUnixMs < current.updatedAtUnixMs) {
          return yield* runStartTimestampConflict(current);
        }
        const claimOwner = yield* readByClaim(valid.claimId);
        if (Option.isSome(claimOwner)) {
          return yield* runStartDomainError(
            "run_start_claim_conflict",
            "claimId 已由其他 Run Start 意图占用。",
            { runId: valid.runId, actualState: current.state, actualRevision: current.revision },
          );
        }
        return yield* runStartStateConflict(current, "prepared without claim");
      }),
    );

  const releaseStart: CompositionRunStartStoreShape["releaseStart"] = (input) =>
    withTransaction(
      Effect.gen(function* () {
        const valid = yield* validateRunStartRelease(input);
        const updated = yield* query(
          "CompositionRunStartStore.releaseStart.update",
          statements.releaseRow(valid),
        );
        if (Option.isSome(updated)) {
          return yield* decodeRow("CompositionRunStartStore.releaseStart.update", updated.value);
        }

        const current = yield* readRequired(valid.runId);
        if (
          current.state === "prepared" &&
          current.revision === valid.expectedRevision + 1 &&
          current.lastReleaseClaimId === valid.claimId &&
          current.lastReleaseOperationId === valid.releaseOperationId &&
          current.lastReleasedAtUnixMs === valid.releasedAtUnixMs
        ) {
          return current;
        }
        if (current.revision !== valid.expectedRevision) {
          return yield* runStartRevisionConflict(current, valid.expectedRevision);
        }
        if (current.state !== "dispatching") {
          return yield* runStartStateConflict(current, "dispatching");
        }
        if (current.claimId !== valid.claimId) return yield* runStartClaimConflict(current);
        if (valid.releasedAtUnixMs < current.updatedAtUnixMs) {
          return yield* runStartTimestampConflict(current);
        }
        const releaseOwner = yield* readByReleaseOperation(valid.releaseOperationId);
        if (Option.isSome(releaseOwner)) return yield* runStartReleaseConflict(current);
        return yield* runStartStateConflict(
          current,
          "dispatching with available release operation identity",
        );
      }),
    );

  const markAccepted: CompositionRunStartStoreShape["markAccepted"] = (input) =>
    withTransaction(
      Effect.gen(function* () {
        const valid = yield* validateRunStartAccepted(input);
        const normalized = {
          ...valid,
          runtimeTaskId: valid.runtimeTaskId ?? null,
          capabilityHandshakeId: valid.capabilityHandshakeId ?? null,
        };
        const updated = yield* query(
          "CompositionRunStartStore.markAccepted.update",
          statements.acceptRow(normalized),
        );
        if (Option.isSome(updated)) {
          return yield* decodeRow("CompositionRunStartStore.markAccepted.update", updated.value);
        }

        const current = yield* readRequired(valid.runId);
        if (current.state === "accepted" || current.state === "settled") {
          if (
            current.claimId === valid.claimId &&
            current.runtimeTaskId === normalized.runtimeTaskId &&
            current.capabilityHandshakeId === normalized.capabilityHandshakeId &&
            current.acceptedAtUnixMs === valid.acceptedAtUnixMs
          ) {
            return current;
          }
          return yield* runStartDomainError(
            "run_start_receipt_conflict",
            "Run Start accepted receipt 与既有结果不一致。",
            {
              runId: current.runId,
              actualState: current.state,
              actualRevision: current.revision,
            },
          );
        }
        if (current.revision !== valid.expectedRevision) {
          return yield* runStartRevisionConflict(current, valid.expectedRevision);
        }
        if (current.state !== "dispatching") {
          return yield* runStartStateConflict(current, "dispatching");
        }
        if (current.claimId !== valid.claimId) return yield* runStartClaimConflict(current);
        if (valid.acceptedAtUnixMs < current.updatedAtUnixMs) {
          return yield* runStartTimestampConflict(current);
        }
        if (normalized.runtimeTaskId !== null) {
          const receiptOwner = yield* readByRuntimeTask(
            current.runtimeId,
            normalized.runtimeTaskId,
          );
          if (Option.isSome(receiptOwner)) {
            return yield* runStartDomainError(
              "run_start_receipt_conflict",
              "runtimeTaskId 已绑定到其他 Run Start receipt。",
              { runId: current.runId, actualState: current.state },
            );
          }
        }
        return yield* runStartStateConflict(current, "dispatching with available receipt identity");
      }),
    );

  const markIndeterminate: CompositionRunStartStoreShape["markIndeterminate"] = (input) =>
    withTransaction(
      Effect.gen(function* () {
        const valid = yield* validateRunStartIndeterminate(input);
        const updated = yield* query(
          "CompositionRunStartStore.markIndeterminate.update",
          statements.indeterminateRow(valid),
        );
        if (Option.isSome(updated)) {
          return yield* decodeRow(
            "CompositionRunStartStore.markIndeterminate.update",
            updated.value,
          );
        }

        const current = yield* readRequired(valid.runId);
        if (
          current.state === "indeterminate" &&
          current.claimId === valid.claimId &&
          current.outcomeCode === valid.outcomeCode &&
          current.updatedAtUnixMs === valid.indeterminateAtUnixMs
        ) {
          return current;
        }
        if (current.revision !== valid.expectedRevision) {
          return yield* runStartRevisionConflict(current, valid.expectedRevision);
        }
        if (current.state !== "dispatching") {
          return yield* runStartStateConflict(current, "dispatching");
        }
        if (current.claimId !== valid.claimId) return yield* runStartClaimConflict(current);
        return yield* runStartTimestampConflict(current);
      }),
    );

  const settleStart: CompositionRunStartStoreShape["settleStart"] = (input) =>
    withTransaction(
      Effect.gen(function* () {
        const valid = yield* validateRunStartSettle(input);
        const updated = yield* query(
          "CompositionRunStartStore.settleStart.update",
          statements.settleRow(valid),
        );
        if (Option.isSome(updated)) {
          return yield* decodeRow("CompositionRunStartStore.settleStart.update", updated.value);
        }

        const current = yield* readRequired(valid.runId);
        if (
          current.state === "settled" &&
          current.revision === valid.expectedRevision + 1 &&
          current.claimId === valid.claimId &&
          current.settledAtUnixMs === valid.settledAtUnixMs
        ) {
          return current;
        }
        if (current.revision !== valid.expectedRevision) {
          return yield* runStartRevisionConflict(current, valid.expectedRevision);
        }
        if (current.state !== "accepted") {
          return yield* runStartStateConflict(current, "accepted");
        }
        if (current.claimId !== valid.claimId) return yield* runStartClaimConflict(current);
        return yield* runStartTimestampConflict(current);
      }),
    );

  return CompositionRunStartStore.of({
    prepareStart,
    getStart,
    listUnsettledStarts,
    claimStart,
    releaseStart,
    markAccepted,
    markIndeterminate,
    settleStart,
  });
});

export const CompositionRunStartStoreLive = Layer.effect(CompositionRunStartStore, makeStore);
