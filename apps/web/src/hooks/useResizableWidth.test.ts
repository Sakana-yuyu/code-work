import type { KeyboardEvent, PointerEvent } from "react";
import { afterEach, expect, it, vi } from "vite-plus/test";

afterEach(() => {
  vi.doUnmock("react");
  vi.resetModules();
  vi.unstubAllGlobals();
});

it("拖动实时调宽、松手保存，重新挂载恢复，并支持键盘和取消", async () => {
  let width: number | undefined;
  const ref = { current: null as unknown };
  let cleanup: (() => void) | undefined;
  let frame: FrameRequestCallback | undefined;
  const stored = new Map<string, string>();
  const write = vi.fn((key: string, value: string) => stored.set(key, value));
  const style = { cursor: "", userSelect: "", removeProperty: vi.fn() };
  vi.stubGlobal("window", {
    localStorage: { getItem: (key: string) => stored.get(key) ?? null, setItem: write },
  });
  vi.stubGlobal("document", { body: { style } });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frame = callback;
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {
    frame = undefined;
  });
  // 沿用无 DOM 的 Hook 单测方式，只模拟 React 状态调度，执行实际拖动与持久化逻辑。
  vi.doMock("react", () => ({
    useCallback: <T>(callback: T) => callback,
    useRef: () => ref,
    useState: (initial: () => number) => {
      width ??= initial();
      return [
        width,
        (next: number) => {
          width = next;
        },
      ];
    },
    useEffect: (effect: () => () => void) => {
      cleanup = effect();
    },
  }));
  const { useResizableWidth } = await import("./useResizableWidth");
  let maxWidth = 621;
  const render = () =>
    useResizableWidth({
      storageKey: "codework.ideChatWidth",
      legacyStorageKey: undefined,
      defaultWidth: 360,
      minWidth: 280,
      maxWidth,
      edge: "left",
    });
  const target = {
    setPointerCapture: vi.fn(),
    hasPointerCapture: () => true,
    releasePointerCapture: vi.fn(),
  };
  const pointer = (clientX: number) =>
    ({
      button: 0,
      pointerId: 1,
      clientX,
      currentTarget: target,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    }) as unknown as PointerEvent<HTMLElement>;
  const key = (value: string) =>
    ({
      key: value,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    }) as unknown as KeyboardEvent<HTMLElement>;

  let panel = render();
  panel.handlers.onPointerDown(pointer(741));
  panel.handlers.onPointerMove(pointer(581));
  frame?.(0);
  expect(render().width).toBe(520);
  expect(write).not.toHaveBeenCalled();
  panel.handlers.onPointerUp(pointer(581));
  expect(write).toHaveBeenCalledExactlyOnceWith("codework.ideChatWidth", "520");

  width = undefined;
  maxWidth = 360;
  expect(render().width).toBe(360);
  maxWidth = 621;
  expect(render().width).toBe(520);
  render().handlers.onKeyDown(key("ArrowRight"));
  expect(render().width).toBe(500);
  render().handlers.onKeyDown(key("Home"));
  expect(render().width).toBe(280);
  render().handlers.onKeyDown(key("End"));
  expect(render().width).toBe(621);

  panel = render();
  panel.handlers.onPointerDown(pointer(480));
  panel.handlers.onPointerMove(pointer(1000));
  frame?.(0);
  expect(render().width).toBe(280);
  panel.handlers.onPointerCancel(pointer(1000));
  expect(render().width).toBe(621);
  expect(stored.get("codework.ideChatWidth")).toBe("621");

  panel = render();
  panel.handlers.onPointerDown(pointer(480));
  panel.handlers.onPointerMove(pointer(500));
  cleanup?.();
  expect(frame).toBeUndefined();
  expect(ref.current).toBeNull();
  expect(style.removeProperty).toHaveBeenCalledWith("cursor");
});
