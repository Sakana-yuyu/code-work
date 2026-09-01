import type {
  OrchestrationLatestTurnState,
  OrchestrationMessage,
  OrchestrationSessionStatus,
  OrchestrationThread,
} from "@codework/contracts";

export type AgentControlStatus =
  | "idle"
  | "running"
  | "completed"
  | "interrupted"
  | "failed"
  | "archived";

export interface AgentStatusSnapshot {
  readonly agentId: string;
  readonly projectId: string;
  readonly title: string;
  readonly status: AgentControlStatus;
  readonly sessionStatus: OrchestrationSessionStatus | null;
  readonly activeTurnId: string | null;
  readonly latestTurnId: string | null;
  readonly latestTurnState: OrchestrationLatestTurnState | null;
  readonly providerInstanceId: string;
  readonly model: string;
  readonly archivedAt: string | null;
  readonly updatedAt: string;
}

export interface AgentLogsSnapshot {
  readonly agentId: string;
  readonly messages: ReadonlyArray<OrchestrationMessage>;
}

export function deriveAgentStatus(thread: OrchestrationThread): AgentControlStatus {
  if (thread.archivedAt !== null) return "archived";

  switch (thread.latestTurn?.state) {
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "interrupted":
      return "interrupted";
    case "error":
      return "failed";
    case undefined:
      break;
  }

  switch (thread.session?.status) {
    case "starting":
    case "running":
      return "running";
    case "interrupted":
      return "interrupted";
    case "error":
      return "failed";
    case "idle":
    case "ready":
    case "stopped":
    case undefined:
      return "idle";
  }
}

export function toAgentStatusSnapshot(thread: OrchestrationThread): AgentStatusSnapshot {
  return {
    agentId: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    status: deriveAgentStatus(thread),
    sessionStatus: thread.session?.status ?? null,
    activeTurnId: thread.session?.activeTurnId ?? null,
    latestTurnId: thread.latestTurn?.turnId ?? null,
    latestTurnState: thread.latestTurn?.state ?? null,
    providerInstanceId: thread.modelSelection.instanceId,
    model: thread.modelSelection.model,
    archivedAt: thread.archivedAt,
    updatedAt: thread.updatedAt,
  };
}

export function toAgentLogsSnapshot(thread: OrchestrationThread): AgentLogsSnapshot {
  return {
    agentId: thread.id,
    messages: thread.messages,
  };
}
