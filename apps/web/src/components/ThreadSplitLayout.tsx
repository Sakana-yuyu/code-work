import type { ScopedThreadRef } from "@codework/contracts";
import { XIcon } from "lucide-react";
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useCallback,
} from "react";

import ChatView from "./ChatView";
import { Button } from "./ui/button";
import { t } from "../i18n";
import { useThreadSplitStore } from "../threadSplitStore";
import { scopedThreadKey } from "@codework/client-runtime/environment";

export function ThreadSplitLayout(props: {
  readonly primaryThreadRef: ScopedThreadRef | null;
  readonly children: ReactNode;
}) {
  const { primaryThreadRef, children } = props;
  const secondaryThreadRef = useThreadSplitStore((state) => state.secondaryThreadRef);
  const dividerRatio = useThreadSplitStore((state) => state.dividerRatio);
  const closeSecondaryThread = useThreadSplitStore((state) => state.closeSecondaryThread);
  const setDividerRatio = useThreadSplitStore((state) => state.setDividerRatio);
  // Publish the main-view thread so menu builders can tell which threads are
  // already on screen ("open beside" is a no-op for both panes).
  useEffect(() => {
    const state = useThreadSplitStore.getState();
    const currentKey = state.primaryThreadRef ? scopedThreadKey(state.primaryThreadRef) : null;
    const nextKey = primaryThreadRef ? scopedThreadKey(primaryThreadRef) : null;
    if (currentKey !== nextKey) {
      state.setPrimaryThreadRef(primaryThreadRef);
    }
  }, [primaryThreadRef]);
  const secondaryIsDistinct =
    secondaryThreadRef !== null &&
    scopedThreadKey(secondaryThreadRef) !==
      (primaryThreadRef === null ? null : scopedThreadKey(primaryThreadRef));

  const handleDividerPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!secondaryIsDistinct || event.button !== 0) return;
      const container = event.currentTarget.parentElement;
      if (!container) return;
      const bounds = container.getBoundingClientRect();
      const vertical = window.matchMedia("(min-width: 768px)").matches;
      const updateRatio = (clientX: number, clientY: number) => {
        const total = vertical ? bounds.width : bounds.height;
        const offset = vertical ? clientX - bounds.left : clientY - bounds.top;
        if (total <= 0) return;
        setDividerRatio(offset / total);
      };
      const onPointerMove = (moveEvent: PointerEvent) =>
        updateRatio(moveEvent.clientX, moveEvent.clientY);
      const onPointerUp = () => {
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
      };
      updateRatio(event.clientX, event.clientY);
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp, { once: true });
    },
    [secondaryIsDistinct, setDividerRatio],
  );

  if (!secondaryIsDistinct || secondaryThreadRef === null) {
    return <>{children}</>;
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden md:flex-row">
      <section
        className="relative flex min-h-0 min-w-0 w-full flex-col overflow-hidden md:w-[var(--thread-split-primary)] md:flex-none"
        style={{ "--thread-split-primary": `${dividerRatio * 100}%` } as CSSProperties}
      >
        {children}
      </section>
      <div
        aria-label={t("resizeConversationSplit")}
        aria-orientation="vertical"
        className="group relative z-30 h-2 w-full shrink-0 cursor-row-resize border-y border-border/70 bg-background/80 hover:bg-accent/60 md:h-full md:w-1.5 md:cursor-col-resize md:border-y-0 md:border-x"
        onPointerDown={handleDividerPointerDown}
        role="separator"
      >
        <div className="absolute inset-0 m-auto h-0.5 w-8 rounded-full bg-border opacity-70 transition-opacity group-hover:opacity-100 md:h-8 md:w-0.5" />
      </div>
      <section
        className="relative flex min-h-0 min-w-0 w-full flex-1 flex-col overflow-hidden md:w-[var(--thread-split-secondary)] md:flex-none"
        style={{ "--thread-split-secondary": `${(1 - dividerRatio) * 100}%` } as CSSProperties}
      >
        <ChatView
          environmentId={secondaryThreadRef.environmentId}
          threadId={secondaryThreadRef.threadId}
          routeKind="server"
          reserveTitleBarControlInset
        />
        <Button
          aria-label={t("closeSplitConversation")}
          className="absolute top-1 right-2 z-[70] size-7 rounded-full border border-border/70 bg-background/85 p-0 shadow-sm backdrop-blur-sm hover:bg-accent"
          onClick={closeSecondaryThread}
          size="icon"
          type="button"
          variant="ghost"
        >
          <XIcon className="size-3.5" />
        </Button>
      </section>
    </div>
  );
}
