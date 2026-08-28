import {
  isByokDelegationControlTask,
  isByokResumeRedispatchable,
  type CompositionControlCenterByokResumeRedispatchRequest,
  type CompositionControlCenterRedispatchRequest,
  type CompositionControlCenterTask,
} from "@codework/contracts";

/** Goal Loop 五态 → i18n 标签键；未知状态返回 null，调用方回退为原始状态文本。 */
const GOAL_LOOP_STATE_LABEL_KEYS: Readonly<Record<string, string>> = {
  not_started: "controlCenter.state.notStarted",
  running: "controlCenter.state.running",
  converged: "controlCenter.state.converged",
  supervisor_settled: "controlCenter.state.supervisorSettled",
  interrupted: "controlCenter.state.interrupted",
};

export const goalLoopStateLabelKey = (state: string): string | null =>
  GOAL_LOOP_STATE_LABEL_KEYS[state] ?? null;

/** 与 Web 控制中心面板一致：仅这两种 Goal Loop 状态提供"自动重派"入口。 */
const REDISPATCHABLE_GOAL_LOOP_STATES: ReadonlySet<string> = new Set([
  "interrupted",
  "supervisor_settled",
]);

/** 与服务端投影的活跃 Run 状态集一致：仅这些 Run 提供取消入口。 */
const CANCELLABLE_RUN_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "dispatched",
  "resuming",
  "running",
  "waiting_approval",
  "waiting_input",
  "in_review",
]);

export interface ControlCenterTaskActions {
  readonly redispatchable: boolean;
  readonly cancellable: boolean;
  readonly reviewable: boolean;
  readonly abandonable: boolean;
  readonly byokResumable: boolean;
}

/**
 * 行操作渲染门槛，与 Web 控制中心面板逐条对齐：
 * - 重派：goalLoop interrupted/supervisor_settled 且存在最新 Run；
 * - 取消：最新 Run 处于活跃状态；
 * - 审批：任务状态 in_review 且存在最新 Run（后端对非 in_review 显式报错）；
 * - 放弃：仅 goalLoop interrupted（supervisor_settled 已有结算行，再落 abandon 会被拒）；
 * - 恢复并重派：与 Web 共用 `isByokResumeRedispatchable`（存在最新 Run、排除已结算，
 *   接受 byok_resume_interrupted 或可恢复 checkpoint 链）；
 * - BYOK 委派行只展示、不套 Goal Loop 五态操作或 composition cancel。
 */
export const resolveControlCenterTaskActions = (
  task: CompositionControlCenterTask,
): ControlCenterTaskActions => {
  if (isByokDelegationControlTask(task)) {
    return {
      redispatchable: false,
      cancellable: false,
      reviewable: false,
      abandonable: false,
      byokResumable: false,
    };
  }
  return {
    redispatchable:
      task.latestRun !== undefined &&
      task.goalLoop !== undefined &&
      REDISPATCHABLE_GOAL_LOOP_STATES.has(task.goalLoop.state),
    cancellable:
      task.latestRun !== undefined && CANCELLABLE_RUN_STATUSES.has(task.latestRun.status),
    reviewable: task.status === "in_review" && task.latestRun !== undefined,
    abandonable: task.latestRun !== undefined && task.goalLoop?.state === "interrupted",
    byokResumable: isByokResumeRedispatchable(task),
  };
};

/** 控制中心"自动重派"请求输入：capabilityIds 按逗号拆分并去除空白项，与 Web 面板一致。 */
export const buildRedispatchInput = (input: {
  readonly taskId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly newRunId: string;
  readonly capabilityIdsText: string;
}): CompositionControlCenterRedispatchRequest => ({
  taskId: input.taskId,
  runId: input.runId,
  agentId: input.agentId,
  newRunId: input.newRunId,
  capabilityIds: input.capabilityIdsText
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
});

/** 恢复并重派请求：移动端不提供 capabilityIds 输入，固定空数组。 */
export const buildByokResumeRedispatchInput = (input: {
  readonly taskId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly newRunId: string;
  readonly note: string;
}): CompositionControlCenterByokResumeRedispatchRequest => ({
  ...buildRedispatchInput({ ...input, capabilityIdsText: "" }),
  note: input.note,
});

/** Goal Loop 摘要行：轮次固定展示，拒绝数仅在 >0 时追加。 */
export const formatGoalLoopMeta = (
  labels: { readonly rounds: string; readonly rejected: string },
  goalLoop: { readonly completedRounds: number; readonly rejectedCompletions: number },
): string =>
  goalLoop.rejectedCompletions > 0
    ? `${labels.rounds}: ${goalLoop.completedRounds} · ${labels.rejected}: ${goalLoop.rejectedCompletions}`
    : `${labels.rounds}: ${goalLoop.completedRounds}`;

/** Grant 摘要行：事件总数固定展示，撤销数仅在 >0 时追加。 */
export const formatGrantMeta = (
  labels: { readonly grants: string; readonly revoked: string },
  grants: { readonly totalEvents: number; readonly revokedEvents: number },
): string =>
  grants.revokedEvents > 0
    ? `${labels.grants}: ${grants.totalEvents} · ${labels.revoked}: ${grants.revokedEvents}`
    : `${labels.grants}: ${grants.totalEvents}`;

/** BYOK 恢复摘要行：段数固定展示，可恢复时追加字节数，否则标记不可恢复。 */
export const formatByokResumeMeta = (
  labels: {
    readonly checkpoints: string;
    readonly recoveredBytes: string;
    readonly unrecoverable: string;
  },
  byokResume: {
    readonly checkpointCount: number;
    readonly recoveredUtf8Bytes: number;
    readonly recoverable: boolean;
  },
): string =>
  byokResume.recoverable
    ? `${labels.checkpoints}: ${byokResume.checkpointCount} · ${labels.recoveredBytes}: ${byokResume.recoveredUtf8Bytes}`
    : `${labels.checkpoints}: ${byokResume.checkpointCount} · ${labels.unrecoverable}`;

/** BYOK 委派摘要行：agentId 与轮次固定展示，错误码仅在存在时追加。 */
export const formatByokDelegationMeta = (
  labels: { readonly rounds: string; readonly errorCode: string },
  input: {
    readonly agentId: string;
    readonly attempt: number;
    readonly failureCode?: string;
  },
): string =>
  input.failureCode === undefined
    ? `${input.agentId} · ${labels.rounds}: ${input.attempt}`
    : `${input.agentId} · ${labels.rounds}: ${input.attempt} · ${labels.errorCode}: ${input.failureCode}`;

/** Squad 名册摘要行：队长与成员数。 */
export const formatSquadMeta = (
  labels: { readonly leader: string; readonly members: string },
  squad: { readonly leaderAgentId: string; readonly memberAgentIds: readonly string[] },
): string =>
  `${labels.leader}: ${squad.leaderAgentId} · ${labels.members}: ${squad.memberAgentIds.length}`;
