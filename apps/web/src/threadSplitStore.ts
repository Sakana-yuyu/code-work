import type { ScopedThreadRef } from "@codework/contracts";
import { create } from "zustand";

interface ThreadSplitState {
  readonly primaryThreadRef: ScopedThreadRef | null;
  readonly secondaryThreadRef: ScopedThreadRef | null;
  readonly dividerRatio: number;
  setPrimaryThreadRef: (threadRef: ScopedThreadRef | null) => void;
  openSecondaryThread: (threadRef: ScopedThreadRef) => void;
  closeSecondaryThread: () => void;
  setDividerRatio: (ratio: number) => void;
}

const DEFAULT_DIVIDER_RATIO = 0.5;

export const useThreadSplitStore = create<ThreadSplitState>((set) => ({
  primaryThreadRef: null,
  secondaryThreadRef: null,
  dividerRatio: DEFAULT_DIVIDER_RATIO,
  setPrimaryThreadRef: (threadRef) => set({ primaryThreadRef: threadRef }),
  openSecondaryThread: (threadRef) => set({ secondaryThreadRef: threadRef }),
  closeSecondaryThread: () => set({ secondaryThreadRef: null }),
  setDividerRatio: (ratio) => set({ dividerRatio: Math.min(0.75, Math.max(0.25, ratio)) }),
}));
