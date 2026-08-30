import type {
  CompositionRuntimeLease,
  CompositionSquad,
  CompositionSquadRevision,
  CompositionTask,
  CompositionTaskDependency,
  CompositionTaskEvent,
  CompositionTaskRun,
} from "@codework/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import type { PersistenceSqlError } from "../Errors.ts";

export type CompositionTaskStoreError = PersistenceSqlError;

/**
 * Multica quick-create 的本地发送事实。仅保存本地关联键和远端任务 ID，绝不保存 prompt、请求头或凭据。
 */
export type CompositionMulticaQuickCreateIntent = {
  readonly runId: string;
  readonly taskId: string;
  readonly runtimeId: string;
  readonly idempotencyKey: string;
  readonly state: "prepared" | "sending" | "accepted";
  readonly remoteTaskId?: string;
  readonly createdAtUnixMs: number;
  readonly updatedAtUnixMs: number;
};

export type CompositionMulticaQuickCreateIntentInput = Omit<
  CompositionMulticaQuickCreateIntent,
  "state"
>;

export type CompositionRuntimeLeaseClaimInput = {
  readonly lease: CompositionRuntimeLease;
  readonly nowUnixMs: number;
};

export type CompositionRuntimeLeaseRenewInput = {
  readonly leaseId: string;
  readonly runtimeId: string;
  readonly heartbeatAtUnixMs: number;
  readonly expiresAtUnixMs: number;
  readonly nowUnixMs: number;
};

export type CompositionRuntimeLeaseReleaseInput = {
  readonly leaseId: string;
  readonly runtimeId: string;
  readonly releasedAtUnixMs: number;
};

export type CompositionRuntimeLeaseReclaimInput = {
  readonly nowUnixMs: number;
};

export interface CompositionTaskStoreShape {
  readonly upsertTask: (
    task: CompositionTask,
  ) => Effect.Effect<CompositionTask, CompositionTaskStoreError>;
  readonly getTask: (
    taskId: string,
  ) => Effect.Effect<Option.Option<CompositionTask>, CompositionTaskStoreError>;
  readonly listTasks: (
    projectId?: string,
  ) => Effect.Effect<ReadonlyArray<CompositionTask>, CompositionTaskStoreError>;
  readonly upsertRun: (
    run: CompositionTaskRun,
  ) => Effect.Effect<CompositionTaskRun, CompositionTaskStoreError>;
  readonly getRun: (
    runId: string,
  ) => Effect.Effect<Option.Option<CompositionTaskRun>, CompositionTaskStoreError>;
  readonly getLatestRun: (
    taskId: string,
  ) => Effect.Effect<Option.Option<CompositionTaskRun>, CompositionTaskStoreError>;
  /** 按 Task 与 attempt 查询全部候选 Run；多命中时调用方必须拒绝猜测。 */
  readonly listRunsByTaskAttempt: (
    taskId: string,
    attempt: number,
  ) => Effect.Effect<ReadonlyArray<CompositionTaskRun>, CompositionTaskStoreError>;
  /** 按外部 Runtime 的稳定任务标识查询所有候选 Run；多命中时调用方必须拒绝猜测。 */
  readonly listRunsByRuntimeTask: (
    runtimeId: string,
    runtimeTaskId: string,
  ) => Effect.Effect<ReadonlyArray<CompositionTaskRun>, CompositionTaskStoreError>;
  /** 原子创建发送意图；false 表示 Run 或 Runtime 作用域幂等键已有不可覆盖的历史意图。 */
  readonly createMulticaQuickCreateIntent: (
    intent: CompositionMulticaQuickCreateIntentInput,
  ) => Effect.Effect<boolean, CompositionTaskStoreError>;
  readonly getMulticaQuickCreateIntent: (
    runId: string,
  ) => Effect.Effect<Option.Option<CompositionMulticaQuickCreateIntent>, CompositionTaskStoreError>;
  readonly getMulticaQuickCreateIntentByIdempotencyKey: (
    runtimeId: string,
    idempotencyKey: string,
  ) => Effect.Effect<Option.Option<CompositionMulticaQuickCreateIntent>, CompositionTaskStoreError>;
  /** 仅 prepared 可转为 sending；sending 代表请求结果已不可安全推断。 */
  readonly claimMulticaQuickCreateIntentForSend: (input: {
    readonly runId: string;
    readonly runtimeId: string;
    readonly updatedAtUnixMs: number;
  }) => Effect.Effect<
    Option.Option<CompositionMulticaQuickCreateIntent>,
    CompositionTaskStoreError
  >;
  /** 仅将本次 sending 意图绑定到已验证的远端 task ID。 */
  readonly acceptMulticaQuickCreateIntent: (input: {
    readonly runId: string;
    readonly runtimeId: string;
    readonly remoteTaskId: string;
    readonly updatedAtUnixMs: number;
  }) => Effect.Effect<
    Option.Option<CompositionMulticaQuickCreateIntent>,
    CompositionTaskStoreError
  >;
  readonly listPendingMulticaQuickCreateIntents: (
    runtimeId?: string,
  ) => Effect.Effect<ReadonlyArray<CompositionMulticaQuickCreateIntent>, CompositionTaskStoreError>;
  readonly appendEvent: (
    event: CompositionTaskEvent,
  ) => Effect.Effect<CompositionTaskEvent, CompositionTaskStoreError>;
  /**
   * 以 sourceEventId 原子抢占一次外部事件；返回 false 表示同一事件已被其他投影者处理。
   */
  readonly appendEventIfNew: (
    event: CompositionTaskEvent & { readonly sourceEventId: string },
  ) => Effect.Effect<boolean, CompositionTaskStoreError>;
  readonly withTransaction: <A, E, R>(
    self: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | CompositionTaskStoreError, R>;
  readonly listEvents: (
    taskId: string,
    runId: string,
  ) => Effect.Effect<ReadonlyArray<CompositionTaskEvent>, CompositionTaskStoreError>;
  readonly upsertDependency: (
    dependency: CompositionTaskDependency,
  ) => Effect.Effect<CompositionTaskDependency, CompositionTaskStoreError>;
  readonly listDependencies: (
    taskId: string,
  ) => Effect.Effect<ReadonlyArray<CompositionTaskDependency>, CompositionTaskStoreError>;
  readonly upsertLease: (
    lease: CompositionRuntimeLease,
  ) => Effect.Effect<CompositionRuntimeLease, CompositionTaskStoreError>;
  readonly getLease: (
    leaseId: string,
  ) => Effect.Effect<Option.Option<CompositionRuntimeLease>, CompositionTaskStoreError>;
  /** 同一 workspace 同时只允许一个未过期 active lease；完全相同的请求可安全重放。 */
  readonly claimLease: (
    input: CompositionRuntimeLeaseClaimInput,
  ) => Effect.Effect<Option.Option<CompositionRuntimeLease>, CompositionTaskStoreError>;
  /** 仅 lease owner 可在当前租约过期前单调延长 heartbeat 和 expiresAt。 */
  readonly renewLease: (
    input: CompositionRuntimeLeaseRenewInput,
  ) => Effect.Effect<Option.Option<CompositionRuntimeLease>, CompositionTaskStoreError>;
  /** owner 可幂等释放仍有效或已经释放的租约，不能覆盖 expired 终态。 */
  readonly releaseLease: (
    input: CompositionRuntimeLeaseReleaseInput,
  ) => Effect.Effect<Option.Option<CompositionRuntimeLease>, CompositionTaskStoreError>;
  /** 批量把到期的 active lease 收口为 expired，返回本次实际回收的记录。 */
  readonly reclaimExpiredLeases: (
    input: CompositionRuntimeLeaseReclaimInput,
  ) => Effect.Effect<ReadonlyArray<CompositionRuntimeLease>, CompositionTaskStoreError>;
  readonly upsertSquad: (
    squad: CompositionSquad,
  ) => Effect.Effect<CompositionSquad, CompositionTaskStoreError>;
  readonly getSquad: (
    squadId: string,
  ) => Effect.Effect<Option.Option<CompositionSquad>, CompositionTaskStoreError>;
  readonly listSquads: (options?: {
    readonly includeArchived?: boolean;
  }) => Effect.Effect<ReadonlyArray<CompositionSquad>, CompositionTaskStoreError>;
  readonly listSquadRevisions: (
    squadId: string,
  ) => Effect.Effect<ReadonlyArray<CompositionSquadRevision>, CompositionTaskStoreError>;
}

export class CompositionTaskStore extends Context.Service<
  CompositionTaskStore,
  CompositionTaskStoreShape
>()("codework/persistence/Services/CompositionTaskStore") {}
