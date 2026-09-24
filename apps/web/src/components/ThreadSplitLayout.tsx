import type { ScopedThreadRef } from "@codework/contracts";
import { ArrowLeftRightIcon, Columns2Icon, Rows2Icon, XIcon } from "lucide-react";
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
import { useAllEnvironmentShellsBootstrapped, useThreadShell } from "../state/entities";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { cn } from "../lib/utils";

export function ThreadSplitLayout(props: {
  readonly primaryThreadRef: ScopedThreadRef | null;
  readonly children: ReactNode;
}) {
  const { primaryThreadRef, children } = props;
  const secondaryThreadRef = useThreadSplitStore((state) => state.secondaryThreadRef);
  const tertiaryThreadRef = useThreadSplitStore((state) => state.tertiaryThreadRef);
  const dividerRatio = useThreadSplitStore((state) => state.dividerRatio);
  const secondaryDividerRatio = useThreadSplitStore((state) => state.secondaryDividerRatio);
  const orientation = useThreadSplitStore((state) => state.orientation);
  const toggleOrientation = useThreadSplitStore((state) => state.toggleOrientation);
  const closeSecondaryThread = useThreadSplitStore((state) => state.closeSecondaryThread);
  const closeTertiaryThread = useThreadSplitStore((state) => state.closeTertiaryThread);
  const swapSecondaryAndTertiary = useThreadSplitStore((state) => state.swapSecondaryAndTertiary);
  const setDividerRatio = useThreadSplitStore((state) => state.setDividerRatio);
  const setSecondaryDividerRatio = useThreadSplitStore((state) => state.setSecondaryDividerRatio);
  const secondaryShell = useThreadShell(secondaryThreadRef);
  const tertiaryShell = useThreadShell(tertiaryThreadRef);
  const shellsBootstrapped = useAllEnvironmentShellsBootstrapped();
  const wideViewport = useMediaQuery({ min: 768 });
  const sideBySide = wideViewport && orientation === "horizontal";
  useEffect(() => {
    if (!shellsBootstrapped || secondaryThreadRef === null) return;
    if (secondaryShell === null) {
      closeSecondaryThread();
    }
  }, [closeSecondaryThread, secondaryThreadRef, secondaryShell, shellsBootstrapped]);
  useEffect(() => {
    if (!shellsBootstrapped || tertiaryThreadRef === null) return;
    if (tertiaryShell === null) closeTertiaryThread();
  }, [closeTertiaryThread, tertiaryThreadRef, tertiaryShell, shellsBootstrapped]);
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
  const tertiaryIsDistinct =
    secondaryIsDistinct &&
    secondaryThreadRef !== null &&
    tertiaryThreadRef !== null &&
    scopedThreadKey(tertiaryThreadRef) !== scopedThreadKey(secondaryThreadRef) &&
    scopedThreadKey(tertiaryThreadRef) !==
      (primaryThreadRef === null ? null : scopedThreadKey(primaryThreadRef));
  useEffect(() => {
    if (secondaryThreadRef !== null && !secondaryIsDistinct) closeSecondaryThread();
    if (tertiaryThreadRef !== null && !tertiaryIsDistinct) closeTertiaryThread();
  }, [
    closeSecondaryThread,
    closeTertiaryThread,
    secondaryIsDistinct,
    secondaryThreadRef,
    tertiaryIsDistinct,
    tertiaryThreadRef,
  ]);
  const secondaryPercent =
    (1 - dividerRatio) * (tertiaryIsDistinct ? secondaryDividerRatio : 1) * 100;
  const tertiaryPercent = (1 - dividerRatio) * (1 - secondaryDividerRatio) * 100;
  const dividerClassName = cn(
    "group relative z-30 shrink-0 border-border/70 bg-background/80 hover:bg-accent/60",
    sideBySide
      ? "h-full w-1.5 cursor-col-resize border-x"
      : "h-2 w-full cursor-row-resize border-y",
  );

  const handleDividerPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, divider: "primary" | "secondary") => {
      if (!secondaryIsDistinct || event.button !== 0) return;
      const container = event.currentTarget.parentElement;
      if (!container) return;
      const bounds = container.getBoundingClientRect();
      let firstRatio = dividerRatio;
      let secondRatio = secondaryDividerRatio;
      const updateRatio = (clientX: number, clientY: number) => {
        const total = sideBySide ? bounds.width : bounds.height;
        const offset = sideBySide ? clientX - bounds.left : clientY - bounds.top;
        if (total <= 0) return;
        if (divider === "primary") {
          firstRatio = Math.min(tertiaryIsDistinct ? 0.6 : 0.75, Math.max(0.25, offset / total));
        } else {
          secondRatio = Math.min(
            0.75,
            Math.max(0.25, (offset - firstRatio * total) / ((1 - firstRatio) * total)),
          );
        }
        container.style.setProperty("--thread-split-primary", `${firstRatio * 100}%`);
        container.style.setProperty(
          "--thread-split-secondary",
          `${(1 - firstRatio) * (tertiaryIsDistinct ? secondRatio : 1) * 100}%`,
        );
        container.style.setProperty(
          "--thread-split-tertiary",
          `${(1 - firstRatio) * (1 - secondRatio) * 100}%`,
        );
      };
      const onPointerMove = (moveEvent: PointerEvent) =>
        updateRatio(moveEvent.clientX, moveEvent.clientY);
      const onPointerUp = () => {
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        if (divider === "primary") setDividerRatio(firstRatio);
        else setSecondaryDividerRatio(secondRatio);
      };
      updateRatio(event.clientX, event.clientY);
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp, { once: true });
    },
    [
      dividerRatio,
      secondaryDividerRatio,
      secondaryIsDistinct,
      setDividerRatio,
      setSecondaryDividerRatio,
      sideBySide,
      tertiaryIsDistinct,
    ],
  );

  if (!secondaryIsDistinct || secondaryThreadRef === null) {
    return <>{children}</>;
  }

  return (
    <div
      className={cn(
        "flex h-full min-h-0 min-w-0 flex-1 overflow-hidden",
        sideBySide ? "flex-row" : "flex-col",
      )}
      style={
        {
          "--thread-split-primary": `${dividerRatio * 100}%`,
          "--thread-split-secondary": `${secondaryPercent}%`,
          "--thread-split-tertiary": `${tertiaryPercent}%`,
        } as CSSProperties
      }
    >
      <section
        data-thread-split-primary
        className={cn(
          "relative flex min-h-0 min-w-0 flex-col overflow-hidden",
          sideBySide
            ? "h-full w-[var(--thread-split-primary)] flex-none"
            : "h-[var(--thread-split-primary)] w-full flex-none",
        )}
      >
        {children}
      </section>
      <div
        aria-label={t("resizeConversationSplit")}
        aria-orientation={sideBySide ? "vertical" : "horizontal"}
        className={dividerClassName}
        onPointerDown={(event) => handleDividerPointerDown(event, "primary")}
        role="separator"
      >
        <div
          className={cn(
            "absolute inset-0 m-auto rounded-full bg-border opacity-70 transition-opacity group-hover:opacity-100",
            sideBySide ? "h-8 w-0.5" : "h-0.5 w-8",
          )}
        />
      </div>
      <section
        data-thread-split-secondary
        className={cn(
          "relative flex min-h-0 min-w-0 flex-col overflow-hidden",
          sideBySide
            ? "h-full w-[var(--thread-split-secondary)] flex-none"
            : "h-[var(--thread-split-secondary)] w-full flex-none",
        )}
      >
        <ChatView
          environmentId={secondaryThreadRef.environmentId}
          threadId={secondaryThreadRef.threadId}
          routeKind="server"
          reserveTitleBarControlInset
        />
        <Button
          aria-label={t("toggleConversationSplitOrientation")}
          className="absolute top-1 right-10 z-[70] size-7 rounded-full border border-border/70 bg-background/85 p-0 shadow-sm backdrop-blur-sm hover:bg-accent"
          onClick={toggleOrientation}
          size="icon"
          type="button"
          variant="ghost"
        >
          {sideBySide ? <Rows2Icon className="size-3.5" /> : <Columns2Icon className="size-3.5" />}
        </Button>
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
      {tertiaryIsDistinct && tertiaryThreadRef !== null ? (
        <>
          <div
            aria-label={t("resizeConversationSplit")}
            aria-orientation={sideBySide ? "vertical" : "horizontal"}
            className={dividerClassName}
            onPointerDown={(event) => handleDividerPointerDown(event, "secondary")}
            role="separator"
          />
          <section
            data-thread-split-tertiary
            className={cn(
              "relative flex min-h-0 min-w-0 flex-col overflow-hidden",
              sideBySide
                ? "h-full w-[var(--thread-split-tertiary)] flex-none"
                : "h-[var(--thread-split-tertiary)] w-full flex-none",
            )}
          >
            <ChatView
              environmentId={tertiaryThreadRef.environmentId}
              threadId={tertiaryThreadRef.threadId}
              routeKind="server"
              reserveTitleBarControlInset
            />
            <Button
              aria-label={t("swapSplitConversations")}
              className="absolute top-1 right-10 z-[70] size-7 rounded-full border border-border/70 bg-background/85 p-0 shadow-sm backdrop-blur-sm hover:bg-accent"
              onClick={swapSecondaryAndTertiary}
              size="icon"
              type="button"
              variant="ghost"
            >
              <ArrowLeftRightIcon className="size-3.5" />
            </Button>
            <Button
              aria-label={t("closeThirdSplitConversation")}
              className="absolute top-1 right-2 z-[70] size-7 rounded-full border border-border/70 bg-background/85 p-0 shadow-sm backdrop-blur-sm hover:bg-accent"
              onClick={closeTertiaryThread}
              size="icon"
              type="button"
              variant="ghost"
            >
              <XIcon className="size-3.5" />
            </Button>
          </section>
        </>
      ) : null}
    </div>
  );
}
