import * as Schema from "effect/Schema";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { scopedThreadKey } from "@codework/client-runtime/environment";

import { useLocalStorage } from "./hooks/useLocalStorage";
import { useMediaQuery } from "./hooks/useMediaQuery";
import { useThreadSplitStore } from "./threadSplitStore";

export const WorkspaceLayoutSchema = Schema.Literals(["chat", "ide"]);
type WorkspaceLayoutMode = typeof WorkspaceLayoutSchema.Type;
const IDE_MIN_WIDTH = 900;
export const IDE_MIN_VIEWPORT_WIDTH = 1000;
/** 编辑器让位前保留的最小宽度，与对话列的拖宽上限原先所用的余量一致。 */
export const IDE_EDITOR_MIN_WIDTH = 480;
export const IDE_CHAT_MIN_WIDTH = 280;

/**
 * 对话列拖过编辑器的最小宽度后，编辑器让位，对话占满这一行。
 * 窗口还不够同时放下两者时不让位，避免窄屏把编辑器直接藏掉。
 */
export function ideEditorGivesWay(width: number, chatWidth: number): boolean {
  if (width < IDE_EDITOR_MIN_WIDTH + IDE_CHAT_MIN_WIDTH) return false;
  return chatWidth > width - IDE_EDITOR_MIN_WIDTH;
}

/** 重新要编辑器时，把对话列收回到两者都能放下的宽度。 */
export function ideChatWidthForEditor(width: number, chatWidth: number): number {
  const maxChat = Math.max(IDE_CHAT_MIN_WIDTH, width - IDE_EDITOR_MIN_WIDTH);
  return Math.min(Math.max(chatWidth, IDE_CHAT_MIN_WIDTH), maxChat);
}

export function shouldUseIdeShell(
  preferred: WorkspaceLayoutMode,
  viewportWidth: number,
  isThreadRoute: boolean,
) {
  return preferred === "ide" && viewportWidth >= IDE_MIN_VIEWPORT_WIDTH && isThreadRoute;
}

export function useWorkspaceLayoutPreference() {
  return useLocalStorage("codework.workspaceLayout", "chat", WorkspaceLayoutSchema);
}

export function useIdeViewportAvailable() {
  const wideViewport = useMediaQuery({ min: IDE_MIN_VIEWPORT_WIDTH });
  const hasSplit = useThreadSplitStore(
    (state) =>
      state.secondaryThreadRef !== null &&
      scopedThreadKey(state.secondaryThreadRef) !==
        (state.primaryThreadRef ? scopedThreadKey(state.primaryThreadRef) : null),
  );
  return wideViewport && !hasSplit;
}

export function resolveWorkspaceLayout(
  preferred: WorkspaceLayoutMode,
  width: number,
): WorkspaceLayoutMode {
  return preferred === "ide" && width >= IDE_MIN_WIDTH ? "ide" : "chat";
}

export function useWorkspaceLayout(element: HTMLDivElement | null) {
  const [preferred, setPreferred] = useWorkspaceLayoutPreference();
  const wideViewport = useIdeViewportAvailable();
  const [width, setWidth] = useState(0);
  const animation = useRef<Animation | null>(null);

  useLayoutEffect(() => {
    if (!element) return;
    const measure = () => setWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
      animation.current?.cancel();
    };
  }, [element]);

  // 只在主动切换时淡入，保留同一工作台节点；连续切换从当前透明度接续。
  const setMode = useCallback(
    (mode: WorkspaceLayoutMode) => {
      if (mode === preferred) return;
      const opacity =
        element && animation.current?.playState === "running"
          ? getComputedStyle(element).opacity
          : 0.45;
      animation.current?.cancel();
      setPreferred(mode);
      if (
        !element?.animate ||
        window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
        element.ownerDocument.activeElement?.matches(":focus-visible")
      )
        return;
      animation.current = element.animate([{ opacity }, { opacity: 1 }], {
        duration: 180,
        easing: "cubic-bezier(0.22, 1, 0.36, 1)",
      });
    },
    [element, preferred, setPreferred],
  );

  return {
    width,
    mode: resolveWorkspaceLayout(preferred, wideViewport ? width : 0),
    setMode,
  };
}
