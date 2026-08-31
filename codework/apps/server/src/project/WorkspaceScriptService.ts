import * as NodeCrypto from "node:crypto";

import {
  ProjectId,
  ThreadId,
  WORKSPACE_SCRIPT_LOG_MAX_BYTES,
  type OrchestrationProjectShell,
  type TerminalEvent,
  type WorkspaceScriptListRequest,
  type WorkspaceScriptLogsResult,
  type WorkspaceScriptRun,
  type WorkspaceScriptStartRequest,
  type WorkspaceScriptStopRequest,
  WorkspaceScriptRpcError,
} from "@codework/contracts";
import { HostProcessPlatform } from "@codework/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  WorkspaceScriptStore,
  type StoredWorkspaceScriptRun,
  type WorkspaceScriptStoreShape,
  type WorkspaceScriptStopTransitionInput,
} from "../persistence/Services/WorkspaceScriptStore.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import { makeWorkspaceScriptTerminalOwner } from "../terminal/TerminalSessionOwnership.ts";
import {
  assessWorkspaceScriptStart,
  isWorkspaceScriptStartTerminationOperationId,
  makeWorkspaceScriptStartFailed,
  WORKSPACE_SCRIPT_START_FAILED_DETAIL,
} from "./WorkspaceScriptStartState.ts";
import {
  isFinishedWorkspaceScriptRun,
  makeWorkspaceScriptClosed,
  makeWorkspaceScriptExited,
} from "./WorkspaceScriptStopState.ts";
import { executeWorkspaceScriptStop } from "./WorkspaceScriptStopExecution.ts";
import {
  recoverWorkspaceScriptStop,
  type WorkspaceScriptStopRecoveryOutcome,
} from "./WorkspaceScriptStopRecovery.ts";
import {
  detailFromUnknown,
  operationError,
  persistenceError,
  WorkspaceScriptDependencyError,
} from "./WorkspaceScriptErrors.ts";
import { makeWorkspaceScriptStart } from "./WorkspaceScriptStartExecution.ts";
import type { WorkspaceScriptTerminalPort } from "./WorkspaceScriptTerminalPort.ts";

export { WorkspaceScriptDependencyError } from "./WorkspaceScriptErrors.ts";
export { workspaceScriptShellInvocation } from "./WorkspaceScriptStartExecution.ts";
export type {
  WorkspaceScriptTerminalPort,
  WorkspaceScriptTerminalRunCommandInput,
} from "./WorkspaceScriptTerminalPort.ts";

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
  readonly makeStopClaimOwnerId?: () => string;
  readonly stopClaimTtlMs?: number;
  readonly waitForStopClaimExpiry?: (retryAtUnixMs: number) => Effect.Effect<void>;
}

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

export const makeWorkspaceScriptService = Effect.fn("WorkspaceScriptService.make")(function* (
  options: WorkspaceScriptServiceOptions,
) {
  const serviceScope = yield* Effect.scope;
  const currentTimeMillis =
    options.now === undefined ? Clock.currentTimeMillis : Effect.sync(options.now);
  const makeStopClaimOwnerId = options.makeStopClaimOwnerId ?? NodeCrypto.randomUUID;
  const stopClaimTtlMs = options.stopClaimTtlMs ?? 30_000;

  const readRun = (workspaceScriptRunId: string) =>
    options.store
      .getRun(workspaceScriptRunId)
      .pipe(
        Effect.mapError((cause) =>
          persistenceError("读取 Workspace Script Run", cause, { workspaceScriptRunId }),
        ),
      );

  const getActiveRunByTerminal = (threadId: string, terminalId: string) =>
    options.store
      .getActiveRunByTerminal(threadId, terminalId)
      .pipe(
        Effect.mapError((cause) => persistenceError("读取终端对应的 Workspace Script Run", cause)),
      );

  const saveStopTransition = (input: WorkspaceScriptStopTransitionInput) =>
    options.store.saveStopTransition(input).pipe(
      Effect.mapError((cause) =>
        persistenceError("保存 Workspace Script 停止结果", cause, {
          workspaceScriptRunId: input.run.workspaceScriptRunId,
          expectedRevision: input.expectedRevision,
        }),
      ),
    );

  const makeStopClaimInput = Effect.fn("WorkspaceScriptService.makeStopClaimInput")(function* (
    run: WorkspaceScriptRun,
    _operationId: string,
  ) {
    const claimedAtUnixMs = Math.max(yield* currentTimeMillis, run.updatedAtUnixMs);
    const claimExpiresAtUnixMs = claimedAtUnixMs + stopClaimTtlMs;
    if (
      !Number.isSafeInteger(stopClaimTtlMs) ||
      stopClaimTtlMs <= 0 ||
      !Number.isSafeInteger(claimExpiresAtUnixMs)
    ) {
      return yield* operationError(
        "workspace_script_stop_claim_config_invalid",
        "Workspace Script 停止 claim 有效期配置无效。",
        { workspaceScriptRunId: run.workspaceScriptRunId },
      );
    }
    return {
      claimOwnerId: makeStopClaimOwnerId(),
      claimedAtUnixMs,
      claimExpiresAtUnixMs,
    };
  });

  const stopRecoveryOptions = {
    currentTimeMillis,
    getActiveRunByTerminal,
    readRun,
    makeStopClaimInput,
    claimStop: options.store.claimStop,
    saveStopTransition,
    terminal: options.terminal,
    retryDelayMillis: stopClaimTtlMs,
  } as const;

  const waitForStopClaimExpiry = (retryAtUnixMs: number) =>
    options.waitForStopClaimExpiry?.(retryAtUnixMs) ??
    currentTimeMillis.pipe(
      Effect.flatMap((nowUnixMs) => Effect.sleep(Math.max(0, retryAtUnixMs - nowUnixMs))),
    );

  const continueStopRecovery: (
    stored: StoredWorkspaceScriptRun,
    retryAtUnixMs: number,
  ) => Effect.Effect<void> = (stored, retryAtUnixMs) =>
    Effect.gen(function* () {
      yield* waitForStopClaimExpiry(retryAtUnixMs);
      const latestResult = yield* getActiveRunByTerminal(
        stored.run.threadId,
        stored.run.terminalId,
      ).pipe(Effect.result);
      if (latestResult._tag === "Failure") {
        const nowUnixMs = yield* currentTimeMillis;
        const nextRetryAt =
          stored.stopClaim !== null && stored.stopClaim.expiresAtUnixMs > nowUnixMs
            ? stored.stopClaim.expiresAtUnixMs
            : Math.max(nowUnixMs, stored.run.updatedAtUnixMs) + stopClaimTtlMs;
        yield* Effect.logWarning("Workspace Script 延迟停止恢复读取失败", {
          workspaceScriptRunId: stored.run.workspaceScriptRunId,
          retryAtUnixMs: nextRetryAt,
          cause: latestResult.failure,
        });
        yield* continueStopRecovery(stored, nextRetryAt);
        return;
      }
      const latest = latestResult.success;
      if (
        Option.isNone(latest) ||
        latest.value.run.workspaceScriptRunId !== stored.run.workspaceScriptRunId ||
        latest.value.stopOperationId !== stored.stopOperationId
      ) {
        return;
      }

      const outcomeResult = yield* recoverWorkspaceScriptStop(
        latest.value,
        stopRecoveryOptions,
      ).pipe(Effect.result);
      if (outcomeResult._tag === "Failure") {
        yield* Effect.logWarning("Workspace Script 延迟停止恢复失败", {
          workspaceScriptRunId: stored.run.workspaceScriptRunId,
          cause: outcomeResult.failure,
        });
        return;
      }
      if (outcomeResult.success._tag === "Deferred") {
        yield* continueStopRecovery(latest.value, outcomeResult.success.retryAtUnixMs);
      }
    });

  const scheduleStopRecovery = (
    stored: StoredWorkspaceScriptRun,
    outcome: WorkspaceScriptStopRecoveryOutcome,
  ) =>
    outcome._tag === "Completed"
      ? Effect.void
      : continueStopRecovery(stored, outcome.retryAtUnixMs).pipe(
          Effect.forkIn(serviceScope),
          Effect.asVoid,
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

  const rejectUnconfirmedStart = Effect.fn("WorkspaceScriptService.rejectUnconfirmedStart")(
    function* (workspaceScriptRunId: string, logContext: Readonly<Record<string, unknown>>) {
      yield* Effect.logError("Workspace Script 启动确认失败", {
        workspaceScriptRunId,
        ...logContext,
      });
      const failed = yield* updateRun(workspaceScriptRunId, (run, observedAtUnixMs) =>
        makeWorkspaceScriptStartFailed(run, observedAtUnixMs),
      );
      if (Option.isSome(failed) && failed.value.status !== "failed") {
        return failed.value;
      }
      return yield* operationError(
        "workspace_script_start_failed",
        (Option.isSome(failed) ? failed.value.errorDetail : null) ??
          WORKSPACE_SCRIPT_START_FAILED_DETAIL,
        { workspaceScriptRunId },
      );
    },
  );

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
      const startTerminationClaimed = isWorkspaceScriptStartTerminationOperationId(
        ownedRun.workspaceScriptRunId,
        owned.value.stopOperationId,
      );
      const stopClaimed = owned.value.stopOperationId !== null;

      switch (event.type) {
        case "started":
        case "restarted":
          return;
        case "exited":
          yield* updateRun(ownedRun.workspaceScriptRunId, (run, observedAtUnixMs) =>
            startTerminationClaimed && run.status === "starting"
              ? run
              : makeWorkspaceScriptExited({
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
            stopClaimed || run.status === "starting" || run.status === "stopping"
              ? run
              : isFinishedWorkspaceScriptRun(run)
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
            startTerminationClaimed && run.status === "starting"
              ? run
              : run.status === "starting"
                ? makeWorkspaceScriptStartFailed(run, observedAtUnixMs)
                : makeWorkspaceScriptClosed({
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

  /** 服务重启后按原 owner 回读终端回执：会话仍活跃则复活为 running，真实退出则收口为 exited。 */
  const reviveRecoveredRun = (stored: StoredWorkspaceScriptRun) =>
    Effect.gen(function* () {
      const run = stored.run;
      const receiptResult = yield* options.terminal
        .inspectSessionReceipt({
          threadId: run.threadId,
          terminalId: run.terminalId,
          expectedOwner: makeWorkspaceScriptTerminalOwner({
            workspaceScriptRunId: run.workspaceScriptRunId,
            generation: run.requestedAtUnixMs,
          }),
        })
        .pipe(Effect.result);
      if (receiptResult._tag === "Failure") return;
      const assessment = assessWorkspaceScriptStart(receiptResult.success);
      if (assessment._tag !== "Ready" && assessment._tag !== "Settled") return;
      const observedAtUnixMs = Math.max(yield* currentTimeMillis, run.updatedAtUnixMs);
      const revived: WorkspaceScriptRun =
        assessment._tag === "Ready"
          ? {
              ...run,
              status: "running",
              healthCheckedAtUnixMs: null,
              healthDetail: null,
              revision: run.revision + 1,
              startedAtUnixMs: run.startedAtUnixMs ?? observedAtUnixMs,
              finishedAtUnixMs: null,
              exitCode: null,
              exitSignal: null,
              errorCode: null,
              errorDetail: null,
              updatedAtUnixMs: observedAtUnixMs,
            }
          : {
              ...run,
              status: "exited",
              healthStatus: "unknown",
              healthCheckedAtUnixMs: null,
              healthDetail: null,
              revision: run.revision + 1,
              startedAtUnixMs: run.startedAtUnixMs ?? observedAtUnixMs,
              finishedAtUnixMs: observedAtUnixMs,
              exitCode: assessment.exitCode,
              exitSignal: assessment.exitSignal,
              errorCode: null,
              errorDetail: null,
              updatedAtUnixMs: observedAtUnixMs,
            };
      const saved = yield* options.store
        .saveTransition({ run: revived, expectedRevision: run.revision })
        .pipe(Effect.result);
      if (saved._tag === "Failure") {
        yield* Effect.logWarning("Workspace Script 重启恢复回写失败", {
          workspaceScriptRunId: run.workspaceScriptRunId,
          cause: saved.failure,
        });
      }
    });

  yield* Effect.forEach(
    recovered,
    (stored) =>
      Effect.gen(function* () {
        if (stored.stopOperationId === null) {
          yield* reviveRecoveredRun(stored);
          return;
        }
        const outcome = yield* recoverWorkspaceScriptStop(stored, stopRecoveryOptions);
        yield* scheduleStopRecovery(stored, outcome);
      }),
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

  const start: WorkspaceScriptServiceShape["start"] = makeWorkspaceScriptStart({
    store: options.store,
    terminal: options.terminal,
    resolveProject: options.resolveProject,
    resolveThreadProjectId: options.resolveThreadProjectId,
    platform: options.platform,
    ...(options.windowsComSpec === undefined ? {} : { windowsComSpec: options.windowsComSpec }),
    currentTimeMillis,
    readRun,
    getActiveRunByTerminal,
    updateRun,
    rejectUnconfirmedStart,
    makeStopClaimInput,
    saveStopTransition,
    recoverStop: (stored) => recoverWorkspaceScriptStop(stored, stopRecoveryOptions),
    scheduleStopRecovery,
  });

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

      const stopClaimInput = yield* makeStopClaimInput(current.value, input.operationId);
      const stopping: WorkspaceScriptRun = {
        ...current.value,
        ...(isFinishedWorkspaceScriptRun(current.value) ? {} : { status: "stopping" as const }),
        startedAtUnixMs: current.value.startedAtUnixMs ?? current.value.requestedAtUnixMs,
        revision: current.value.revision + 1,
        updatedAtUnixMs: stopClaimInput.claimedAtUnixMs,
      };
      const claim = yield* options.store
        .claimStop({
          run: stopping,
          operationId: input.operationId,
          expectedRevision: input.expectedRevision,
          ...stopClaimInput,
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
      if (!claim.claimed || isFinishedWorkspaceScriptRun(claim.run)) {
        if (!claim.claimed && claim.stopClaim !== null) {
          yield* scheduleStopRecovery(
            {
              run: claim.run,
              stopOperationId: input.operationId,
              stopClaim: claim.stopClaim,
            },
            { _tag: "Deferred", retryAtUnixMs: claim.stopClaim.expiresAtUnixMs },
          );
        }
        return claim.run;
      }
      if (claim.stopClaim === null) {
        return yield* operationError(
          "workspace_script_stop_claim_missing",
          "Workspace Script 停止执行缺少持久 claim。",
          { workspaceScriptRunId: input.workspaceScriptRunId },
        );
      }

      const outcome = yield* executeWorkspaceScriptStop({
        run: claim.run,
        stopOperationId: input.operationId,
        stopClaim: claim.stopClaim,
        currentTimeMillis,
        readRun,
        saveStopTransition,
        terminal: options.terminal,
      });
      if (outcome._tag === "Settled") return outcome.run;
      return yield* operationError(
        "workspace_script_stop_failed",
        outcome.killFailure === null
          ? "终端停止结果未获得同一 owner 会话的确定性退出回执。"
          : detailFromUnknown(outcome.killFailure),
        { workspaceScriptRunId: input.workspaceScriptRunId },
      );
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
      inspectSessionReceipt: (input) =>
        terminalManager
          .inspectSessionReceipt(input)
          .pipe(
            Effect.mapError(
              (cause) =>
                new WorkspaceScriptDependencyError({ operation: "inspectTerminal", cause }),
            ),
          ),
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
