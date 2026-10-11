import { EventId, type ProviderRuntimeEvent, type TurnId } from "@codework/contracts";
import * as Effect from "effect/Effect";

type ItemEvent = Extract<
  ProviderRuntimeEvent,
  { readonly type: "item.started" | "item.updated" | "item.completed" }
>;

interface ThreadItems {
  activeTurn: TurnId | undefined;
  closedTurn: { readonly turnId: TurnId | undefined } | undefined;
  readonly items: Map<string, ItemEvent>;
}

/** Adapter 发射边界的在途条目；只关闭同一回合，不结束可独立运行的 task。 */
export function createRuntimeTurnItems() {
  const threads = new Map<string, ThreadItems>();

  const apply = (event: ProviderRuntimeEvent): ReadonlyArray<ProviderRuntimeEvent> => {
    if (event.type === "session.started") {
      threads.delete(event.threadId);
      return [event];
    }
    let state = threads.get(event.threadId);
    if (event.type === "turn.started") {
      if (!state) {
        state = { activeTurn: event.turnId, closedTurn: undefined, items: new Map() };
        threads.set(event.threadId, state);
      } else state.activeTurn = event.turnId;
      return [event];
    }

    if (
      event.type === "item.started" ||
      event.type === "item.updated" ||
      event.type === "item.completed"
    ) {
      if (!event.itemId || event.payload.itemType === "user_message") return [event];
      if (!state && event.type !== "item.started" && event.payload.status !== "inProgress")
        return [event];
      if (!state) {
        state = { activeTurn: undefined, closedTurn: undefined, items: new Map() };
        threads.set(event.threadId, state);
      }
      const turnId = event.turnId ?? state.activeTurn ?? state.closedTurn?.turnId;
      const key = JSON.stringify([turnId, event.itemId]);
      const previous = state.items.get(key);
      const status = event.payload.status;
      const open =
        status === "inProgress" ||
        (status === undefined &&
          event.type !== "item.completed" &&
          (event.type === "item.started" || previous !== undefined));
      // 迟到的运行中通知不能重新点亮刚结束的回合；真正的最终结果仍保留。
      if (open && state.closedTurn?.turnId === turnId && state.closedTurn !== undefined) return [];
      if (open) {
        state.items.set(key, {
          ...event,
          ...(turnId !== undefined ? { turnId } : {}),
          payload: { ...previous?.payload, ...event.payload },
        });
      } else state.items.delete(key);
      return [event];
    }

    if (
      event.type !== "turn.completed" &&
      event.type !== "turn.aborted" &&
      event.type !== "session.exited"
    )
      return [event];
    // 无回合归属的结束不能证明属于当前工作，不能绕过 ingestion 的准入保护。
    if (event.type !== "session.exited" && event.turnId === undefined) return [event];
    if (!state) {
      if (event.type === "session.exited") return [event];
      state = { activeTurn: undefined, closedTurn: undefined, items: new Map() };
      threads.set(event.threadId, state);
    }
    const turnId = event.turnId ?? state.activeTurn;
    const completed = event.type === "turn.completed" && event.payload.state === "completed";
    const settled: ProviderRuntimeEvent[] = [];
    for (const [key, item] of state.items) {
      if (event.type !== "session.exited" && item.turnId !== turnId) continue;
      const { data, detail, ...payload } = item.payload;
      const isText = payload.itemType === "assistant_message" || payload.itemType === "reasoning";
      settled.push({
        ...item,
        type: "item.completed",
        eventId: EventId.make(`${event.eventId}:item:${item.itemId}`),
        createdAt: event.createdAt,
        ...(event.raw ? { raw: event.raw } : {}),
        payload: {
          ...payload,
          status: completed ? "completed" : "failed",
          // 文本始终由完整累积来源收尾，不能用开始通知的旧前缀覆盖新尾文。
          ...(!isText && data !== undefined ? { data } : {}),
          ...(!isText && detail !== undefined ? { detail } : {}),
        },
      });
      state.items.delete(key);
    }
    if (event.type === "session.exited") threads.delete(event.threadId);
    else {
      state.closedTurn = { turnId };
      if (state.activeTurn === turnId) state.activeTurn = undefined;
    }
    return [...settled, event];
  };

  return { apply };
}

/** 在真正发布时更新状态，整批条目完成通知先于回合终态进入同一个队列。 */
export function makeTerminalSafeRuntimeEmitter(
  publish: (events: ReadonlyArray<ProviderRuntimeEvent>) => Effect.Effect<void>,
) {
  const items = createRuntimeTurnItems();
  return (event: ProviderRuntimeEvent) => Effect.suspend(() => publish(items.apply(event)));
}
