import type { SpecWorkflowState, SpecWorkflowStateEvent } from "@codework/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

export const SpecWorkflowStateStoreErrorCode = Schema.Literals([
  "invalid-input",
  "workflow-not-found",
  "persistence-failed",
  "revision-conflict",
]);
export type SpecWorkflowStateStoreErrorCode = typeof SpecWorkflowStateStoreErrorCode.Type;

export class SpecWorkflowStateStoreDomainError extends Schema.TaggedErrorClass<SpecWorkflowStateStoreDomainError>()(
  "SpecWorkflowStateStoreDomainError",
  {
    code: SpecWorkflowStateStoreErrorCode,
    detail: Schema.String,
    threadId: Schema.String,
    workflowId: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return `Spec Workflow 状态持久化失败：${this.code}: ${this.detail}`;
  }
}

export type SpecWorkflowStateStoreError =
  | PersistenceSqlError
  | PersistenceDecodeError
  | SpecWorkflowStateStoreDomainError;

export type SpecWorkflowStateStoreAppendInput = {
  readonly threadId: string;
  readonly event: SpecWorkflowStateEvent;
  readonly expectedRevision: number;
};

export interface SpecWorkflowStateStoreShape {
  readonly listStates: () => Effect.Effect<
    ReadonlyArray<SpecWorkflowState>,
    SpecWorkflowStateStoreError
  >;
  readonly get: (
    threadId: string,
  ) => Effect.Effect<Option.Option<SpecWorkflowState>, SpecWorkflowStateStoreError>;
  readonly append: (
    input: SpecWorkflowStateStoreAppendInput,
  ) => Effect.Effect<SpecWorkflowState, SpecWorkflowStateStoreError>;
  readonly listEvents: (
    threadId: string,
  ) => Effect.Effect<ReadonlyArray<SpecWorkflowStateEvent>, SpecWorkflowStateStoreError>;
  readonly subscribe: (
    threadId: string,
  ) => Effect.Effect<Stream.Stream<SpecWorkflowStateEvent>, never>;
}

export class SpecWorkflowStateStore extends Context.Service<
  SpecWorkflowStateStore,
  SpecWorkflowStateStoreShape
>()("codework/persistence/Services/SpecWorkflowStateStore") {}
