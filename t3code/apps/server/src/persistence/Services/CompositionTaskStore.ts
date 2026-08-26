import type {
  CompositionRuntimeLease,
  CompositionSquad,
  CompositionTask,
  CompositionTaskDependency,
  CompositionTaskEvent,
  CompositionTaskRun,
} from "@t3tools/contracts";
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
  readonly appendEvent: (
    event: CompositionTaskEvent,
  ) => Effect.Effect<CompositionTaskEvent, CompositionTaskStoreError>;
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
>()("t3/persistence/Services/CompositionTaskStore") {}
