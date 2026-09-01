import type {
  CompositionSquadExecution,
  CompositionSquadExecutionStatus,
} from "@codework/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

export const CompositionSquadExecutionStoreErrorCode = Schema.Literals([
  "squad_execution_not_found",
  "squad_execution_conflict",
  "squad_execution_initial_state_invalid",
  "squad_execution_revision_conflict",
  "squad_execution_status_conflict",
  "squad_execution_snapshot_invalid",
  "squad_execution_squad_revision_invalid",
  "squad_execution_list_cursor_invalid",
  "squad_execution_list_limit_invalid",
]);
export type CompositionSquadExecutionStoreErrorCode =
  typeof CompositionSquadExecutionStoreErrorCode.Type;

export class CompositionSquadExecutionStoreDomainError extends Schema.TaggedErrorClass<CompositionSquadExecutionStoreDomainError>()(
  "CompositionSquadExecutionStoreDomainError",
  {
    code: CompositionSquadExecutionStoreErrorCode,
    detail: Schema.String,
    executionId: Schema.String,
    squadId: Schema.optional(Schema.String),
    expectedRevision: Schema.optional(Schema.Number),
    actualRevision: Schema.optional(Schema.Number),
    expectedStatus: Schema.optional(Schema.String),
    actualStatus: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return `Squad execution 持久化失败：${this.code}: ${this.detail}`;
  }
}

export type CompositionSquadExecutionStoreError =
  | PersistenceSqlError
  | PersistenceDecodeError
  | CompositionSquadExecutionStoreDomainError;

export interface CompositionSquadExecutionClaimResult {
  readonly execution: CompositionSquadExecution;
  readonly claimed: boolean;
}

export interface CompositionSquadExecutionTransitionInput {
  readonly execution: CompositionSquadExecution;
  readonly expectedRevision: number;
}

export interface CompositionSquadExecutionListInput {
  readonly projectId?: string;
  readonly threadId?: string;
  readonly squadId?: string;
  readonly statuses?: ReadonlyArray<CompositionSquadExecutionStatus>;
  readonly limit: number;
}

export interface CompositionSquadExecutionUnsettledListInput {
  readonly limit: number;
  readonly cursor?: {
    readonly updatedAtUnixMs: number;
    readonly executionId: string;
  };
}

export interface CompositionSquadExecutionStoreShape {
  readonly claimExecution: (
    execution: CompositionSquadExecution,
  ) => Effect.Effect<CompositionSquadExecutionClaimResult, CompositionSquadExecutionStoreError>;
  readonly saveTransition: (
    input: CompositionSquadExecutionTransitionInput,
  ) => Effect.Effect<CompositionSquadExecution, CompositionSquadExecutionStoreError>;
  readonly getExecution: (
    executionId: string,
  ) => Effect.Effect<Option.Option<CompositionSquadExecution>, CompositionSquadExecutionStoreError>;
  readonly listExecutions: (
    input: CompositionSquadExecutionListInput,
  ) => Effect.Effect<ReadonlyArray<CompositionSquadExecution>, CompositionSquadExecutionStoreError>;
  readonly listUnsettledExecutions: (
    input: CompositionSquadExecutionUnsettledListInput,
  ) => Effect.Effect<ReadonlyArray<CompositionSquadExecution>, CompositionSquadExecutionStoreError>;
}

export class CompositionSquadExecutionStore extends Context.Service<
  CompositionSquadExecutionStore,
  CompositionSquadExecutionStoreShape
>()("codework/persistence/Services/CompositionSquadExecutionStore") {}
