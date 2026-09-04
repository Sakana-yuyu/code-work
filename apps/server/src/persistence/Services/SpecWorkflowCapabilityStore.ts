import type {
  SpecWorkflowCapability,
  SpecWorkflowEvent,
  SpecWorkflowSetInput,
} from "@codework/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

export const SpecWorkflowCapabilityStoreErrorCode = Schema.Literals([
  "thread-not-found",
  "invalid-input",
  "persistence-failed",
  "stale-version",
]);
export type SpecWorkflowCapabilityStoreErrorCode = typeof SpecWorkflowCapabilityStoreErrorCode.Type;

export class SpecWorkflowCapabilityStoreDomainError extends Schema.TaggedErrorClass<SpecWorkflowCapabilityStoreDomainError>()(
  "SpecWorkflowCapabilityStoreDomainError",
  {
    code: SpecWorkflowCapabilityStoreErrorCode,
    detail: Schema.String,
    threadId: Schema.String,
  },
) {
  override get message(): string {
    return `Spec Workflow 能力持久化失败：${this.code}: ${this.detail}`;
  }
}

export type SpecWorkflowCapabilityStoreError =
  | PersistenceSqlError
  | PersistenceDecodeError
  | SpecWorkflowCapabilityStoreDomainError;

export interface SpecWorkflowCapabilityStoreShape {
  readonly get: (
    threadId: string,
  ) => Effect.Effect<SpecWorkflowCapability, SpecWorkflowCapabilityStoreError>;
  readonly set: (
    input: SpecWorkflowSetInput,
  ) => Effect.Effect<SpecWorkflowCapability, SpecWorkflowCapabilityStoreError>;
  readonly subscribe: (threadId: string) => Effect.Effect<Stream.Stream<SpecWorkflowEvent>, never>;
}

export class SpecWorkflowCapabilityStore extends Context.Service<
  SpecWorkflowCapabilityStore,
  SpecWorkflowCapabilityStoreShape
>()("codework/persistence/Services/SpecWorkflowCapabilityStore") {}
