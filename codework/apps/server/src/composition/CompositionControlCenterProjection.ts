import type {
  CompositionCapabilityAuditEvent,
  CompositionCapabilityAuditOutcome,
  CompositionSquad,
  CompositionTask,
  CompositionTaskRun,
  CompositionTaskStatus,
} from "@codework/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { CapabilityGrantPersistenceError } from "./CapabilityGrantRegistry.ts";
import type { CapabilityGrantRegistryShape } from "./CapabilityGrantRegistry.ts";
import type {
  CompositionTaskStoreError,
  CompositionTaskStoreShape,
} from "../persistence/Services/CompositionTaskStore.ts";
import { scanCompositionGoalLoopRun } from "./CompositionGoalLoopSupervisor.ts";

export type CompositionGoalLoopProjectionState =
  | "not_started"
  | "running"
  | "converged"
  | "supervisor_settled"
  | "interrupted";

export type CompositionGoalLoopProjection = {
  readonly runId: string;
  readonly state: CompositionGoalLoopProjectionState;
  readonly completedRounds: number;
  readonly rejectedCompletions: number;
  readonly terminalStatuses: ReadonlyArray<string>;
  readonly settledBySupervisor: boolean;
};

export type CompositionGrantProjection = {
  readonly taskId: string;
  readonly totalEvents: number;
  readonly revokedEvents: number;
  readonly lastOutcome: CompositionCapabilityAuditOutcome | undefined;
  readonly lastOccurredAtUnixMs: number | undefined;
};

export type CompositionTaskControlProjection = {
  readonly taskId: string;
  readonly status: CompositionTaskStatus;
  readonly agentId: string;
  readonly updatedAtUnixMs: number;
  readonly dependsOnTaskIds: ReadonlyArray<string>;
  readonly latestRun?:
    | Pick<CompositionTaskRun, "runId" | "status" | "attempt" | "failureCode">
    | undefined;
  readonly goalLoop?: CompositionGoalLoopProjection | undefined;
  readonly grants?: CompositionGrantProjection | undefined;
};

export type CompositionControlCenterProjection = {
  readonly generatedAtUnixMs: number;
  readonly tasks: ReadonlyArray<CompositionTaskControlProjection>;
  readonly squads: ReadonlyArray<
    Pick<CompositionSquad, "squadId" | "name" | "leaderAgentId" | "memberAgentIds">
  >;
};

const RUN_ACTIVE_STATUSES: ReadonlySet<CompositionTaskStatus> = new Set([
  "queued",
  "dispatched",
  "resuming",
  "running",
  "waiting_approval",
  "waiting_input",
  "in_review",
]);

const deriveGoalLoopState = (
  runStatus: CompositionTaskStatus,
  scan: {
    readonly started: boolean;
    readonly terminalStatuses: ReadonlyArray<string>;
    readonly settledBySupervisor: boolean;
  },
): CompositionGoalLoopProjectionState => {
  if (!scan.started) return "not_started";
  if (scan.terminalStatuses.length > 0) return "converged";
  if (scan.settledBySupervisor) return "supervisor_settled";
  // Run 已终结但循环没有终态行：进程中断所致。
  return RUN_ACTIVE_STATUSES.has(runStatus) ? "running" : "interrupted";
};

const summarizeGrantAudit = (
  taskId: string,
  audit: ReadonlyArray<CompositionCapabilityAuditEvent>,
): CompositionGrantProjection => {
  const sorted = [...audit].sort(
    (a, b) => a.occurredAtUnixMs - b.occurredAtUnixMs || a.auditId.localeCompare(b.auditId),
  );
  const last = sorted.at(-1);
  return {
    taskId,
    totalEvents: sorted.length,
    revokedEvents: sorted.filter((event) => event.outcome === "revoked").length,
    lastOutcome: last?.outcome,
    lastOccurredAtUnixMs: last?.occurredAtUnixMs,
  };
};

/**
 * 控制中心统一投影（Web Settings/控制中心展示入口的数据层）：
 * 按任务聚合最新 Run、Goal Loop 状态（台账扫描，含运行时恢复/停滞/结算）、
 * capability grant 审计摘要与任务依赖，并按需展开 Squad 名册。
 * 只做只读聚合，不产生任何台账写入。
 */
export const projectCompositionControlCenter = (deps: {
  readonly store: Pick<
    CompositionTaskStoreShape,
    "listTasks" | "getLatestRun" | "listEvents" | "getSquad"
  >;
  readonly grantRegistry?: Pick<CapabilityGrantRegistryShape, "listAudit">;
  readonly projectId?: string;
  /** 需要展开名册的 Squad ID 列表（store 无 listSquads，由调用方给出关注集合）。 */
  readonly squadIds?: ReadonlyArray<string>;
  readonly now?: () => number;
}): Effect.Effect<
  CompositionControlCenterProjection,
  CompositionTaskStoreError | CapabilityGrantPersistenceError
> =>
  Effect.gen(function* () {
    const tasks = yield* deps.store.listTasks(deps.projectId);
    const projections: CompositionTaskControlProjection[] = [];
    for (const task of tasks) {
      projections.push(yield* projectTask(deps, task));
    }
    const squads: CompositionControlCenterProjection["squads"] = [];
    for (const squadId of deps.squadIds ?? []) {
      const squadOption = yield* deps.store.getSquad(squadId);
      if (Option.isSome(squadOption)) {
        const squad = squadOption.value;
        squads.push({
          squadId: squad.squadId,
          name: squad.name,
          leaderAgentId: squad.leaderAgentId,
          memberAgentIds: [...squad.memberAgentIds],
        });
      }
    }
    return { generatedAtUnixMs: (deps.now ?? Date.now)(), tasks: projections, squads };
  });

const projectTask = (
  deps: Parameters<typeof projectCompositionControlCenter>[0],
  task: CompositionTask,
): Effect.Effect<
  CompositionTaskControlProjection,
  CompositionTaskStoreError | CapabilityGrantPersistenceError
> =>
  Effect.gen(function* () {
    const latestRunOption = yield* deps.store.getLatestRun(task.taskId);
    const latestRun = Option.isNone(latestRunOption) ? undefined : latestRunOption.value;
    let goalLoop: CompositionGoalLoopProjection | undefined;
    if (latestRun !== undefined) {
      const events = yield* deps.store.listEvents(task.taskId, latestRun.runId);
      const scan = scanCompositionGoalLoopRun(events, {
        taskId: task.taskId,
        runId: latestRun.runId,
      });
      goalLoop = {
        runId: latestRun.runId,
        state: deriveGoalLoopState(latestRun.status, scan),
        completedRounds: scan.completedRounds,
        rejectedCompletions: scan.rejectedCompletions,
        terminalStatuses: scan.terminalStatuses,
        settledBySupervisor: scan.settledBySupervisor,
      };
    }
    let grants: CompositionGrantProjection | undefined;
    if (deps.grantRegistry !== undefined) {
      grants = summarizeGrantAudit(
        task.taskId,
        yield* deps.grantRegistry.listAudit({ taskId: task.taskId }),
      );
    }
    return {
      taskId: task.taskId,
      status: task.status,
      agentId: task.assigneeId,
      updatedAtUnixMs: task.updatedAtUnixMs,
      dependsOnTaskIds: [...task.dependsOnTaskIds].sort(),
      ...(latestRun === undefined
        ? {}
        : {
            latestRun: {
              runId: latestRun.runId,
              status: latestRun.status,
              attempt: latestRun.attempt,
              failureCode: latestRun.failureCode,
            },
          }),
      ...(goalLoop === undefined ? {} : { goalLoop }),
      ...(grants === undefined ? {} : { grants }),
    };
  });
