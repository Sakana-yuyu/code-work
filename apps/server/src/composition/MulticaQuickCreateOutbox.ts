import type {
  CompositionMulticaQuickCreateIntent,
  CompositionTaskStoreError,
  CompositionTaskStoreShape,
} from "../persistence/Services/CompositionTaskStore.ts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

export class MulticaQuickCreateOutboxFailure extends Data.TaggedError(
  "MulticaQuickCreateOutboxError",
)<{
  readonly code: "quick_create_outbox_not_accepted" | "quick_create_intent_missing";
  readonly detail: string;
}> {}

/** 账本中处于未终态的 quick-create 发送意图。 */
export type PendingQuickCreateIntent = CompositionMulticaQuickCreateIntent;

export type MulticaQuickCreateOutboxAudit = {
  /** 已持久化但从未 claim 发送；重派是安全的，POST 还没有发出过。 */
  readonly readyToDispatch: ReadonlyArray<PendingQuickCreateIntent>;
  /**
   * 曾进入 sending 且超过租约窗口仍无终态；远端结果未知，
   * 在真实服务端幂等/查询能力确认前禁止自动重放 POST，只能人工核对后 settle。
   */
  readonly staleSending: ReadonlyArray<PendingQuickCreateIntent>;
  /** sending 但仍在租约窗口内，可能是其他进程正在发送；保持观察。 */
  readonly freshSending: ReadonlyArray<PendingQuickCreateIntent>;
};

export type MulticaQuickCreateOutboxAuditOptions = {
  readonly runtimeId?: string;
  /** 租约截止：updatedAt 早于该值的 sending 视为悬挂。 */
  readonly staleBeforeUnixMs: number;
};

export type OutboxCompositionTaskStore = Pick<
  CompositionTaskStoreShape,
  "listPendingMulticaQuickCreateIntents" | "acceptMulticaQuickCreateIntent"
>;

/**
 * 持久化 outbox 审计：把 pending intent 分为可安全重派、需人工收口与在途三类。
 * 只分类不投递；是否重派仍由 dispatchTask 的既有安全门决定。
 */
export const auditMulticaQuickCreateIntents = (
  store: {
    readonly listPendingMulticaQuickCreateIntents: OutboxCompositionTaskStore["listPendingMulticaQuickCreateIntents"];
  },
  options: MulticaQuickCreateOutboxAuditOptions,
): Effect.Effect<MulticaQuickCreateOutboxAudit, CompositionTaskStoreError> =>
  Effect.map(store.listPendingMulticaQuickCreateIntents(options.runtimeId), (pending) => {
    const readyToDispatch: Array<PendingQuickCreateIntent> = [];
    const staleSending: Array<PendingQuickCreateIntent> = [];
    const freshSending: Array<PendingQuickCreateIntent> = [];
    for (const intent of pending) {
      if (intent.state === "prepared") {
        readyToDispatch.push(intent);
      } else if (intent.updatedAtUnixMs < options.staleBeforeUnixMs) {
        staleSending.push(intent);
      } else {
        freshSending.push(intent);
      }
    }
    return { readyToDispatch, staleSending, freshSending };
  });

export type SettleStaleSendingInput = {
  readonly runId: string;
  readonly runtimeId: string;
  /** 人工核对 Multica 后取得的远端 task ID。 */
  readonly remoteTaskId: string;
  readonly updatedAtUnixMs: number;
};

/**
 * 收口一条悬挂的 sending 意图：绑定核对取得的远端 task ID。
 * 之后同一 Run 再派发会命中 accepted 恢复路径，不会产生第二个远端任务。
 */
export const settleStaleSendingIntent = (
  store: {
    readonly acceptMulticaQuickCreateIntent: OutboxCompositionTaskStore["acceptMulticaQuickCreateIntent"];
  },
  input: SettleStaleSendingInput,
): Effect.Effect<
  PendingQuickCreateIntent,
  MulticaQuickCreateOutboxFailure | CompositionTaskStoreError
> =>
  Effect.flatMap(
    store.acceptMulticaQuickCreateIntent({
      runId: input.runId,
      runtimeId: input.runtimeId,
      remoteTaskId: input.remoteTaskId,
      updatedAtUnixMs: input.updatedAtUnixMs,
    }),
    (accepted) =>
      Option.isSome(accepted)
        ? Effect.succeed(accepted.value)
        : Effect.fail(
            new MulticaQuickCreateOutboxFailure({
              code: "quick_create_outbox_not_accepted",
              detail: `run ${input.runId} 不再处于 sending 状态，无法绑定远端 task ${input.remoteTaskId}。`,
            }),
          ),
  );
