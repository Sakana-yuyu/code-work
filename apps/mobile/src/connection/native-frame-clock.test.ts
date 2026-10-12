import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import { makeLatestFramePublisher } from "../../../../packages/client-runtime/src/state/latestFrame.ts";
import {
  nativeFrameClockLayer,
  nativeFrameQueue,
  nativeTextRevealClock,
} from "./native-frame-clock";

afterEach(() => vi.unstubAllGlobals());

const withDriver = Effect.gen(function* () {
  const frames = yield* Queue.unbounded<number>();
  nativeFrameQueue.setForeground(true);
  const driver = nativeFrameQueue.attachDriver((active, generation) => {
    if (active) Queue.offerUnsafe(frames, generation);
  });
  const scope = yield* Scope.Scope;
  yield* Scope.addFinalizer(
    scope,
    Effect.sync(() => driver.dispose()),
  );
  return { driver, frames };
});

describe("移动端真实帧适配", () => {
  it.effect("完整状态通过 Native layer 等待 UI 帧，绕过零延时 rAF", () =>
    Effect.gen(function* () {
      const raf = vi.fn(() => {
        throw new Error("不能使用 RN 的零延时 rAF");
      });
      vi.stubGlobal("requestAnimationFrame", raf);
      const h = yield* withDriver;
      const publisher = yield* makeLatestFramePublisher<string>();
      yield* publisher.publish("首段");
      expect(yield* Queue.take(publisher.queue)).toBe("首段");
      yield* publisher.publish("首段第二段");
      yield* publisher.publish("首段第二段第三段");
      const first = yield* Queue.take(h.frames);
      expect(yield* Queue.poll(publisher.queue)).toEqual(Option.none());
      h.driver.onFrame(16, first);
      expect(yield* Queue.take(publisher.queue)).toBe("首段第二段第三段");
      yield* publisher.publish("下一帧");
      const next = yield* Queue.take(h.frames);
      h.driver.onFrame(16, next);
      expect(yield* Queue.poll(publisher.queue)).toEqual(Option.none());
      h.driver.onFrame(32, next);
      expect(yield* Queue.take(publisher.queue)).toBe("下一帧");
      expect(raf).not.toHaveBeenCalled();
    }).pipe(Effect.provide(nativeFrameClockLayer), Effect.scoped),
  );

  it.effect("文字时钟共用 UI 队列，取消和迟到帧不触发回调", () =>
    Effect.gen(function* () {
      const h = yield* withDriver;
      const completed = yield* Queue.unbounded<string>();
      const cancelled = vi.fn();
      const cancel = nativeTextRevealClock.request(cancelled);
      const first = yield* Queue.take(h.frames);
      cancel();
      const stop = nativeTextRevealClock.request(() => Queue.offerUnsafe(completed, "已显示"));
      const next = yield* Queue.take(h.frames);
      h.driver.onFrame(16, first);
      expect(yield* Queue.poll(completed)).toEqual(Option.none());
      h.driver.onFrame(32, next);
      expect(yield* Queue.take(completed)).toBe("已显示");
      stop();
      expect(cancelled).not.toHaveBeenCalled();
    }).pipe(Effect.scoped),
  );
});
