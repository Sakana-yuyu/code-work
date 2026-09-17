import { ThreadGoalRpcError, type ThreadGoal, type ThreadGoalEvent } from "@codework/contracts";
import * as Cause from "effect/Cause";
import { describe, expect, it } from "vite-plus/test";

import { isThreadGoalAlreadyCleared, resolveThreadGoalSnapshot } from "./threadGoal";

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

describe("thread goal web state", () => {
  it("uses a live update event for the current thread goal", () => {
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

  it("keeps the query snapshot when no event has arrived", () => {
    expect(resolveThreadGoalSnapshot(goal("blocked"), null)?.status).toBe("blocked");
  });

  it("treats a server-side already-cleared goal as a successful clear", () => {
    expect(
      isThreadGoalAlreadyCleared(
        Cause.fail(new ThreadGoalRpcError({ code: "goal-not-found", message: "already cleared" })),
      ),
    ).toBe(true);
    expect(
      isThreadGoalAlreadyCleared(
        Cause.fail(new ThreadGoalRpcError({ code: "stale-version", message: "changed" })),
      ),
    ).toBe(false);
  });
});
