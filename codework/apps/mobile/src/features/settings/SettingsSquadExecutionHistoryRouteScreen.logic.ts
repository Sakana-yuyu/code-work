import type {
  CompositionSquadExecutionStatus,
  CompositionSquadExecutionSummary,
} from "@codework/contracts";

export const SQUAD_EXECUTION_HISTORY_STATUS_LABEL_KEYS = {
  queued: "squadExecutionHistory.status.queued",
  planning: "squadExecutionHistory.status.planning",
  awaiting_approval: "squadExecutionHistory.status.awaitingApproval",
  running: "squadExecutionHistory.status.running",
  in_review: "squadExecutionHistory.status.inReview",
  paused: "squadExecutionHistory.status.paused",
  cancelling: "squadExecutionHistory.status.cancelling",
  completed: "squadExecutionHistory.status.completed",
  failed: "squadExecutionHistory.status.failed",
  cancelled: "squadExecutionHistory.status.cancelled",
} as const satisfies Readonly<
  Record<CompositionSquadExecutionStatus, `squadExecutionHistory.status.${string}`>
>;

export type SquadExecutionHistoryStatusLabelKey =
  (typeof SQUAD_EXECUTION_HISTORY_STATUS_LABEL_KEYS)[CompositionSquadExecutionStatus];

export interface SquadExecutionHistoryItem {
  readonly executionId: string;
  readonly squadId: string;
  readonly squadDisplayName: string;
  readonly projectId: string;
  readonly projectTitle: string;
  readonly status: CompositionSquadExecutionStatus;
  readonly statusLabelKey: SquadExecutionHistoryStatusLabelKey;
  /** 执行绑定的 Squad 配置版本，不是持久化记录自身的写入版本。 */
  readonly revision: number;
  readonly nodeCount: number;
  readonly pendingApprovalCount: number;
  readonly createdAtUnixMs: number;
  readonly resultSummary?: string;
  readonly failureCode?: string;
}

export type SquadExecutionHistoryProjectTitleMap = ReadonlyMap<string, string>;

export const squadExecutionHistoryStatusLabelKey = (
  status: CompositionSquadExecutionStatus,
): SquadExecutionHistoryStatusLabelKey => SQUAD_EXECUTION_HISTORY_STATUS_LABEL_KEYS[status];

/**
 * 将服务端安全摘要投影为移动端展示模型，并原样保留服务端排序。
 * 该边界不接收完整 execution，因此无法读取 Task、Run、节点明细或内部摘要。
 */
export const projectSquadExecutionHistory = (
  summaries: ReadonlyArray<CompositionSquadExecutionSummary>,
  projectTitlesById: SquadExecutionHistoryProjectTitleMap,
): ReadonlyArray<SquadExecutionHistoryItem> =>
  summaries.map((summary) => ({
    executionId: summary.executionId,
    squadId: summary.squadId,
    squadDisplayName: summary.squadDisplayName,
    projectId: summary.projectId,
    projectTitle: projectTitlesById.get(summary.projectId) ?? summary.projectId,
    status: summary.status,
    statusLabelKey: squadExecutionHistoryStatusLabelKey(summary.status),
    revision: summary.squadRevision,
    nodeCount: summary.nodeCount,
    pendingApprovalCount: summary.pendingApprovalCount,
    createdAtUnixMs: summary.createdAtUnixMs,
    ...(summary.resultSummary === undefined ? {} : { resultSummary: summary.resultSummary }),
    ...(summary.failureCode === undefined ? {} : { failureCode: summary.failureCode }),
  }));
