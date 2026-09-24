import { ScopedThreadRef } from "@codework/contracts";
import * as Schema from "effect/Schema";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export type ThreadSplitOrientation = "horizontal" | "vertical";

interface ThreadSplitState {
  readonly primaryThreadRef: ScopedThreadRef | null;
  readonly secondaryThreadRef: ScopedThreadRef | null;
  readonly dividerRatio: number;
  readonly orientation: ThreadSplitOrientation;
  setPrimaryThreadRef: (threadRef: ScopedThreadRef | null) => void;
  openSecondaryThread: (threadRef: ScopedThreadRef) => void;
  closeSecondaryThread: () => void;
  setDividerRatio: (ratio: number) => void;
  toggleOrientation: () => void;
}

const DEFAULT_DIVIDER_RATIO = 0.5;

const isScopedThreadRef = Schema.is(ScopedThreadRef);

/** 只恢复有效的会话引用和分隔比例，路由驱动的主会话不写入持久状态。 */
export function normalizeThreadSplitPersistedState(value: unknown): {
  secondaryThreadRef: ScopedThreadRef | null;
  dividerRatio: number;
  orientation: ThreadSplitOrientation;
} {
  const source =
    value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const ratio = source.dividerRatio;
  return {
    secondaryThreadRef: isScopedThreadRef(source.secondaryThreadRef)
      ? source.secondaryThreadRef
      : null,
    dividerRatio:
      typeof ratio === "number" && Number.isFinite(ratio)
        ? Math.min(0.75, Math.max(0.25, ratio))
        : DEFAULT_DIVIDER_RATIO,
    orientation: source.orientation === "vertical" ? "vertical" : "horizontal",
  };
}

export const useThreadSplitStore = create<ThreadSplitState>()(
  persist(
    (set) => ({
      primaryThreadRef: null,
      secondaryThreadRef: null,
      dividerRatio: DEFAULT_DIVIDER_RATIO,
      orientation: "horizontal",
      setPrimaryThreadRef: (threadRef) => set({ primaryThreadRef: threadRef }),
      openSecondaryThread: (threadRef) => set({ secondaryThreadRef: threadRef }),
      closeSecondaryThread: () => set({ secondaryThreadRef: null }),
      setDividerRatio: (ratio) => set({ dividerRatio: Math.min(0.75, Math.max(0.25, ratio)) }),
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
        dividerRatio: state.dividerRatio,
        orientation: state.orientation,
      }),
      merge: (persisted, current) => ({
        ...current,
        ...normalizeThreadSplitPersistedState(persisted),
      }),
    },
  ),
);
