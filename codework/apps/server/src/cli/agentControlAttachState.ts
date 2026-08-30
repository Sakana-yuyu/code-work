import type { OrchestrationMessage, OrchestrationThreadStreamItem } from "@codework/contracts";

import {
  initialAgentStreamState,
  reduceAgentStreamState,
  type AgentStreamState,
} from "./agentControlStreamState.ts";
import {
  deriveAgentStatus,
  toAgentStatusSnapshot,
  type AgentControlStatus,
  type AgentStatusSnapshot,
} from "./agentControlState.ts";

export interface AgentAttachMessageFrame {
  readonly kind: "message";
  readonly change: "snapshot" | "new" | "append" | "replace";
  readonly agentId: string;
  readonly messageId: string;
  readonly role: OrchestrationMessage["role"];
  readonly turnId: string | null;
  readonly text: string;
  readonly streaming: boolean;
  readonly attachments?: OrchestrationMessage["attachments"];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AgentAttachMessageRemovedFrame {
  readonly kind: "message-removed";
  readonly agentId: string;
  readonly messageId: string;
}

export interface AgentAttachStatusFrame {
  readonly kind: "status";
  readonly agentId: string;
  readonly status: AgentControlStatus;
  readonly snapshot: AgentStatusSnapshot;
}

export type AgentAttachFrame =
  | AgentAttachMessageFrame
  | AgentAttachMessageRemovedFrame
  | AgentAttachStatusFrame;

export type AgentAttachUnavailableReason = "deleted" | "missing-thread" | "missing-turn";

export interface AgentAttachState {
  readonly stream: AgentStreamState;
  readonly initialized: boolean;
  readonly lastStatus: AgentControlStatus | null;
}

export interface AgentAttachReduction {
  readonly state: AgentAttachState;
  readonly frames: ReadonlyArray<AgentAttachFrame>;
  readonly done: boolean;
  readonly unavailableReason: AgentAttachUnavailableReason | null;
}

export const initialAgentAttachState: AgentAttachState = {
  stream: initialAgentStreamState,
  initialized: false,
  lastStatus: null,
};

const isTerminalStatus = (status: AgentControlStatus): boolean =>
  status === "completed" ||
  status === "interrupted" ||
  status === "failed" ||
  status === "archived";

const toMessageFrame = (
  agentId: string,
  message: OrchestrationMessage,
  change: AgentAttachMessageFrame["change"],
  text: string,
): AgentAttachMessageFrame => ({
  kind: "message",
  change,
  agentId,
  messageId: message.id,
  role: message.role,
  turnId: message.turnId,
  text,
  streaming: message.streaming,
  ...(message.attachments === undefined ? {} : { attachments: message.attachments }),
  createdAt: message.createdAt,
  updatedAt: message.updatedAt,
});

function projectMessageFrames(
  previous: AgentStreamState["thread"],
  next: NonNullable<AgentStreamState["thread"]>,
  initialSnapshot: boolean,
): ReadonlyArray<AgentAttachFrame> {
  if (initialSnapshot) {
    return next.messages.map((message) =>
      toMessageFrame(next.id, message, "snapshot", message.text),
    );
  }

  const previousMessages = new Map(previous?.messages.map((message) => [message.id, message]));
  const nextMessageIds = new Set(next.messages.map((message) => message.id));
  const frames: Array<AgentAttachFrame> = [];

  for (const message of next.messages) {
    const prior = previousMessages.get(message.id);
    if (prior === undefined) {
      frames.push(toMessageFrame(next.id, message, "new", message.text));
      continue;
    }
    if (
      prior.text === message.text &&
      prior.streaming === message.streaming &&
      prior.updatedAt === message.updatedAt
    ) {
      continue;
    }

    const appended = message.text.startsWith(prior.text);
    frames.push(
      toMessageFrame(
        next.id,
        message,
        appended ? "append" : "replace",
        appended ? message.text.slice(prior.text.length) : message.text,
      ),
    );
  }

  for (const message of previous?.messages ?? []) {
    if (!nextMessageIds.has(message.id)) {
      frames.push({ kind: "message-removed", agentId: next.id, messageId: message.id });
    }
  }

  return frames;
}

export function reduceAgentAttachState(
  state: AgentAttachState,
  item: OrchestrationThreadStreamItem,
): AgentAttachReduction {
  const stream = reduceAgentStreamState(state.stream, item);
  const thread = stream.thread;
  const initialSnapshot = !state.initialized && item.kind === "snapshot";
  const messageFrames =
    thread === null ? [] : projectMessageFrames(state.stream.thread, thread, initialSnapshot);
  const status = thread === null ? null : deriveAgentStatus(thread);
  const done = status !== null && isTerminalStatus(status);
  const statusFrames: ReadonlyArray<AgentAttachStatusFrame> =
    done && status !== state.lastStatus && thread !== null
      ? [
          {
            kind: "status",
            agentId: thread.id,
            status,
            snapshot: toAgentStatusSnapshot(thread),
          },
        ]
      : [];
  const unavailableReason = stream.deleted
    ? "deleted"
    : item.kind !== "synchronized"
      ? null
      : thread === null
        ? "missing-thread"
        : thread.latestTurn === null
          ? "missing-turn"
          : null;

  return {
    state: {
      stream,
      initialized: state.initialized || thread !== null,
      lastStatus: status,
    },
    frames: [...messageFrames, ...statusFrames],
    done,
    unavailableReason,
  };
}
