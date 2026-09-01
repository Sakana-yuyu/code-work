import {
  makeWorkspaceScriptRunId,
  makeWorkspaceScriptRunIdempotencyKey,
  type OrchestrationProjectShell,
  TerminalSessionOwnershipError,
  type WorkspaceScriptRpcError,
  type WorkspaceScriptRun,
  type WorkspaceScriptStartRequest,
} from "@codework/contracts";
import { projectScriptCwd, projectScriptRuntimeEnv } from "@codework/shared/projectScripts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type {
  StoredWorkspaceScriptRun,
  WorkspaceScriptStopClaimInput,
  WorkspaceScriptStopTransitionInput,
  WorkspaceScriptStoreShape,
} from "../persistence/Services/WorkspaceScriptStore.ts";
import { makeWorkspaceScriptTerminalOwner } from "../terminal/TerminalSessionOwnership.ts";
import {
  detailFromUnknown,
  operationError,
  persistenceError,
  type WorkspaceScriptDependencyError,
} from "./WorkspaceScriptErrors.ts";
import {
  assessWorkspaceScriptStart,
  makeWorkspaceScriptStartFailed,
  makeWorkspaceScriptStartTerminationOperationId,
  makeWorkspaceScriptStartTerminationRetryable,
  WORKSPACE_SCRIPT_START_FAILED_DETAIL,
} from "./WorkspaceScriptStartState.ts";
import { executeWorkspaceScriptStop } from "./WorkspaceScriptStopExecution.ts";
import type { WorkspaceScriptStopRecoveryOutcome } from "./WorkspaceScriptStopRecovery.ts";
import {
  isFinishedWorkspaceScriptRun,
  makeWorkspaceScriptExited,
} from "./WorkspaceScriptStopState.ts";
import type { WorkspaceScriptTerminalPort } from "./WorkspaceScriptTerminalPort.ts";

interface WorkspaceScriptStartExecutionOptions {
  readonly store: Pick<WorkspaceScriptStoreShape, "claimStart" | "claimStop" | "saveTransition">;
  readonly terminal: Pick<
    WorkspaceScriptTerminalPort,
    "runCommand" | "kill" | "inspectSessionReceipt"
  >;
  readonly resolveProject: (
    projectId: string,
  ) => Effect.Effect<Option.Option<OrchestrationProjectShell>, WorkspaceScriptDependencyError>;
  readonly resolveThreadProjectId: (
    threadId: string,
  ) => Effect.Effect<Option.Option<string>, WorkspaceScriptDependencyError>;
  readonly platform: NodeJS.Platform;
  readonly windowsComSpec?: string;
  readonly currentTimeMillis: Effect.Effect<number>;
  readonly readRun: (
    workspaceScriptRunId: string,
  ) => Effect.Effect<Option.Option<WorkspaceScriptRun>, WorkspaceScriptRpcError>;
  readonly getActiveRunByTerminal: (
    threadId: string,
    terminalId: string,
  ) => Effect.Effect<Option.Option<StoredWorkspaceScriptRun>, WorkspaceScriptRpcError>;
  readonly updateRun: (
    workspaceScriptRunId: string,
    update: (run: WorkspaceScriptRun, observedAtUnixMs: number) => WorkspaceScriptRun,
  ) => Effect.Effect<Option.Option<WorkspaceScriptRun>, WorkspaceScriptRpcError>;
  readonly rejectUnconfirmedStart: (
    workspaceScriptRunId: string,
    logContext: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<WorkspaceScriptRun, WorkspaceScriptRpcError>;
  readonly makeStopClaimInput: (
    run: WorkspaceScriptRun,
    operationId: string,
  ) => Effect.Effect<
    Pick<
      WorkspaceScriptStopClaimInput,
      "claimOwnerId" | "claimedAtUnixMs" | "claimExpiresAtUnixMs"
    >,
    WorkspaceScriptRpcError
  >;
  readonly saveStopTransition: (
    input: WorkspaceScriptStopTransitionInput,
  ) => Effect.Effect<Option.Option<WorkspaceScriptRun>, WorkspaceScriptRpcError>;
  readonly recoverStop: (
    stored: StoredWorkspaceScriptRun,
  ) => Effect.Effect<WorkspaceScriptStopRecoveryOutcome, WorkspaceScriptRpcError>;
  readonly scheduleStopRecovery: (
    stored: StoredWorkspaceScriptRun,
    outcome: WorkspaceScriptStopRecoveryOutcome,
  ) => Effect.Effect<void>;
}

const workspaceScriptTerminalId = (operationId: string): string =>
  `workspace-script-${operationId}`;

const workspaceScriptTerminalOwner = (run: WorkspaceScriptRun) =>
  makeWorkspaceScriptTerminalOwner({
    workspaceScriptRunId: run.workspaceScriptRunId,
    generation: run.requestedAtUnixMs,
  });

/** 会话归属错误是确定性结果：目标 terminalId 已被其他 owner（如普通终端）占用。 */
const isTerminalOwnershipFailure = (cause: unknown): boolean => {
  let current: unknown = cause;
  for (let depth = 0; depth < 8 && current !== null && current !== undefined; depth += 1) {
    if (Schema.is(TerminalSessionOwnershipError)(current)) return true;
    current =
      typeof current === "object" && "cause" in current
        ? (current as { readonly cause?: unknown }).cause
        : undefined;
  }
  return false;
};

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

export const makeWorkspaceScriptStart = (options: WorkspaceScriptStartExecutionOptions) =>
  Effect.fn("WorkspaceScriptService.start")(function* (input: WorkspaceScriptStartRequest) {
    const workspaceScriptRunId = makeWorkspaceScriptRunId(input.operationId);
    const idempotencyKey = makeWorkspaceScriptRunIdempotencyKey(input);
    const earlyExisting = yield* options.readRun(workspaceScriptRunId);
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
      if (earlyExisting.value.status !== "starting") return earlyExisting.value;
    }

    const startContext = Option.isSome(earlyExisting)
      ? {
          claim: { run: earlyExisting.value, claimed: false as const },
          project: null,
          script: null,
        }
      : yield* Effect.gen(function* () {
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
          const requestedAtUnixMs = yield* options.currentTimeMillis;
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

          const claim = yield* options.store.claimStart(starting).pipe(
            Effect.mapError((cause) =>
              cause._tag === "WorkspaceScriptStoreDomainError" &&
              cause.code === "workspace_script_run_conflict"
                ? operationError(
                    "workspace_script_idempotency_conflict",
                    "同一 operationId 已绑定到其他项目、线程或脚本。",
                    { workspaceScriptRunId },
                  )
                : persistenceError("领取 Workspace Script 启动", cause, {
                    workspaceScriptRunId,
                  }),
            ),
          );
          return { claim, project, script };
        });
    const { claim } = startContext;
    if (!claim.claimed && claim.run.status !== "starting") return claim.run;

    const claimedRun = claim.run;
    const terminalOwner = workspaceScriptTerminalOwner(claimedRun);
    if (claim.claimed) {
      const preSpawn = yield* options.getActiveRunByTerminal(
        claimedRun.threadId,
        claimedRun.terminalId,
      );
      if (
        Option.isNone(preSpawn) ||
        preSpawn.value.run.workspaceScriptRunId !== claimedRun.workspaceScriptRunId
      ) {
        return yield* operationError(
          "workspace_script_run_not_found",
          `Workspace Script Run 不存在：${workspaceScriptRunId}`,
          { workspaceScriptRunId },
        );
      }
      if (preSpawn.value.run.status !== "starting" || preSpawn.value.stopOperationId !== null) {
        if (
          preSpawn.value.stopOperationId !== null &&
          !isFinishedWorkspaceScriptRun(preSpawn.value.run)
        ) {
          // 当前 start 仍持有尚未创建 PTY 的 spawn gate，可用 CAS 确认“未启动即停止”。
          const observedAtUnixMs = Math.max(
            yield* options.currentTimeMillis,
            preSpawn.value.run.updatedAtUnixMs,
          );
          const suppressed = yield* options.store
            .saveTransition({
              expectedRevision: preSpawn.value.run.revision,
              run: makeWorkspaceScriptExited({
                run: preSpawn.value.run,
                stopOperationId: preSpawn.value.stopOperationId,
                observedAtUnixMs,
                exitCode: null,
                exitSignal: null,
              }),
            })
            .pipe(Effect.result);
          if (suppressed._tag === "Success") return suppressed.success;
          if (
            suppressed.failure._tag === "WorkspaceScriptStoreDomainError" &&
            suppressed.failure.code === "workspace_script_revision_conflict"
          ) {
            const winner = yield* options.getActiveRunByTerminal(
              claimedRun.threadId,
              claimedRun.terminalId,
            );
            if (Option.isSome(winner)) return winner.value.run;
            const settled = yield* options.readRun(claimedRun.workspaceScriptRunId);
            return Option.getOrElse(settled, () => preSpawn.value.run);
          }
          return yield* persistenceError(
            "确认 Workspace Script 在创建终端前已停止",
            suppressed.failure,
            {
              workspaceScriptRunId,
              expectedRevision: preSpawn.value.run.revision,
            },
          );
        }
        return preSpawn.value.run;
      }
    }
    const commandResult =
      claim.claimed && startContext.project !== null && startContext.script !== null
        ? yield* options.terminal
            .runCommand({
              threadId: claimedRun.threadId,
              terminalId: claimedRun.terminalId,
              cwd: claimedRun.cwd,
              ...(claimedRun.worktreePath === null
                ? {}
                : { worktreePath: claimedRun.worktreePath }),
              env: projectScriptRuntimeEnv({
                project: { cwd: startContext.project.workspaceRoot },
                worktreePath: claimedRun.worktreePath,
              }),
              ...workspaceScriptShellInvocation({
                platform: options.platform,
                command: startContext.script.command,
                ...(options.windowsComSpec === undefined
                  ? {}
                  : { windowsComSpec: options.windowsComSpec }),
              }),
              owner: terminalOwner,
            })
            .pipe(Effect.result)
        : null;

    if (commandResult !== null) {
      const postSpawn = yield* options.getActiveRunByTerminal(
        claimedRun.threadId,
        claimedRun.terminalId,
      );
      if (
        Option.isSome(postSpawn) &&
        postSpawn.value.run.workspaceScriptRunId === claimedRun.workspaceScriptRunId &&
        postSpawn.value.stopOperationId !== null
      ) {
        const recoveryOutcome = yield* options.recoverStop(postSpawn.value);
        yield* options.scheduleStopRecovery(postSpawn.value, recoveryOutcome);
        const reconciled = yield* options.getActiveRunByTerminal(
          claimedRun.threadId,
          claimedRun.terminalId,
        );
        if (Option.isSome(reconciled)) return reconciled.value.run;
        const settled = yield* options.readRun(claimedRun.workspaceScriptRunId);
        return Option.getOrElse(settled, () => claimedRun);
      }
    }

    const receiptResult = yield* options.terminal
      .inspectSessionReceipt({
        threadId: input.threadId,
        terminalId: claimedRun.terminalId,
        expectedOwner: terminalOwner,
      })
      .pipe(Effect.result);
    if (receiptResult._tag === "Failure") {
      if (commandResult?._tag === "Failure" && isTerminalOwnershipFailure(receiptResult.failure)) {
        // 会话被普通终端预占且从未接管：启动请求确定性失败，且不允许触碰他人会话。
        return yield* options.rejectUnconfirmedStart(workspaceScriptRunId, {
          cause: commandResult.failure,
        });
      }
      yield* Effect.logError("Workspace Script 启动状态暂未确认", {
        workspaceScriptRunId,
        cause: receiptResult.failure,
        ...(commandResult?._tag === "Failure" ? { commandCause: commandResult.failure } : {}),
      });
      const current = yield* options.readRun(workspaceScriptRunId);
      return Option.getOrElse(current, () => claim.run);
    }

    const startAssessment = assessWorkspaceScriptStart(receiptResult.success);
    if (
      commandResult?._tag === "Failure" &&
      startAssessment._tag === "Pending" &&
      receiptResult.success.snapshot === null
    ) {
      return yield* options.rejectUnconfirmedStart(workspaceScriptRunId, {
        cause: commandResult.failure,
      });
    }

    if (startAssessment._tag === "Settled") {
      const settled = yield* options.updateRun(workspaceScriptRunId, (run, observedAtUnixMs) =>
        makeWorkspaceScriptExited({
          run,
          stopOperationId: null,
          observedAtUnixMs,
          exitCode: startAssessment.exitCode,
          exitSignal: startAssessment.exitSignal,
        }),
      );
      return Option.getOrElse(settled, () => claim.run);
    }

    if (startAssessment._tag === "Pending") {
      yield* Effect.logWarning("Workspace Script 启动状态等待终端事件收口", {
        workspaceScriptRunId,
        reason: startAssessment.reason,
        ...(commandResult?._tag === "Failure" ? { commandCause: commandResult.failure } : {}),
      });
      const current = yield* options.readRun(workspaceScriptRunId);
      return Option.getOrElse(current, () => claim.run);
    }

    if (startAssessment._tag === "Failed") {
      return yield* options.rejectUnconfirmedStart(workspaceScriptRunId, {
        reason: startAssessment.reason,
      });
    }

    if (startAssessment._tag === "TerminationRequired") {
      const current = yield* options.readRun(workspaceScriptRunId);
      if (Option.isNone(current)) {
        return yield* operationError(
          "workspace_script_run_not_found",
          `Workspace Script Run 不存在：${workspaceScriptRunId}`,
          { workspaceScriptRunId },
        );
      }
      if (current.value.status !== "starting") {
        return current.value;
      }

      const stopOperationId = makeWorkspaceScriptStartTerminationOperationId(workspaceScriptRunId);
      const stopClaimInput = yield* options.makeStopClaimInput(current.value, stopOperationId);
      const terminationClaimResult = yield* options.store
        .claimStop({
          run: {
            ...current.value,
            revision: current.value.revision + 1,
            updatedAtUnixMs: stopClaimInput.claimedAtUnixMs,
          },
          operationId: stopOperationId,
          expectedRevision: current.value.revision,
          ...stopClaimInput,
        })
        .pipe(Effect.result);
      if (terminationClaimResult._tag === "Failure") {
        const latest = yield* options.readRun(workspaceScriptRunId);
        if (Option.isSome(latest) && latest.value.status !== "starting") return latest.value;
        return yield* persistenceError(
          "领取 Workspace Script 启动失败终止",
          terminationClaimResult.failure,
          { workspaceScriptRunId },
        );
      }
      if (terminationClaimResult.success.run.status !== "starting") {
        return terminationClaimResult.success.run;
      }
      if (!terminationClaimResult.success.claimed) {
        if (terminationClaimResult.success.stopClaim !== null) {
          yield* options.scheduleStopRecovery(
            {
              run: terminationClaimResult.success.run,
              stopOperationId,
              stopClaim: terminationClaimResult.success.stopClaim,
            },
            {
              _tag: "Deferred",
              retryAtUnixMs: terminationClaimResult.success.stopClaim.expiresAtUnixMs,
            },
          );
        }
        return yield* operationError(
          "workspace_script_start_failed",
          WORKSPACE_SCRIPT_START_FAILED_DETAIL,
          { workspaceScriptRunId },
        );
      }
      if (terminationClaimResult.success.stopClaim === null) {
        return yield* operationError(
          "workspace_script_stop_claim_missing",
          "Workspace Script 启动补偿缺少持久停止 claim。",
          { workspaceScriptRunId },
        );
      }

      const outcome = yield* executeWorkspaceScriptStop({
        run: terminationClaimResult.success.run,
        stopOperationId,
        stopClaim: terminationClaimResult.success.stopClaim,
        currentTimeMillis: options.currentTimeMillis,
        readRun: options.readRun,
        saveStopTransition: options.saveStopTransition,
        terminal: options.terminal,
        makeSettledRun: (run, observedAtUnixMs) =>
          makeWorkspaceScriptStartFailed(run, observedAtUnixMs),
        makeRetryableRun: makeWorkspaceScriptStartTerminationRetryable,
      });
      return yield* operationError(
        "workspace_script_start_failed",
        outcome.run.errorDetail ?? WORKSPACE_SCRIPT_START_FAILED_DETAIL,
        { workspaceScriptRunId },
      );
    }

    const currentStored = yield* options.getActiveRunByTerminal(
      claimedRun.threadId,
      claimedRun.terminalId,
    );
    if (
      Option.isNone(currentStored) ||
      currentStored.value.run.workspaceScriptRunId !== claimedRun.workspaceScriptRunId
    ) {
      return claim.run;
    }
    if (
      currentStored.value.run.status !== "starting" ||
      currentStored.value.stopOperationId !== null
    ) {
      return currentStored.value.run;
    }
    const observedAtUnixMs = Math.max(
      yield* options.currentTimeMillis,
      currentStored.value.run.updatedAtUnixMs,
    );
    const runningResult = yield* options.store
      .saveTransition({
        expectedRevision: currentStored.value.run.revision,
        run: {
          ...currentStored.value.run,
          status: "running",
          revision: currentStored.value.run.revision + 1,
          startedAtUnixMs: observedAtUnixMs,
          updatedAtUnixMs: observedAtUnixMs,
        },
      })
      .pipe(Effect.result);
    if (runningResult._tag === "Success") return runningResult.success;
    if (
      runningResult.failure._tag === "WorkspaceScriptStoreDomainError" &&
      runningResult.failure.code === "workspace_script_revision_conflict"
    ) {
      const winner = yield* options.getActiveRunByTerminal(
        claimedRun.threadId,
        claimedRun.terminalId,
      );
      return Option.isSome(winner) ? winner.value.run : claim.run;
    }
    return yield* persistenceError("确认 Workspace Script 已启动", runningResult.failure, {
      workspaceScriptRunId,
      expectedRevision: currentStored.value.run.revision,
    });
  });
