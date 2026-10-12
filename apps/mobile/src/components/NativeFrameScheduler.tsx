import { useCallback, useEffect, useRef } from "react";
import { AppState } from "react-native";
import {
  runOnJS,
  runOnUI,
  useFrameCallback,
  useSharedValue,
  type FrameInfo,
} from "react-native-reanimated";
import { nativeFrameQueue } from "../connection/native-frame-clock";

/** 有等待内容时才启用原生帧回调；在途标记避免 JS 忙碌时累积 UI 通知。 */
export function NativeFrameScheduler() {
  const generation = useSharedValue(0);
  const dispatched = useSharedValue<number | null>(null);
  const driverRef = useRef<ReturnType<typeof nativeFrameQueue.attachDriver> | null>(null);
  const finishDispatch = useCallback(
    (frameGeneration: number) => {
      "worklet";
      if (dispatched.value === frameGeneration) dispatched.value = null;
    },
    [dispatched],
  );
  const flushFrame = useCallback(
    (timestamp: number, frameGeneration: number) => {
      driverRef.current?.onFrame(timestamp, frameGeneration);
      runOnUI(finishDispatch)(frameGeneration);
    },
    [finishDispatch],
  );
  const onFrame = useCallback(
    (frame: FrameInfo) => {
      "worklet";
      const frameGeneration = generation.value;
      if (dispatched.value === frameGeneration) return;
      dispatched.value = frameGeneration;
      runOnJS(flushFrame)(frame.timestamp, frameGeneration);
    },
    [dispatched, flushFrame, generation],
  );
  const frameCallback = useFrameCallback(onFrame, false);

  // SDK 先在 effect 注册 callbackId，再挂载可激活的驱动。
  useEffect(() => {
    nativeFrameQueue.setForeground(AppState.currentState === "active");
    const driver = nativeFrameQueue.attachDriver((active, nextGeneration) => {
      if (active) generation.value = nextGeneration;
      else dispatched.value = null;
      frameCallback.setActive(active);
    });
    driverRef.current = driver;
    const subscription = AppState.addEventListener("change", (state) => {
      nativeFrameQueue.setForeground(state === "active");
    });
    return () => {
      driverRef.current = null;
      subscription.remove();
      driver.dispose();
    };
  }, [dispatched, frameCallback, generation]);

  return null;
}
