import { FrameClock } from "@codework/client-runtime/state/runtime";
import type { TextRevealClock } from "@codework/client-runtime/text-reveal";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeNativeFrameQueue } from "./native-frame-queue";

export const nativeFrameQueue = makeNativeFrameQueue();

const waitForNativeFrame = Effect.callback<void>((resume) => {
  const cancel = nativeFrameQueue.request(() => resume(Effect.void));
  return Effect.sync(cancel);
});

export const nativeFrameClockLayer = Layer.succeed(FrameClock, { wait: waitForNativeFrame });

/** 状态发布与文字切片共用同一 UI 帧队列，完整数据的累积不经过该队列。 */
export const nativeTextRevealClock: TextRevealClock = {
  now: () => performance.now(),
  request(callback) {
    return Effect.runCallback(waitForNativeFrame.pipe(Effect.andThen(Effect.sync(callback))));
  },
};
