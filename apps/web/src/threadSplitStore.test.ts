import { EnvironmentId, ThreadId } from "@codework/contracts";
import { describe, expect, it } from "vite-plus/test";

import { normalizeThreadSplitPersistedState, useThreadSplitStore } from "./threadSplitStore";

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
    ).toEqual({
      secondaryThreadRef,
      tertiaryThreadRef: null,
      dividerRatio: 0.67,
      secondaryDividerRatio: 0.5,
      orientation: "vertical",
    });
  });

  it("rejects invalid references and bounds the restored ratio", () => {
    expect(
      normalizeThreadSplitPersistedState({
        secondaryThreadRef: { environmentId: "remote" },
        dividerRatio: Infinity,
        orientation: "diagonal",
      }),
    ).toEqual({
      secondaryThreadRef: null,
      tertiaryThreadRef: null,
      dividerRatio: 0.5,
      secondaryDividerRatio: 0.5,
      orientation: "horizontal",
    });
    expect(normalizeThreadSplitPersistedState({ dividerRatio: 3 }).dividerRatio).toBe(0.75);
  });

  it("restores a distinct third thread and bounds its divider", () => {
    const secondaryThreadRef = {
      environmentId: EnvironmentId.make("remote"),
      threadId: ThreadId.make("thread-2"),
    };
    const tertiaryThreadRef = {
      environmentId: EnvironmentId.make("remote"),
      threadId: ThreadId.make("thread-3"),
    };
    expect(
      normalizeThreadSplitPersistedState({
        secondaryThreadRef,
        tertiaryThreadRef,
        secondaryDividerRatio: 0.9,
      }),
    ).toMatchObject({
      secondaryThreadRef,
      tertiaryThreadRef,
      secondaryDividerRatio: 0.75,
    });
    expect(
      normalizeThreadSplitPersistedState({
        secondaryThreadRef,
        tertiaryThreadRef: secondaryThreadRef,
      }).tertiaryThreadRef,
    ).toBeNull();
  });

  it("fills two side panes and promotes the third when the middle pane closes", () => {
    const primary = { environmentId: EnvironmentId.make("local"), threadId: ThreadId.make("one") };
    const secondary = {
      environmentId: EnvironmentId.make("local"),
      threadId: ThreadId.make("two"),
    };
    const tertiary = {
      environmentId: EnvironmentId.make("local"),
      threadId: ThreadId.make("three"),
    };
    const store = useThreadSplitStore.getState();
    store.setPrimaryThreadRef(primary);
    store.openSecondaryThread(secondary);
    store.openSecondaryThread(tertiary);
    store.openSecondaryThread(tertiary);
    expect(useThreadSplitStore.getState()).toMatchObject({
      secondaryThreadRef: secondary,
      tertiaryThreadRef: tertiary,
    });
    useThreadSplitStore.getState().swapSecondaryAndTertiary();
    expect(useThreadSplitStore.getState()).toMatchObject({
      secondaryThreadRef: tertiary,
      tertiaryThreadRef: secondary,
    });
    useThreadSplitStore.getState().swapSecondaryAndTertiary();
    useThreadSplitStore.getState().closeSecondaryThread();
    expect(useThreadSplitStore.getState()).toMatchObject({
      secondaryThreadRef: tertiary,
      tertiaryThreadRef: null,
    });
    useThreadSplitStore.getState().closeSecondaryThread();
    useThreadSplitStore.getState().setPrimaryThreadRef(null);
  });
});
