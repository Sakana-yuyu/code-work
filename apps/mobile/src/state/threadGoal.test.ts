import type { ThreadGoal, ThreadGoalEvent } from "@codework/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveThreadGoalSnapshot } from "./threadGoal.logic";

const goal = (status: ThreadGoal["status"] = "active"): ThreadGoal => ({
  threadId: "thread-1" as ThreadGoal["threadId"],
  goalId: "goal-1" as ThreadGoal["goalId"],
  objective: "Keep the release green",
  status,
  createdAt: 1,
  updatedAt: 2,
  timeUsedSeconds: 3,
  tokenBudget: 100,
  tokensUsed: 20,
});

describe("thread goal mobile state", () => {
  it("uses an update event for the current thread goal", () => {
    const event: ThreadGoalEvent = { type: "updated", goal: goal("paused") };

    expect(resolveThreadGoalSnapshot(goal(), event)).toEqual(event.goal);
  });

  it("turns a clear event into an empty state", () => {
    const event: ThreadGoalEvent = {
      type: "cleared",
      threadId: "thread-1" as ThreadGoal["threadId"],
      goalId: "goal-1" as ThreadGoal["goalId"],
      clearedAt: 4,
    };

    expect(resolveThreadGoalSnapshot(goal(), event)).toBeNull();
  });

  it("keeps the query snapshot without an event", () => {
    expect(resolveThreadGoalSnapshot(goal("blocked"), null)?.status).toBe("blocked");
  });
});
