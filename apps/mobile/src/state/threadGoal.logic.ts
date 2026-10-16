import {
  isUnknownUnionMember,
  type ThreadGoal,
  type ThreadGoalEventWire,
} from "@codework/contracts";

export function resolveThreadGoalSnapshot(
  queryGoal: ThreadGoal | null,
  event: ThreadGoalEventWire | null,
): ThreadGoal | null {
  if (event === null || isUnknownUnionMember(event)) return queryGoal;
  return event.type === "updated" ? event.goal : null;
}
