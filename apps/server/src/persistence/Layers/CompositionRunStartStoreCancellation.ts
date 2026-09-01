import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type PersistenceDecodeError,
  type PersistenceSqlError,
} from "../Errors.ts";
import {
  CompositionRunStartStoreDomainError,
  type CompositionRunStartCancellationSourceFence,
  type CompositionRunStartIntent,
  type CompositionRunStartStoreErrorCode,
  type CompositionRunStartStoreShape,
} from "../Services/CompositionRunStartStore.ts";
import { makeCompositionRunStartCancelStatements } from "./CompositionRunStartStoreCancelStatements.ts";
import { toCompositionRunStartIntent } from "./CompositionRunStartStoreRow.ts";

const LIST_LIMIT_MAX = 200;
const DEFAULT_OWNER_LEASE_MS = 60_000;
const terminalStatuses = new Set(["completed", "failed", "cancelled", "timed_out"]);

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
      ? toPersistenceDecodeError(operation + ":decode")(cause)
      : toPersistenceSqlError(operation + ":query")(cause);

const hasTextWithin = (value: string, maxLength: number): boolean =>
  value.trim().length > 0 && value.length <= maxLength;

const validateTimestamp = (operation: string, runId: string, value: number) =>
  Number.isSafeInteger(value) && value >= 0
    ? Effect.succeed(value)
    : Effect.fail(
        domainError("run_start_input_invalid", operation + " 的时间必须是非负安全整数。", {
          runId,
        }),
      );

const validateRevision = (operation: string, runId: string, value: number) =>
  Number.isSafeInteger(value) && value >= 1
    ? Effect.succeed(value)
    : Effect.fail(
        domainError("run_start_input_invalid", operation + " 的 revision 必须是正安全整数。", {
          runId,
          expectedRevision: value,
        }),
      );

const validateOwnerEpoch = (operation: string, runId: string, value: number) =>
  Number.isSafeInteger(value) && value >= 1
    ? Effect.succeed(value)
    : Effect.fail(
        domainError("run_start_input_invalid", operation + " 的 owner epoch 必须是正安全整数。", {
          runId,
        }),
      );

const sameSourceFence = (
  intent: CompositionRunStartIntent,
  input: CompositionRunStartCancellationSourceFence,
): boolean =>
  intent.cancelSourceRevision === input.sourceRevision &&
  intent.cancelSourceClaimId === input.sourceClaimId &&
  intent.cancelSourceOwnerEpoch === input.sourceOwnerEpoch;

const sameReceipt = (
  intent: CompositionRunStartIntent,
  input: {
    readonly runtimeTaskId: string | null;
    readonly capabilityHandshakeId: string | null;
  },
): boolean =>
  intent.runtimeTaskId === input.runtimeTaskId &&
  intent.capabilityHandshakeId === input.capabilityHandshakeId;

const isCancellationIntent = (intent: CompositionRunStartIntent): boolean =>
  intent.cancelRequestedAtUnixMs != null &&
  intent.cancelReason != null &&
  intent.cancelSourceState != null &&
  intent.cancelSourceRevision != null &&
  intent.cancelSourceOwnerEpoch != null &&
  intent.cancelStartOutcome != null;

const isCancellationSettleReady = (intent: CompositionRunStartIntent): boolean =>
  (intent.cancelStartOutcome === "rejected" &&
    intent.cancelTerminalStatus === null &&
    intent.cancelTerminalSourceEventId === null &&
    intent.cancelTerminalObservedAtUnixMs === null) ||
  (intent.cancelStartOutcome === "accepted" &&
    intent.cancelTerminalStatus !== null &&
    intent.cancelTerminalSourceEventId !== null &&
    intent.cancelTerminalObservedAtUnixMs !== null);

export const makeCompositionRunStartStoreCancellation = (sql: SqlClient.SqlClient) => {
  const statements = makeCompositionRunStartCancelStatements(sql);
  const runQuery = <A, E, R>(operation: string, effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.mapError((cause) => mapQueryError(operation)(cause)));
  const getRequired = (runId: string) =>
    runQuery(
      "CompositionRunStartStoreCancellation.getRequired",
      statements.getCancellationRow({ runId }),
    ).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(domainError("run_start_not_found", "Run Start 意图不存在。", { runId })),
          onSome: (row) => Effect.succeed(toCompositionRunStartIntent(row)),
        }),
      ),
    );

  const validateClaim = (
    operation: string,
    input: {
      readonly runId: string;
      readonly expectedRevision: number;
      readonly claimId: string;
      readonly claimedAtUnixMs: number;
      readonly leaseExpiresAtUnixMs?: number;
    },
  ) =>
    Effect.gen(function* () {
      if (!hasTextWithin(input.runId, 512) || !hasTextWithin(input.claimId, 512)) {
        return yield* domainError(
          "run_start_input_invalid",
          operation + " 的 runId/claimId 不能为空或超长。",
          { runId: input.runId },
        );
      }
      yield* validateRevision(operation, input.runId, input.expectedRevision);
      yield* validateTimestamp(operation, input.runId, input.claimedAtUnixMs);
      const leaseExpiresAtUnixMs =
        input.leaseExpiresAtUnixMs ?? input.claimedAtUnixMs + DEFAULT_OWNER_LEASE_MS;
      if (
        !Number.isSafeInteger(leaseExpiresAtUnixMs) ||
        leaseExpiresAtUnixMs <= input.claimedAtUnixMs
      ) {
        return yield* domainError(
          "run_start_input_invalid",
          operation + " 的 owner lease 必须晚于 claim 时间且为安全整数。",
          { runId: input.runId },
        );
      }
      return { ...input, leaseExpiresAtUnixMs };
    });

  const validateSourceFence = (
    operation: string,
    input: CompositionRunStartCancellationSourceFence,
    requireClaim: boolean,
  ) =>
    Effect.gen(function* () {
      if (
        !hasTextWithin(input.runId, 512) ||
        (input.sourceClaimId !== null && !hasTextWithin(input.sourceClaimId, 512)) ||
        (requireClaim && input.sourceClaimId === null)
      ) {
        return yield* domainError(
          "run_start_input_invalid",
          operation + " 的 source fence 非法。",
          { runId: input.runId },
        );
      }
      yield* validateRevision(operation, input.runId, input.sourceRevision);
      yield* validateOwnerEpoch(operation, input.runId, input.sourceOwnerEpoch);
    });

  const requestCancellation: CompositionRunStartStoreShape["requestCancellation"] = (input) =>
    Effect.gen(function* () {
      if (!hasTextWithin(input.runId, 512) || !hasTextWithin(input.reason, 1024)) {
        return yield* domainError(
          "run_start_input_invalid",
          "requestCancellation 的 runId/reason 不能为空或超长。",
          { runId: input.runId },
        );
      }
      yield* validateRevision("requestCancellation", input.runId, input.expectedRevision);
      yield* validateTimestamp("requestCancellation", input.runId, input.requestedAtUnixMs);
      const requested = yield* runQuery(
        "CompositionRunStartStore.requestCancellation",
        statements.requestCancellationRow(input),
      );
      if (Option.isSome(requested)) return toCompositionRunStartIntent(requested.value);
      const current = yield* getRequired(input.runId);
      if (
        isCancellationIntent(current) &&
        (current.state === "cancel_pending" || current.state === "settled")
      ) {
        return current;
      }
      if (input.requestedAtUnixMs < current.createdAtUnixMs) {
        return yield* domainError(
          "run_start_input_invalid",
          "取消请求时间不能早于 Run Start 创建时间。",
          { runId: input.runId },
        );
      }
      if (current.revision !== input.expectedRevision) {
        return yield* domainError(
          "run_start_revision_conflict",
          "取消屏障 revision 已变化，调用方必须重读后重试。",
          {
            runId: input.runId,
            expectedRevision: input.expectedRevision,
            actualRevision: current.revision,
          },
        );
      }
      return yield* domainError(
        "run_start_state_conflict",
        "只有 dispatching、accepted、manual_pending 或 accepted-settled 可请求取消。",
        {
          runId: input.runId,
          expectedRevision: input.expectedRevision,
          actualRevision: current.revision,
          expectedState: "dispatching|accepted|manual_pending|accepted_settled",
          actualState: current.state,
        },
      );
    });

  const claimCancellationRecovery: CompositionRunStartStoreShape["claimCancellationRecovery"] = (
    input,
  ) =>
    Effect.gen(function* () {
      const claim = yield* validateClaim("claimCancellationRecovery", input);
      const claimed = yield* runQuery(
        "CompositionRunStartStore.claimCancellationRecovery",
        statements.claimCancellationRecoveryRow(claim),
      );
      if (Option.isSome(claimed)) {
        return { intent: toCompositionRunStartIntent(claimed.value), claimed: true };
      }
      const current = yield* getRequired(input.runId);
      const replayed =
        current.state === "cancel_pending" &&
        current.revision === input.expectedRevision + 1 &&
        current.claimId === input.claimId &&
        current.ownerLeaseExpiresAtUnixMs !== null &&
        current.ownerLeaseExpiresAtUnixMs >= claim.leaseExpiresAtUnixMs;
      return { intent: current, claimed: replayed };
    });

  const releaseCancellationRecovery: CompositionRunStartStoreShape["releaseCancellationRecovery"] =
    (input) =>
      Effect.gen(function* () {
        if (!hasTextWithin(input.runId, 512) || !hasTextWithin(input.claimId, 512)) {
          return yield* domainError(
            "run_start_input_invalid",
            "releaseCancellationRecovery 的 runId/claimId 不能为空或超长。",
            { runId: input.runId },
          );
        }
        yield* validateRevision("releaseCancellationRecovery", input.runId, input.expectedRevision);
        yield* validateOwnerEpoch("releaseCancellationRecovery", input.runId, input.ownerEpoch);
        yield* validateTimestamp(
          "releaseCancellationRecovery",
          input.runId,
          input.releasedAtUnixMs,
        );
        const released = yield* runQuery(
          "CompositionRunStartStore.releaseCancellationRecovery",
          statements.releaseCancellationRecoveryRow(input),
        );
        if (Option.isSome(released)) return toCompositionRunStartIntent(released.value);
        const current = yield* getRequired(input.runId);
        if (
          current.state === "cancel_pending" &&
          current.revision === input.expectedRevision + 1 &&
          current.claimId === null &&
          current.ownerEpoch === input.ownerEpoch &&
          current.ownerLeaseExpiresAtUnixMs === null
        ) {
          return current;
        }
        return yield* domainError(
          "run_start_claim_conflict",
          "只有租约未到期的当前 cancel owner 可以释放取消恢复 claim。",
          {
            runId: input.runId,
            expectedRevision: input.expectedRevision,
            actualRevision: current.revision,
            expectedState: "cancel_pending",
            actualState: current.state,
          },
        );
      });

  const recordCancellationStartAccepted: CompositionRunStartStoreShape["recordCancellationStartAccepted"] =
    (input) =>
      Effect.gen(function* () {
        yield* validateSourceFence("recordCancellationStartAccepted", input, true);
        if (
          (input.runtimeTaskId !== null && !hasTextWithin(input.runtimeTaskId, 1024)) ||
          (input.capabilityHandshakeId !== null &&
            !hasTextWithin(input.capabilityHandshakeId, 1024))
        ) {
          return yield* domainError("run_start_input_invalid", "迟到 accepted receipt 字段非法。", {
            runId: input.runId,
          });
        }
        yield* validateTimestamp(
          "recordCancellationStartAccepted",
          input.runId,
          input.acceptedAtUnixMs,
        );
        const accepted = yield* runQuery(
          "CompositionRunStartStore.recordCancellationStartAccepted",
          statements.recordCancellationStartAcceptedRow(input),
        );
        if (Option.isSome(accepted)) return toCompositionRunStartIntent(accepted.value);
        const current = yield* getRequired(input.runId);
        if (
          isCancellationIntent(current) &&
          (current.state === "cancel_pending" || current.state === "settled") &&
          sameSourceFence(current, input) &&
          current.cancelStartOutcome === "accepted" &&
          sameReceipt(current, input)
        ) {
          return current;
        }
        return yield* domainError(
          "run_start_receipt_conflict",
          "迟到 accepted receipt 与取消屏障持久赢家不一致。",
          { runId: input.runId, actualRevision: current.revision },
        );
      });

  const recordCancellationStartRejected: CompositionRunStartStoreShape["recordCancellationStartRejected"] =
    (input) =>
      Effect.gen(function* () {
        yield* validateSourceFence("recordCancellationStartRejected", input, true);
        if (
          !hasTextWithin(input.outcomeCode, 128) ||
          (input.outcomeDetail !== null && !hasTextWithin(input.outcomeDetail, 1024))
        ) {
          return yield* domainError("run_start_input_invalid", "迟到 rejected 稳定结果字段非法。", {
            runId: input.runId,
          });
        }
        yield* validateTimestamp(
          "recordCancellationStartRejected",
          input.runId,
          input.rejectedAtUnixMs,
        );
        const rejected = yield* runQuery(
          "CompositionRunStartStore.recordCancellationStartRejected",
          statements.recordCancellationStartRejectedRow(input),
        );
        if (Option.isSome(rejected)) return toCompositionRunStartIntent(rejected.value);
        const current = yield* getRequired(input.runId);
        if (
          isCancellationIntent(current) &&
          (current.state === "cancel_pending" || current.state === "settled") &&
          sameSourceFence(current, input) &&
          current.cancelStartOutcome === "rejected" &&
          current.outcomeCode === input.outcomeCode &&
          current.outcomeDetail === input.outcomeDetail
        ) {
          return current;
        }
        return yield* domainError(
          "run_start_receipt_conflict",
          "迟到 rejected 结果与取消屏障持久赢家不一致。",
          { runId: input.runId, actualRevision: current.revision },
        );
      });

  const markCancellationTerminalObserved: CompositionRunStartStoreShape["markCancellationTerminalObserved"] =
    (input) =>
      Effect.gen(function* () {
        yield* validateSourceFence("markCancellationTerminalObserved", input, false);
        yield* validateRevision(
          "markCancellationTerminalObserved",
          input.runId,
          input.expectedRevision,
        );
        if (
          (input.runtimeTaskId !== null && !hasTextWithin(input.runtimeTaskId, 1024)) ||
          (input.capabilityHandshakeId !== null &&
            !hasTextWithin(input.capabilityHandshakeId, 1024)) ||
          !terminalStatuses.has(input.terminalStatus) ||
          !hasTextWithin(input.sourceEventId, 512)
        ) {
          return yield* domainError(
            "run_start_input_invalid",
            "取消终态的 receipt、status 或来源事件非法。",
            { runId: input.runId },
          );
        }
        yield* validateTimestamp(
          "markCancellationTerminalObserved",
          input.runId,
          input.observedAtUnixMs,
        );
        const marked = yield* runQuery(
          "CompositionRunStartStore.markCancellationTerminalObserved",
          statements.markCancellationTerminalObservedRow(input),
        );
        if (Option.isSome(marked)) return toCompositionRunStartIntent(marked.value);
        const current = yield* getRequired(input.runId);
        if (
          isCancellationIntent(current) &&
          (current.state === "cancel_pending" || current.state === "settled") &&
          sameSourceFence(current, input) &&
          sameReceipt(current, input) &&
          current.cancelTerminalStatus === input.terminalStatus &&
          current.cancelTerminalSourceEventId === input.sourceEventId &&
          current.cancelTerminalObservedAtUnixMs === input.observedAtUnixMs
        ) {
          return current;
        }
        if (
          current.cancelRequestedAtUnixMs != null &&
          input.observedAtUnixMs < current.cancelRequestedAtUnixMs
        ) {
          return yield* domainError(
            "run_start_input_invalid",
            "取消终态观察时间不能早于取消请求时间。",
            { runId: input.runId },
          );
        }
        if (
          current.cancelTerminalStatus != null ||
          current.cancelTerminalSourceEventId != null ||
          current.cancelTerminalObservedAtUnixMs != null
        ) {
          return yield* domainError(
            "run_start_receipt_conflict",
            "取消终态证据首次写入后不可改写。",
            { runId: input.runId, actualRevision: current.revision },
          );
        }
        return yield* domainError(
          "run_start_revision_conflict",
          "取消终态投影 revision 或 receipt fence 已变化，调用方必须重读。",
          {
            runId: input.runId,
            expectedRevision: input.expectedRevision,
            actualRevision: current.revision,
          },
        );
      });

  const settleCancellation: CompositionRunStartStoreShape["settleCancellation"] = (input) =>
    Effect.gen(function* () {
      if (!hasTextWithin(input.runId, 512) || !hasTextWithin(input.claimId, 512)) {
        return yield* domainError(
          "run_start_input_invalid",
          "settleCancellation 的 runId/claimId 不能为空或超长。",
          { runId: input.runId },
        );
      }
      yield* validateRevision("settleCancellation", input.runId, input.expectedRevision);
      yield* validateOwnerEpoch("settleCancellation", input.runId, input.ownerEpoch);
      yield* validateTimestamp("settleCancellation", input.runId, input.settledAtUnixMs);
      const settled = yield* runQuery(
        "CompositionRunStartStore.settleCancellation",
        statements.settleCancellationRow(input),
      );
      if (Option.isSome(settled)) return toCompositionRunStartIntent(settled.value);
      const current = yield* getRequired(input.runId);
      if (
        current.state === "settled" &&
        isCancellationIntent(current) &&
        current.revision === input.expectedRevision + 1 &&
        current.claimId === input.claimId &&
        current.ownerEpoch === input.ownerEpoch &&
        current.ownerLeaseExpiresAtUnixMs === null &&
        isCancellationSettleReady(current)
      ) {
        return current;
      }
      if (
        current.state === "cancel_pending" &&
        current.revision === input.expectedRevision &&
        current.claimId === input.claimId &&
        current.ownerEpoch === input.ownerEpoch &&
        !isCancellationSettleReady(current)
      ) {
        return yield* domainError(
          "run_start_state_conflict",
          "取消只能在启动明确 rejected，或 accepted 且观察到可信外部终态后结算。",
          {
            runId: input.runId,
            expectedRevision: input.expectedRevision,
            actualRevision: current.revision,
            expectedState: "cancel_pending:settle_ready",
            actualState: current.state + ":" + String(current.cancelStartOutcome),
          },
        );
      }
      return yield* domainError(
        "run_start_claim_conflict",
        "只有租约未到期的当前 cancel owner 可以结算取消恢复。",
        {
          runId: input.runId,
          expectedRevision: input.expectedRevision,
          actualRevision: current.revision,
          expectedState: "cancel_pending",
          actualState: current.state,
        },
      );
    });

  const getCancellationRecoveryScanUpperBound: CompositionRunStartStoreShape["getCancellationRecoveryScanUpperBound"] =
    runQuery(
      "CompositionRunStartStore.getCancellationRecoveryScanUpperBound",
      statements
        .getCancellationRecoveryScanUpperBoundRow(undefined)
        .pipe(Effect.map(Option.map((row) => row.runId))),
    );

  const listCancellationRecoveries: CompositionRunStartStoreShape["listCancellationRecoveries"] = ({
    limit,
    after,
    throughRunId,
  }) =>
    Number.isSafeInteger(limit) && limit >= 1 && limit <= LIST_LIMIT_MAX
      ? runQuery(
          "CompositionRunStartStore.listCancellationRecoveries",
          statements.listCancellationRecoveryRows({
            limit,
            afterRunId: after?.runId ?? null,
            throughRunId: throughRunId ?? null,
          }),
        ).pipe(Effect.map((rows) => rows.map(toCompositionRunStartIntent)))
      : Effect.fail(
          domainError(
            "run_start_list_limit_invalid",
            "listCancellationRecoveries limit 必须位于 1.." + String(LIST_LIMIT_MAX) + "。",
          ),
        );

  return {
    requestCancellation,
    claimCancellationRecovery,
    releaseCancellationRecovery,
    recordCancellationStartAccepted,
    recordCancellationStartRejected,
    markCancellationTerminalObserved,
    settleCancellation,
    getCancellationRecoveryScanUpperBound,
    listCancellationRecoveries,
  } satisfies Pick<
    CompositionRunStartStoreShape,
    | "requestCancellation"
    | "claimCancellationRecovery"
    | "releaseCancellationRecovery"
    | "recordCancellationStartAccepted"
    | "recordCancellationStartRejected"
    | "markCancellationTerminalObserved"
    | "settleCancellation"
    | "getCancellationRecoveryScanUpperBound"
    | "listCancellationRecoveries"
  >;
};
