import type { SpecWorkflowState, SpecWorkflowStateEvent } from "@codework/contracts";

import { SpecWorkflowTransitionError } from "./SpecWorkflowDecider.ts";

export const projectSpecWorkflowEvent = (
  current: SpecWorkflowState | undefined,
  event: SpecWorkflowStateEvent,
): SpecWorkflowState => {
  if (event.type === "started") {
    if (current !== undefined) {
      throw new SpecWorkflowTransitionError({
        code: "invalid-state",
        detail: "同一个工作流不能重复 started。",
        from: current.stage,
      });
    }
    return event.state;
  }

  if (current === undefined) {
    throw new SpecWorkflowTransitionError({
      code: "invalid-state",
      detail: "没有 started 事件，不能投影后续状态变更。",
      from: event.state.stage,
      to: event.state.stage,
    });
  }
  if (event.state.workflowId !== current.workflowId || event.state.threadId !== current.threadId) {
    throw new SpecWorkflowTransitionError({
      code: "invalid-state",
      detail: "事件所属工作流或线程与当前投影不一致。",
      from: current.stage,
      to: event.state.stage,
    });
  }
  if (event.state.revision !== current.revision + 1) {
    throw new SpecWorkflowTransitionError({
      code: "revision-conflict",
      detail: "事件 revision 不是当前投影的下一个版本。",
      from: current.stage,
      to: event.state.stage,
    });
  }
  return event.state;
};

export const replaySpecWorkflowEvents = (
  events: ReadonlyArray<SpecWorkflowStateEvent>,
): SpecWorkflowState | undefined => {
  let current: SpecWorkflowState | undefined;
  for (const event of events) current = projectSpecWorkflowEvent(current, event);
  return current;
};
