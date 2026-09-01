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
  "workspace_script_recovery_time_invalid",
  "workspace_script_stop_operation_conflict",
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

export interface WorkspaceScriptStopClaim {
  readonly ownerId: string;
  readonly epoch: number;
  readonly expiresAtUnixMs: number;
}

export interface WorkspaceScriptStopClaimResult extends WorkspaceScriptRunClaimResult {
  readonly stopClaim: WorkspaceScriptStopClaim | null;
}

export interface StoredWorkspaceScriptRun {
  readonly run: WorkspaceScriptRun;
  readonly stopOperationId: string | null;
  readonly stopClaim: WorkspaceScriptStopClaim | null;
}

export interface WorkspaceScriptRunTransitionInput {
  readonly run: WorkspaceScriptRun;
  readonly expectedRevision: number;
}

export interface WorkspaceScriptStopClaimInput extends WorkspaceScriptRunTransitionInput {
  readonly operationId: string;
  readonly claimOwnerId: string;
  readonly claimedAtUnixMs: number;
  readonly claimExpiresAtUnixMs: number;
}

export interface WorkspaceScriptStopTransitionInput extends WorkspaceScriptRunTransitionInput {
  readonly operationId: string;
  readonly claimOwnerId: string;
  readonly claimEpoch: number;
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
  ) => Effect.Effect<WorkspaceScriptStopClaimResult, WorkspaceScriptStoreError>;
  readonly saveStopTransition: (
    input: WorkspaceScriptStopTransitionInput,
  ) => Effect.Effect<Option.Option<WorkspaceScriptRun>, WorkspaceScriptStoreError>;
  readonly getRun: (
    workspaceScriptRunId: string,
  ) => Effect.Effect<Option.Option<WorkspaceScriptRun>, WorkspaceScriptStoreError>;
  /** 仅服务端协调路径读取 stop operation；RPC 投影仍只暴露 Run。 */
  readonly getStoredRun: (
    workspaceScriptRunId: string,
  ) => Effect.Effect<Option.Option<StoredWorkspaceScriptRun>, WorkspaceScriptStoreError>;
  readonly getActiveRunByTerminal: (
    threadId: string,
    terminalId: string,
  ) => Effect.Effect<Option.Option<StoredWorkspaceScriptRun>, WorkspaceScriptStoreError>;
  readonly listRuns: (
    request: WorkspaceScriptListRequest,
  ) => Effect.Effect<ReadonlyArray<WorkspaceScriptRun>, WorkspaceScriptStoreError>;
  readonly recoverInterrupted: (
    input: WorkspaceScriptRecoveryInput,
  ) => Effect.Effect<ReadonlyArray<StoredWorkspaceScriptRun>, WorkspaceScriptStoreError>;
}

export class WorkspaceScriptStore extends Context.Service<
  WorkspaceScriptStore,
  WorkspaceScriptStoreShape
>()("codework/persistence/Services/WorkspaceScriptStore") {}
