import type * as PtyAdapter from "./PtyAdapter.ts";

/** PTY 退出只记录一次；迟订阅者同步获得同一权威事件。 */
export class PtyExitLatch {
  private exitEvent: PtyAdapter.PtyExitEvent | null = null;
  private readonly listeners = new Set<(event: PtyAdapter.PtyExitEvent) => void>();

  get exited(): boolean {
    return this.exitEvent !== null;
  }

  emit(event: PtyAdapter.PtyExitEvent): void {
    if (this.exitEvent !== null) return;
    this.exitEvent = event;
    const listeners = [...this.listeners];
    this.listeners.clear();
    for (const listener of listeners) {
      this.notify(listener, event);
    }
  }

  subscribe(callback: (event: PtyAdapter.PtyExitEvent) => void): () => void {
    const exitEvent = this.exitEvent;
    if (exitEvent !== null) {
      this.notify(callback, exitEvent);
      return () => undefined;
    }
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  private notify(
    listener: (event: PtyAdapter.PtyExitEvent) => void,
    event: PtyAdapter.PtyExitEvent,
  ): void {
    try {
      listener(event);
    } catch {
      // 单个观察者异常不得阻断其余观察者或 PTY 退出收口。
    }
  }
}
