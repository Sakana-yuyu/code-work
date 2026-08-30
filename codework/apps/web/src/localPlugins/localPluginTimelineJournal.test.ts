import { describe, expect, it, vi } from "vite-plus/test";

import {
  BrowserLocalPluginTimelineStorage,
  decodeLocalPluginTimelineStorageDocument,
  encodeLocalPluginTimelineStorageDocument,
  type LocalPluginTimelineStorage,
} from "./localPluginTimelineStorage";
import { LocalPluginTimelineJournal } from "./localPluginTimelineJournal";

class MemoryStorage implements LocalPluginTimelineStorage {
  value: string | null = null;

  read(): string | null {
    return this.value;
  }

  write(value: string): void {
    this.value = value;
  }
}

describe("localPluginTimelineStorage", () => {
  it("只读写版本化命名空间，并拒绝未知版本和无效时间", () => {
    const getItem = vi.fn(() => "stored");
    const setItem = vi.fn();
    const storage = new BrowserLocalPluginTimelineStorage({ getItem, setItem });

    expect(storage.read()).toBe("stored");
    storage.write("next");
    expect(getItem).toHaveBeenCalledWith("codework:local-plugin-timeline:v1");
    expect(setItem).toHaveBeenCalledWith("codework:local-plugin-timeline:v1", "next");
    expect(
      decodeLocalPluginTimelineStorageDocument(encodeLocalPluginTimelineStorageDocument([])),
    ).toEqual({ version: 1, events: [] });
    expect(() => decodeLocalPluginTimelineStorageDocument('{"version":2,"events":[]}')).toThrow();
    expect(() =>
      decodeLocalPluginTimelineStorageDocument(
        JSON.stringify({
          version: 1,
          events: [
            {
              id: "event-1",
              threadKey: "environment:thread",
              pluginId: "acme.timeline",
              timelineId: "checks",
              title: "检查",
              message: "完成",
              tone: "success",
              createdAt: "not-a-date",
            },
          ],
        }),
      ),
    ).toThrow();
  });
});

describe("LocalPluginTimelineJournal", () => {
  it("按线程隔离事件，并持久化稳定 ID 与完整展示字段", () => {
    const storage = new MemoryStorage();
    let now = Date.parse("2026-08-30T01:00:00.000Z");
    const journal = new LocalPluginTimelineJournal({
      storage,
      now: () => now,
      makeId: (sequence) => `event-${sequence}`,
    });

    journal.restore();
    const first = journal.append({
      threadKey: "environment-a:thread-1",
      pluginId: "acme.timeline",
      timelineId: "checks",
      title: "检查结果",
      message: "第一项已完成",
      tone: "success",
    });
    now += 1_000;
    journal.append({
      threadKey: "environment-a:thread-2",
      pluginId: "acme.timeline",
      timelineId: "checks",
      title: "检查结果",
      message: "另一线程",
      tone: "warning",
    });

    expect(first).toEqual({
      id: "event-1",
      threadKey: "environment-a:thread-1",
      pluginId: "acme.timeline",
      timelineId: "checks",
      title: "检查结果",
      message: "第一项已完成",
      tone: "success",
      createdAt: "2026-08-30T01:00:00.000Z",
    });
    expect(journal.list("environment-a:thread-1")).toEqual([first]);
    expect(journal.list("environment-a:thread-2").map((event) => event.message)).toEqual([
      "另一线程",
    ]);

    const restored = new LocalPluginTimelineJournal({
      storage,
      now: () => now,
      makeId: (sequence) => `restored-${sequence}`,
    });
    restored.restore();
    expect(restored.list("environment-a:thread-1")).toEqual([first]);
  });

  it("同时限制单线程和全局事件数量，优先丢弃最旧事件", () => {
    const storage = new MemoryStorage();
    let now = Date.parse("2026-08-30T02:00:00.000Z");
    const journal = new LocalPluginTimelineJournal({
      storage,
      now: () => now,
      makeId: (sequence) => `event-${sequence}`,
      maxEntriesPerThread: 2,
      maxEntries: 3,
    });

    const append = (threadKey: string, message: string) => {
      journal.append({
        threadKey,
        pluginId: "acme.timeline",
        timelineId: "checks",
        title: "检查",
        message,
        tone: "info",
      });
      now += 1_000;
    };

    append("environment:thread-1", "一");
    append("environment:thread-1", "二");
    append("environment:thread-1", "三");
    append("environment:thread-2", "四");
    append("environment:thread-3", "五");

    expect(journal.list("environment:thread-1").map((event) => event.message)).toEqual(["三"]);
    expect(journal.getSnapshot().events.map((event) => event.message)).toEqual(["三", "四", "五"]);
  });

  it("隔离发布订阅者异常，并保持追加返回值与恢复快照稳定", () => {
    const storage = new MemoryStorage();
    const journal = new LocalPluginTimelineJournal({
      storage,
      now: () => Date.parse("2026-08-30T03:00:00.000Z"),
      makeId: () => "event-1",
    });
    const throwingListener = vi.fn(() => {
      throw new Error("listener failed");
    });
    const healthyListener = vi.fn();
    journal.subscribe(throwingListener);
    journal.subscribe(healthyListener);
    let appended: ReturnType<LocalPluginTimelineJournal["append"]> | undefined;

    expect(() => {
      appended = journal.append({
        threadKey: "environment:thread",
        pluginId: "acme.timeline",
        timelineId: "checks",
        title: "检查",
        message: "已完成",
        tone: "success",
      });
    }).not.toThrow();

    expect(appended).toMatchObject({ id: "event-1", message: "已完成" });
    expect(journal.getSnapshot().events).toEqual([appended]);
    expect(throwingListener).toHaveBeenCalledTimes(1);
    expect(healthyListener).toHaveBeenCalledTimes(1);

    const restored = new LocalPluginTimelineJournal({
      storage,
      now: () => Date.parse("2026-08-30T03:00:01.000Z"),
      makeId: () => "restored-event",
    });
    const restoredThrowingListener = vi.fn(() => {
      throw new Error("restore listener failed");
    });
    const restoredHealthyListener = vi.fn();
    restored.subscribe(restoredThrowingListener);
    restored.subscribe(restoredHealthyListener);

    expect(() => restored.restore()).not.toThrow();
    expect(restored.getSnapshot().events).toEqual([appended]);
    expect(restoredThrowingListener).toHaveBeenCalledTimes(1);
    expect(restoredHealthyListener).toHaveBeenCalledTimes(1);
  });

  it("持久化失败时不发布半写入事件", () => {
    const storage: LocalPluginTimelineStorage = {
      read: () => null,
      write: () => {
        throw new Error("quota exceeded");
      },
    };
    const journal = new LocalPluginTimelineJournal({
      storage,
      now: () => Date.parse("2026-08-30T03:00:00.000Z"),
      makeId: () => "event-1",
    });
    const listener = vi.fn();
    journal.subscribe(listener);

    expect(() =>
      journal.append({
        threadKey: "environment:thread",
        pluginId: "acme.timeline",
        timelineId: "checks",
        title: "检查",
        message: "不会发布",
        tone: "error",
      }),
    ).toThrow("quota exceeded");
    expect(journal.getSnapshot()).toEqual({ events: [] });
    expect(listener).not.toHaveBeenCalled();
  });
});
