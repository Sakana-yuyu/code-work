import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { makeNativeFrameQueue } from "./native-frame-queue";

afterEach(() => vi.useRealTimers());

function harness() {
  vi.useFakeTimers();
  const queue = makeNativeFrameQueue();
  const active = vi.fn<(enabled: boolean, generation: number) => void>();
  const driver = queue.attachDriver(active);
  const ticket = () => active.mock.calls.findLast(([enabled]) => enabled)![1];
  return { queue, active, driver, ticket };
}

describe("移动端 UI 帧请求", () => {
  it("空闲不绘制，同一帧的多个等待只开启一次驱动", () => {
    const h = harness();
    expect(h.active).not.toHaveBeenCalled();
    const first = vi.fn();
    const second = vi.fn();
    h.queue.request(first);
    h.queue.request(second);
    expect(h.active).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    h.driver.onFrame(16, h.ticket());
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(h.active.mock.lastCall?.[0]).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(h.active).toHaveBeenCalledTimes(2);
  });

  it("处理中新请求等下一 UI 帧，同一时刻的回调不重复提交", () => {
    const h = harness();
    const next = vi.fn();
    h.queue.request(() => h.queue.request(next));
    h.driver.onFrame(16, h.ticket());
    h.driver.onFrame(16, h.ticket());
    expect(next).not.toHaveBeenCalled();
    h.driver.onFrame(32, h.ticket());
    expect(next).toHaveBeenCalledOnce();
  });

  it("全部取消停止驱动，迟到帧不能消费取消后重新请求的内容", () => {
    const h = harness();
    const old = vi.fn();
    const cancel = h.queue.request(old);
    const oldTicket = h.ticket();
    cancel();
    expect(h.active.mock.lastCall?.[0]).toBe(false);
    const next = vi.fn();
    h.queue.request(next);
    h.driver.onFrame(16, oldTicket);
    expect(old).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    h.driver.onFrame(32, h.ticket());
    expect(next).toHaveBeenCalledOnce();
  });

  it("同一批的前一回调仍可取消后一等待", () => {
    const h = harness();
    let cancel = () => {};
    h.queue.request(() => cancel());
    const next = vi.fn();
    cancel = h.queue.request(next);
    h.driver.onFrame(16, h.ticket());
    expect(next).not.toHaveBeenCalled();
  });

  it("后台只有等待内容时才用 100ms 兜底", () => {
    const h = harness();
    h.queue.setForeground(false);
    expect(vi.getTimerCount()).toBe(0);
    const callback = vi.fn();
    h.queue.request(callback);
    expect(h.active).not.toHaveBeenCalled();
    vi.advanceTimersByTime(99);
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(callback).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("回前台取消兜底，旧 UI 回调与新激活互斥", () => {
    const h = harness();
    const callback = vi.fn();
    h.queue.request(callback);
    const oldTicket = h.ticket();
    h.queue.setForeground(false);
    h.queue.setForeground(true);
    expect(vi.getTimerCount()).toBe(0);
    h.driver.onFrame(16, oldTicket);
    expect(callback).not.toHaveBeenCalled();
    h.driver.onFrame(32, h.ticket());
    vi.advanceTimersByTime(100);
    expect(callback).toHaveBeenCalledOnce();
  });

  it("驱动未挂载仍可推进，挂载后取消启动兜底", () => {
    vi.useFakeTimers();
    const queue = makeNativeFrameQueue();
    const first = vi.fn();
    queue.request(first);
    vi.advanceTimersByTime(100);
    expect(first).toHaveBeenCalledOnce();
    const next = vi.fn();
    queue.request(next);
    const active = vi.fn<(enabled: boolean, generation: number) => void>();
    const driver = queue.attachDriver(active);
    expect(vi.getTimerCount()).toBe(0);
    driver.onFrame(16, active.mock.lastCall![1]);
    expect(next).toHaveBeenCalledOnce();
  });

  it("卸载旧驱动不影响新驱动，旧回调不能消费新请求", () => {
    const h = harness();
    const callback = vi.fn();
    h.queue.request(callback);
    const oldTicket = h.ticket();
    const active = vi.fn<(enabled: boolean, generation: number) => void>();
    const next = h.queue.attachDriver(active);
    h.driver.dispose();
    h.driver.onFrame(16, oldTicket);
    expect(callback).not.toHaveBeenCalled();
    next.onFrame(32, active.mock.lastCall![1]);
    expect(callback).toHaveBeenCalledOnce();
  });
});
