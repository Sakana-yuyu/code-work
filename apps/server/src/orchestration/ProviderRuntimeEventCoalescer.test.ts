import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@codework/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

import { makeProviderRuntimeEventCoalescer } from "./ProviderRuntimeEventCoalescer.ts";

type TextEvent = Extract<ProviderRuntimeEvent, { type: "content.delta" }>;

function textEvent(id: string, delta: string, overrides: Partial<TextEvent> = {}): TextEvent {
  return {
    type: "content.delta",
    provider: ProviderDriverKind.make("codex"),
    eventId: EventId.make(id),
    threadId: ThreadId.make("thread-one"),
    turnId: TurnId.make("turn-one"),
    itemId: RuntimeItemId.make("item-one"),
    createdAt: "2026-10-12T00:00:00.000Z",
    payload: { streamKind: "assistant_text", delta },
    ...overrides,
  };
}

function controlEvent(id: string): ProviderRuntimeEvent {
  return {
    ...textEvent(id, ""),
    type: "turn.started",
    payload: {},
  };
}

const makeHarness = Effect.gen(function* () {
  const emitted: Array<{ time: number; event: ProviderRuntimeEvent }> = [];
  const coalescer = yield* makeProviderRuntimeEventCoalescer((events) =>
    Effect.gen(function* () {
      const time = yield* Clock.currentTimeMillis;
      emitted.push(...events.map((event) => ({ time, event })));
    }),
  );
  return { ...coalescer, emitted };
});

describe("provider 文字 leading/trailing 合并窗口", () => {
  it.effect("原包在不同合并窗口重投只应用一次，合法的相同文字仍保留", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const first = textEvent("first", "首🌏\r\n");
      const second = textEvent("second", "首🌏\r\n");
      const tail = textEvent("tail", "尾");
      yield* harness.offer(first);
      yield* harness.flush;
      yield* harness.offer(first);
      yield* harness.offer(second);
      yield* harness.offer(second);
      yield* harness.offer(tail);
      yield* harness.offer(tail);
      yield* harness.flush;
      const text = harness.emitted
        .map(({ event }) => (event.type === "content.delta" ? event.payload.delta : ""))
        .join("");
      expect(text).toBe("首🌏\r\n首🌏\r\n尾");
    }).pipe(Effect.scoped),
  );

  it.effect("重投控制和终态不新增通知，同一原包的不同 canonical 类型仍通过", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const started = controlEvent("native-packet");
      const state: ProviderRuntimeEvent = {
        ...started,
        type: "session.state.changed",
        payload: { state: "running" },
      };
      const terminal: ProviderRuntimeEvent = {
        ...controlEvent("terminal"),
        type: "turn.completed",
        payload: { state: "completed" },
      };
      for (const event of [started, state, started, state, terminal, terminal]) {
        yield* harness.offer(event);
      }
      expect(harness.emitted.map(({ event }) => event.type)).toEqual([
        "turn.started",
        "session.state.changed",
        "turn.completed",
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("事件身份按 provider 实例、线程、回合、条目及流内索引隔离", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const base = textEvent("shared-native-id", "x", {
        providerInstanceId: ProviderInstanceId.make("one"),
      });
      const events: TextEvent[] = [
        base,
        { ...base, provider: ProviderDriverKind.make("claude-code") },
        { ...base, providerInstanceId: ProviderInstanceId.make("two") },
        { ...base, threadId: ThreadId.make("thread-two") },
        { ...base, turnId: TurnId.make("turn-two") },
        { ...base, itemId: RuntimeItemId.make("item-two") },
        { ...base, payload: { ...base.payload, streamKind: "reasoning_text" } },
        { ...base, payload: { ...base.payload, contentIndex: 1 } },
        { ...base, payload: { ...base.payload, summaryIndex: 1 } },
      ];
      for (const event of [...events, ...events]) yield* harness.offer(event);
      yield* harness.flush;
      expect(
        harness.emitted
          .map(({ event }) => (event.type === "content.delta" ? event.payload.delta : ""))
          .join(""),
      ).toBe("x".repeat(events.length));
    }).pipe(Effect.scoped),
  );

  it.effect("同一原生通知展开的不同任务与请求不互相去重", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const base = controlEvent("native-task-packet");
      const events: ProviderRuntimeEvent[] = [
        { ...base, type: "task.started", payload: { taskId: RuntimeTaskId.make("one") } },
        { ...base, type: "task.started", payload: { taskId: RuntimeTaskId.make("two") } },
        {
          ...base,
          type: "request.opened",
          requestId: RuntimeRequestId.make("one"),
          payload: { requestType: "command_execution_approval" },
        },
        {
          ...base,
          type: "request.opened",
          requestId: RuntimeRequestId.make("two"),
          payload: { requestType: "command_execution_approval" },
        },
      ];
      for (const event of [...events, ...events]) yield* harness.offer(event);
      expect(harness.emitted.map(({ event }) => event)).toEqual(events);
    }).pipe(Effect.scoped),
  );

  it.effect("缺失事件身份及非法 payload 不阻塞后续合法通知", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const anonymous = {
        ...controlEvent("anonymous"),
        eventId: undefined,
      } as unknown as ProviderRuntimeEvent;
      const malformed = {
        ...controlEvent("malformed"),
        payload: "非法 payload",
      } as unknown as ProviderRuntimeEvent;
      yield* harness.offer(anonymous);
      yield* harness.offer(anonymous);
      yield* harness.offer(malformed);
      yield* harness.offer(controlEvent("valid-after-malformed"));
      expect(harness.emitted.map(({ event }) => event.eventId)).toEqual([
        undefined,
        undefined,
        "malformed",
        "valid-after-malformed",
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("近期身份记录有容量上限，持续工作不会无限保留原包", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const oldest = controlEvent("bounded-0");
      yield* harness.offer(oldest);
      for (let index = 1; index <= 10_000; index++) {
        yield* harness.offer(controlEvent(`bounded-${index}`));
      }
      yield* harness.offer(controlEvent("bounded-10000"));
      expect(harness.emitted).toHaveLength(10_001);
      yield* harness.offer(oldest);
      expect(harness.emitted).toHaveLength(10_002);
      expect(harness.emitted.at(-1)!.event).toBe(oldest);
    }).pipe(Effect.scoped),
  );

  it.effect("非法 delta 交给下游隔离，后续控制事件仍继续投递", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const invalid = {
        ...textEvent("invalid", ""),
        payload: { streamKind: "assistant_text", delta: undefined },
      } as unknown as ProviderRuntimeEvent;
      yield* harness.offer(invalid);
      yield* harness.offer(controlEvent("after-invalid"));
      expect(harness.emitted.map(({ event }) => event.eventId)).toEqual([
        "invalid",
        "after-invalid",
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("空闲首包立即送达，突发尾包在 60 ms 合并且保留 Unicode", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* harness.offer(textEvent("a", "首"));
      yield* harness.offer(textEvent("b", "段🌏"));
      yield* harness.offer(textEvent("c", "\r\n尾"));
      expect(harness.emitted.map(({ time }) => time)).toEqual([0]);
      yield* TestClock.adjust(59);
      expect(harness.emitted).toHaveLength(1);
      yield* TestClock.adjust(1);
      expect(harness.emitted.map(({ time }) => time)).toEqual([0, 60]);
      expect(harness.emitted[1]!.event).toMatchObject({
        type: "content.delta",
        payload: { delta: "段🌏\r\n尾" },
      });
    }).pipe(Effect.scoped),
  );

  it.effect("空闲窗口结束后下一包立即送达，不创建持续刷新循环", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* harness.offer(textEvent("a", "a"));
      yield* TestClock.adjust(80);
      yield* harness.offer(textEvent("b", "b"));
      expect(harness.emitted.map(({ time }) => time)).toEqual([0, 80]);
      yield* TestClock.adjust(1000);
      expect(harness.emitted).toHaveLength(2);
    }).pipe(Effect.scoped),
  );

  it.effect("控制事件与终态不能越过前面的文字，下一条目也遵守窗口", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* harness.offer(textEvent("a", "a"));
      yield* harness.offer(textEvent("b", "b"));
      yield* harness.offer(controlEvent("boundary"));
      yield* harness.offer(textEvent("c", "c", { itemId: RuntimeItemId.make("next-item") }));
      yield* harness.offer(textEvent("d", "d", { itemId: RuntimeItemId.make("next-item") }));
      const terminal: ProviderRuntimeEvent = {
        ...controlEvent("terminal"),
        type: "turn.completed",
        payload: { state: "completed" },
      };
      yield* harness.offer(terminal);
      yield* TestClock.adjust(60);
      expect(harness.emitted.map(({ event }) => event.type)).toEqual([
        "content.delta",
        "content.delta",
        "turn.started",
      ]);
      yield* TestClock.adjust(60);
      expect(harness.emitted.map(({ time }) => time)).toEqual([0, 60, 60, 120, 120]);
      expect(harness.emitted.at(-2)!.event).toMatchObject({ payload: { delta: "cd" } });
      expect(harness.emitted.at(-1)!.event).toBe(terminal);
    }).pipe(Effect.scoped),
  );

  it.effect("不同线程独立推进，其他线程的控制事件不等待当前尾包", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* harness.offer(textEvent("a", "a"));
      yield* harness.offer(textEvent("b", "b"));
      const other = textEvent("other", "其他", { threadId: ThreadId.make("thread-two") });
      yield* harness.offer(other);
      expect(harness.emitted.map(({ event }) => event.eventId)).toEqual(["a", "other"]);
      yield* TestClock.adjust(60);
      expect(harness.emitted.at(-1)!.event).toMatchObject({ payload: { delta: "b" } });
    }).pipe(Effect.scoped),
  );

  it.effect("媒体保持原包，推理文字只与同种流合并", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* harness.offer(textEvent("a", "a"));
      const media = textEvent("media", "图", {
        payload: {
          streamKind: "assistant_text",
          delta: "图",
          image: { mimeType: "image/png", data: "YWJj" },
        },
      });
      yield* harness.offer(media);
      yield* harness.offer(
        textEvent("r1", "思", {
          payload: { streamKind: "reasoning_summary_text", delta: "思", summaryIndex: 0 },
        }),
      );
      yield* harness.offer(
        textEvent("r2", "考", {
          payload: { streamKind: "reasoning_summary_text", delta: "考", summaryIndex: 0 },
        }),
      );
      yield* TestClock.adjust(60);
      expect(harness.emitted.at(-1)!.event).toBe(media);
      yield* TestClock.adjust(60);
      expect(harness.emitted.at(-1)!.event).toMatchObject({
        payload: { streamKind: "reasoning_summary_text", delta: "思考", summaryIndex: 0 },
      });
    }).pipe(Effect.scoped),
  );

  it.effect("不同正文与摘要索引、回合或 provider 身份不能合并", () =>
    Effect.gen(function* () {
      const variants: Partial<TextEvent>[] = [
        { payload: { streamKind: "assistant_text", delta: "b", contentIndex: 1 } },
        { payload: { streamKind: "assistant_text", delta: "b", summaryIndex: 1 } },
        { turnId: TurnId.make("other-turn") },
        { provider: ProviderDriverKind.make("claude") },
        { providerRefs: { providerTurnId: "other-provider-turn" } },
      ];
      for (const [index, variant] of variants.entries()) {
        const harness = yield* makeHarness;
        yield* harness.offer(textEvent(`leading-${index}`, "0"));
        const first = textEvent(`a-${index}`, "a");
        const second = textEvent(`b-${index}`, "b", variant);
        yield* harness.offer(first);
        yield* harness.offer(second);
        yield* TestClock.adjust(60);
        expect(harness.emitted.at(-1)!.event).toBe(first);
        yield* TestClock.adjust(60);
        expect(harness.emitted.at(-1)!.event).toBe(second);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("合并包保留首包身份元数据，不伪造原始 checkpoint 摘要或修改输入", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* harness.offer(textEvent("leading", "a"));
      const first = textEvent("first", "b", {
        payload: {
          streamKind: "assistant_text",
          delta: "b",
          checkpointOffsetBytes: 2,
          checkpointDigest: "digest-b",
        },
      });
      const last = textEvent("last", "c", {
        payload: {
          streamKind: "assistant_text",
          delta: "c",
          checkpointOffsetBytes: 3,
          checkpointDigest: "digest-c",
        },
      });
      yield* harness.offer(first);
      yield* harness.offer(last);
      yield* TestClock.adjust(60);
      expect(harness.emitted.at(-1)!.event).toEqual({
        ...first,
        eventId: EventId.make("coalesced:first:last"),
        payload: { streamKind: "assistant_text", delta: "bc" },
      });
      expect(first.payload.delta).toBe("b");
      expect(last.payload.checkpointDigest).toBe("digest-c");
    }).pipe(Effect.scoped),
  );

  it.effect("显式 drain 刷新尾包并废弃旧计时回调，后续新窗口仍可使用", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* harness.offer(textEvent("a", "a"));
      yield* harness.offer(textEvent("b", "b"));
      yield* harness.flush;
      expect(harness.emitted).toHaveLength(2);
      yield* harness.offer(textEvent("c", "c"));
      yield* TestClock.adjust(60);
      expect(harness.emitted.map(({ event }) => event.eventId)).toEqual(["a", "b", "c"]);
    }).pipe(Effect.scoped),
  );

  it.effect("持续突发每 60 ms 最多一组文字且最终内容完整", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      let expected = "";
      for (let window = 0; window < 5; window++) {
        for (let part = 0; part < 30; part++) {
          const delta = `${window}-${part}🌏;`;
          expected += delta;
          yield* harness.offer(textEvent(`${window}-${part}`, delta));
        }
        yield* TestClock.adjust(60);
      }
      expect(harness.emitted.map(({ time }) => time)).toEqual([0, 60, 120, 180, 240, 300]);
      expect(
        harness.emitted
          .map(({ event }) => (event.type === "content.delta" ? event.payload.delta : ""))
          .join(""),
      ).toBe(expected);
    }).pipe(Effect.scoped),
  );

  it.effect("顺序停机先刷新尾包，再关闭计时与投递", () =>
    Effect.gen(function* () {
      const ownScope = yield* Scope.make("sequential");
      const harness = yield* makeHarness.pipe(Effect.provideService(Scope.Scope, ownScope));
      yield* Scope.addFinalizer(ownScope, harness.flush);
      yield* harness.offer(textEvent("a", "a"));
      yield* harness.offer(textEvent("b", "b"));
      yield* harness.offer(controlEvent("terminal"));
      yield* Scope.close(ownScope, Exit.void);
      expect(harness.emitted.map(({ event }) => event.eventId)).toEqual(["a", "b", "terminal"]);
      yield* TestClock.adjust(120);
      yield* harness.offer(textEvent("late", "late"));
      expect(harness.emitted).toHaveLength(3);
    }).pipe(Effect.scoped),
  );

  it.effect("作用域关闭后取消计时与后续投递", () =>
    Effect.gen(function* () {
      const ownScope = yield* Scope.make();
      const harness = yield* makeHarness.pipe(Effect.provideService(Scope.Scope, ownScope));
      yield* harness.offer(textEvent("a", "a"));
      yield* harness.offer(textEvent("b", "b"));
      yield* Scope.close(ownScope, Exit.void);
      yield* TestClock.adjust(60);
      yield* harness.offer(textEvent("late", "late"));
      expect(harness.emitted.map(({ event }) => event.eventId)).toEqual(["a"]);
    }).pipe(Effect.scoped),
  );
});
