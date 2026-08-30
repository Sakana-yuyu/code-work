import type { CompositionSquadRunBoardExecution } from "@codework/client-runtime/composition/squad-run-board";
import type { CompositionSquadExecutionStatus } from "@codework/contracts";

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

export type SquadExecutionHistoryProjectTitleMap = ReadonlyMap<string, string>;
export type SquadExecutionHistorySquadTitleMap = ReadonlyMap<string, string>;

export interface SquadRunBoardHistoryItem extends CompositionSquadRunBoardExecution {
  readonly squadDisplayName: string;
  readonly projectTitle: string;
  readonly statusLabelKey: SquadExecutionHistoryStatusLabelKey;
  /** 对齐历史摘要页字段名，表示 execution 绑定的 Squad 配置版本。 */
  readonly revision: number;
}

export const squadExecutionHistoryStatusLabelKey = (
  status: CompositionSquadExecutionStatus,
): SquadExecutionHistoryStatusLabelKey => SQUAD_EXECUTION_HISTORY_STATUS_LABEL_KEYS[status];

/** 为完整 Run Board 读模型补充移动端展示名，不改变服务端 execution 排序。 */
export const projectSquadRunBoardHistory = (
  executions: ReadonlyArray<CompositionSquadRunBoardExecution>,
  squadTitlesById: SquadExecutionHistorySquadTitleMap,
  projectTitlesById: SquadExecutionHistoryProjectTitleMap,
): ReadonlyArray<SquadRunBoardHistoryItem> =>
  executions.map((execution) => ({
    ...execution,
    squadDisplayName: squadTitlesById.get(execution.squadId) ?? execution.squadId,
    projectTitle: projectTitlesById.get(execution.projectId) ?? execution.projectId,
    statusLabelKey: squadExecutionHistoryStatusLabelKey(execution.status),
    revision: execution.squadRevision,
  }));
