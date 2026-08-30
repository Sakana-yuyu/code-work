import type {
  ClientOrchestrationCommand,
  CommandId,
  OrchestrationThread,
} from "@codework/contracts";

type AgentArchiveThreadState = Pick<OrchestrationThread, "id" | "archivedAt">;

export interface AgentArchiveResult {
  readonly agentId: string;
  readonly commandId: string;
  readonly sequence: number;
}

export type AgentArchivePlan =
  | {
      readonly ok: true;
      readonly command: Extract<ClientOrchestrationCommand, { readonly type: "thread.archive" }>;
    }
  | {
      readonly ok: false;
      readonly reason: "already-archived";
      readonly message: string;
    };

export type AgentUnarchivePlan =
  | {
      readonly ok: true;
      readonly command: Extract<ClientOrchestrationCommand, { readonly type: "thread.unarchive" }>;
    }
  | {
      readonly ok: false;
      readonly reason: "not-archived";
      readonly message: string;
    };

export function planAgentArchiveCommand(
  thread: AgentArchiveThreadState,
  commandId: CommandId,
): AgentArchivePlan {
  if (thread.archivedAt !== null) {
    return {
      ok: false,
      reason: "already-archived",
      message: `Agent '${thread.id}' is already archived.`,
    };
  }

  return {
    ok: true,
    command: {
      type: "thread.archive",
      commandId,
      threadId: thread.id,
    },
  };
}

export function planAgentUnarchiveCommand(
  thread: AgentArchiveThreadState,
  commandId: CommandId,
): AgentUnarchivePlan {
  if (thread.archivedAt === null) {
    return {
      ok: false,
      reason: "not-archived",
      message: `Agent '${thread.id}' is not archived.`,
    };
  }

  return {
    ok: true,
    command: {
      type: "thread.unarchive",
      commandId,
      threadId: thread.id,
    },
  };
}
