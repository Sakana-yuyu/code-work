import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { FrameClock, makeLatestFramePublisher, publishLatestByFrame } from "./latestFrame.ts";

afterEach(() => vi.unstubAllGlobals());

const makeClock = Effect.gen(function* () {
  const frames = yield* Queue.unbounded<() => void>();
  const cancelled: number[] = [];
  let count = 0;
  const wait = Effect.callback<void>((resume) => {
    const id = count++;
    Queue.offerUnsafe(frames, () => resume(Effect.void));
    return Effect.sync(() => cancelled.push(id));
  });
  return {
    clock: { wait },
    frames,
    cancelled,
    requests: () => count,
    next: Queue.take(frames),
  };
});

describe("完整状态按帧发布", () => {
  it.effect("使用主机 rAF 发布并取消后台兜底，空闲时没有新请求", () =>
    Effect.gen(function* () {
      const frames = yield* Queue.unbounded<FrameRequestCallback>();
      const request = vi.fn((callback: FrameRequestCallback) => {
        Queue.offerUnsafe(frames, callback);
        return 42;
      });
      const cancel = vi.fn();
      vi.stubGlobal("requestAnimationFrame", request);
      vi.stubGlobal("cancelAnimationFrame", cancel);
      const publisher = yield* makeLatestFramePublisher<string>();
      yield* publisher.publish("a");
      yield* Queue.take(publisher.queue);
      yield* publisher.publish("ab");
      const frame = yield* Queue.take(frames);
      frame(16);
      expect(yield* Queue.take(publisher.queue)).toBe("ab");
      yield* TestClock.adjust(1000);
      expect(request).toHaveBeenCalledTimes(1);
      // 已触发的主机帧没有待取消句柄；race 只取消尚未结束的兜底等待。
      expect(cancel).not.toHaveBeenCalled();
      expect(yield* Queue.poll(publisher.queue)).toEqual(Option.none());
    }).pipe(Effect.scoped),
  );

  it.effect("后台 rAF 暂停时仅对待发布内容使用 100 ms 兜底", () =>
    Effect.gen(function* () {
      const frames = yield* Queue.unbounded<FrameRequestCallback>();
      const request = vi.fn((callback: FrameRequestCallback) => {
        Queue.offerUnsafe(frames, callback);
        return 7;
      });
      const cancel = vi.fn();
      vi.stubGlobal("requestAnimationFrame", request);
      vi.stubGlobal("cancelAnimationFrame", cancel);
      const publisher = yield* makeLatestFramePublisher<string>();
      yield* publisher.publish("a");
      yield* Queue.take(publisher.queue);
      yield* publisher.publish("abc");
      yield* Queue.take(frames);
      yield* TestClock.adjust(99);
      expect(yield* Queue.poll(publisher.queue)).toEqual(Option.none());
      yield* TestClock.adjust(1);
      expect(yield* Queue.take(publisher.queue)).toBe("abc");
      expect(cancel).toHaveBeenCalledWith(7);
      yield* TestClock.adjust(1000);
      expect(request).toHaveBeenCalledTimes(1);
    }).pipe(Effect.scoped),
  );

  it.effect("首次快照完整送达，一帧的多次更新只发布最后完整状态", () =>
    Effect.gen(function* () {
      const clock = yield* makeClock;
      const publisher = yield* makeLatestFramePublisher<string>().pipe(
        Effect.provideService(FrameClock, clock.clock),
      );
      yield* publisher.publish("首次🌏完整文本");
      expect(yield* Queue.take(publisher.queue)).toBe("首次🌏完整文本");
      yield* publisher.publish("首次🌏完整文本\n新");
      const frame = yield* clock.next;
      yield* publisher.publish("首次🌏完整文本\n新增");
      yield* publisher.publish("首次🌏完整文本\n新增完整尾段");
      expect(yield* Queue.size(publisher.queue)).toBe(0);
      expect(clock.requests()).toBe(1);
      frame();
      expect(yield* Queue.take(publisher.queue)).toBe("首次🌏完整文本\n新增完整尾段");
      yield* publisher.publish("下一帧");
      const nextFrame = yield* clock.next;
      nextFrame();
      expect(yield* Queue.take(publisher.queue)).toBe("下一帧");
      expect(clock.requests()).toBe(2);
    }).pipe(Effect.scoped),
  );

  it.effect("慢消费保留最新累积状态，不积压中间全文快照", () =>
    Effect.gen(function* () {
      const clock = yield* makeClock;
      const publisher = yield* makeLatestFramePublisher<string>().pipe(
        Effect.provideService(FrameClock, clock.clock),
      );
      yield* publisher.publish("a");
      for (const text of ["ab", "abc", "abcd"]) {
        yield* publisher.publish(text);
        const frame = yield* clock.next;
        frame();
        // 回执证明帧已结束，不用延迟或轮询等待。
        yield* publisher.flush;
      }
      expect(yield* Queue.size(publisher.queue)).toBe(1);
      expect(yield* Queue.take(publisher.queue)).toBe("abcd");
    }).pipe(Effect.scoped),
  );

  it.effect("结束时刷新最终完整状态并取消未到达的帧", () =>
    Effect.gen(function* () {
      const clock = yield* makeClock;
      const publisher = yield* makeLatestFramePublisher<{
        text: string;
        streaming: boolean;
      }>().pipe(Effect.provideService(FrameClock, clock.clock));
      yield* publisher.publish({ text: "首", streaming: true });
      yield* Queue.take(publisher.queue);
      yield* publisher.publish({ text: "首段与完整尾文", streaming: false });
      const pendingFrame = yield* clock.next;
      yield* publisher.end(Exit.void);
      expect(yield* Stream.runCollect(Stream.fromQueue(publisher.queue))).toEqual([
        { text: "首段与完整尾文", streaming: false },
      ]);
      pendingFrame();
      expect(clock.cancelled).toEqual([0]);
      expect(yield* Queue.poll(publisher.queue)).toEqual(Option.none());
    }).pipe(Effect.scoped),
  );

  it.effect("结束错误仍传播真实错误，保留结束前最后完整快照", () =>
    Effect.gen(function* () {
      const clock = yield* makeClock;
      const publisher = yield* makeLatestFramePublisher<string, string>().pipe(
        Effect.provideService(FrameClock, clock.clock),
      );
      yield* publisher.publish("首");
      yield* Queue.take(publisher.queue);
      yield* publisher.publish("已累积完整文本");
      yield* clock.next;
      yield* publisher.end(Exit.fail("连接错误"));
      expect(yield* Queue.take(publisher.queue)).toBe("已累积完整文本");
      expect(yield* Queue.take(publisher.queue).pipe(Effect.flip)).toBe("连接错误");
    }).pipe(Effect.scoped),
  );

  it.effect("作用域关闭取消待发布帧，之后回调不能发布或创建新帧", () =>
    Effect.gen(function* () {
      const ownScope = yield* Scope.make("sequential");
      const clock = yield* makeClock;
      const publisher = yield* makeLatestFramePublisher<string>().pipe(
        Effect.provideService(FrameClock, clock.clock),
        Effect.provideService(Scope.Scope, ownScope),
      );
      yield* publisher.publish("首");
      yield* publisher.publish("首尾");
      const frame = yield* clock.next;
      yield* Scope.close(ownScope, Exit.void);
      frame();
      yield* publisher.publish("已关闭");
      expect(clock.requests()).toBe(1);
      expect(clock.cancelled).toEqual([0]);
    }).pipe(Effect.scoped),
  );

  it.effect("流包装仍处理全部源值，结束刷新最后状态", () =>
    Effect.gen(function* () {
      const clock = yield* makeClock;
      const reduced: string[] = [];
      const source = Stream.fromIterable(["a", "ab", "abc"]).pipe(
        Stream.tap((value) => Effect.sync(() => reduced.push(value))),
      );
      const states = yield* Stream.runCollect(publishLatestByFrame(source)).pipe(
        Effect.provideService(FrameClock, clock.clock),
      );
      expect(reduced).toEqual(["a", "ab", "abc"]);
      expect(states.at(-1)).toBe("abc");
      expect(clock.requests()).toBeLessThanOrEqual(1);
    }),
  );
});
