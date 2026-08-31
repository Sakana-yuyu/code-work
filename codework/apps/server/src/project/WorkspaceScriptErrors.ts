import { WorkspaceScriptRpcError } from "@codework/contracts";
import * as Data from "effect/Data";

import type { WorkspaceScriptStoreError } from "../persistence/Services/WorkspaceScriptStore.ts";

export class WorkspaceScriptDependencyError extends Data.TaggedError(
  "WorkspaceScriptDependencyError",
)<{
  readonly operation:
    | "resolveProject"
    | "resolveThread"
    | "runCommand"
    | "killTerminal"
    | "inspectTerminal"
    | "getHistory";
  readonly cause: unknown;
}> {}

export const detailFromUnknown = (cause: unknown): string => {
  if (cause instanceof WorkspaceScriptDependencyError) return detailFromUnknown(cause.cause);
  if (cause instanceof Error && cause.message.trim().length > 0) return cause.message.trim();
  const detail = String(cause).trim();
  return detail.length > 0 ? detail : "未知错误";
};

export const operationError = (
  code: string,
  detail: string,
  correlation: {
    readonly workspaceScriptRunId?: string;
    readonly expectedRevision?: number;
    readonly actualRevision?: number;
  } = {},
): WorkspaceScriptRpcError => new WorkspaceScriptRpcError({ code, detail, ...correlation });

export const persistenceError = (
  operation: string,
  cause: WorkspaceScriptStoreError,
  correlation: {
    readonly workspaceScriptRunId?: string;
    readonly expectedRevision?: number;
    readonly actualRevision?: number;
  } = {},
): WorkspaceScriptRpcError => {
  if (cause._tag === "WorkspaceScriptStoreDomainError") {
    if (cause.code === "workspace_script_run_not_found") {
      return operationError(cause.code, cause.detail, {
        ...correlation,
        ...(cause.workspaceScriptRunId === undefined
          ? {}
          : { workspaceScriptRunId: cause.workspaceScriptRunId }),
      });
    }
    if (cause.code === "workspace_script_revision_conflict") {
      return operationError(cause.code, cause.detail, {
        ...correlation,
        ...(cause.workspaceScriptRunId === undefined
          ? {}
          : { workspaceScriptRunId: cause.workspaceScriptRunId }),
        ...(cause.expectedRevision === undefined
          ? {}
          : { expectedRevision: cause.expectedRevision }),
        ...(cause.actualRevision === undefined ? {} : { actualRevision: cause.actualRevision }),
      });
    }
  }
  return operationError(
    "workspace_script_persistence_failed",
    `${operation}失败：${cause.message}`,
    correlation,
  );
};
