import {
  BYOK_DELEGATION_PROJECT_ID,
  type CompositionTask,
  type CompositionTaskRun,
  type CompositionTaskStatus,
} from "@codework/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type {
  CompositionTaskStoreError,
  CompositionTaskStoreShape,
} from "../persistence/Services/CompositionTaskStore.ts";
import {
  BYOK_DELEGATION_INTERRUPTED_FAILURE_CODE,
  projectByokDelegationTransition,
  type ByokDelegationLedgerStorePort,
  type ByokDelegationProjectionScope,
} from "./CompositionByokDelegationProjection.ts";

const IN_FLIGHT_STATUSES: ReadonlySet<CompositionTaskStatus> = new Set(["queued", "running"]);

export type ByokDelegationSupervisorStorePort = ByokDelegationLedgerStorePort &
  Pick<CompositionTaskStoreShape, "listTasks" | "getLatestRun">;

/** 对单个合成委派 Run 的跨重启扫描结果。 */
export type ByokDelegationInterruptScan = {
  readonly taskId: string;
  readonly runId: string;
  readonly interrupted: boolean;
  readonly alreadyTerminal: boolean;
};

const providerInstanceId = (agentId: string): string =>
  agentId.startsWith("provider:") ? agentId.slice("provider:".length) : agentId;

const scopeFromLedger = (
  task: CompositionTask,
  run: CompositionTaskRun,
): ByokDelegationProjectionScope => ({
  instanceId: providerInstanceId(run.agentId),
  delegationId: run.runtimeTaskId ?? run.runId,
  taskId: task.taskId,
  runId: run.runId,
  agentId: run.agentId,
  runtimeId: run.runtimeId,
  promptDigest: task.promptDigest,
});

/**
 * 纯函数：`byok-delegation` 项目下 queued/running 的合成 Run，若调度器内存没有
 * 对应条目（进程重启后 live 集合为空），即视为中断。已终态 Run 一律不算中断。
 */
export const scanByokDelegationRun = (
  task: CompositionTask,
  run: CompositionTaskRun,
  liveDelegationIds: ReadonlySet<string>,
): ByokDelegationInterruptScan => {
  const alreadyTerminal = !IN_FLIGHT_STATUSES.has(run.status);
  const live = run.runtimeTaskId !== undefined && liveDelegationIds.has(run.runtimeTaskId);
  return {
    taskId: task.taskId,
    runId: run.runId,
    alreadyTerminal,
    interrupted: task.projectId === BYOK_DELEGATION_PROJECT_ID && !alreadyTerminal && !live,
  };
};

/**
 * 幂等收口一条中断委派：经既有投影写入 `terminal:failed` 行与
 * failureCode=`byok_delegation_interrupted`。已终态或非中断扫描零副作用。
 */
export const settleInterruptedByokDelegationRun = (options: {
  readonly store: ByokDelegationLedgerStorePort;
  readonly task: CompositionTask;
  readonly run: CompositionTaskRun;
  readonly liveDelegationIds: ReadonlySet<string>;
  readonly nowUnixMs: number;
}): Effect.Effect<boolean, CompositionTaskStoreError> => {
  const scan = scanByokDelegationRun(options.task, options.run, options.liveDelegationIds);
  if (!scan.interrupted) return Effect.succeed(false);
  return projectByokDelegationTransition({
    store: options.store,
    scope: scopeFromLedger(options.task, options.run),
    transition: {
      status: "failed",
      errorCode: BYOK_DELEGATION_INTERRUPTED_FAILURE_CODE,
    },
    nowUnixMs: options.nowUnixMs,
  });
};

/**
 * 扫描 `byok-delegation` 项目下全部 Task 的最新 Run，对中断的 queued/running
 * 合成 Run 幂等写入终态。重复扫描对已终态行零副作用。
 */
export const recoverInterruptedByokDelegations = (options: {
  readonly store: ByokDelegationSupervisorStorePort;
  readonly liveDelegationIds: ReadonlySet<string>;
  readonly nowUnixMs: number;
}): Effect.Effect<
  ReadonlyArray<{ readonly taskId: string; readonly runId: string; readonly settled: boolean }>,
  CompositionTaskStoreError
> =>
  Effect.gen(function* () {
    const tasks = yield* options.store.listTasks(BYOK_DELEGATION_PROJECT_ID);
    const results: Array<{
      readonly taskId: string;
      readonly runId: string;
      readonly settled: boolean;
    }> = [];
    for (const task of tasks) {
      const runOption = yield* options.store.getLatestRun(task.taskId);
      if (Option.isNone(runOption)) continue;
      const run = runOption.value;
      const settled = yield* settleInterruptedByokDelegationRun({
        store: options.store,
        task,
        run,
        liveDelegationIds: options.liveDelegationIds,
        nowUnixMs: options.nowUnixMs,
      });
      if (settled) {
        results.push({ taskId: task.taskId, runId: run.runId, settled });
      }
    }
    return results;
  });
