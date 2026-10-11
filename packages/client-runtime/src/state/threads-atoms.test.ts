import {
  EnvironmentId,
  EventId,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThread,
  type OrchestrationThreadDetailSnapshot,
  type OrchestrationThreadStreamItem,
  type ScopedThreadRef,
} from "@codework/contracts";
import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { EnvironmentCacheStore, ConnectionPersistenceError } from "../platform/persistence.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createEnvironmentThreadDetailAtoms } from "./threadDetail.ts";
import { THREAD_STATE_IDLE_TTL_MS } from "./threadRetention.ts";
import { FrameClock } from "./latestFrame.ts";
import {
  createEnvironmentThreadStateAtoms,
  requestOlderThreadTurns,
  ThreadSnapshotLoader,
} from "./threads.ts";

const REF: ScopedThreadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
};
const BASE_THREAD: OrchestrationThread = {
  id: REF.threadId,
  projectId: ProjectId.make("project-1"),
  title: "缓存线程",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
};

const makeHarness = Effect.fn("线程订阅测试.makeHarness")(function* (options?: {
  readonly cached?: OrchestrationThreadDetailSnapshot;
  readonly failSave?: boolean;
  readonly frameClock?: { readonly wait: Effect.Effect<void> };
}) {
  vi.useFakeTimers();
  const inputs = yield* Queue.unbounded<OrchestrationThreadStreamItem>();
  const subscriptions: Array<{ readonly afterSequence?: number }> = [];
  const closed: Array<number> = [];
  const saved: Array<OrchestrationThreadDetailSnapshot> = [];
  let cacheLoads = 0;
  let snapshotLoads = 0;
  let disconnects = 0;
  let saveAttempts = 0;
  let releaseSave: (() => void) | undefined;
  let releasePage: (() => void) | undefined;
  let saveBlocked = false;
  let pageCancelled = false;
  const client = {
    [ORCHESTRATION_WS_METHODS.subscribeThread]: (input: { readonly afterSequence?: number }) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const index = subscriptions.push(input);
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              closed.push(index);
            }),
          );
          return Stream.fromQueue(inputs);
        }),
      ),
  } as unknown as WsRpcProtocolClient;
  const session: RpcSession = {
    client,
    initialConfig: Effect.succeed({
      threadResumeCompletionMarker: true,
      threadSnapshotPagination: true,
    } as never),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
  const target = new PrimaryConnectionTarget({
    environmentId: REF.environmentId,
    label: "测试环境",
    httpBaseUrl: "https://example.test",
    wsBaseUrl: "wss://example.test",
  });
  const supervisor = EnvironmentSupervisor.of({
    target,
    state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(
      Option.some({
        environmentId: target.environmentId,
        label: target.label,
        httpBaseUrl: target.httpBaseUrl,
        socketUrl: target.wsBaseUrl,
        httpAuthorization: null,
        target,
      }),
    ),
    connect: Effect.void,
    disconnect: Effect.sync(() => {
      disconnects++;
    }),
    retryNow: Effect.void,
  });
  const environmentRegistry = EnvironmentRegistry.of({
    followStream: (_environmentId, stream) =>
      Stream.provideService(stream, EnvironmentSupervisor, supervisor),
  } as EnvironmentRegistry["Service"]);
  const cache = EnvironmentCacheStore.of({
    loadShell: () => Effect.succeed(Option.none()),
    saveShell: () => Effect.void,
    loadThread: () =>
      Effect.sync(() => {
        cacheLoads++;
        return Option.fromNullishOr(options?.cached);
      }),
    saveThread: (_environmentId, snapshot) =>
      Effect.gen(function* () {
        saveAttempts++;
        if (options?.failSave && saveAttempts === 1)
          return yield* new ConnectionPersistenceError({
            operation: "save-thread",
            message: "测试首次写入失败",
          });
        if (saveBlocked)
          yield* Effect.callback<void>((resume) => {
            releaseSave = () => resume(Effect.void);
          });
        saved.push(snapshot);
      }),
    removeThread: () => Effect.void,
    loadServerConfig: () => Effect.succeed(Option.none()),
    saveServerConfig: () => Effect.void,
    loadVcsRefs: () => Effect.succeed(Option.none()),
    saveVcsRefs: () => Effect.void,
    removeVcsRefs: () => Effect.void,
    clearVcsRefs: () => Effect.void,
    clear: () => Effect.void,
  });
  const loader = ThreadSnapshotLoader.of({
    load: (_prepared, _threadId, window) => {
      snapshotLoads++;
      if (window?.beforeCursor)
        return Effect.callback<Option.Option<OrchestrationThreadDetailSnapshot>>((resume) => {
          releasePage = () => resume(Effect.succeed(Option.none()));
          return Effect.sync(() => {
            pageCancelled = true;
          });
        });
      return Effect.succeed(Option.none());
    },
  });
  const runtime = Atom.runtime(
    Layer.mergeAll(
      Layer.succeed(EnvironmentRegistry, environmentRegistry),
      Layer.succeed(EnvironmentCacheStore, cache),
      Layer.succeed(ThreadSnapshotLoader, loader),
      ...(options?.frameClock ? [Layer.succeed(FrameClock, options.frameClock)] : []),
    ),
  );
  const threads = createEnvironmentThreadStateAtoms(runtime);
  const details = createEnvironmentThreadDetailAtoms(threads.stateAtom);
  const tasks: Array<{ readonly run: () => void; cancelled: boolean }> = [];
  const registry = AtomRegistry.make({
    timeoutResolution: 1,
    scheduleTask: (run) => {
      const task = { run, cancelled: false };
      tasks.push(task);
      return () => {
        task.cancelled = true;
      };
    },
  });
  const atom = threads.stateAtom(REF.environmentId, REF.threadId);
  const read = () => Option.getOrThrow(AsyncResult.value(registry.get(atom)));
  const drain = async () => {
    await Promise.resolve();
    while (tasks.length > 0) {
      for (const task of tasks.splice(0)) if (!task.cancelled) task.run();
      await Promise.resolve();
    }
  };
  // 消费 scheduler 已入队的任务；虚拟时钟只推进 TTL / debounce，不等待真实时间。
  const settle = async () => {
    await drain();
    await vi.advanceTimersByTimeAsync(0);
    await drain();
  };
  const snapshot = async (
    thread = BASE_THREAD,
    sequence = 7,
    page?: OrchestrationThreadDetailSnapshot["page"],
  ) => {
    Queue.offerUnsafe(inputs, {
      kind: "snapshot",
      snapshot: { thread, snapshotSequence: sequence, ...(page ? { page } : {}) },
    });
    await settle();
  };
  const event = async (title: string, sequence: number) => {
    Queue.offerUnsafe(inputs, {
      kind: "event",
      event: {
        eventId: EventId.make(`event-${sequence}`),
        sequence,
        aggregateKind: "thread",
        aggregateId: REF.threadId,
        type: "thread.meta-updated",
        occurredAt: "2026-04-01T00:01:00.000Z",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: { threadId: REF.threadId, title, updatedAt: "2026-04-01T00:01:00.000Z" },
      },
    });
    await settle();
  };
  return {
    registry,
    atom,
    details,
    read,
    settle,
    snapshot,
    event,
    emit: async (item: OrchestrationThreadStreamItem) => {
      Queue.offerUnsafe(inputs, item);
      await settle();
    },
    subscriptions,
    closed,
    saved,
    counts: () => ({ cacheLoads, snapshotLoads, disconnects, saveAttempts }),
    blockSave: () => {
      saveBlocked = true;
    },
    releaseSave: () => {
      saveBlocked = false;
      releaseSave?.();
    },
    releasePage: () => releasePage?.(),
    pageCancelled: () => pageCancelled,
  };
});

const registries: Array<AtomRegistry.AtomRegistry> = [];
afterEach(() => {
  registries.splice(0).forEach((registry) => registry.dispose());
  vi.useRealTimers();
});
function harness(options?: Parameters<typeof makeHarness>[0]) {
  return makeHarness(options).pipe(
    Effect.tap((value) =>
      Effect.sync(() => {
        registries.push(value.registry);
      }),
    ),
  );
}

describe("createEnvironmentThreadStateAtoms", () => {
  it.effect("帧内仅发布一次完整正文，退出前未显示的完成事件仍与游标一起保留", () =>
    Effect.gen(function* () {
      const frames: Array<{ run: () => void; cancelled: boolean }> = [];
      const h = yield* harness({
        cached: { thread: BASE_THREAD, snapshotSequence: 7 },
        frameClock: {
          wait: Effect.callback<void>((resume) => {
            const frame = { run: () => resume(Effect.void), cancelled: false };
            frames.push(frame);
            return Effect.sync(() => {
              frame.cancelled = true;
            });
          }),
        },
      });
      yield* Effect.promise(async () => {
        const tick = async () => {
          for (const frame of frames.splice(0)) if (!frame.cancelled) frame.run();
          await h.settle();
        };
        const close = h.registry.mount(h.atom);
        await h.settle();
        await tick();
        const seen: string[] = [];
        const unsubscribe = h.registry.subscribe(h.atom, (result) => {
          const value = Option.getOrNull(AsyncResult.value(result));
          const thread = value ? Option.getOrNull(value.data) : null;
          if (thread) seen.push(thread.messages.map((message) => message.text).join(""));
        });
        const emitMessage = (text: string, sequence: number, streaming: boolean) =>
          h.emit({
            kind: "event",
            event: {
              eventId: EventId.make(`frame-event-${sequence}`),
              sequence,
              aggregateKind: "thread",
              aggregateId: REF.threadId,
              type: "thread.message-sent",
              occurredAt: "2026-04-01T00:01:00.000Z",
              commandId: null,
              causationEventId: null,
              correlationId: null,
              metadata: {},
              payload: {
                threadId: REF.threadId,
                messageId: MessageId.make("frame-message"),
                role: "assistant",
                turnId: TurnId.make("turn-1"),
                text,
                streaming,
                createdAt: "2026-04-01T00:01:00.000Z",
                updatedAt: "2026-04-01T00:01:00.000Z",
              },
            },
          });
        await emitMessage("首段🌏", 8, true);
        await emitMessage("与完整尾文", 9, true);
        expect(seen).toEqual([]);
        await tick();
        expect(seen).toEqual(["首段🌏与完整尾文"]);
        await emitMessage("首段🌏与完整尾文", 10, false);
        expect(Option.getOrThrow(h.read().data).messages[0]?.streaming).toBe(true);
        unsubscribe();
        close();
        await h.settle();
        const reopen = h.registry.mount(h.atom);
        expect(Option.getOrThrow(h.read().data).messages[0]).toMatchObject({
          text: "首段🌏与完整尾文",
          streaming: false,
        });
        await h.settle();
        expect(h.subscriptions[1]?.afterSequence).toBe(10);
        expect(h.counts().disconnects).toBe(0);
        reopen();
      });
    }),
  );

  it("立即释放实时节点并保留线程 atom 的身份", () => {
    const runtime = Atom.runtime(Layer.empty) as unknown as Atom.AtomRuntime<
      EnvironmentRegistry | EnvironmentCacheStore | ThreadSnapshotLoader,
      never
    >;
    const threads = createEnvironmentThreadStateAtoms(runtime);
    const environmentId = EnvironmentId.make("environment-1");
    const threadId = ThreadId.make("thread-1");
    const atom = threads.stateAtom(environmentId, threadId);

    expect(atom.idleTTL).toBe(0);
    expect(threads.stateAtom(environmentId, threadId)).toBe(atom);
    expect(threads.stateAtom(environmentId, ThreadId.make("thread-2"))).not.toBe(atom);
  });

  it.effect("多个消费者共享订阅，最后退出才取消且不关闭环境连接", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* Effect.promise(async () => {
        const first = h.registry.mount(h.details.messagesAtom(REF));
        const second = h.registry.mount(h.details.statusAtom(REF));
        await h.settle();
        await h.snapshot();
        expect(h.subscriptions).toHaveLength(1);
        first();
        await h.settle();
        expect(h.closed).toHaveLength(0);
        second();
        await h.settle();
        expect(h.closed).toEqual([1]);
        expect(h.counts().disconnects).toBe(0);
      });
    }),
  );

  it.effect("忙碌线程立即显示缓存并从配对游标重放，无额外 HTTP 或磁盘读取", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* Effect.promise(async () => {
        const close = h.registry.mount(h.atom);
        await h.settle();
        const active = {
          ...BASE_THREAD,
          session: {
            threadId: REF.threadId,
            status: "running" as const,
            providerName: "codex" as const,
            runtimeMode: "full-access" as const,
            activeTurnId: TurnId.make("turn-1"),
            lastError: null,
            updatedAt: BASE_THREAD.updatedAt,
          },
        };
        await h.snapshot(active);
        await h.event("已显示的新标题", 8);
        close();
        await h.settle();
        expect(h.saved).toHaveLength(0);
        const reopen = h.registry.mount(h.atom);
        expect(Option.getOrThrow(h.read().data).title).toBe("已显示的新标题");
        await h.settle();
        expect(h.subscriptions[1]?.afterSequence).toBe(8);
        expect(h.counts()).toMatchObject({ cacheLoads: 1, snapshotLoads: 1, disconnects: 0 });
        await h.event("重复旧标题", 8);
        expect(Option.getOrThrow(h.read().data).title).toBe("已显示的新标题");
        await h.event("新标题", 9);
        expect(Option.getOrThrow(h.read().data).title).toBe("新标题");
        reopen();
      });
    }),
  );

  it.effect("缓存到期后内容与游标同时丢弃，重新请求完整快照", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* Effect.promise(async () => {
        const close = h.registry.mount(h.atom);
        await h.settle();
        await h.snapshot();
        close();
        await h.settle();
        await vi.advanceTimersByTimeAsync(THREAD_STATE_IDLE_TTL_MS + 2);
        const reopen = h.registry.mount(h.atom);
        await h.settle();
        expect(h.subscriptions[1]?.afterSequence).toBeUndefined();
        expect(h.counts()).toMatchObject({ cacheLoads: 2, snapshotLoads: 2 });
        expect(Option.isNone(h.read().data)).toBe(true);
        reopen();
      });
    }),
  );

  it.effect("缓存按 registry 和环境隔离", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* Effect.promise(async () => {
        const other = AtomRegistry.make();
        registries.push(other);
        h.registry.mount(h.atom);
        await h.settle();
        await h.snapshot();
        other.mount(h.atom);
        await h.settle();
        expect(Option.isNone(Option.getOrThrow(AsyncResult.value(other.get(h.atom))).data)).toBe(
          true,
        );
        const otherEnvironment = h.registry.mount(
          h.details.stateAtom({ ...REF, environmentId: EnvironmentId.make("environment-2") }),
        );
        await h.settle();
        expect(h.subscriptions.at(-1)?.afterSequence).toBeUndefined();
        otherEnvironment();
      });
    }),
  );

  it.effect("退出取消分页请求，重新打开保留页边界且清除加载状态", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* Effect.promise(async () => {
        const close = h.registry.mount(h.atom);
        await h.settle();
        await h.snapshot(BASE_THREAD, 7, {
          beforeCursor: "older-cursor",
          hasMore: true,
          snapshotSequence: 7,
        });
        expect(requestOlderThreadTurns(REF.environmentId, REF.threadId)).toBe(true);
        await h.settle();
        expect(Option.getOrThrow(h.read().page).loadingOlder).toBe(true);
        close();
        await h.settle();
        expect(h.pageCancelled()).toBe(true);
        const reopen = h.registry.mount(h.atom);
        expect(Option.getOrThrow(h.read().page)).toMatchObject({
          beforeCursor: "older-cursor",
          hasMore: true,
          loadingOlder: false,
        });
        h.releasePage();
        await h.settle();
        expect(h.subscriptions[1]?.afterSequence).toBe(7);
        reopen();
      });
    }),
  );

  it.effect("已后台保存的快照退出不重复写入，新快照退出补写", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* Effect.promise(async () => {
        const close = h.registry.mount(h.atom);
        await h.settle();
        await h.snapshot();
        await vi.advanceTimersByTimeAsync(500);
        await h.settle();
        expect(h.saved).toHaveLength(1);
        close();
        await h.settle();
        expect(h.saved).toHaveLength(1);
        const reopen = h.registry.mount(h.atom);
        await h.settle();
        await h.event("结束前更新", 8);
        expect(Option.getOrThrow(h.read().data).title).toBe("结束前更新");
        reopen();
        await h.settle();
        expect(h.closed).toEqual([1, 2]);
        expect(h.saved.at(-1)?.thread.title).toBe("结束前更新");
      });
    }),
  );

  it.effect("后台保存失败后退出仍尝试补写", () =>
    Effect.gen(function* () {
      const h = yield* harness({ failSave: true });
      yield* Effect.promise(async () => {
        const close = h.registry.mount(h.atom);
        await h.settle();
        await h.snapshot();
        await vi.advanceTimersByTimeAsync(500);
        await h.settle();
        expect(h.counts().saveAttempts).toBe(1);
        expect(h.saved).toHaveLength(0);
        close();
        await h.settle();
        expect(h.saved).toHaveLength(1);
        expect(h.counts().saveAttempts).toBe(2);
      });
    }),
  );

  it.effect("旧作用域等待最终写入时，新订阅的缓存不会被旧完成覆盖", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* Effect.promise(async () => {
        const close = h.registry.mount(h.atom);
        await h.settle();
        await h.snapshot();
        h.blockSave();
        close();
        await h.settle();
        const reopen = h.registry.mount(h.atom);
        await h.settle();
        await h.event("新作用域", 8);
        reopen();
        await h.settle();
        expect(h.closed).toEqual([1, 2]);
        const finalOpen = h.registry.mount(h.atom);
        expect(Option.getOrThrow(h.read().data).title).toBe("新作用域");
        h.releaseSave();
        await h.settle();
        expect(h.saved.at(-1)?.thread.title).toBe("新作用域");
        expect(h.saved.at(-1)?.snapshotSequence).toBe(8);
        expect(h.subscriptions[2]?.afterSequence).toBe(8);
        finalOpen();
      });
    }),
  );
});
