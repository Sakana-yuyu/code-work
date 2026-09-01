import type { ScopedThreadRef } from "@codework/contracts";
import { create } from "zustand";

interface ThreadSplitState {
  readonly secondaryThreadRef: ScopedThreadRef | null;
  readonly dividerRatio: number;
  openSecondaryThread: (threadRef: ScopedThreadRef) => void;
  closeSecondaryThread: () => void;
  setDividerRatio: (ratio: number) => void;
}

const DEFAULT_DIVIDER_RATIO = 0.5;

export const useThreadSplitStore = create<ThreadSplitState>((set) => ({
  secondaryThreadRef: null,
  dividerRatio: DEFAULT_DIVIDER_RATIO,
  openSecondaryThread: (threadRef) => set({ secondaryThreadRef: threadRef }),
  closeSecondaryThread: () => set({ secondaryThreadRef: null }),
  setDividerRatio: (ratio) => set({ dividerRatio: Math.min(0.75, Math.max(0.25, ratio)) }),
}));
