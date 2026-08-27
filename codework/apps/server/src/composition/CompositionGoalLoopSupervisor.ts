import type { CompositionTaskEvent, CompositionTaskStatus } from "@codework/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import type {
  CompositionTaskStoreError,
  CompositionTaskStoreShape,
} from "../persistence/Services/CompositionTaskStore.ts";
import { goalLoopEventPrefix } from "./CompositionGoalLoopRunner.ts";

export class CompositionGoalLoopSupervisorError extends Data.TaggedError(
  "CompositionGoalLoopSupervisorError",
)<{
  readonly code: "goal_loop_supervisor_not_interrupted" | "goal_loop_supervisor_already_settled";
  readonly detail: string;
}> {}

export type CompositionGoalLoopStorePort = Pick<
  CompositionTaskStoreShape,
  "listEvents" | "appendEventIfNew"
>;

/** 对单个 Run 的 Goal Loop 台账扫描结果；rounds/rejects 取自幂等行后缀中的最大轮次。 */
export type CompositionGoalLoopScanResult = {
  readonly started: boolean;
  readonly completedRounds: number;
  readonly rejectedCompletions: number;
  readonly terminalStatuses: ReadonlyArray<string>;
  readonly settledBySupervisor: boolean;
  /** 已开始且尚无终态行、也没有 supervisor 结算行，即视为跨重启未收敛。 */
  readonly interrupted: boolean;
};

const SUFFIX_PATTERN = /^start$|^round:(\d+)$|^reject:(\d+)$|^terminal:(.+)$|^supervisor:(.+)$/;

/** 纯函数：按 (taskId, runId) 作用域扫描台账事件，判定该 Run 的 Goal Loop 是否未收敛。 */
export const scanCompositionGoalLoopRun = (
  events: ReadonlyArray<CompositionTaskEvent>,
  scope: { readonly taskId: string; readonly runId: string },
): CompositionGoalLoopScanResult => {
  const prefix = `${goalLoopEventPrefix(scope.taskId, scope.runId)}:`;
  let started = false;
  let completedRounds = 0;
  let rejectedCompletions = 0;
  const terminalStatuses: string[] = [];
  let settledBySupervisor = false;
  for (const event of events) {
    const sourceEventId = event.sourceEventId;
    if (sourceEventId === undefined) continue;
    if (event.taskId !== scope.taskId || event.runId !== scope.runId) continue;
    if (!sourceEventId.startsWith(prefix)) continue;
    const suffix = sourceEventId.slice(prefix.length);
    const match = SUFFIX_PATTERN.exec(suffix);
    if (match === null) continue;
    if (match[0] === "start") {
      started = true;
      continue;
    }
    // 分组：1=round 轮次、2=reject 轮次、3=terminal 状态、4=supervisor 决定（start 无捕获组）。
    if (match[1] !== undefined) {
      started = true;
      completedRounds = Math.max(completedRounds, Number(match[1]));
    } else if (match[2] !== undefined) {
      started = true;
      rejectedCompletions = Math.max(rejectedCompletions, Number(match[2]));
    } else if (match[3] !== undefined) {
      started = true;
      terminalStatuses.push(match[3]);
    } else if (match[4] !== undefined) {
      settledBySupervisor = true;
    }
  }
  return {
    started,
    completedRounds,
    rejectedCompletions,
    terminalStatuses,
    settledBySupervisor,
    interrupted: started && terminalStatuses.length === 0 && !settledBySupervisor,
  };
};

export type CompositionGoalLoopSupervisorOptions = {
  readonly taskId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly parentTaskId?: string;
  readonly runtimeId?: string;
  readonly store: CompositionGoalLoopStorePort;
  /** redispatch：标记待改派（blocked）；abandon：放弃恢复（failed）。 */
  readonly decision: "redispatch" | "abandon";
  /** 附加说明（截断到 120 字符），例如改派目标或放弃原因。 */
  readonly note?: string;
};

/**
 * 跨重启监督结算：扫描台账确认 Run 上存在未收敛的 Goal Loop 后，落一条幂等
 * `supervisor:<decision>` 结算行（blocked/failed），供编排层决定重派或收尾。
 * - 循环已收敛 → `goal_loop_supervisor_not_interrupted`；
 * - 已有任何 supervisor 结算行，或结算行写入时被其他投影者抢占 → `goal_loop_supervisor_already_settled`。
 * 实际重派/收尾的执行仍由编排层决定，本切片只负责检测与幂等标记。
 */
export const superviseCompositionGoalLoopRun = (
  options: CompositionGoalLoopSupervisorOptions,
): Effect.Effect<
  CompositionGoalLoopScanResult,
  CompositionGoalLoopSupervisorError | CompositionTaskStoreError
> =>
  Effect.gen(function* () {
    const events = yield* options.store.listEvents(options.taskId, options.runId);
    const scan = scanCompositionGoalLoopRun(events, {
      taskId: options.taskId,
      runId: options.runId,
    });
    if (!scan.interrupted) {
      return yield* new CompositionGoalLoopSupervisorError({
        code: "goal_loop_supervisor_not_interrupted",
        detail: scan.settledBySupervisor
          ? "该 Run 的 Goal Loop 已由 supervisor 结算过。"
          : "该 Run 没有未收敛的 Goal Loop（无 start/round 行或已有终态行）。",
      });
    }
    const truncate = (text: string): string => {
      const trimmed = text.trim();
      return trimmed.length > 120 ? `${trimmed.slice(0, 120)}…` : trimmed;
    };
    const rejectedNote =
      scan.rejectedCompletions > 0 ? `，完成声明被拒 ${scan.rejectedCompletions} 次` : "";
    const decisionNote = options.decision === "redispatch" ? "已标记待改派" : "已放弃恢复";
    const inserted = yield* options.store.appendEventIfNew({
      taskId: options.taskId,
      runId: options.runId,
      agentId: options.agentId,
      ...(options.parentTaskId === undefined ? {} : { parentTaskId: options.parentTaskId }),
      ...(options.runtimeId === undefined ? {} : { runtimeId: options.runtimeId }),
      sourceEventId: `${goalLoopEventPrefix(options.taskId, options.runId)}:supervisor:${options.decision}`,
      status: (options.decision === "redispatch"
        ? "blocked"
        : "failed") satisfies CompositionTaskStatus,
      sequence: 0,
      eventType: "status",
      summary: `跨重启监督：目标循环未收敛（已完成 ${scan.completedRounds} 轮${rejectedNote}），${decisionNote}${
        options.note === undefined ? "" : `：${truncate(options.note)}`
      }`,
    });
    if (!inserted) {
      return yield* new CompositionGoalLoopSupervisorError({
        code: "goal_loop_supervisor_already_settled",
        detail: "结算行写入被其他投影者抢占，说明已有 supervisor 结算。",
      });
    }
    return scan;
  });
