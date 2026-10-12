const BACKGROUND_FRAME_DELAY_MS = 100;

/** 只在有待处理内容时请求 UI 帧；后台和驱动未挂载时保留一次有界兜底。 */
export function makeNativeFrameQueue() {
  const pending = new Set<{ active: boolean; readonly callback: () => void }>();
  let foreground = true;
  let generation = 0;
  let driver:
    | {
        readonly setActive: (active: boolean, generation: number) => void;
        active: boolean;
        generation: number;
        lastTimestamp: number;
      }
    | undefined;
  let fallback: ReturnType<typeof setTimeout> | undefined;

  const cancelFallback = () => {
    if (fallback !== undefined) clearTimeout(fallback);
    fallback = undefined;
  };
  const flush = () => {
    const callbacks = [...pending];
    pending.clear();
    schedule();
    for (const entry of callbacks) {
      if (!entry.active) continue;
      entry.active = false;
      entry.callback();
    }
    schedule();
  };
  const schedule = () => {
    const useUiFrame = foreground && driver !== undefined && pending.size > 0;
    if (driver && driver.active !== useUiFrame) {
      driver.active = useUiFrame;
      if (useUiFrame) driver.generation = ++generation;
      driver.setActive(useUiFrame, driver.generation);
    }
    if (useUiFrame || pending.size === 0) {
      cancelFallback();
    } else if (fallback === undefined) {
      const handle = setTimeout(() => {
        if (fallback !== handle) return;
        fallback = undefined;
        flush();
      }, BACKGROUND_FRAME_DELAY_MS);
      fallback = handle;
    }
  };

  return {
    request(callback: () => void) {
      const entry = { active: true, callback };
      pending.add(entry);
      schedule();
      return () => {
        entry.active = false;
        pending.delete(entry);
        schedule();
      };
    },
    setForeground(active: boolean) {
      foreground = active;
      schedule();
    },
    attachDriver(setActive: (active: boolean, generation: number) => void) {
      if (driver?.active) driver.setActive(false, driver.generation);
      const current = { setActive, active: false, generation: 0, lastTimestamp: -Infinity };
      driver = current;
      schedule();
      return {
        onFrame(timestamp: number, frameGeneration: number) {
          // 取消后重启、换驱动和同一 UI 帧的迟到回调不能消费新请求。
          if (
            driver !== current ||
            !current.active ||
            current.generation !== frameGeneration ||
            timestamp <= current.lastTimestamp
          )
            return;
          current.lastTimestamp = timestamp;
          flush();
        },
        dispose() {
          if (driver !== current) return;
          if (current.active) current.setActive(false, current.generation);
          driver = undefined;
          schedule();
        },
      };
    },
  };
}
