import type {
  ClientOrchestrationCommand,
  CommandId,
  OrchestrationThread,
} from "@codework/contracts";

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

export function planAgentArchiveCommand(
  thread: OrchestrationThread,
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
