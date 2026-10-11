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
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { createRuntimeTurnItems, makeTerminalSafeRuntimeEmitter } from "./runtimeTurnItems.ts";

const base = {
  provider: ProviderDriverKind.make("codex"),
  providerInstanceId: ProviderInstanceId.make("codex-main"),
  threadId: ThreadId.make("thread-1"),
  turnId: TurnId.make("turn-1"),
  createdAt: "2026-01-01T00:00:00.000Z",
};
const item = {
  ...base,
  eventId: EventId.make("item-start"),
  type: "item.started",
  itemId: RuntimeItemId.make("tool-1"),
  payload: { itemType: "mcp_tool_call", status: "inProgress", title: "检查文件" },
} as const satisfies ProviderRuntimeEvent;
const terminal = (state: "completed" | "failed" | "cancelled" | "interrupted") =>
  ({
    ...base,
    eventId: EventId.make(`turn-end-${state}`),
    createdAt: "2026-01-01T00:00:01.000Z",
    type: "turn.completed",
    payload: { state },
  }) as const satisfies ProviderRuntimeEvent;

const approval = {
  ...base,
  eventId: EventId.make("approval-open"),
  type: "request.opened",
  requestId: RuntimeRequestId.make("approval-1"),
  payload: { requestType: "exec_command_approval" },
} as const satisfies ProviderRuntimeEvent;
const question = {
  ...base,
  eventId: EventId.make("question-open"),
  type: "user-input.requested",
  requestId: RuntimeRequestId.make("question-1"),
  payload: {
    questions: [{ id: "choice", header: "选择", question: "采用哪个方案？", options: [] }],
  },
} as const satisfies ProviderRuntimeEvent;

describe("Adapter 的回合条目终态边界", () => {
  for (const state of ["completed", "failed", "cancelled", "interrupted"] as const) {
    it(`${state} 前关闭仍待回应的交互，只取消审批、不授予权限或编造回答`, () => {
      const tracker = createRuntimeTurnItems();
      tracker.apply(approval);
      tracker.apply(question);
      const end = terminal(state);
      const events = tracker.apply(end);
      expect(events.map((event) => event.type)).toEqual([
        "request.resolved",
        "user-input.resolved",
        "turn.completed",
      ]);
      expect(events[0]).toMatchObject({
        threadId: base.threadId,
        turnId: base.turnId,
        requestId: approval.requestId,
        createdAt: end.createdAt,
        payload: { requestType: "exec_command_approval", decision: "cancel" },
      });
      expect(events[1]).toMatchObject({ requestId: question.requestId, payload: { answers: {} } });
      expect(events.at(-1)).toBe(end);
      expect(tracker.apply(end)).toEqual([end]);
    });
  }

  it("真实交互回应解除追踪，保留 provider 的决定与回答", () => {
    const tracker = createRuntimeTurnItems();
    tracker.apply(approval);
    tracker.apply(question);
    const resolvedApproval = {
      ...approval,
      eventId: EventId.make("approval-real-response"),
      type: "request.resolved",
      payload: { requestType: approval.payload.requestType, decision: "decline" },
    } as const;
    const resolvedQuestion = {
      ...question,
      eventId: EventId.make("question-real-response"),
      type: "user-input.resolved",
      payload: { answers: { choice: "方案一" } },
    } as const;
    expect(tracker.apply(resolvedApproval)).toEqual([resolvedApproval]);
    expect(tracker.apply(resolvedQuestion)).toEqual([resolvedQuestion]);
    expect(tracker.apply(terminal("completed"))).toHaveLength(1);
  });

  it("无回合归属的交互沿用当前回合，迟到请求不能重开，下一回合可复用身份", () => {
    const tracker = createRuntimeTurnItems();
    tracker.apply({ ...base, type: "turn.started", eventId: EventId.make("start"), payload: {} });
    tracker.apply({ ...approval, turnId: undefined });
    expect(tracker.apply(terminal("cancelled"))[0]).toMatchObject({
      type: "request.resolved",
      turnId: base.turnId,
    });
    expect(tracker.apply({ ...approval, turnId: undefined })).toEqual([]);
    const nextTurn = TurnId.make("turn-2");
    tracker.apply({
      ...base,
      type: "turn.started",
      turnId: nextTurn,
      eventId: EventId.make("next-start"),
      payload: {},
    });
    tracker.apply({ ...approval, turnId: undefined });
    expect(tracker.apply({ ...terminal("completed"), turnId: nextTurn })[0]).toMatchObject({
      type: "request.resolved",
      turnId: nextTurn,
    });
  });

  it("同名请求在不同回合与交互类型中独立，退出会话才统一关闭", () => {
    const tracker = createRuntimeTurnItems();
    tracker.apply(approval);
    tracker.apply({ ...question, requestId: approval.requestId });
    tracker.apply({ ...approval, turnId: TurnId.make("turn-2") });
    const first = tracker.apply(terminal("failed"));
    expect(first.map((event) => event.type)).toEqual([
      "request.resolved",
      "user-input.resolved",
      "turn.completed",
    ]);
    const exit = {
      ...base,
      eventId: EventId.make("exit"),
      type: "session.exited",
      payload: { exitKind: "error" },
    } as const;
    expect(tracker.apply(exit)).toMatchObject([
      { type: "request.resolved", turnId: "turn-2" },
      { type: "session.exited" },
    ]);
  });

  for (const state of ["completed", "failed", "cancelled", "interrupted"] as const) {
    it(`${state} 前先完成所有未终结条目，不改动归属`, () => {
      const tracker = createRuntimeTurnItems();
      expect(tracker.apply(item)).toEqual([item]);
      tracker.apply({
        ...item,
        eventId: EventId.make("second"),
        itemId: RuntimeItemId.make("tool-2"),
      });
      const final = terminal(state);
      const events = tracker.apply(final);
      expect(events.map((event) => event.type)).toEqual([
        "item.completed",
        "item.completed",
        "turn.completed",
      ]);
      for (const event of events.slice(0, -1)) {
        expect(event).toMatchObject({
          ...base,
          createdAt: final.createdAt,
          type: "item.completed",
          payload: { status: state === "completed" ? "completed" : "failed" },
        });
      }
      expect(events.at(-1)).toBe(final);
      expect(tracker.apply(final)).toEqual([final]);
    });
  }

  it("中止回合也先关闭条目，后台 task 继续独立运行", () => {
    const tracker = createRuntimeTurnItems();
    tracker.apply(item);
    const task = {
      ...base,
      type: "task.started",
      eventId: EventId.make("background"),
      payload: { taskId: RuntimeTaskId.make("background-1"), description: "后台任务" },
    } as const;
    expect(tracker.apply(task)).toEqual([task]);
    const events = tracker.apply({
      ...base,
      type: "turn.aborted",
      eventId: EventId.make("abort"),
      payload: { reason: "取消" },
    });
    expect(events.map((event) => event.type)).toEqual(["item.completed", "turn.aborted"]);
    expect(events[0]?.payload).toMatchObject({ status: "failed" });
  });

  it("结束某回合不关闭其他回合或线程，复用工具 id 仍分开", () => {
    const tracker = createRuntimeTurnItems();
    tracker.apply(item);
    tracker.apply({ ...item, turnId: TurnId.make("turn-2") });
    tracker.apply({ ...item, threadId: ThreadId.make("thread-2") });
    expect(tracker.apply(terminal("completed"))).toHaveLength(2);
    expect(tracker.apply({ ...terminal("failed"), turnId: TurnId.make("turn-2") })).toHaveLength(2);
    expect(
      tracker.apply({ ...terminal("failed"), threadId: ThreadId.make("thread-2") }),
    ).toHaveLength(2);
  });

  it("独立完成通知不补第二次结束，没有 status 也视为完成", () => {
    const tracker = createRuntimeTurnItems();
    tracker.apply(item);
    tracker.apply({ ...item, type: "item.completed", payload: { itemType: "mcp_tool_call" } });
    expect(tracker.apply(terminal("completed"))).toEqual([terminal("completed")]);
  });

  it("缺少回合归属的结束不会关闭当前回合，旧回合结束也不影响新回合", () => {
    const tracker = createRuntimeTurnItems();
    tracker.apply({ ...base, type: "turn.started", eventId: EventId.make("start"), payload: {} });
    tracker.apply(item);
    const { turnId: _, ...untargeted } = terminal("completed");
    expect(tracker.apply(untargeted)).toEqual([untargeted]);
    const old = { ...terminal("completed"), turnId: TurnId.make("old-turn") };
    expect(tracker.apply(old)).toEqual([old]);
    expect(tracker.apply(terminal("completed"))).toHaveLength(2);
  });

  it("明确仍在运行的 completed 包继续追踪，更新保留已知归属", () => {
    const tracker = createRuntimeTurnItems();
    tracker.apply(item);
    tracker.apply({
      ...item,
      type: "item.completed",
      payload: { ...item.payload, detail: "第一段" },
    });
    tracker.apply({
      ...item,
      type: "item.updated",
      payload: { itemType: "mcp_tool_call", title: "检查继续" },
    });
    const events = tracker.apply(terminal("completed"));
    expect(events[0]?.payload).toMatchObject({
      title: "检查继续",
      detail: "第一段",
      status: "completed",
    });
  });

  it("不以开始通知的文字覆盖累积正文，保留子 agent 归属", () => {
    const tracker = createRuntimeTurnItems();
    tracker.apply({
      ...item,
      payload: {
        itemType: "assistant_message",
        detail: "旧前缀",
        data: { text: "旧前缀" },
        agentId: "child-1",
        parentToolUseId: "parent-tool",
      },
    });
    const events = tracker.apply(terminal("completed"));
    expect(events[0]?.payload).toEqual({
      itemType: "assistant_message",
      status: "completed",
      agentId: "child-1",
      parentToolUseId: "parent-tool",
    });
  });

  it("迟到运行通知不重开回合，实际最终结果仍透传", () => {
    const tracker = createRuntimeTurnItems();
    tracker.apply(item);
    tracker.apply(terminal("completed"));
    expect(tracker.apply(item)).toEqual([]);
    const completed = {
      ...item,
      type: "item.completed",
      payload: { ...item.payload, status: "completed", data: { result: "真实结果" } },
    } as const;
    expect(tracker.apply(completed)).toEqual([completed]);
    tracker.apply({
      ...base,
      type: "turn.started",
      eventId: EventId.make("next-turn"),
      turnId: TurnId.make("turn-2"),
      payload: {},
    });
    const next = { ...item, turnId: TurnId.make("turn-2") };
    expect(tracker.apply(next)).toEqual([next]);
    expect(tracker.apply({ ...terminal("completed"), turnId: TurnId.make("turn-2") })).toHaveLength(
      2,
    );
  });

  it("省略回合 id 的条目归于当前回合，终态后省略 id 也不会重开", () => {
    const tracker = createRuntimeTurnItems();
    tracker.apply({
      ...base,
      type: "turn.started",
      eventId: EventId.make("turn-start"),
      payload: {},
    });
    const { turnId: _, ...untargeted } = item;
    tracker.apply(untargeted);
    expect(tracker.apply(terminal("completed"))[0]?.turnId).toBe(base.turnId);
    expect(tracker.apply(untargeted)).toEqual([]);
  });

  it("会话退出关闭所有残留项，新会话没有旧条目", () => {
    const tracker = createRuntimeTurnItems();
    tracker.apply(item);
    tracker.apply({ ...item, turnId: TurnId.make("turn-2") });
    const exit = {
      ...base,
      type: "session.exited",
      eventId: EventId.make("session-exit"),
      payload: { exitKind: "error" },
    } as const;
    expect(tracker.apply(exit).map((event) => event.type)).toEqual([
      "item.completed",
      "item.completed",
      "session.exited",
    ]);
    tracker.apply({
      ...base,
      type: "session.started",
      eventId: EventId.make("session-new"),
      payload: {},
    });
    expect(tracker.apply(terminal("completed"))).toHaveLength(1);
  });

  it("消息增量和用户回显不新增状态或改写身份", () => {
    const tracker = createRuntimeTurnItems();
    const delta = {
      ...base,
      type: "content.delta",
      eventId: EventId.make("delta"),
      payload: { streamKind: "assistant_text", delta: "新尾文🌏" },
    } as const;
    expect(tracker.apply(delta)[0]).toBe(delta);
    const user = { ...item, payload: { itemType: "user_message", status: "inProgress" } } as const;
    expect(tracker.apply(user)[0]).toBe(user);
    expect(tracker.apply(terminal("completed"))).toHaveLength(1);
  });

  it.effect("发射函数只在执行时追踪，整批关闭通知先于终态进入队列", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
      const emit = makeTerminalSafeRuntimeEmitter((events) =>
        Queue.offerAll(queue, events).pipe(Effect.asVoid),
      );
      const notExecuted = emit(item);
      yield* emit(terminal("completed"));
      expect(yield* Queue.take(queue)).toEqual(terminal("completed"));
      yield* notExecuted;
      // 先前回合已结束，迟到的开始通知被丢弃。
      yield* emit({
        ...base,
        type: "turn.started",
        turnId: TurnId.make("turn-2"),
        eventId: EventId.make("next"),
        payload: {},
      });
      yield* emit({ ...item, turnId: TurnId.make("turn-2") });
      yield* emit({ ...terminal("failed"), turnId: TurnId.make("turn-2") });
      const events = yield* Queue.takeAll(queue);
      expect(events.map((event) => event.type)).toEqual([
        "turn.started",
        "item.started",
        "item.completed",
        "turn.completed",
      ]);
    }),
  );
});
