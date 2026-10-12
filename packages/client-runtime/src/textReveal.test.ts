import { describe, expect, it, vi } from "vite-plus/test";
import {
  createTextReveal,
  hostTextRevealClock,
  isTextRevealEnabled,
  type TextRevealInput,
} from "./textReveal.ts";

function harness(text = "首次全文🌏") {
  let now = 0;
  const callbacks = new Map<object, () => void>();
  const canceled: Array<() => void> = [];
  const reveal = createTextReveal(
    { text, enabled: true, streaming: true },
    {
      now: () => now,
      request(callback) {
        const identity = {};
        callbacks.set(identity, callback);
        return () => {
          callbacks.delete(identity);
          canceled.push(callback);
        };
      },
    },
  );
  const update = (text: string, options: Partial<TextRevealInput> = {}) =>
    reveal.update({ text, enabled: true, streaming: true, ...options });
  return {
    reveal,
    update,
    callbacks,
    canceled,
    frame(elapsed = 16) {
      now += elapsed;
      const frame = [...callbacks.values()];
      callbacks.clear();
      for (const callback of frame) callback();
    },
  };
}

describe("完整正文的显示节奏", () => {
  it("缺少 Intl.Segmenter 时仍按帧揭示，保存全文并在终态立即吸附", () => {
    vi.stubGlobal("Intl", { Segmenter: undefined });
    try {
      const h = harness("首");
      const full = "首" + "👨‍👩‍👧‍👦🇨🇳e\u0301尾文".repeat(50);
      h.update(full);
      expect(h.reveal.getSnapshot().fullText).toBe(full);
      expect(h.reveal.getSnapshot().visibleText).toBe("首");
      expect(h.callbacks.size).toBe(1);
      h.frame();
      expect(h.reveal.getSnapshot().visibleText.length).toBeGreaterThan(1);
      expect(h.reveal.getSnapshot().visibleText.length).toBeLessThan(full.length);
      h.update(full + "完成", { streaming: false });
      expect(h.reveal.getSnapshot().visibleText).toBe(full + "完成");
      expect(h.callbacks.size).toBe(0);
      h.reveal.dispose();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(["🌏", "👨‍👩‍👧‍👦", "🇨🇳", "e\u0301", "\r\n", "👍🏽", "क्ष"])(
    "Hermes 兼容分段不会切开 %s，结束后停止请求帧",
    (grapheme) => {
      vi.stubGlobal("Intl", { Segmenter: undefined });
      try {
        const h = harness("前");
        const full = "前" + grapheme.repeat(50);
        h.update(full);
        for (let frame = 0; frame < 100 && h.callbacks.size; frame++) {
          h.frame(7);
          const shown = h.reveal.getSnapshot().visibleText.slice(1);
          expect(shown.length % grapheme.length).toBe(0);
          expect(full.startsWith(h.reveal.getSnapshot().visibleText)).toBe(true);
        }
        h.update(full, { streaming: false });
        expect(h.reveal.getSnapshot().visibleText).toBe(full);
        expect(h.callbacks.size).toBe(0);
        h.reveal.dispose();
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it("Hermes 分包的代理对、ZWJ 和国旗等待闭合，选择时可追上完整原文", () => {
    vi.stubGlobal("Intl", { Segmenter: undefined });
    try {
      const h = harness("前");
      h.update("前\ud83c");
      expect(h.reveal.getSnapshot().visibleText).toBe("前");
      expect(h.callbacks.size).toBe(0);
      h.update("前🌏👨\u200d");
      for (let frame = 0; frame < 100 && h.callbacks.size; frame++) h.frame();
      expect(h.reveal.getSnapshot().visibleText).toBe("前🌏");
      h.update("前🌏👨‍👩‍👧‍👦🇨");
      for (let frame = 0; frame < 100 && h.callbacks.size; frame++) h.frame();
      expect(h.reveal.getSnapshot().visibleText).toBe("前🌏👨‍👩‍👧‍👦");
      h.update("前🌏👨‍👩‍👧‍👦🇨🇳" + "尾".repeat(1_000));
      expect(h.reveal.getSnapshot().pending).toBe(true);
      h.reveal.catchUp();
      expect(h.reveal.getSnapshot().visibleText).toBe(h.reveal.getSnapshot().fullText);
      expect(h.callbacks.size).toBe(0);
      h.reveal.dispose();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it.each([null, undefined, {}, { features: {} }, { features: { responseTextReveal: false } }])(
    "旧环境不开放揭示控制 %j",
    (config) => expect(isTextRevealEnabled(config)).toBe(false),
  );
  it("新环境缺省开启，可以关闭并重新开启", () => {
    expect(isTextRevealEnabled({ features: { responseTextReveal: true } })).toBe(true);
    expect(
      isTextRevealEnabled({
        features: { responseTextReveal: true },
        settings: { responseTextPacing: false },
      }),
    ).toBe(false);
    expect(
      isTextRevealEnabled({
        features: { responseTextReveal: true },
        settings: { responseTextPacing: true },
      }),
    ).toBe(true);
  });
  it("首次内容整体显示，空状态收到首包也整体显示", () => {
    const h = harness();
    expect(h.reveal.getSnapshot()).toEqual({
      fullText: "首次全文🌏",
      visibleText: "首次全文🌏",
      pending: false,
    });
    expect(h.callbacks.size).toBe(0);
    const empty = harness("");
    empty.update("首次较大的全文".repeat(100));
    expect(empty.reveal.getSnapshot().visibleText).toBe("首次较大的全文".repeat(100));
    expect(empty.callbacks.size).toBe(0);
  });

  it("同一帧多包只安排一个时钟，全文始终保留而显示前缀按帧推进", () => {
    const h = harness("首");
    h.update("首" + "后".repeat(100));
    h.update("首" + "后".repeat(200));
    expect(h.callbacks.size).toBe(1);
    expect(h.reveal.getSnapshot()).toEqual({
      fullText: "首" + "后".repeat(200),
      visibleText: "首",
      pending: true,
    });
    h.frame();
    expect(h.reveal.getSnapshot().visibleText.length).toBeGreaterThan(1);
    expect(h.reveal.getSnapshot().visibleText.length).toBeLessThan(201);
    expect(h.callbacks.size).toBe(1);
  });

  it("大积压更快追赶，持续输入不丢字、不乱序，追完停止请求帧", () => {
    const small = harness("首");
    const large = harness("首");
    small.update("首" + "小".repeat(100));
    large.update("首" + "大".repeat(1_000));
    small.frame();
    large.frame();
    expect(large.reveal.getSnapshot().visibleText.length).toBeGreaterThan(
      small.reveal.getSnapshot().visibleText.length,
    );
    let full = "首" + "大".repeat(1_000);
    for (let index = 0; index < 30; index++) {
      full += `第${index}段🌏\r\n`;
      large.update(full);
      large.frame();
      expect(full.startsWith(large.reveal.getSnapshot().visibleText)).toBe(true);
      expect(large.reveal.getSnapshot().fullText).toBe(full);
    }
    for (let index = 0; index < 1_000 && large.callbacks.size; index++) large.frame();
    expect(large.reveal.getSnapshot()).toEqual({
      fullText: full,
      visibleText: full,
      pending: false,
    });
    expect(large.callbacks.size).toBe(0);
  });

  it.each(["completed", "failed", "canceled"])("%s 完成标志立即吸附全文并取消帧", () => {
    const h = harness("前");
    h.update("前" + "完整尾文".repeat(100));
    h.update("前" + "完整尾文".repeat(100), { streaming: false });
    expect(h.reveal.getSnapshot().visibleText).toBe(h.reveal.getSnapshot().fullText);
    expect(h.callbacks.size).toBe(0);
    for (const callback of h.canceled) callback();
    expect(h.callbacks.size).toBe(0);
  });

  it("关闭节奏立即显示全文，再开启从当前全文继续", () => {
    const h = harness("前");
    const text = "前" + "尾".repeat(100);
    h.update(text);
    h.update(text, { enabled: false });
    expect(h.reveal.getSnapshot().visibleText).toBe(text);
    expect(h.callbacks.size).toBe(0);
    h.update(text, { enabled: true });
    h.update(text + "再新增".repeat(100));
    expect(h.reveal.getSnapshot().visibleText).toBe(text);
    expect(h.callbacks.size).toBe(1);
  });

  it("非追加正文替换立即切换，重新进入流也不重放历史", () => {
    const h = harness("旧");
    h.update("旧" + "积压".repeat(100));
    h.update("新正文🌏");
    expect(h.reveal.getSnapshot().visibleText).toBe("新正文🌏");
    expect(h.callbacks.size).toBe(0);
    h.update("新正文🌏", { streaming: false });
    h.update("续接完整正文", { streaming: true });
    expect(h.reveal.getSnapshot().visibleText).toBe("续接完整正文");
  });

  it("选择、复制或测量追上全文，本次流继续追加而不再限速", () => {
    const h = harness("前");
    const full = "前" + "尾".repeat(100);
    h.update(full);
    h.reveal.catchUp();
    expect(h.reveal.getSnapshot()).toEqual({ fullText: full, visibleText: full, pending: false });
    expect(h.callbacks.size).toBe(0);
    h.update(full + "新段");
    expect(h.reveal.getSnapshot().visibleText).toBe(full + "新段");
    expect(h.callbacks.size).toBe(0);
  });

  it("选区保持正文节点内容不变，完整来源与完成状态保留，清除选区后吸附全文", () => {
    const h = harness("选中文本");
    h.reveal.hold();
    h.update("选中文本与后续尾文");
    h.update("选中文本与完整尾文", { streaming: false });
    expect(h.reveal.getSnapshot()).toEqual({
      fullText: "选中文本与完整尾文",
      visibleText: "选中文本",
      pending: true,
    });
    expect(h.callbacks.size).toBe(0);
    h.reveal.release();
    expect(h.reveal.getSnapshot().visibleText).toBe("选中文本与完整尾文");
  });

  it("已完成或禁用的历史消息不建立字素表", () => {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    const segment = vi.spyOn(segmenter, "segment");
    const reveal = createTextReveal(
      { text: "历史正文".repeat(10_000), enabled: true, streaming: false },
      {
        now: () => 0,
        request: () => () => {},
      },
      segmenter,
    );
    expect(segment).not.toHaveBeenCalled();
    expect(reveal.getSnapshot().pending).toBe(false);
    reveal.update({ text: "新全文", enabled: false, streaming: true });
    expect(segment).not.toHaveBeenCalled();
    reveal.dispose();
  });

  it.each(["🌏", "👨‍👩‍👧‍👦", "🇨🇳", "e\u0301", "\r\n", "👍🏽"])("不会从 %s 中间切开", (grapheme) => {
    const h = harness("前");
    const full = "前" + grapheme.repeat(50);
    h.update(full);
    for (let frame = 0; frame < 50; frame++) {
      h.frame(7);
      const shown = h.reveal.getSnapshot().visibleText.slice(1);
      expect(shown.length % grapheme.length).toBe(0);
      expect(full.startsWith(h.reveal.getSnapshot().visibleText)).toBe(true);
    }
  });

  it("分包的代理对、ZWJ 与国旗在闭合前等待，结束允许原始尾文", () => {
    const h = harness("前");
    h.update("前\ud83c");
    expect(h.reveal.getSnapshot().visibleText).toBe("前");
    expect(h.callbacks.size).toBe(0);
    h.update("前🌏👨\u200d");
    for (let frame = 0; frame < 100 && h.callbacks.size; frame++) h.frame();
    expect(h.reveal.getSnapshot().visibleText).toBe("前🌏");
    h.update("前🌏👨‍👩‍👧‍👦🇨");
    for (let frame = 0; frame < 100 && h.callbacks.size; frame++) h.frame();
    expect(h.reveal.getSnapshot().visibleText).toBe("前🌏👨‍👩‍👧‍👦");
    h.update("前🌏👨‍👩‍👧‍👦🇨🇳");
    for (let frame = 0; frame < 100 && h.callbacks.size; frame++) h.frame();
    expect(h.reveal.getSnapshot().visibleText).toBe("前🌏👨‍👩‍👧‍👦🇨🇳");
    h.update("前🌏👨‍👩‍👧‍👦🇨🇳\ud83c", { streaming: false });
    expect(h.reveal.getSnapshot().visibleText).toBe("前🌏👨‍👩‍👧‍👦🇨🇳\ud83c");
  });

  it("仅重新分割尾部，不扫描已经稳定的长前缀", () => {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    const segment = vi.spyOn(segmenter, "segment");
    const full = "稳定前缀".repeat(10_000);
    const h = harness();
    const reveal = createTextReveal(
      { text: full, enabled: true, streaming: true },
      {
        now: () => 0,
        request: () => () => {},
      },
      segmenter,
    );
    segment.mockClear();
    reveal.update({ text: full + "尾文", enabled: true, streaming: true });
    expect(segment).toHaveBeenCalledExactlyOnceWith("缀尾文");
    reveal.dispose();
    h.reveal.dispose();
  });

  it("后台恢复不因旧时间戳直接跳到尾部", () => {
    const h = harness("首");
    h.update("首" + "尾".repeat(10_000));
    h.frame(60_000);
    expect(h.reveal.getSnapshot().visibleText.length).toBeLessThan(400);
    expect(h.callbacks.size).toBe(1);
    h.reveal.dispose();
  });

  it("卸载取消帧，过期回调无效，严格模式重放挂载可继续", () => {
    const h = harness("首");
    h.update("首" + "尾".repeat(100));
    const listener = vi.fn();
    h.reveal.subscribe(listener);
    h.reveal.dispose();
    for (const callback of h.canceled) callback();
    expect(listener).not.toHaveBeenCalled();
    expect(h.callbacks.size).toBe(0);
    h.reveal.activate();
    h.reveal.subscribe(listener);
    h.frame();
    expect(listener).toHaveBeenCalledOnce();
    h.reveal.dispose();
  });

  it("主机帧与后台兜底只触发一次，空闲没有循环", async () => {
    vi.useFakeTimers();
    let fire: FrameRequestCallback | undefined;
    const cancel = vi.fn();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      fire = callback;
      return 7;
    });
    vi.stubGlobal("cancelAnimationFrame", cancel);
    try {
      const callback = vi.fn();
      hostTextRevealClock.request(callback);
      await vi.advanceTimersByTimeAsync(0);
      fire!(16);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(callback).toHaveBeenCalledOnce();
      expect(cancel).not.toHaveBeenCalled();
      const background = vi.fn();
      const dispose = hostTextRevealClock.request(background);
      await vi.advanceTimersByTimeAsync(99);
      expect(background).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(background).toHaveBeenCalledOnce();
      expect(cancel).toHaveBeenCalledWith(7);
      fire!(32);
      dispose();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(background).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});
