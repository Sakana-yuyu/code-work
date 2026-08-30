import type { WorkspaceScriptListRequest, WorkspaceScriptRun } from "@codework/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

export const WorkspaceScriptStoreErrorCode = Schema.Literals([
  "workspace_script_run_not_found",
  "workspace_script_run_conflict",
  "workspace_script_revision_conflict",
  "workspace_script_stop_operation_conflict",
  "workspace_script_recovery_time_invalid",
]);
export type WorkspaceScriptStoreErrorCode = typeof WorkspaceScriptStoreErrorCode.Type;

export class WorkspaceScriptStoreDomainError extends Schema.TaggedErrorClass<WorkspaceScriptStoreDomainError>()(
  "WorkspaceScriptStoreDomainError",
  {
    code: WorkspaceScriptStoreErrorCode,
    detail: Schema.String,
    workspaceScriptRunId: Schema.optional(Schema.String),
    operationId: Schema.optional(Schema.String),
    expectedRevision: Schema.optional(Schema.Number),
    actualRevision: Schema.optional(Schema.Number),
  },
) {
  override get message(): string {
    return `Workspace Script 持久化失败：${this.code}: ${this.detail}`;
  }
}

export type WorkspaceScriptStoreError =
  | PersistenceSqlError
  | PersistenceDecodeError
  | WorkspaceScriptStoreDomainError;

export interface WorkspaceScriptRunClaimResult {
  readonly run: WorkspaceScriptRun;
  readonly claimed: boolean;
}

export interface WorkspaceScriptRunTransitionInput {
  readonly run: WorkspaceScriptRun;
  readonly expectedRevision: number;
}

export interface WorkspaceScriptStopClaimInput extends WorkspaceScriptRunTransitionInput {
  readonly operationId: string;
}

export interface WorkspaceScriptRecoveryInput {
  readonly observedAtUnixMs: number;
}

export interface WorkspaceScriptStoreShape {
  readonly claimStart: (
    run: WorkspaceScriptRun,
  ) => Effect.Effect<WorkspaceScriptRunClaimResult, WorkspaceScriptStoreError>;
  readonly saveTransition: (
    input: WorkspaceScriptRunTransitionInput,
  ) => Effect.Effect<WorkspaceScriptRun, WorkspaceScriptStoreError>;
  readonly claimStop: (
    input: WorkspaceScriptStopClaimInput,
  ) => Effect.Effect<WorkspaceScriptRunClaimResult, WorkspaceScriptStoreError>;
  readonly getRun: (
    workspaceScriptRunId: string,
  ) => Effect.Effect<Option.Option<WorkspaceScriptRun>, WorkspaceScriptStoreError>;
  readonly getActiveRunByTerminal: (
    threadId: string,
    terminalId: string,
  ) => Effect.Effect<Option.Option<WorkspaceScriptRun>, WorkspaceScriptStoreError>;
  readonly listRuns: (
    request: WorkspaceScriptListRequest,
  ) => Effect.Effect<ReadonlyArray<WorkspaceScriptRun>, WorkspaceScriptStoreError>;
  readonly recoverInterrupted: (
    input: WorkspaceScriptRecoveryInput,
  ) => Effect.Effect<ReadonlyArray<WorkspaceScriptRun>, WorkspaceScriptStoreError>;
}

export class WorkspaceScriptStore extends Context.Service<
  WorkspaceScriptStore,
  WorkspaceScriptStoreShape
>()("codework/persistence/Services/WorkspaceScriptStore") {}
