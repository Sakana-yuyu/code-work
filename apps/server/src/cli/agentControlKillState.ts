import type {
  ClientOrchestrationCommand,
  CommandId,
  OrchestrationThread,
  TurnId,
} from "@codework/contracts";

export interface AgentKillIdentity {
  readonly commandId: CommandId;
  readonly createdAt: string;
}

export interface AgentKillResult {
  readonly agentId: string;
  readonly turnId: string;
  readonly commandId: string;
  readonly sequence: number;
  readonly createdAt: string;
}

export type AgentKillPlan =
  | {
      readonly ok: true;
      readonly turnId: TurnId;
      readonly command: Extract<
        ClientOrchestrationCommand,
        { readonly type: "thread.turn.interrupt" }
      >;
    }
  | {
      readonly ok: false;
      readonly reason: "no-active-turn";
      readonly message: string;
    };

const activeTurnId = (thread: OrchestrationThread): TurnId | null => {
  if (thread.session?.activeTurnId !== null && thread.session?.activeTurnId !== undefined) {
    return thread.session.activeTurnId;
  }
  if (thread.latestTurn?.state === "running") return thread.latestTurn.turnId;
  return null;
};

export function planAgentKillCommand(
  thread: OrchestrationThread,
  identity: AgentKillIdentity,
): AgentKillPlan {
  const turnId = activeTurnId(thread);
  if (turnId === null) {
    return {
      ok: false,
      reason: "no-active-turn",
      message: `Agent '${thread.id}' has no active turn to interrupt.`,
    };
  }

  return {
    ok: true,
    turnId,
    command: {
      type: "thread.turn.interrupt",
      commandId: identity.commandId,
      threadId: thread.id,
      turnId,
      createdAt: identity.createdAt,
    },
  };
}
