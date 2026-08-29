import type {
  CompositionAutomation,
  CompositionAutomationDeleteResult,
  CompositionAutomationListRequest,
  CompositionAutomationRun,
  CompositionAutomationRunListRequest,
  CompositionAutomationRunListResult,
  CompositionAutomationRunStatus,
} from "@codework/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

export const CompositionAutomationStoreErrorCode = Schema.Literals([
  "automation_not_found",
  "automation_already_exists",
  "automation_revision_conflict",
  "automation_revision_invalid",
  "automation_run_not_found",
  "automation_run_conflict",
  "automation_run_status_conflict",
  "automation_schedule_conflict",
  "automation_schedule_invalid",
  "automation_history_cursor_invalid",
  "automation_history_limit_invalid",
]);
export type CompositionAutomationStoreErrorCode = typeof CompositionAutomationStoreErrorCode.Type;

export class CompositionAutomationStoreDomainError extends Schema.TaggedErrorClass<CompositionAutomationStoreDomainError>()(
  "CompositionAutomationStoreDomainError",
  {
    code: CompositionAutomationStoreErrorCode,
    detail: Schema.String,
    automationId: Schema.String,
    automationRunId: Schema.optional(Schema.String),
    expectedRevision: Schema.optional(Schema.Number),
    actualRevision: Schema.optional(Schema.Number),
    expectedStatus: Schema.optional(Schema.String),
    actualStatus: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return `Automation 持久化失败：${this.code}: ${this.detail}`;
  }
}

export type CompositionAutomationStoreError =
  | PersistenceSqlError
  | PersistenceDecodeError
  | CompositionAutomationStoreDomainError;

export interface CompositionAutomationRevisionWriteInput {
  readonly automation: CompositionAutomation;
  readonly expectedRevision: number;
}

export interface CompositionAutomationDeleteInput {
  readonly automationId: string;
  readonly expectedRevision: number;
  readonly deletedAtUnixMs: number;
}

export interface CompositionAutomationRunClaimResult {
  readonly run: CompositionAutomationRun;
  readonly claimed: boolean;
}

export interface CompositionAutomationManualRunClaimInput {
  readonly automationRunId: string;
  readonly automationId: string;
  readonly expectedAutomationRevision: number;
  readonly automationRevision: number;
  readonly operationId: string;
  readonly trigger: "run_once" | "retry";
  readonly sourceAutomationRunId?: string;
  readonly requestedAtUnixMs: number;
  readonly attempt: number;
}

export interface CompositionAutomationDueListInput {
  readonly nowUnixMs: number;
  readonly limit: number;
}

export interface CompositionAutomationScheduledRunClaimInput {
  readonly run: CompositionAutomationRun;
  readonly nextAutomation: CompositionAutomation;
}

export interface CompositionAutomationScheduledRunClaimResult extends CompositionAutomationRunClaimResult {
  readonly automation: CompositionAutomation;
  readonly scheduleAdvanced: boolean;
}

export interface CompositionAutomationRecoverableRunListInput {
  readonly limit: number;
}

export interface CompositionAutomationRunTransitionInput {
  readonly run: CompositionAutomationRun;
  readonly expectedStatus: CompositionAutomationRunStatus;
}

export interface CompositionAutomationStoreShape {
  readonly createAutomation: (
    automation: CompositionAutomation,
  ) => Effect.Effect<CompositionAutomation, CompositionAutomationStoreError>;
  readonly saveAutomationRevision: (
    input: CompositionAutomationRevisionWriteInput,
  ) => Effect.Effect<CompositionAutomation, CompositionAutomationStoreError>;
  readonly getAutomation: (
    automationId: string,
  ) => Effect.Effect<Option.Option<CompositionAutomation>, CompositionAutomationStoreError>;
  readonly getAutomationRevision: (
    automationId: string,
    revision: number,
  ) => Effect.Effect<Option.Option<CompositionAutomation>, CompositionAutomationStoreError>;
  readonly listAutomations: (
    request: CompositionAutomationListRequest,
  ) => Effect.Effect<ReadonlyArray<CompositionAutomation>, CompositionAutomationStoreError>;
  readonly listDueAutomations: (
    input: CompositionAutomationDueListInput,
  ) => Effect.Effect<ReadonlyArray<CompositionAutomation>, CompositionAutomationStoreError>;
  readonly deleteAutomation: (
    input: CompositionAutomationDeleteInput,
  ) => Effect.Effect<CompositionAutomationDeleteResult, CompositionAutomationStoreError>;
  readonly claimRun: (
    run: CompositionAutomationRun,
  ) => Effect.Effect<CompositionAutomationRunClaimResult, CompositionAutomationStoreError>;
  readonly claimManualRun: (
    input: CompositionAutomationManualRunClaimInput,
  ) => Effect.Effect<CompositionAutomationRunClaimResult, CompositionAutomationStoreError>;
  readonly claimRunExecution: (
    run: CompositionAutomationRun,
  ) => Effect.Effect<CompositionAutomationRunClaimResult, CompositionAutomationStoreError>;
  readonly claimScheduledRun: (
    input: CompositionAutomationScheduledRunClaimInput,
  ) => Effect.Effect<CompositionAutomationScheduledRunClaimResult, CompositionAutomationStoreError>;
  readonly saveRunTransition: (
    input: CompositionAutomationRunTransitionInput,
  ) => Effect.Effect<CompositionAutomationRun, CompositionAutomationStoreError>;
  readonly getRun: (
    automationRunId: string,
  ) => Effect.Effect<Option.Option<CompositionAutomationRun>, CompositionAutomationStoreError>;
  readonly listRecoverableRuns: (
    input: CompositionAutomationRecoverableRunListInput,
  ) => Effect.Effect<ReadonlyArray<CompositionAutomationRun>, CompositionAutomationStoreError>;
  readonly listRuns: (
    request: CompositionAutomationRunListRequest,
  ) => Effect.Effect<CompositionAutomationRunListResult, CompositionAutomationStoreError>;
}

export class CompositionAutomationStore extends Context.Service<
  CompositionAutomationStore,
  CompositionAutomationStoreShape
>()("codework/persistence/Services/CompositionAutomationStore") {}
