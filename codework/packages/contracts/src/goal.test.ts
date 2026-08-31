import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  ThreadGoal,
  ThreadGoalClearInput,
  ThreadGoalEvent,
  ThreadGoalPauseInput,
  ThreadGoalResumeInput,
  ThreadGoalSetInput,
  ThreadGoalStatus,
} from "./goal.ts";
import { ThreadId } from "./baseSchemas.ts";

const decodeThreadGoal = Schema.decodeUnknownSync(ThreadGoal);
const decodeThreadGoalSetInput = Schema.decodeUnknownSync(ThreadGoalSetInput);
const decodeThreadGoalStatus = Schema.decodeUnknownSync(ThreadGoalStatus);
const decodeThreadGoalEvent = Schema.decodeUnknownSync(ThreadGoalEvent);

describe("Thread Goal contracts", () => {
  it("accepts the persisted goal shape with a server-owned goal id", () => {
    const goal = decodeThreadGoal({
      threadId: ThreadId.make("thread-1"),
      goalId: "goal-1",
      objective: "Ship the native goal experience",
      status: "active",
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_001_000,
      timeUsedSeconds: 1,
      tokenBudget: 10_000,
      tokensUsed: 12,
    });

    expect(goal.goalId).toBe("goal-1");
    expect(goal.status).toBe("active");
    expect(goal.timeUsedSeconds).toBe(1);
  });

  it("keeps write inputs free of client-controlled goal identity and status", () => {
    expect(Object.keys(ThreadGoalSetInput.fields)).toEqual([
      "threadId",
      "objective",
      "tokenBudget",
    ]);
    expect(Object.keys(ThreadGoalPauseInput.fields)).toEqual(["threadId"]);
    expect(Object.keys(ThreadGoalResumeInput.fields)).toEqual(["threadId"]);
    expect(Object.keys(ThreadGoalClearInput.fields)).toEqual(["threadId"]);
  });

  it("enforces objective boundaries at the write contract", () => {
    const valid = decodeThreadGoalSetInput({
      threadId: ThreadId.make("thread-1"),
      objective: "Ship it",
      tokenBudget: null,
    });
    expect(valid.objective).toBe("Ship it");
    expect(() =>
      decodeThreadGoalSetInput({ threadId: "thread-1", objective: "   ", tokenBudget: null }),
    ).toThrow();
    expect(() =>
      decodeThreadGoalSetInput({
        threadId: "thread-1",
        objective: `line${String.fromCharCode(10)}break`,
      }),
    ).toThrow();
    expect(() =>
      decodeThreadGoalSetInput({ threadId: "thread-1", objective: "a".repeat(4_001) }),
    ).toThrow();
    expect(
      decodeThreadGoalSetInput({ threadId: "thread-1", objective: "a".repeat(4_000) }).objective,
    ).toHaveLength(4_000);
  });

  it("exposes the canonical states and update/clear events", () => {
    expect(decodeThreadGoalStatus("usageLimited")).toBe("usageLimited");
    expect(
      decodeThreadGoalEvent({
        type: "updated",
        goal: {
          threadId: "thread-1",
          goalId: "goal-1",
          objective: "Ship it",
          status: "complete",
          createdAt: 1,
          updatedAt: 2,
          timeUsedSeconds: 0,
          tokenBudget: null,
          tokensUsed: 0,
        },
      }).type,
    ).toBe("updated");
  });
});
