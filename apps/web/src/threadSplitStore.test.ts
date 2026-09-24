import { EnvironmentId, ThreadId } from "@codework/contracts";
import { describe, expect, it } from "vite-plus/test";

import { normalizeThreadSplitPersistedState } from "./threadSplitStore";

describe("thread split persistence", () => {
  it("restores a valid secondary thread and vertical orientation", () => {
    const secondaryThreadRef = {
      environmentId: EnvironmentId.make("remote"),
      threadId: ThreadId.make("thread-2"),
    };
    expect(
      normalizeThreadSplitPersistedState({
        primaryThreadRef: secondaryThreadRef,
        secondaryThreadRef,
        dividerRatio: 0.67,
        orientation: "vertical",
      }),
    ).toEqual({ secondaryThreadRef, dividerRatio: 0.67, orientation: "vertical" });
  });

  it("rejects invalid references and bounds the restored ratio", () => {
    expect(
      normalizeThreadSplitPersistedState({
        secondaryThreadRef: { environmentId: "remote" },
        dividerRatio: Infinity,
        orientation: "diagonal",
      }),
    ).toEqual({ secondaryThreadRef: null, dividerRatio: 0.5, orientation: "horizontal" });
    expect(normalizeThreadSplitPersistedState({ dividerRatio: 3 }).dividerRatio).toBe(0.75);
  });
});
