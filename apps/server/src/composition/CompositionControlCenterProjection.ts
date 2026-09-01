import {
  BYOK_DELEGATION_PROJECT_ID,
  type CompositionCapabilityAuditEvent,
  type CompositionCapabilityAuditOutcome,
  type CompositionControlCenterHumanAction,
  type CompositionSquad,
  type CompositionTask,
  type CompositionTaskEvent,
  type CompositionTaskRun,
  type CompositionTaskStatus,
} from "@codework/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { CapabilityGrantPersistenceError } from "./CapabilityGrantRegistry.ts";
import type { CapabilityGrantRegistryShape } from "./CapabilityGrantRegistry.ts";
import type {
  CompositionTaskStoreError,
  CompositionTaskStoreShape,
} from "../persistence/Services/CompositionTaskStore.ts";
import {
  isByokPersistedCheckpointEvent,
  recoverPersistedCheckpointText,
} from "./CompositionByokCheckpointRecovery.ts";
import { byokResumeRedispatchEventPrefix } from "./CompositionByokResumeRedispatch.ts";
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

/**
 * 最新 Run 的 BYOK 部分输出恢复态。Goal Loop 五态只识别 `goalloop:*` 前缀，
 * `byok:` checkpoint 链对它不可见，因此控制中心"恢复并重派"门槛需要这一路独立投影。
 */
export type CompositionByokResumeProjection = {
  readonly runId: string;
  readonly checkpointCount: number;
  readonly recoveredUtf8Bytes: number;
  readonly recoverable: boolean;
  readonly redispatchSettled: boolean;
  readonly recoveryFailureCode: string | undefined;
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
    | Pick<CompositionTaskRun, "runId" | "status" | "attempt" | "runtimeTaskId" | "failureCode">
    | undefined;
  readonly goalLoop?: CompositionGoalLoopProjection | undefined;
  readonly byokResume?: CompositionByokResumeProjection | undefined;
  readonly byokDelegation?: CompositionByokDelegationProjection | undefined;
  readonly humanAction?: CompositionControlCenterHumanAction | undefined;
  readonly grants?: CompositionGrantProjection | undefined;
};

/**
 * BYOK 委派合成 Task 的控制中心摘要。只从 Task/Run 取 ID/状态/轮次/错误码，
 * 不把台账事件摘要或 promptDigest 带进投影。
 */
export type CompositionByokDelegationProjection = {
  readonly runId: string;
  readonly delegationId: string;
  readonly status: CompositionTaskStatus;
  readonly attempt: number;
  readonly failureCode?: string | undefined;
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

const humanActionKind = (
  status: CompositionTaskStatus,
): CompositionControlCenterHumanAction["kind"] | undefined => {
  if (status === "waiting_approval") return "approval";
  if (status === "waiting_input") return "input";
  if (status === "in_review") return "review";
  return undefined;
};

const humanActionFallbackSummary: Readonly<
  Record<CompositionControlCenterHumanAction["kind"], string>
> = {
  approval: "任务等待人工审批",
  input: "任务等待人工输入",
  review: "任务等待人工审核",
};

const projectHumanAction = (input: {
  readonly taskStatus: CompositionTaskStatus;
  readonly run: CompositionTaskRun;
  readonly events: ReadonlyArray<CompositionTaskEvent>;
}): CompositionControlCenterHumanAction | undefined => {
  const kind = humanActionKind(input.taskStatus);
  if (kind === undefined || input.run.status !== input.taskStatus) return undefined;
  const event = [...input.events]
    .filter((candidate) => candidate.status === input.taskStatus)
    .sort((left, right) => left.sequence - right.sequence)
    .at(-1);
  return {
    runId: input.run.runId,
    kind,
    summary: event?.summary ?? humanActionFallbackSummary[kind],
    sequence: event?.sequence ?? 0,
    ...(event?.blockerCode === undefined ? {} : { blockerCode: event.blockerCode }),
    ...(event?.approvalRequestId === undefined
      ? {}
      : { approvalRequestId: event.approvalRequestId }),
  };
};

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

/**
 * 只读推导 BYOK 恢复态：跑一遍摘要链校验（失败降级为 recoverable=false + 稳定错误码），
 * 并检测是否已有恢复重派结算行。调用方先确认存在 `byok:` checkpoint 行，非 BYOK 任务
 * 不挂空字段。
 */
const projectByokResume = (input: {
  readonly taskId: string;
  readonly runId: string;
  readonly events: ReadonlyArray<CompositionTaskEvent>;
  readonly checkpoints: ReadonlyArray<CompositionTaskEvent>;
}): Effect.Effect<CompositionByokResumeProjection> => {
  const settleSourceEventId = `${byokResumeRedispatchEventPrefix(input.taskId, input.runId)}:settle`;
  const redispatchSettled = input.events.some(
    (event) => event.sourceEventId === settleSourceEventId,
  );
  return recoverPersistedCheckpointText(input.checkpoints).pipe(
    Effect.map(
      (recovered): CompositionByokResumeProjection => ({
        runId: input.runId,
        checkpointCount: recovered.chunkCount,
        recoveredUtf8Bytes: recovered.utf8Bytes,
        recoverable: true,
        redispatchSettled,
        recoveryFailureCode: undefined,
      }),
    ),
    Effect.catchTag(
      "ByokCheckpointRecoveryError",
      (error): Effect.Effect<CompositionByokResumeProjection> =>
        Effect.succeed({
          runId: input.runId,
          checkpointCount: input.checkpoints.length,
          recoveredUtf8Bytes: 0,
          recoverable: false,
          redispatchSettled,
          recoveryFailureCode: error.code,
        }),
    ),
  );
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
    const squads: Array<CompositionControlCenterProjection["squads"][number]> = [];
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
    let byokResume: CompositionByokResumeProjection | undefined;
    let byokDelegation: CompositionByokDelegationProjection | undefined;
    let humanAction: CompositionControlCenterHumanAction | undefined;
    const isByokDelegation = task.projectId === BYOK_DELEGATION_PROJECT_ID;
    if (latestRun !== undefined && isByokDelegation) {
      // Goal Loop 五态只扫 `goalloop:*`，套到委派行会得到误导性的 not_started。
      byokDelegation = {
        runId: latestRun.runId,
        delegationId: latestRun.runtimeTaskId ?? latestRun.runId,
        status: latestRun.status,
        attempt: latestRun.attempt,
        ...(latestRun.failureCode === undefined ? {} : { failureCode: latestRun.failureCode }),
      };
    } else if (latestRun !== undefined) {
      const events = yield* deps.store.listEvents(task.taskId, latestRun.runId);
      humanAction = projectHumanAction({ taskStatus: task.status, run: latestRun, events });
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
      const checkpoints = events.filter(isByokPersistedCheckpointEvent);
      if (checkpoints.length > 0) {
        byokResume = yield* projectByokResume({
          taskId: task.taskId,
          runId: latestRun.runId,
          events,
          checkpoints,
        });
      }
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
              ...(latestRun.runtimeTaskId === undefined
                ? {}
                : { runtimeTaskId: latestRun.runtimeTaskId }),
              failureCode: latestRun.failureCode,
            },
          }),
      ...(goalLoop === undefined ? {} : { goalLoop }),
      ...(byokResume === undefined ? {} : { byokResume }),
      ...(byokDelegation === undefined ? {} : { byokDelegation }),
      ...(humanAction === undefined ? {} : { humanAction }),
      ...(grants === undefined ? {} : { grants }),
    };
  });
