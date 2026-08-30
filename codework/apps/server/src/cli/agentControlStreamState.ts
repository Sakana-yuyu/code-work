import { applyThreadDetailEvent } from "@codework/client-runtime/state/thread-reducer";
import type { OrchestrationThread, OrchestrationThreadStreamItem } from "@codework/contracts";

import { deriveAgentStatus } from "./agentControlState.ts";

export interface AgentStreamState {
  readonly thread: OrchestrationThread | null;
  readonly synchronized: boolean;
  readonly deleted: boolean;
}

export const initialAgentStreamState: AgentStreamState = {
  thread: null,
  synchronized: false,
  deleted: false,
};

export function reduceAgentStreamState(
  state: AgentStreamState,
  item: OrchestrationThreadStreamItem,
): AgentStreamState {
  if (item.kind === "synchronized") {
    return { ...state, synchronized: true };
  }
  if (item.kind === "snapshot") {
    return {
      thread: item.snapshot.thread,
      synchronized: state.synchronized,
      deleted: false,
    };
  }
  if (state.thread === null) return state;

  const reduced = applyThreadDetailEvent(state.thread, item.event);
  switch (reduced.kind) {
    case "unchanged":
      return state;
    case "deleted":
      return { ...state, thread: null, deleted: true };
    case "updated":
      return { ...state, thread: reduced.thread };
  }
}

export function isAgentWaitComplete(state: AgentStreamState): boolean {
  if (state.thread === null) return false;
  const status = deriveAgentStatus(state.thread);
  return (
    status === "completed" ||
    status === "interrupted" ||
    status === "failed" ||
    status === "archived"
  );
}
