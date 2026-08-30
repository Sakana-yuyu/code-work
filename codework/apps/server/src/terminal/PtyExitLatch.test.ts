import { describe, expect, it, vi } from "vite-plus/test";

import { PtyExitLatch } from "./PtyExitLatch.ts";

const firstExit = { exitCode: 7, signal: 15 } as const;
const ignoredExit = { exitCode: 9, signal: 9 } as const;

describe("PtyExitLatch", () => {
  it("只记录首次退出并向迟订阅者同步重放", () => {
    const latch = new PtyExitLatch();
    const early = vi.fn();
    const late = vi.fn();

    latch.subscribe(early);
    latch.emit(firstExit);
    latch.emit(ignoredExit);
    latch.subscribe(late);

    expect(early).toHaveBeenCalledOnce();
    expect(early).toHaveBeenCalledWith(firstExit);
    expect(late).toHaveBeenCalledOnce();
    expect(late).toHaveBeenCalledWith(firstExit);
  });

  it("取消订阅后不再投递退出事件", () => {
    const latch = new PtyExitLatch();
    const listener = vi.fn();
    const unsubscribe = latch.subscribe(listener);

    unsubscribe();
    latch.emit(firstExit);

    expect(listener).not.toHaveBeenCalled();
  });

  it("隔离观察者异常并允许回调内重入订阅", () => {
    const latch = new PtyExitLatch();
    const order: string[] = [];

    latch.subscribe(() => {
      order.push("throwing");
      throw new Error("listener failed");
    });
    latch.subscribe(() => {
      order.push("reentrant-start");
      latch.subscribe(() => order.push("reentrant-late"));
      latch.emit(ignoredExit);
      order.push("reentrant-end");
    });
    latch.subscribe(() => order.push("final"));

    expect(() => latch.emit(firstExit)).not.toThrow();
    expect(order).toEqual([
      "throwing",
      "reentrant-start",
      "reentrant-late",
      "reentrant-end",
      "final",
    ]);
  });
});
