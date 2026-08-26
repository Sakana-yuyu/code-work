import type {
  CompositionRuntimeLease,
  CompositionSquad,
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
  /** 按外部 Runtime 的稳定任务标识查询所有候选 Run；多命中时调用方必须拒绝猜测。 */
  readonly listRunsByRuntimeTask: (
    runtimeId: string,
    runtimeTaskId: string,
  ) => Effect.Effect<ReadonlyArray<CompositionTaskRun>, CompositionTaskStoreError>;
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
  readonly upsertSquad: (
    squad: CompositionSquad,
  ) => Effect.Effect<CompositionSquad, CompositionTaskStoreError>;
  readonly getSquad: (
    squadId: string,
  ) => Effect.Effect<Option.Option<CompositionSquad>, CompositionTaskStoreError>;
}

export class CompositionTaskStore extends Context.Service<
  CompositionTaskStore,
  CompositionTaskStoreShape
>()("codework/persistence/Services/CompositionTaskStore") {}
