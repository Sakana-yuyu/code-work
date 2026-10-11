import * as Effect from "effect/Effect";
import { FrameClock } from "./state/latestFrame.ts";

export interface TextRevealInput {
  readonly text: string;
  readonly streaming: boolean;
  readonly enabled: boolean;
}

export interface TextRevealSnapshot {
  readonly fullText: string;
  readonly visibleText: string;
  readonly pending: boolean;
}

export interface TextRevealClock {
  readonly now: () => number;
  readonly request: (callback: () => void) => () => void;
}

/** 只执行一次能力门控，旧环境继续保持自己的输出行为。 */
export function isTextRevealEnabled(
  config:
    | {
        readonly features?: { readonly responseTextReveal?: boolean };
        readonly settings?: { readonly responseTextPacing?: boolean };
      }
    | null
    | undefined,
) {
  return (
    config?.features?.responseTextReveal === true && config.settings?.responseTextPacing !== false
  );
}

/** 只有积压文字存在时才请求帧；后台暂停 rAF 时单次兜底也会取消另一条路径。 */
export const hostTextRevealClock: TextRevealClock = {
  now: () => performance.now(),
  request(callback) {
    let active = true;
    const interrupt = Effect.runCallback(
      Effect.gen(function* () {
        const clock = yield* FrameClock;
        yield* clock.wait;
        if (!active) return;
        active = false;
        callback();
      }),
    );
    return () => {
      active = false;
      interrupt();
    };
  },
};

function isIncompleteGrapheme(text: string) {
  const last = text.charCodeAt(text.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) return true;
  if (text.endsWith("\u200d")) return true;
  const points = Array.from(text);
  return points.length === 1 && /\p{Regional_Indicator}/u.test(points[0]!);
}

/** 保存完整正文，只限速显示的前缀；不能用于消息累积、持久化或回放去重。 */
export function createTextReveal(
  initial: TextRevealInput,
  clock: TextRevealClock = hostTextRevealClock,
  segmenter = typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : undefined,
) {
  const listeners = new Set<() => void>();
  let input = initial;
  let snapshot: TextRevealSnapshot;
  let boundaries: number[] = [0];
  let segmentedText = "";
  let visible = 0;
  let safeEnd = 0;
  let following = false;
  let heldText: string | null = null;
  let disposed = false;
  let scheduled: { cancel: () => void } | null = null;
  let lastFrameAt = clock.now();
  let credit = 0;

  const buildBoundaries = (text: string, append: boolean) => {
    if (!segmenter) {
      boundaries = [text.length];
      safeEnd = text.length;
      return;
    }
    // 新片段可能延长上一字素；只重分最后一个字素及新增尾文。
    const start = append && boundaries.length > 1 ? boundaries.at(-2)! : 0;
    if (append) {
      while (boundaries.length > 0 && boundaries.at(-1)! > start) boundaries.pop();
    } else boundaries = [0];
    for (const part of segmenter.segment(text.slice(start))) {
      if (isIncompleteGrapheme(part.segment)) break;
      boundaries.push(start + part.index + part.segment.length);
    }
    safeEnd = boundaries.at(-1) ?? 0;
    segmentedText = text;
  };

  const publish = () => {
    const next = {
      fullText: input.text,
      visibleText: heldText ?? input.text.slice(0, visible),
      pending: (heldText ?? input.text.slice(0, visible)) !== input.text,
    };
    if (
      snapshot?.fullText === next.fullText &&
      snapshot.visibleText === next.visibleText &&
      snapshot.pending === next.pending
    )
      return;
    snapshot = next;
    for (const listener of listeners) listener();
  };

  const cancelFrame = () => {
    scheduled?.cancel();
    scheduled = null;
  };

  const schedule = () => {
    if (disposed || heldText !== null || scheduled || visible >= safeEnd) return;
    const entry = { cancel: () => {} };
    scheduled = entry;
    entry.cancel = clock.request(() => {
      if (disposed || scheduled !== entry) return;
      scheduled = null;
      const now = clock.now();
      const elapsed = Math.max(0, Math.min(64, now - lastFrameAt));
      lastFrameAt = now;
      // 小积压保持可读速度，大积压加速追赶；后台长暂停不会一次跨过全部尾文。
      credit += (elapsed * Math.min(5_000, 90 + (safeEnd - visible) / 0.35)) / 1_000;
      const target = Math.min(safeEnd, visible + Math.floor(credit));
      let low = 0;
      let high = boundaries.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (boundaries[middle]! <= target) low = middle + 1;
        else high = middle;
      }
      const next = boundaries[Math.max(0, low - 1)] ?? visible;
      credit -= Math.max(0, next - visible);
      visible = Math.max(visible, next);
      if (visible >= safeEnd) credit = 0;
      publish();
      schedule();
    });
  };

  if (initial.streaming && initial.enabled && segmenter) buildBoundaries(initial.text, false);
  visible = initial.streaming && initial.enabled && segmenter ? safeEnd : initial.text.length;
  publish();

  const update = (next: TextRevealInput) => {
    if (disposed) return;
    const previous = input;
    const append = next.text.startsWith(previous.text);
    const firstContent = previous.text.length === 0;
    if (next.streaming && next.enabled && segmenter && next.text !== segmentedText) {
      buildBoundaries(next.text, next.text.startsWith(segmentedText));
    }
    input = next;
    if (!next.streaming || !next.enabled || !segmenter) {
      cancelFrame();
      visible = next.text.length;
      credit = 0;
      following = false;
    } else if (following || firstContent || !append || !previous.streaming || !previous.enabled) {
      cancelFrame();
      visible = safeEnd;
      credit = 0;
    }
    if (!scheduled) lastFrameAt = clock.now();
    publish();
    schedule();
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    update,
    /** React 严格模式会重放挂载清理；重连只恢复时钟，不丢正文或字素边界。 */
    activate() {
      disposed = false;
      lastFrameAt = clock.now();
      schedule();
    },
    /** 选择、复制与几何读取前追上全文；本次流的后续文字也直接显示。 */
    catchUp() {
      if (disposed) return;
      following = true;
      cancelFrame();
      visible = input.text.length;
      credit = 0;
      publish();
    },
    /** 保留用户正在选择的 DOM 正文；完整来源继续更新，清除选区后再显示全部尾文。 */
    hold() {
      if (disposed || heldText !== null) return;
      following = true;
      cancelFrame();
      heldText = snapshot.visibleText;
      credit = 0;
      publish();
    },
    release() {
      if (disposed || heldText === null) return;
      heldText = null;
      visible = input.text.length;
      publish();
    },
    dispose() {
      disposed = true;
      cancelFrame();
      listeners.clear();
    },
  };
}
