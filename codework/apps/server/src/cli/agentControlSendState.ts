import type {
  ClientOrchestrationCommand,
  CommandId,
  MessageId,
  OrchestrationThread,
} from "@codework/contracts";

export interface AgentSendIdentity {
  readonly commandId: CommandId;
  readonly messageId: MessageId;
  readonly createdAt: string;
}

export interface AgentSendResult {
  readonly agentId: string;
  readonly commandId: string;
  readonly messageId: string;
  readonly sequence: number;
  readonly createdAt: string;
}

export type AgentSendPlan =
  | {
      readonly ok: true;
      readonly command: Extract<ClientOrchestrationCommand, { readonly type: "thread.turn.start" }>;
    }
  | {
      readonly ok: false;
      readonly reason: "invalid-prompt" | "archived" | "busy";
      readonly message: string;
    };

const isBusy = (thread: OrchestrationThread): boolean =>
  thread.latestTurn?.state === "running" ||
  (thread.session?.activeTurnId !== null && thread.session?.activeTurnId !== undefined) ||
  thread.session?.status === "starting" ||
  thread.session?.status === "running";

export function planAgentSendCommand(
  thread: OrchestrationThread,
  prompt: string,
  identity: AgentSendIdentity,
): AgentSendPlan {
  if (prompt.trim().length === 0) {
    return {
      ok: false,
      reason: "invalid-prompt",
      message: "Prompt must contain non-whitespace text.",
    };
  }
  if (thread.archivedAt !== null) {
    return {
      ok: false,
      reason: "archived",
      message: `Agent '${thread.id}' is archived and cannot accept a new prompt.`,
    };
  }
  if (isBusy(thread)) {
    return {
      ok: false,
      reason: "busy",
      message: `Agent '${thread.id}' already has an active turn.`,
    };
  }

  return {
    ok: true,
    command: {
      type: "thread.turn.start",
      commandId: identity.commandId,
      threadId: thread.id,
      message: {
        messageId: identity.messageId,
        role: "user",
        text: prompt,
        attachments: [],
      },
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      createdAt: identity.createdAt,
    },
  };
}
