import {
  makeWorkspaceScriptRunId,
  makeWorkspaceScriptRunIdempotencyKey,
  ProjectId,
  ThreadId,
  type OrchestrationProjectShell,
  type TerminalEvent,
  type TerminalOpenInput,
  type TerminalSessionSnapshot,
  type WorkspaceScriptListRequest,
  type WorkspaceScriptRun,
  type WorkspaceScriptStartRequest,
  type WorkspaceScriptStopRequest,
  WorkspaceScriptRpcError,
} from "@codework/contracts";
import { HostProcessPlatform } from "@codework/shared/hostProcess";
import { projectScriptCwd, projectScriptRuntimeEnv } from "@codework/shared/projectScripts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as TerminalManager from "../terminal/Manager.ts";

export type WorkspaceScriptTerminalRunCommandInput = TerminalOpenInput & {
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
};

export interface WorkspaceScriptTerminalPort {
  readonly runCommand: (
    input: WorkspaceScriptTerminalRunCommandInput,
  ) => Effect.Effect<TerminalSessionSnapshot, WorkspaceScriptDependencyError>;
  readonly kill: (input: {
    readonly threadId: string;
    readonly terminalId: string;
  }) => Effect.Effect<void, WorkspaceScriptDependencyError>;
  readonly subscribe: (
    listener: (event: TerminalEvent) => Effect.Effect<void>,
  ) => Effect.Effect<() => void>;
}

export interface WorkspaceScriptServiceShape {
  readonly start: (
    input: WorkspaceScriptStartRequest,
  ) => Effect.Effect<WorkspaceScriptRun, WorkspaceScriptRpcError>;
  readonly stop: (
    input: WorkspaceScriptStopRequest,
  ) => Effect.Effect<WorkspaceScriptRun, WorkspaceScriptRpcError>;
  readonly get: (workspaceScriptRunId: string) => Effect.Effect<Option.Option<WorkspaceScriptRun>>;
  readonly list: (
    input: WorkspaceScriptListRequest,
  ) => Effect.Effect<ReadonlyArray<WorkspaceScriptRun>>;
}

export class WorkspaceScriptService extends Context.Service<
  WorkspaceScriptService,
  WorkspaceScriptServiceShape
>()("codework/project/WorkspaceScriptService") {}

export class WorkspaceScriptDependencyError extends Data.TaggedError(
  "WorkspaceScriptDependencyError",
)<{
  readonly operation: "resolveProject" | "resolveThread" | "runCommand" | "killTerminal";
  readonly cause: unknown;
}> {}

export interface WorkspaceScriptServiceOptions {
  readonly terminal: WorkspaceScriptTerminalPort;
  readonly resolveProject: (
    projectId: string,
  ) => Effect.Effect<Option.Option<OrchestrationProjectShell>, WorkspaceScriptDependencyError>;
  readonly resolveThreadProjectId: (
    threadId: string,
  ) => Effect.Effect<Option.Option<string>, WorkspaceScriptDependencyError>;
  readonly platform: NodeJS.Platform;
  readonly windowsComSpec?: string;
  readonly now?: () => number;
}

type StartClaim =
  | { readonly type: "existing"; readonly run: WorkspaceScriptRun }
  | { readonly type: "claimed"; readonly run: WorkspaceScriptRun };

type StopClaim =
  | { readonly type: "existing"; readonly run: WorkspaceScriptRun }
  | { readonly type: "claimed"; readonly run: WorkspaceScriptRun };

const detailFromUnknown = (cause: unknown): string => {
  if (cause instanceof WorkspaceScriptDependencyError) return detailFromUnknown(cause.cause);
  if (cause instanceof Error && cause.message.trim().length > 0) return cause.message.trim();
  const detail = String(cause).trim();
  return detail.length > 0 ? detail : "未知错误";
};

const operationError = (
  code: string,
  detail: string,
  correlation: {
    readonly workspaceScriptRunId?: string;
    readonly expectedRevision?: number;
    readonly actualRevision?: number;
  } = {},
): WorkspaceScriptRpcError => new WorkspaceScriptRpcError({ code, detail, ...correlation });

const workspaceScriptTerminalId = (operationId: string): string =>
  `workspace-script-${operationId}`;

export const workspaceScriptShellInvocation = (input: {
  readonly platform: NodeJS.Platform;
  readonly command: string;
  readonly windowsComSpec?: string;
}): { readonly command: string; readonly args: ReadonlyArray<string> } =>
  input.platform === "win32"
    ? {
        command: input.windowsComSpec?.trim() || process.env.ComSpec?.trim() || "cmd.exe",
        args: ["/d", "/s", "/c", input.command],
      }
    : {
        command: "/bin/sh",
        args: ["-lc", input.command],
      };

const isFinished = (run: WorkspaceScriptRun): boolean =>
  run.status === "stopped" || run.status === "exited" || run.status === "failed";

export const makeWorkspaceScriptService = Effect.fn("WorkspaceScriptService.make")(function* (
  options: WorkspaceScriptServiceOptions,
) {
  const runs = new Map<string, WorkspaceScriptRun>();
  const stopOperations = new Map<string, string>();
  const now = options.now ?? Date.now;

  const updateRun = (
    workspaceScriptRunId: string,
    update: (run: WorkspaceScriptRun, observedAtUnixMs: number) => WorkspaceScriptRun,
  ): WorkspaceScriptRun | undefined => {
    const current = runs.get(workspaceScriptRunId);
    if (current === undefined) return undefined;
    const next = update(current, Math.max(now(), current.updatedAtUnixMs));
    runs.set(workspaceScriptRunId, next);
    return next;
  };

  const runForTerminal = (threadId: string, terminalId: string): WorkspaceScriptRun | undefined =>
    [...runs.values()].find((run) => run.threadId === threadId && run.terminalId === terminalId);

  const onTerminalEvent = (event: TerminalEvent): Effect.Effect<void> =>
    Effect.sync(() => {
      const owned = runForTerminal(event.threadId, event.terminalId);
      if (owned === undefined || isFinished(owned)) return;

      switch (event.type) {
        case "started":
        case "restarted":
          updateRun(owned.workspaceScriptRunId, (run, observedAtUnixMs) =>
            run.status !== "starting"
              ? run
              : {
                  ...run,
                  status: "running",
                  revision: run.revision + 1,
                  startedAtUnixMs: observedAtUnixMs,
                  updatedAtUnixMs: observedAtUnixMs,
                },
          );
          return;
        case "exited":
          updateRun(owned.workspaceScriptRunId, (run, observedAtUnixMs) => ({
            ...run,
            status: run.status === "stopping" ? "stopped" : "exited",
            healthStatus: "unknown",
            healthCheckedAtUnixMs: null,
            healthDetail: null,
            revision: run.revision + 1,
            startedAtUnixMs: run.startedAtUnixMs ?? observedAtUnixMs,
            finishedAtUnixMs: observedAtUnixMs,
            exitCode: event.exitCode,
            exitSignal: event.exitSignal,
            updatedAtUnixMs: observedAtUnixMs,
          }));
          return;
        case "error":
          updateRun(owned.workspaceScriptRunId, (run, observedAtUnixMs) => ({
            ...run,
            status: "failed",
            healthStatus: "unknown",
            healthCheckedAtUnixMs: null,
            healthDetail: null,
            revision: run.revision + 1,
            finishedAtUnixMs: observedAtUnixMs,
            errorCode: "workspace_script_terminal_error",
            errorDetail: event.message,
            updatedAtUnixMs: observedAtUnixMs,
          }));
          return;
        case "closed":
          updateRun(owned.workspaceScriptRunId, (run, observedAtUnixMs) => ({
            ...run,
            status: run.status === "stopping" ? "stopped" : "failed",
            healthStatus: "unknown",
            healthCheckedAtUnixMs: null,
            healthDetail: null,
            revision: run.revision + 1,
            finishedAtUnixMs: observedAtUnixMs,
            ...(run.status === "stopping"
              ? {}
              : {
                  errorCode: "workspace_script_terminal_closed",
                  errorDetail: "受监督终端在脚本完成前被关闭。",
                }),
            updatedAtUnixMs: observedAtUnixMs,
          }));
          return;
        case "activity":
        case "cleared":
        case "output":
          return;
      }
    });

  const unsubscribe = yield* options.terminal.subscribe(onTerminalEvent);
  yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

  const get: WorkspaceScriptServiceShape["get"] = (workspaceScriptRunId) =>
    Effect.sync(() => Option.fromNullishOr(runs.get(workspaceScriptRunId)));

  const list: WorkspaceScriptServiceShape["list"] = (input) =>
    Effect.sync(() =>
      [...runs.values()]
        .filter(
          (run) =>
            (input.projectId === undefined || run.projectId === input.projectId) &&
            (input.threadId === undefined || run.threadId === input.threadId) &&
            (input.statuses === undefined || input.statuses.includes(run.status)),
        )
        .toSorted(
          (left, right) =>
            right.requestedAtUnixMs - left.requestedAtUnixMs ||
            left.workspaceScriptRunId.localeCompare(right.workspaceScriptRunId),
        ),
    );

  const start: WorkspaceScriptServiceShape["start"] = Effect.fn("WorkspaceScriptService.start")(
    function* (input) {
      const workspaceScriptRunId = makeWorkspaceScriptRunId(input.operationId);
      const idempotencyKey = makeWorkspaceScriptRunIdempotencyKey(input);
      const earlyExisting = runs.get(workspaceScriptRunId);
      if (earlyExisting !== undefined) {
        if (earlyExisting.idempotencyKey !== idempotencyKey) {
          return yield* operationError(
            "workspace_script_idempotency_conflict",
            "同一 operationId 已绑定到其他项目、线程或脚本。",
            { workspaceScriptRunId },
          );
        }
        return earlyExisting;
      }

      const projectResult = yield* options.resolveProject(input.projectId).pipe(Effect.result);
      if (projectResult._tag === "Failure") {
        return yield* operationError(
          "workspace_script_project_lookup_failed",
          detailFromUnknown(projectResult.failure),
          { workspaceScriptRunId },
        );
      }
      if (Option.isNone(projectResult.success)) {
        return yield* operationError(
          "workspace_script_project_not_found",
          `项目不存在：${input.projectId}`,
          { workspaceScriptRunId },
        );
      }

      const threadProjectResult = yield* options
        .resolveThreadProjectId(input.threadId)
        .pipe(Effect.result);
      if (threadProjectResult._tag === "Failure") {
        return yield* operationError(
          "workspace_script_thread_lookup_failed",
          detailFromUnknown(threadProjectResult.failure),
          { workspaceScriptRunId },
        );
      }
      if (
        Option.isNone(threadProjectResult.success) ||
        threadProjectResult.success.value !== input.projectId
      ) {
        return yield* operationError(
          "workspace_script_thread_project_mismatch",
          "线程不存在，或不属于请求中的项目。",
          { workspaceScriptRunId },
        );
      }

      const project = projectResult.success.value;
      const script = project.scripts.find((candidate) => candidate.id === input.scriptId);
      if (script === undefined) {
        return yield* operationError(
          "workspace_script_not_found",
          `项目 ${input.projectId} 中不存在脚本 ${input.scriptId}。`,
          { workspaceScriptRunId },
        );
      }

      const worktreePath = input.worktreePath ?? null;
      const cwd = projectScriptCwd({ project: { cwd: project.workspaceRoot }, worktreePath });
      const requestedAtUnixMs = now();
      const starting: WorkspaceScriptRun = {
        workspaceScriptRunId,
        idempotencyKey,
        projectId: input.projectId,
        threadId: input.threadId,
        scriptId: script.id,
        scriptName: script.name,
        terminalId: workspaceScriptTerminalId(input.operationId),
        cwd,
        worktreePath,
        status: "starting",
        healthStatus: "unknown",
        healthCheckedAtUnixMs: null,
        healthDetail: null,
        ports: [],
        revision: 1,
        requestedAtUnixMs,
        startedAtUnixMs: null,
        finishedAtUnixMs: null,
        exitCode: null,
        exitSignal: null,
        errorCode: null,
        errorDetail: null,
        compositionTaskId: input.compositionTaskId ?? null,
        compositionRunId: input.compositionRunId ?? null,
        updatedAtUnixMs: requestedAtUnixMs,
      };

      const claim: StartClaim = (() => {
        const current = runs.get(workspaceScriptRunId);
        if (current !== undefined) return { type: "existing", run: current };
        runs.set(workspaceScriptRunId, starting);
        return { type: "claimed", run: starting };
      })();
      if (claim.type === "existing") {
        if (claim.run.idempotencyKey !== idempotencyKey) {
          return yield* operationError(
            "workspace_script_idempotency_conflict",
            "同一 operationId 已绑定到其他项目、线程或脚本。",
            { workspaceScriptRunId },
          );
        }
        return claim.run;
      }

      const invocation = workspaceScriptShellInvocation({
        platform: options.platform,
        command: script.command,
        ...(options.windowsComSpec === undefined ? {} : { windowsComSpec: options.windowsComSpec }),
      });
      const startResult = yield* options.terminal
        .runCommand({
          threadId: input.threadId,
          terminalId: starting.terminalId,
          cwd,
          ...(worktreePath === null ? {} : { worktreePath }),
          env: projectScriptRuntimeEnv({
            project: { cwd: project.workspaceRoot },
            worktreePath,
          }),
          ...invocation,
        })
        .pipe(Effect.result);

      if (startResult._tag === "Failure") {
        const failed = updateRun(workspaceScriptRunId, (run, observedAtUnixMs) =>
          isFinished(run)
            ? run
            : {
                ...run,
                status: "failed",
                revision: run.revision + 1,
                finishedAtUnixMs: observedAtUnixMs,
                errorCode: "workspace_script_start_failed",
                errorDetail: detailFromUnknown(startResult.failure),
                updatedAtUnixMs: observedAtUnixMs,
              },
        );
        return yield* operationError(
          "workspace_script_start_failed",
          failed?.errorDetail ?? detailFromUnknown(startResult.failure),
          { workspaceScriptRunId },
        );
      }

      return (
        updateRun(workspaceScriptRunId, (run, observedAtUnixMs) =>
          run.status !== "starting"
            ? run
            : {
                ...run,
                status: "running",
                revision: run.revision + 1,
                startedAtUnixMs: observedAtUnixMs,
                updatedAtUnixMs: observedAtUnixMs,
              },
        ) ?? claim.run
      );
    },
  );

  const stop: WorkspaceScriptServiceShape["stop"] = Effect.fn("WorkspaceScriptService.stop")(
    function* (input) {
      const existingOperationRunId = stopOperations.get(input.operationId);
      if (existingOperationRunId !== undefined) {
        if (existingOperationRunId !== input.workspaceScriptRunId) {
          return yield* operationError(
            "workspace_script_stop_idempotency_conflict",
            "同一停止 operationId 已绑定到其他 Workspace Script Run。",
            { workspaceScriptRunId: input.workspaceScriptRunId },
          );
        }
        const existing = runs.get(existingOperationRunId);
        if (existing === undefined) {
          return yield* operationError(
            "workspace_script_run_not_found",
            `Workspace Script Run 不存在：${existingOperationRunId}`,
            { workspaceScriptRunId: existingOperationRunId },
          );
        }
        return existing;
      }

      const current = runs.get(input.workspaceScriptRunId);
      if (current === undefined) {
        return yield* operationError(
          "workspace_script_run_not_found",
          `Workspace Script Run 不存在：${input.workspaceScriptRunId}`,
          { workspaceScriptRunId: input.workspaceScriptRunId },
        );
      }
      if (current.revision !== input.expectedRevision) {
        return yield* operationError(
          "workspace_script_revision_conflict",
          "Workspace Script Run revision 已变化，请刷新后重试。",
          {
            workspaceScriptRunId: input.workspaceScriptRunId,
            expectedRevision: input.expectedRevision,
            actualRevision: current.revision,
          },
        );
      }

      stopOperations.set(input.operationId, input.workspaceScriptRunId);
      if (isFinished(current)) return current;

      const stopping: WorkspaceScriptRun = {
        ...current,
        status: "stopping",
        revision: current.revision + 1,
        updatedAtUnixMs: Math.max(now(), current.updatedAtUnixMs),
      };
      runs.set(input.workspaceScriptRunId, stopping);

      const killResult = yield* options.terminal
        .kill({ threadId: stopping.threadId, terminalId: stopping.terminalId })
        .pipe(Effect.result);
      if (killResult._tag === "Failure") {
        const failed = updateRun(input.workspaceScriptRunId, (run, observedAtUnixMs) =>
          isFinished(run)
            ? run
            : {
                ...run,
                status: "failed",
                revision: run.revision + 1,
                finishedAtUnixMs: observedAtUnixMs,
                errorCode: "workspace_script_stop_failed",
                errorDetail: detailFromUnknown(killResult.failure),
                updatedAtUnixMs: observedAtUnixMs,
              },
        );
        return yield* operationError(
          "workspace_script_stop_failed",
          failed?.errorDetail ?? detailFromUnknown(killResult.failure),
          { workspaceScriptRunId: input.workspaceScriptRunId },
        );
      }

      return runs.get(input.workspaceScriptRunId) ?? stopping;
    },
  );

  return WorkspaceScriptService.of({ start, stop, get, list });
});

export const make = Effect.gen(function* () {
  const terminalManager = yield* TerminalManager.TerminalManager;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const platform = yield* HostProcessPlatform;
  return yield* makeWorkspaceScriptService({
    terminal: {
      runCommand: (input) =>
        terminalManager
          .runCommand(input)
          .pipe(
            Effect.mapError(
              (cause) => new WorkspaceScriptDependencyError({ operation: "runCommand", cause }),
            ),
          ),
      kill: (input) =>
        terminalManager
          .kill(input)
          .pipe(
            Effect.mapError(
              (cause) => new WorkspaceScriptDependencyError({ operation: "killTerminal", cause }),
            ),
          ),
      subscribe: terminalManager.subscribe,
    },
    resolveProject: (projectId) =>
      projectionSnapshotQuery
        .getProjectShellById(ProjectId.make(projectId))
        .pipe(
          Effect.mapError(
            (cause) => new WorkspaceScriptDependencyError({ operation: "resolveProject", cause }),
          ),
        ),
    resolveThreadProjectId: (threadId) =>
      projectionSnapshotQuery.getThreadShellById(ThreadId.make(threadId)).pipe(
        Effect.map(Option.map((thread) => String(thread.projectId))),
        Effect.mapError(
          (cause) => new WorkspaceScriptDependencyError({ operation: "resolveThread", cause }),
        ),
      ),
    platform,
  });
});

export const layer = Layer.effect(WorkspaceScriptService, make);
