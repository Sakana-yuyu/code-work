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
  CompositionRunStartStoreDomainError,
  type CompositionRunStartAcceptedInput,
  type CompositionRunStartClaimInput,
  type CompositionRunStartClaimResult,
  type CompositionRunStartDispatchInput,
  type CompositionRunStartIdentity,
  type CompositionRunStartIntent,
  type CompositionRunStartPrepareInput,
  type CompositionRunStartQuarantineInput,
  type CompositionRunStartRejectedInput,
  type CompositionRunStartReleaseInput,
  type CompositionRunStartSettledInput,
  type CompositionRunStartStoreErrorCode,
  type CompositionRunStartStoreShape,
} from "../Services/CompositionRunStartStore.ts";
import {
  makeCompositionRunStartStoreStatements,
  type RunStartRow,
} from "./CompositionRunStartStoreStatements.ts";

const LIST_LIMIT_MAX = 200;

const domainError = (
  code: CompositionRunStartStoreErrorCode,
  detail: string,
  metadata: {
    readonly runId?: string;
    readonly expectedRevision?: number;
    readonly actualRevision?: number;
    readonly expectedState?: string;
    readonly actualState?: string;
  } = {},
) => new CompositionRunStartStoreDomainError({ code, detail, ...metadata });

const mapQueryError =
  (operation: string): ((cause: unknown) => PersistenceSqlError | PersistenceDecodeError) =>
  (cause) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(`${operation}:decode`)(cause)
      : toPersistenceSqlError(`${operation}:query`)(cause);

const toIntent = (row: RunStartRow): CompositionRunStartIntent => ({ ...row });

const hasTextWithin = (value: string, maxLength: number): boolean =>
  value.trim().length > 0 && value.length <= maxLength;

const validateTimestamp = (operation: string, runId: string, value: number) =>
  Number.isSafeInteger(value) && value >= 0
    ? Effect.succeed(value)
    : Effect.fail(
        domainError("run_start_input_invalid", `${operation} 的时间必须是非负安全整数。`, {
          runId,
        }),
      );

const validateRevision = (operation: string, runId: string, value: number) =>
  Number.isSafeInteger(value) && value >= 1
    ? Effect.succeed(value)
    : Effect.fail(
        domainError("run_start_input_invalid", `${operation} 的 revision 必须是正安全整数。`, {
          runId,
          expectedRevision: value,
        }),
      );

const validateIdentity = <A extends CompositionRunStartIdentity>(operation: string, input: A) => {
  const valid =
    hasTextWithin(input.taskId, 512) &&
    hasTextWithin(input.runId, 512) &&
    (input.previousRunId === null || hasTextWithin(input.previousRunId, 512)) &&
    hasTextWithin(input.agentId, 512) &&
    hasTextWithin(input.runtimeId, 512) &&
    Number.isSafeInteger(input.attempt) &&
    input.attempt >= 1 &&
    hasTextWithin(input.payloadDigest, 512) &&
    hasTextWithin(input.capabilityDigest, 512);
  return valid
    ? Effect.succeed(input)
    : Effect.fail(
        domainError("run_start_input_invalid", `${operation} 的身份或摘要字段非法。`, {
          runId: input.runId,
        }),
      );
};

const sameIdentity = (
  left: CompositionRunStartIdentity,
  right: CompositionRunStartIdentity,
): boolean =>
  left.taskId === right.taskId &&
  left.runId === right.runId &&
  left.previousRunId === right.previousRunId &&
  left.agentId === right.agentId &&
  left.runtimeId === right.runtimeId &&
  left.attempt === right.attempt &&
  left.payloadDigest === right.payloadDigest &&
  left.capabilityDigest === right.capabilityDigest;

const sameReceipt = (intent: CompositionRunStartIntent, input: CompositionRunStartAcceptedInput) =>
  intent.runtimeTaskId === input.runtimeTaskId &&
  intent.capabilityHandshakeId === input.capabilityHandshakeId;

const makeStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const statements = makeCompositionRunStartStoreStatements(sql);
  const runQuery = <A>(operation: string, effect: Effect.Effect<A, unknown>) =>
    effect.pipe(Effect.mapError(mapQueryError(operation)));

  const getStart: CompositionRunStartStoreShape["getStart"] = (runId) =>
    hasTextWithin(runId, 512)
      ? runQuery("CompositionRunStartStore.getStart", statements.getRow({ runId })).pipe(
          Effect.map(Option.map(toIntent)),
        )
      : Effect.fail(
          domainError("run_start_input_invalid", "getStart 的 runId 不能为空或超长。", {
            runId,
          }),
        );

  const getRequired = (runId: string) =>
    getStart(runId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(domainError("run_start_not_found", "Run Start 意图不存在。", { runId })),
          onSome: Effect.succeed,
        }),
      ),
    );

  const prepareStart: CompositionRunStartStoreShape["prepareStart"] = (
    input: CompositionRunStartPrepareInput,
  ) =>
    Effect.gen(function* () {
      yield* validateIdentity("prepareStart", input);
      yield* validateTimestamp("prepareStart", input.runId, input.createdAtUnixMs);
      const inserted = yield* runQuery(
        "CompositionRunStartStore.prepareStart",
        statements.insertPreparedRow(input),
      );
      if (Option.isSome(inserted)) return toIntent(inserted.value);
      const currentByRunId = yield* getStart(input.runId);
      const currentByTaskAttempt = Option.isSome(currentByRunId)
        ? Option.none<RunStartRow>()
        : yield* runQuery(
            "CompositionRunStartStore.prepareStart.getTaskAttemptWinner",
            statements.getRowByTaskAttempt({ taskId: input.taskId, attempt: input.attempt }),
          );
      const current = Option.isSome(currentByRunId)
        ? currentByRunId.value
        : Option.isSome(currentByTaskAttempt)
          ? toIntent(currentByTaskAttempt.value)
          : undefined;
      if (current === undefined) {
        return yield* domainError(
          "run_start_identity_conflict",
          "Run Start 插入发生唯一键冲突，但未能读取既有赢家。",
          { runId: input.runId },
        );
      }
      if (sameIdentity(current, input)) return current;
      return yield* domainError(
        "run_start_identity_conflict",
        "同一 runId 或 task/attempt 已绑定到不同启动摘要，拒绝覆盖。",
        { runId: input.runId, actualRevision: current.revision },
      );
    });

  const validateClaim = (operation: string, input: CompositionRunStartClaimInput) =>
    Effect.gen(function* () {
      if (!hasTextWithin(input.runId, 512) || !hasTextWithin(input.claimId, 512)) {
        return yield* domainError(
          "run_start_input_invalid",
          `${operation} 的 runId/claimId 不能为空或超长。`,
          { runId: input.runId },
        );
      }
      yield* validateRevision(operation, input.runId, input.expectedRevision);
      yield* validateTimestamp(operation, input.runId, input.claimedAtUnixMs);
      return input;
    });

  const claimPrepared: CompositionRunStartStoreShape["claimPrepared"] = (input) =>
    Effect.gen(function* () {
      yield* validateClaim("claimPrepared", input);
      const claimed = yield* runQuery(
        "CompositionRunStartStore.claimPrepared",
        statements.claimPreparedRow(input),
      );
      if (Option.isSome(claimed)) {
        return { intent: toIntent(claimed.value), claimed: true };
      }
      const current = yield* getRequired(input.runId);
      const replayed =
        current.state === "preparing" &&
        current.claimId === input.claimId &&
        current.revision === input.expectedRevision + 1 &&
        current.updatedAtUnixMs === input.claimedAtUnixMs;
      return { intent: current, claimed: replayed } satisfies CompositionRunStartClaimResult;
    });

  const releasePreparation: CompositionRunStartStoreShape["releasePreparation"] = (
    input: CompositionRunStartReleaseInput,
  ) =>
    Effect.gen(function* () {
      if (!hasTextWithin(input.runId, 512) || !hasTextWithin(input.claimId, 512)) {
        return yield* domainError(
          "run_start_input_invalid",
          "releasePreparation 的 runId/claimId 不能为空或超长。",
          { runId: input.runId },
        );
      }
      yield* validateRevision("releasePreparation", input.runId, input.expectedRevision);
      yield* validateTimestamp("releasePreparation", input.runId, input.releasedAtUnixMs);
      const released = yield* runQuery(
        "CompositionRunStartStore.releasePreparation",
        statements.releasePreparationRow(input),
      );
      if (Option.isSome(released)) return toIntent(released.value);
      const current = yield* getRequired(input.runId);
      if (current.state === "prepared" && current.claimId === null) return current;
      return yield* domainError(
        "run_start_claim_conflict",
        "只有当前 setup owner 可以释放准备阶段。",
        {
          runId: input.runId,
          expectedRevision: input.expectedRevision,
          actualRevision: current.revision,
          expectedState: "preparing",
          actualState: current.state,
        },
      );
    });

  const resetPreparationForRecovery: CompositionRunStartStoreShape["resetPreparationForRecovery"] =
    (input) =>
      Effect.gen(function* () {
        if (!hasTextWithin(input.runId, 512)) {
          return yield* domainError("run_start_input_invalid", "reset 的 runId 不能为空或超长。", {
            runId: input.runId,
          });
        }
        yield* validateRevision("resetPreparationForRecovery", input.runId, input.expectedRevision);
        yield* validateTimestamp("resetPreparationForRecovery", input.runId, input.resetAtUnixMs);
        const reset = yield* runQuery(
          "CompositionRunStartStore.resetPreparationForRecovery",
          statements.resetPreparationRow(input),
        );
        if (Option.isSome(reset)) return toIntent(reset.value);
        const current = yield* getRequired(input.runId);
        if (current.state === "prepared" && current.claimId === null) return current;
        return yield* domainError(
          "run_start_state_conflict",
          "只有 preparing 意图可以在启动恢复时重置。",
          {
            runId: input.runId,
            expectedRevision: input.expectedRevision,
            actualRevision: current.revision,
            expectedState: "preparing",
            actualState: current.state,
          },
        );
      });

  const markDispatching: CompositionRunStartStoreShape["markDispatching"] = (
    input: CompositionRunStartDispatchInput,
  ) =>
    Effect.gen(function* () {
      if (!hasTextWithin(input.runId, 512) || !hasTextWithin(input.claimId, 512)) {
        return yield* domainError(
          "run_start_input_invalid",
          "markDispatching 的 runId/claimId 不能为空或超长。",
          { runId: input.runId },
        );
      }
      yield* validateRevision("markDispatching", input.runId, input.expectedRevision);
      yield* validateTimestamp("markDispatching", input.runId, input.dispatchedAtUnixMs);
      const dispatching = yield* runQuery(
        "CompositionRunStartStore.markDispatching",
        statements.markDispatchingRow(input),
      );
      if (Option.isSome(dispatching)) return toIntent(dispatching.value);
      const current = yield* getRequired(input.runId);
      if (
        current.state === "dispatching" &&
        current.claimId === input.claimId &&
        current.revision === input.expectedRevision + 1
      ) {
        return current;
      }
      return yield* domainError(
        "run_start_claim_conflict",
        "只有当前 setup owner 可以进入 dispatching。",
        {
          runId: input.runId,
          expectedRevision: input.expectedRevision,
          actualRevision: current.revision,
          expectedState: "preparing",
          actualState: current.state,
        },
      );
    });

  const claimDispatchRecovery: CompositionRunStartStoreShape["claimDispatchRecovery"] = (input) =>
    Effect.gen(function* () {
      yield* validateClaim("claimDispatchRecovery", input);
      const claimed = yield* runQuery(
        "CompositionRunStartStore.claimDispatchRecovery",
        statements.claimDispatchRecoveryRow(input),
      );
      if (Option.isSome(claimed)) {
        return { intent: toIntent(claimed.value), claimed: true };
      }
      const current = yield* getRequired(input.runId);
      const replayed =
        current.state === "dispatching" &&
        current.claimId === input.claimId &&
        current.revision === input.expectedRevision + 1 &&
        current.updatedAtUnixMs === input.claimedAtUnixMs;
      return { intent: current, claimed: replayed } satisfies CompositionRunStartClaimResult;
    });

  const recordAccepted: CompositionRunStartStoreShape["recordAccepted"] = (
    input: CompositionRunStartAcceptedInput,
  ) =>
    Effect.gen(function* () {
      if (
        !hasTextWithin(input.runId, 512) ||
        !hasTextWithin(input.claimId, 512) ||
        (input.runtimeTaskId !== null && !hasTextWithin(input.runtimeTaskId, 1024)) ||
        (input.capabilityHandshakeId !== null && !hasTextWithin(input.capabilityHandshakeId, 1024))
      ) {
        return yield* domainError(
          "run_start_input_invalid",
          "recordAccepted 的身份或 receipt 字段非法。",
          { runId: input.runId },
        );
      }
      yield* validateRevision("recordAccepted", input.runId, input.expectedRevision);
      yield* validateTimestamp("recordAccepted", input.runId, input.acceptedAtUnixMs);
      const accepted = yield* runQuery(
        "CompositionRunStartStore.recordAccepted",
        statements.recordAcceptedRow(input),
      );
      if (Option.isSome(accepted)) return toIntent(accepted.value);
      const current = yield* getRequired(input.runId);
      if (
        (current.state === "accepted" || current.state === "settled") &&
        sameReceipt(current, input)
      ) {
        return current;
      }
      return yield* domainError(
        "run_start_receipt_conflict",
        "迟到 receipt 与当前持久赢家不一致。",
        {
          runId: input.runId,
          expectedRevision: input.expectedRevision,
          actualRevision: current.revision,
          expectedState: "dispatching",
          actualState: current.state,
        },
      );
    });

  const settleAccepted: CompositionRunStartStoreShape["settleAccepted"] = (
    input: CompositionRunStartSettledInput,
  ) =>
    Effect.gen(function* () {
      if (!hasTextWithin(input.runId, 512)) {
        return yield* domainError("run_start_input_invalid", "settle 的 runId 不能为空或超长。", {
          runId: input.runId,
        });
      }
      yield* validateRevision("settleAccepted", input.runId, input.expectedRevision);
      yield* validateTimestamp("settleAccepted", input.runId, input.settledAtUnixMs);
      const settled = yield* runQuery(
        "CompositionRunStartStore.settleAccepted",
        statements.settleAcceptedRow(input),
      );
      if (Option.isSome(settled)) return toIntent(settled.value);
      const current = yield* getRequired(input.runId);
      if (current.state === "settled") return current;
      return yield* domainError("run_start_state_conflict", "只有 accepted 意图可以结算。", {
        runId: input.runId,
        expectedRevision: input.expectedRevision,
        actualRevision: current.revision,
        expectedState: "accepted",
        actualState: current.state,
      });
    });

  const settleRejected: CompositionRunStartStoreShape["settleRejected"] = (
    input: CompositionRunStartRejectedInput,
  ) =>
    Effect.gen(function* () {
      if (
        !hasTextWithin(input.runId, 512) ||
        !hasTextWithin(input.claimId, 512) ||
        !hasTextWithin(input.outcomeCode, 128) ||
        (input.outcomeDetail !== null && !hasTextWithin(input.outcomeDetail, 1024))
      ) {
        return yield* domainError(
          "run_start_input_invalid",
          "settleRejected 的身份或稳定结果字段非法。",
          { runId: input.runId },
        );
      }
      yield* validateRevision("settleRejected", input.runId, input.expectedRevision);
      yield* validateTimestamp("settleRejected", input.runId, input.settledAtUnixMs);
      const settled = yield* runQuery(
        "CompositionRunStartStore.settleRejected",
        statements.settleRejectedRow(input),
      );
      if (Option.isSome(settled)) return toIntent(settled.value);
      const current = yield* getRequired(input.runId);
      if (
        current.state === "settled" &&
        current.outcomeCode === input.outcomeCode &&
        current.outcomeDetail === input.outcomeDetail
      ) {
        return current;
      }
      return yield* domainError(
        "run_start_state_conflict",
        "只有当前 dispatch owner 可以结算明确启动失败。",
        {
          runId: input.runId,
          expectedRevision: input.expectedRevision,
          actualRevision: current.revision,
          expectedState: "dispatching",
          actualState: current.state,
        },
      );
    });

  const quarantine: CompositionRunStartStoreShape["quarantine"] = (
    input: CompositionRunStartQuarantineInput,
  ) =>
    Effect.gen(function* () {
      if (
        !hasTextWithin(input.runId, 512) ||
        !hasTextWithin(input.outcomeCode, 128) ||
        (input.outcomeDetail !== null && !hasTextWithin(input.outcomeDetail, 1024))
      ) {
        return yield* domainError(
          "run_start_input_invalid",
          "quarantine 的 runId 或稳定结果字段非法。",
          { runId: input.runId },
        );
      }
      yield* validateRevision("quarantine", input.runId, input.expectedRevision);
      yield* validateTimestamp("quarantine", input.runId, input.quarantinedAtUnixMs);
      const quarantined = yield* runQuery(
        "CompositionRunStartStore.quarantine",
        statements.quarantineRow(input),
      );
      if (Option.isSome(quarantined)) return toIntent(quarantined.value);
      const current = yield* getRequired(input.runId);
      if (
        current.state === "quarantined" &&
        current.outcomeCode === input.outcomeCode &&
        current.outcomeDetail === input.outcomeDetail
      ) {
        return current;
      }
      return yield* domainError(
        "run_start_state_conflict",
        "当前意图不能被本次 quarantine 覆盖。",
        {
          runId: input.runId,
          expectedRevision: input.expectedRevision,
          actualRevision: current.revision,
          actualState: current.state,
        },
      );
    });

  const listRecoverable: CompositionRunStartStoreShape["listRecoverable"] = ({ limit }) =>
    Number.isSafeInteger(limit) && limit >= 1 && limit <= LIST_LIMIT_MAX
      ? runQuery(
          "CompositionRunStartStore.listRecoverable",
          statements.listRecoverableRows({ limit }),
        ).pipe(Effect.map((rows) => rows.map(toIntent)))
      : Effect.fail(
          domainError(
            "run_start_list_limit_invalid",
            `listRecoverable limit 必须位于 1..${LIST_LIMIT_MAX}。`,
          ),
        );

  return {
    prepareStart,
    getStart,
    claimPrepared,
    releasePreparation,
    resetPreparationForRecovery,
    markDispatching,
    claimDispatchRecovery,
    recordAccepted,
    settleAccepted,
    settleRejected,
    quarantine,
    listRecoverable,
  } satisfies CompositionRunStartStoreShape;
});

export const CompositionRunStartStoreLive = Layer.effect(CompositionRunStartStore, makeStore);
