import {
  makeWorkspaceScriptRunId,
  makeWorkspaceScriptRunIdempotencyKey,
  ProjectId,
  ThreadId,
  WORKSPACE_SCRIPT_LOG_MAX_BYTES,
  type OrchestrationProjectShell,
  type TerminalEvent,
  type TerminalOpenInput,
  type TerminalSessionSnapshot,
  type WorkspaceScriptListRequest,
  type WorkspaceScriptLogsResult,
  type WorkspaceScriptRun,
  type WorkspaceScriptStartRequest,
  type WorkspaceScriptStopRequest,
  WorkspaceScriptRpcError,
} from "@codework/contracts";
import { HostProcessPlatform } from "@codework/shared/hostProcess";
import { projectScriptCwd, projectScriptRuntimeEnv } from "@codework/shared/projectScripts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  WorkspaceScriptStore,
  type WorkspaceScriptStoreError,
  type WorkspaceScriptStoreShape,
} from "../persistence/Services/WorkspaceScriptStore.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import {
  isFinishedWorkspaceScriptRun,
  makeWorkspaceScriptClosed,
  makeWorkspaceScriptExited,
  makeWorkspaceScriptStopping,
  makeWorkspaceScriptStopRetryable,
} from "./WorkspaceScriptStopState.ts";
import {
  settleRecoveredWorkspaceScriptStop,
  type WorkspaceScriptTerminalInspection,
} from "./WorkspaceScriptTerminalRecovery.ts";

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
  readonly inspectSession: (input: {
    readonly threadId: string;
    readonly terminalId: string;
  }) => Effect.Effect<WorkspaceScriptTerminalInspection>;
  readonly getHistory: (input: {
    readonly threadId: string;
    readonly terminalId: string;
  }) => Effect.Effect<string, WorkspaceScriptDependencyError>;
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
  readonly get: (
    workspaceScriptRunId: string,
  ) => Effect.Effect<Option.Option<WorkspaceScriptRun>, WorkspaceScriptRpcError>;
  readonly list: (
    input: WorkspaceScriptListRequest,
  ) => Effect.Effect<ReadonlyArray<WorkspaceScriptRun>, WorkspaceScriptRpcError>;
  readonly getLogs: (
    workspaceScriptRunId: string,
  ) => Effect.Effect<WorkspaceScriptLogsResult, WorkspaceScriptRpcError>;
}

export class WorkspaceScriptService extends Context.Service<
  WorkspaceScriptService,
  WorkspaceScriptServiceShape
>()("codework/project/WorkspaceScriptService") {}

export class WorkspaceScriptDependencyError extends Data.TaggedError(
  "WorkspaceScriptDependencyError",
)<{
  readonly operation:
    | "resolveProject"
    | "resolveThread"
    | "runCommand"
    | "killTerminal"
    | "getHistory";
  readonly cause: unknown;
}> {}

export interface WorkspaceScriptServiceOptions {
  readonly store: WorkspaceScriptStoreShape;
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

const capWorkspaceScriptHistory = (
  history: string,
): Pick<WorkspaceScriptLogsResult, "history" | "truncated"> => {
  const bytes = Buffer.from(history, "utf8");
  if (bytes.length <= WORKSPACE_SCRIPT_LOG_MAX_BYTES) {
    return { history, truncated: false };
  }

  let start = bytes.length - WORKSPACE_SCRIPT_LOG_MAX_BYTES;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) {
    start += 1;
  }
  return {
    history: bytes.subarray(start).toString("utf8"),
    truncated: true,
  };
};

const persistenceError = (
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

export const makeWorkspaceScriptService = Effect.fn("WorkspaceScriptService.make")(function* (
  options: WorkspaceScriptServiceOptions,
) {
  const currentTimeMillis =
    options.now === undefined ? Clock.currentTimeMillis : Effect.sync(options.now);

  const readRun = (workspaceScriptRunId: string) =>
    options.store
      .getRun(workspaceScriptRunId)
      .pipe(
        Effect.mapError((cause) =>
          persistenceError("读取 Workspace Script Run", cause, { workspaceScriptRunId }),
        ),
      );

  const updateRun = Effect.fn("WorkspaceScriptService.updateRun")(function* (
    workspaceScriptRunId: string,
    update: (run: WorkspaceScriptRun, observedAtUnixMs: number) => WorkspaceScriptRun,
  ) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = yield* readRun(workspaceScriptRunId);
      if (Option.isNone(current)) return Option.none<WorkspaceScriptRun>();
      const next = update(
        current.value,
        Math.max(yield* currentTimeMillis, current.value.updatedAtUnixMs),
      );
      if (next === current.value || next.revision === current.value.revision) {
        return Option.some(current.value);
      }

      const saved = yield* options.store
        .saveTransition({ run: next, expectedRevision: current.value.revision })
        .pipe(Effect.result);
      if (saved._tag === "Success") return Option.some(saved.success);
      if (
        saved.failure._tag === "WorkspaceScriptStoreDomainError" &&
        saved.failure.code === "workspace_script_revision_conflict" &&
        attempt < 2
      ) {
        continue;
      }
      return yield* persistenceError("更新 Workspace Script Run", saved.failure, {
        workspaceScriptRunId,
        expectedRevision: current.value.revision,
      });
    }
    return Option.none<WorkspaceScriptRun>();
  });

  const onTerminalEvent = (event: TerminalEvent): Effect.Effect<void> =>
    Effect.gen(function* () {
      const owned = yield* options.store
        .getActiveRunByTerminal(event.threadId, event.terminalId)
        .pipe(
          Effect.mapError((cause) =>
            persistenceError("定位终端对应的 Workspace Script Run", cause),
          ),
        );
      if (Option.isNone(owned)) return;
      const ownedRun = owned.value.run;

      switch (event.type) {
        case "started":
        case "restarted":
          yield* updateRun(ownedRun.workspaceScriptRunId, (run, observedAtUnixMs) =>
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
          yield* updateRun(ownedRun.workspaceScriptRunId, (run, observedAtUnixMs) =>
            makeWorkspaceScriptExited({
              run,
              stopOperationId: owned.value.stopOperationId,
              observedAtUnixMs,
              exitCode: event.exitCode,
              exitSignal: event.exitSignal,
            }),
          );
          return;
        case "error":
          yield* updateRun(ownedRun.workspaceScriptRunId, (run, observedAtUnixMs) =>
            isFinishedWorkspaceScriptRun(run)
              ? run
              : {
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
                },
          );
          return;
        case "closed":
          yield* updateRun(ownedRun.workspaceScriptRunId, (run, observedAtUnixMs) =>
            makeWorkspaceScriptClosed({
              run,
              stopOperationId: owned.value.stopOperationId,
              observedAtUnixMs,
            }),
          );
          return;
        case "activity":
        case "cleared":
        case "output":
          return;
      }
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning(`Workspace Script 终端事件持久化失败：${cause.message}`),
      ),
    );

  const unsubscribe = yield* options.terminal.subscribe(onTerminalEvent);
  yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

  const recovered = yield* options.store
    .recoverInterrupted({ observedAtUnixMs: yield* currentTimeMillis })
    .pipe(Effect.mapError((cause) => persistenceError("恢复中断的 Workspace Script Run", cause)));
  yield* Effect.forEach(
    recovered,
    (stored) => {
      const stopOperationId = stored.stopOperationId;
      if (stopOperationId === null) return Effect.void;
      return Effect.gen(function* () {
        const inspection = yield* options.terminal.inspectSession({
          threadId: stored.run.threadId,
          terminalId: stored.run.terminalId,
        });
        yield* updateRun(stored.run.workspaceScriptRunId, (run, observedAtUnixMs) =>
          settleRecoveredWorkspaceScriptStop({
            run,
            stopOperationId,
            inspection,
            observedAtUnixMs,
          }),
        );
      });
    },
    { discard: true },
  );

  const get: WorkspaceScriptServiceShape["get"] = readRun;

  const list: WorkspaceScriptServiceShape["list"] = (input) =>
    options.store
      .listRuns(input)
      .pipe(Effect.mapError((cause) => persistenceError("查询 Workspace Script Run", cause)));

  const getLogs: WorkspaceScriptServiceShape["getLogs"] = Effect.fn(
    "WorkspaceScriptService.getLogs",
  )(function* (workspaceScriptRunId) {
    const run = yield* readRun(workspaceScriptRunId);
    if (Option.isNone(run)) {
      return yield* operationError(
        "workspace_script_run_not_found",
        "Workspace Script 运行记录不存在。",
        { workspaceScriptRunId },
      );
    }

    const history = yield* options.terminal
      .getHistory({
        threadId: run.value.threadId,
        terminalId: run.value.terminalId,
      })
      .pipe(
        Effect.mapError(() =>
          operationError("workspace_script_logs_failed", "读取 Workspace Script 日志失败。", {
            workspaceScriptRunId,
          }),
        ),
      );
    const capped = capWorkspaceScriptHistory(history);
    return {
      workspaceScriptRunId,
      terminalId: run.value.terminalId,
      ...capped,
    } satisfies WorkspaceScriptLogsResult;
  });

  const start: WorkspaceScriptServiceShape["start"] = Effect.fn("WorkspaceScriptService.start")(
    function* (input) {
      const workspaceScriptRunId = makeWorkspaceScriptRunId(input.operationId);
      const idempotencyKey = makeWorkspaceScriptRunIdempotencyKey(input);
      const earlyExisting = yield* readRun(workspaceScriptRunId);
      if (Option.isSome(earlyExisting)) {
        if (
          earlyExisting.value.idempotencyKey !== idempotencyKey ||
          earlyExisting.value.worktreePath !== (input.worktreePath ?? null) ||
          earlyExisting.value.compositionTaskId !== (input.compositionTaskId ?? null) ||
          earlyExisting.value.compositionRunId !== (input.compositionRunId ?? null)
        ) {
          return yield* operationError(
            "workspace_script_idempotency_conflict",
            "同一 operationId 已绑定到其他项目、线程或脚本。",
            { workspaceScriptRunId },
          );
        }
        return earlyExisting.value;
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
      const requestedAtUnixMs = yield* currentTimeMillis;
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

      const claim = yield* options.store
        .claimStart(starting)
        .pipe(
          Effect.mapError((cause) =>
            cause._tag === "WorkspaceScriptStoreDomainError" &&
            cause.code === "workspace_script_run_conflict"
              ? operationError(
                  "workspace_script_idempotency_conflict",
                  "同一 operationId 已绑定到其他项目、线程或脚本。",
                  { workspaceScriptRunId },
                )
              : persistenceError("领取 Workspace Script 启动", cause, { workspaceScriptRunId }),
          ),
        );
      if (!claim.claimed) return claim.run;

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
        const failed = yield* updateRun(workspaceScriptRunId, (run, observedAtUnixMs) =>
          isFinishedWorkspaceScriptRun(run)
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
          (Option.isSome(failed) ? failed.value.errorDetail : null) ??
            detailFromUnknown(startResult.failure),
          { workspaceScriptRunId },
        );
      }

      const running = yield* updateRun(workspaceScriptRunId, (run, observedAtUnixMs) =>
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
      return Option.getOrElse(running, () => claim.run);
    },
  );

  const stop: WorkspaceScriptServiceShape["stop"] = Effect.fn("WorkspaceScriptService.stop")(
    function* (input) {
      const current = yield* readRun(input.workspaceScriptRunId);
      if (Option.isNone(current)) {
        return yield* operationError(
          "workspace_script_run_not_found",
          `Workspace Script Run 不存在：${input.workspaceScriptRunId}`,
          { workspaceScriptRunId: input.workspaceScriptRunId },
        );
      }

      const stopping = makeWorkspaceScriptStopping(
        current.value,
        Math.max(yield* currentTimeMillis, current.value.updatedAtUnixMs),
      );
      const claim = yield* options.store
        .claimStop({
          run: stopping,
          operationId: input.operationId,
          expectedRevision: input.expectedRevision,
        })
        .pipe(
          Effect.mapError((cause) =>
            cause._tag === "WorkspaceScriptStoreDomainError" &&
            (cause.code === "workspace_script_stop_operation_conflict" ||
              cause.code === "workspace_script_run_conflict")
              ? operationError("workspace_script_stop_idempotency_conflict", cause.detail, {
                  workspaceScriptRunId: input.workspaceScriptRunId,
                })
              : persistenceError("领取 Workspace Script 停止", cause, {
                  workspaceScriptRunId: input.workspaceScriptRunId,
                  expectedRevision: input.expectedRevision,
                }),
          ),
        );
      if (!claim.claimed || isFinishedWorkspaceScriptRun(claim.run)) return claim.run;

      const killResult = yield* options.terminal
        .kill({ threadId: claim.run.threadId, terminalId: claim.run.terminalId })
        .pipe(Effect.result);
      if (killResult._tag === "Failure") {
        yield* updateRun(input.workspaceScriptRunId, (run, observedAtUnixMs) =>
          makeWorkspaceScriptStopRetryable(run, observedAtUnixMs),
        );
        return yield* operationError(
          "workspace_script_stop_failed",
          detailFromUnknown(killResult.failure),
          { workspaceScriptRunId: input.workspaceScriptRunId },
        );
      }

      const inspection = yield* options.terminal.inspectSession({
        threadId: claim.run.threadId,
        terminalId: claim.run.terminalId,
      });
      if (inspection === "active") {
        yield* updateRun(input.workspaceScriptRunId, (run, observedAtUnixMs) =>
          makeWorkspaceScriptStopRetryable(run, observedAtUnixMs),
        );
        return yield* operationError(
          "workspace_script_stop_failed",
          "终端停止调用返回后仍检测到活动进程。",
          { workspaceScriptRunId: input.workspaceScriptRunId },
        );
      }

      const stopped = yield* updateRun(input.workspaceScriptRunId, (run, observedAtUnixMs) =>
        makeWorkspaceScriptExited({
          run,
          stopOperationId: input.operationId,
          observedAtUnixMs,
          exitCode: null,
          exitSignal: null,
        }),
      );
      return Option.getOrElse(stopped, () => claim.run);
    },
  );

  return WorkspaceScriptService.of({ start, stop, get, list, getLogs });
});

export const make = Effect.gen(function* () {
  const store = yield* WorkspaceScriptStore;
  const terminalManager = yield* TerminalManager.TerminalManager;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const platform = yield* HostProcessPlatform;
  return yield* makeWorkspaceScriptService({
    store,
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
      inspectSession: terminalManager.inspectSession,
      getHistory: (input) =>
        terminalManager
          .getHistory(input)
          .pipe(
            Effect.mapError(
              (cause) => new WorkspaceScriptDependencyError({ operation: "getHistory", cause }),
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
