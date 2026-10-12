import { EventId, type ProviderRuntimeEvent } from "@codework/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

export const PROVIDER_TEXT_DELTA_WINDOW_MS = 60;
const RECENT_RUNTIME_EVENT_CAPACITY = 10_000;

function runtimeEventIdentity(event: ProviderRuntimeEvent): string | null {
  // 缺失身份的非法包仍由下游隔离；不能误把后续合法事件当成同一个包。
  if (typeof event.eventId !== "string" || event.eventId.length === 0) return null;
  const payload = event.payload;
  return JSON.stringify([
    event.provider,
    event.providerInstanceId,
    event.threadId,
    event.eventId,
    event.type,
    event.turnId,
    event.itemId,
    event.requestId,
    typeof payload === "object" && payload !== null && "taskId" in payload
      ? payload.taskId
      : undefined,
    event.type === "content.delta" ? event.payload?.streamKind : undefined,
    event.type === "content.delta" ? event.payload?.contentIndex : undefined,
    event.type === "content.delta" ? event.payload?.summaryIndex : undefined,
  ]);
}

interface PendingRuntimeEvent {
  event: ProviderRuntimeEvent;
  readonly textUpdate: boolean;
  readonly mergeKey: string | null;
  readonly firstEventId: string;
}

interface ThreadEventWindow {
  readonly pending: PendingRuntimeEvent[];
  readyAt: number;
}

function pendingEvent(event: ProviderRuntimeEvent): PendingRuntimeEvent {
  // 非法包仍交给已有 ingestion 错误隔离，不能在合并前杀死整个订阅。
  const textUpdate =
    event.type === "content.delta" &&
    typeof event.payload?.delta === "string" &&
    event.payload.delta.length > 0;
  const mergeKey =
    textUpdate &&
    event.type === "content.delta" &&
    !event.payload.image &&
    !event.payload.audio &&
    !event.payload.blob
      ? JSON.stringify([
          event.provider,
          event.providerInstanceId,
          event.turnId,
          event.itemId,
          event.requestId,
          event.providerRefs?.providerTurnId,
          event.providerRefs?.providerItemId,
          event.providerRefs?.providerRequestId,
          event.payload.streamKind,
          event.payload.contentIndex,
          event.payload.summaryIndex,
        ])
      : null;
  return { event, textUpdate, mergeKey, firstEventId: event.eventId };
}

function appendPending(window: ThreadEventWindow, incoming: PendingRuntimeEvent) {
  const previous = window.pending.at(-1);
  if (
    previous?.mergeKey !== null &&
    previous?.mergeKey === incoming.mergeKey &&
    previous.event.type === "content.delta" &&
    incoming.event.type === "content.delta"
  ) {
    const { raw: _raw, ...base } = previous.event;
    const {
      checkpointOffsetBytes: _offset,
      checkpointDigest: _digest,
      ...payload
    } = previous.event.payload;
    // 合并仅用于 ingestion；原始总线保留每个包的日志与 checkpoint，合并包不冒充原始摘要。
    previous.event = {
      ...base,
      eventId: EventId.make(`coalesced:${previous.firstEventId}:${incoming.event.eventId}`),
      payload: { ...payload, delta: payload.delta + incoming.event.payload.delta },
    };
    return;
  }
  window.pending.push(incoming);
}

/** 按线程保持文字与控制事件顺序；空闲首包立即处理，其余文字按固定窗口合并。 */
export const makeProviderRuntimeEventCoalescer = Effect.fn("makeProviderRuntimeEventCoalescer")(
  function* (emit: (events: ReadonlyArray<ProviderRuntimeEvent>) => Effect.Effect<void>) {
    const scope = yield* Scope.Scope;
    const lock = yield* Semaphore.make(1);
    const windows = new Map<string, ThreadEventWindow>();
    const recentEventIdentities = new Set<string>();
    let closed = false;
    yield* Scope.addFinalizer(
      scope,
      Effect.sync(() => {
        closed = true;
        windows.clear();
        recentEventIdentities.clear();
      }),
    );

    const schedule = (
      key: string,
      window: ThreadEventWindow,
      delayMs: number,
    ): Effect.Effect<void> =>
      Effect.sleep(delayMs).pipe(
        Effect.andThen(
          lock.withPermits(1)(
            Effect.gen(function* () {
              if (windows.get(key) !== window) return;
              const now = yield* Clock.currentTimeMillis;
              if (now < window.readyAt) {
                yield* schedule(key, window, window.readyAt - now);
                return;
              }

              const nextText = window.pending.findIndex((entry) => entry.textUpdate);
              if (nextText < 0) {
                const events = window.pending.map((entry) => entry.event);
                windows.delete(key);
                if (events.length > 0) yield* emit(events);
                return;
              }

              let end = nextText + 1;
              while (end < window.pending.length && !window.pending[end]!.textUpdate) end++;
              const events = window.pending.splice(0, end).map((entry) => entry.event);
              window.readyAt = now + PROVIDER_TEXT_DELTA_WINDOW_MS;
              // 同一窗口最多取一组文字；后面的工具、终态等紧随它，不能越过下一组文字。
              yield* emit(events);
              yield* schedule(key, window, PROVIDER_TEXT_DELTA_WINDOW_MS);
            }),
          ),
        ),
        Effect.forkIn(scope),
        Effect.asVoid,
      );

    const offer = Effect.fn("ProviderRuntimeEventCoalescer.offer")(function* (
      event: ProviderRuntimeEvent,
    ) {
      if (closed) return;
      const identity = runtimeEventIdentity(event);
      if (identity !== null) {
        if (recentEventIdentities.has(identity)) return;
        // 在锁内且合并前过滤，重投不能改变积压文字或依赖合并窗口的分组方式。
        recentEventIdentities.add(identity);
        if (recentEventIdentities.size > RECENT_RUNTIME_EVENT_CAPACITY) {
          recentEventIdentities.delete(recentEventIdentities.values().next().value!);
        }
      }
      const key = String(event.threadId);
      const incoming = pendingEvent(event);
      const now = yield* Clock.currentTimeMillis;
      const existing = windows.get(key);
      if (existing === undefined) {
        if (incoming.textUpdate) {
          const window = { pending: [], readyAt: now + PROVIDER_TEXT_DELTA_WINDOW_MS };
          windows.set(key, window);
          yield* emit([event]);
          yield* schedule(key, window, PROVIDER_TEXT_DELTA_WINDOW_MS);
        } else {
          yield* emit([event]);
        }
        return;
      }

      if (existing.pending.length > 0) {
        appendPending(existing, incoming);
        return;
      }
      if (!incoming.textUpdate) {
        yield* emit([event]);
        return;
      }
      if (now >= existing.readyAt) {
        existing.readyAt = now + PROVIDER_TEXT_DELTA_WINDOW_MS;
        yield* emit([event]);
        return;
      }
      appendPending(existing, incoming);
    }, lock.withPermits(1));

    // 显式 drain 供验收与停机刷新使用；清空窗口后旧计时回调无法重发尾包。
    const flush = lock.withPermits(1)(
      Effect.gen(function* () {
        const pending = Array.from(windows.values()).flatMap((window) =>
          window.pending.map((entry) => entry.event),
        );
        windows.clear();
        if (pending.length > 0) yield* emit(pending);
      }),
    );

    return { offer, flush };
  },
);
