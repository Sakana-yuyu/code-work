import { ScopedThreadRef } from "@codework/contracts";
import * as Schema from "effect/Schema";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export type ThreadSplitOrientation = "horizontal" | "vertical";

interface ThreadSplitState {
  readonly primaryThreadRef: ScopedThreadRef | null;
  readonly secondaryThreadRef: ScopedThreadRef | null;
  readonly tertiaryThreadRef: ScopedThreadRef | null;
  readonly dividerRatio: number;
  readonly secondaryDividerRatio: number;
  readonly orientation: ThreadSplitOrientation;
  setPrimaryThreadRef: (threadRef: ScopedThreadRef | null) => void;
  openSecondaryThread: (threadRef: ScopedThreadRef) => void;
  closeSecondaryThread: () => void;
  closeTertiaryThread: () => void;
  swapSecondaryAndTertiary: () => void;
  setDividerRatio: (ratio: number) => void;
  setSecondaryDividerRatio: (ratio: number) => void;
  toggleOrientation: () => void;
}

const DEFAULT_DIVIDER_RATIO = 0.5;

const isScopedThreadRef = Schema.is(ScopedThreadRef);
const sameThread = (left: ScopedThreadRef | null, right: ScopedThreadRef | null) =>
  left !== null &&
  right !== null &&
  left.environmentId === right.environmentId &&
  left.threadId === right.threadId;

/** 只恢复有效的会话引用和分隔比例，路由驱动的主会话不写入持久状态。 */
export function normalizeThreadSplitPersistedState(value: unknown): {
  secondaryThreadRef: ScopedThreadRef | null;
  tertiaryThreadRef: ScopedThreadRef | null;
  dividerRatio: number;
  secondaryDividerRatio: number;
  orientation: ThreadSplitOrientation;
} {
  const source =
    value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const ratio = source.dividerRatio;
  const secondaryRatio = source.secondaryDividerRatio;
  const secondaryThreadRef = isScopedThreadRef(source.secondaryThreadRef)
    ? source.secondaryThreadRef
    : null;
  const tertiaryThreadRef = isScopedThreadRef(source.tertiaryThreadRef)
    ? source.tertiaryThreadRef
    : null;
  return {
    secondaryThreadRef,
    tertiaryThreadRef:
      secondaryThreadRef !== null && !sameThread(secondaryThreadRef, tertiaryThreadRef)
        ? tertiaryThreadRef
        : null,
    dividerRatio:
      typeof ratio === "number" && Number.isFinite(ratio)
        ? Math.min(0.75, Math.max(0.25, ratio))
        : DEFAULT_DIVIDER_RATIO,
    secondaryDividerRatio:
      typeof secondaryRatio === "number" && Number.isFinite(secondaryRatio)
        ? Math.min(0.75, Math.max(0.25, secondaryRatio))
        : DEFAULT_DIVIDER_RATIO,
    orientation: source.orientation === "vertical" ? "vertical" : "horizontal",
  };
}

export const useThreadSplitStore = create<ThreadSplitState>()(
  persist(
    (set) => ({
      primaryThreadRef: null,
      secondaryThreadRef: null,
      tertiaryThreadRef: null,
      dividerRatio: DEFAULT_DIVIDER_RATIO,
      secondaryDividerRatio: DEFAULT_DIVIDER_RATIO,
      orientation: "horizontal",
      setPrimaryThreadRef: (threadRef) => set({ primaryThreadRef: threadRef }),
      openSecondaryThread: (threadRef) =>
        set((state) => {
          if (
            sameThread(threadRef, state.primaryThreadRef) ||
            sameThread(threadRef, state.secondaryThreadRef) ||
            sameThread(threadRef, state.tertiaryThreadRef)
          ) {
            return state;
          }
          return state.secondaryThreadRef === null
            ? { secondaryThreadRef: threadRef }
            : { tertiaryThreadRef: threadRef };
        }),
      closeSecondaryThread: () =>
        set((state) => ({
          secondaryThreadRef: state.tertiaryThreadRef,
          tertiaryThreadRef: null,
        })),
      closeTertiaryThread: () => set({ tertiaryThreadRef: null }),
      swapSecondaryAndTertiary: () =>
        set((state) =>
          state.secondaryThreadRef === null || state.tertiaryThreadRef === null
            ? state
            : {
                secondaryThreadRef: state.tertiaryThreadRef,
                tertiaryThreadRef: state.secondaryThreadRef,
              },
        ),
      setDividerRatio: (ratio) => set({ dividerRatio: Math.min(0.75, Math.max(0.25, ratio)) }),
      setSecondaryDividerRatio: (ratio) =>
        set({ secondaryDividerRatio: Math.min(0.75, Math.max(0.25, ratio)) }),
      toggleOrientation: () =>
        set((state) => ({
          orientation: state.orientation === "horizontal" ? "vertical" : "horizontal",
        })),
    }),
    {
      name: "codework:thread-split:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        secondaryThreadRef: state.secondaryThreadRef,
        tertiaryThreadRef: state.tertiaryThreadRef,
        dividerRatio: state.dividerRatio,
        secondaryDividerRatio: state.secondaryDividerRatio,
        orientation: state.orientation,
      }),
      merge: (persisted, current) => ({
        ...current,
        ...normalizeThreadSplitPersistedState(persisted),
      }),
    },
  ),
);
