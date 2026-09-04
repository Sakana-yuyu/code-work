import type { ThreadGoal, ThreadGoalEvent } from "@codework/contracts";

export function resolveThreadGoalSnapshot(
  queryGoal: ThreadGoal | null,
  event: ThreadGoalEvent | null,
): ThreadGoal | null {
  if (event === null) return queryGoal;
  return event.type === "updated" ? event.goal : null;
}
