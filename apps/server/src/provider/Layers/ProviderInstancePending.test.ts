import { expect, it } from "@effect/vitest";
import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ServerProvider,
} from "@codework/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { ProviderDriver, ProviderInstance } from "../ProviderDriver.ts";
import { makeProviderInstanceRegistry } from "./ProviderInstanceRegistryLive.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";

it.effect("忙碌实例保留最后配置，终态后替换；删除也等待终态", () =>
  Effect.gen(function* () {
    const id = ProviderInstanceId.make("test-account");
    const driverKind = ProviderDriverKind.make("test");
    const threadId = ThreadId.make("thread");
    const turnId = TurnId.make("turn");
    const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = yield* Ref.make<ReadonlyArray<ProviderSession>>([]);
    const started = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    const built: string[] = [];
    const closed: string[] = [];
    const driver: ProviderDriver<{ label: string }> = {
      driverKind,
      metadata: { displayName: "测试" },
      configSchema: Schema.Struct({ label: Schema.String }),
      defaultConfig: () => ({ label: "initial" }),
      create: ({ config }) =>
        Effect.gen(function* () {
          built.push(config.label);
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              closed.push(config.label);
            }),
          );
          const snapshot = {
            instanceId: id,
            driver: driverKind,
            auth: { status: "authenticated" },
          } as ServerProvider;
          return {
            instanceId: id,
            driverKind,
            displayName: config.label,
            enabled: true,
            continuationIdentity: { driverKind, continuationKey: "test" },
            adapter: {
              listSessions: () => Ref.get(sessions),
              streamEvents: Stream.fromQueue(events),
              startSession: () => Effect.die("测试不应启动真实会话"),
              sendTurn: () =>
                Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Deferred.await(finish)),
                  Effect.as({ threadId, turnId }),
                ),
            } as unknown as ProviderInstance["adapter"],
            snapshot: {
              maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
                provider: driverKind,
                packageName: null,
              }),
              getSnapshot: Effect.succeed(snapshot),
              refresh: Effect.succeed(snapshot),
              streamChanges: Stream.empty,
            },
            textGeneration: {} as ProviderInstance["textGeneration"],
          };
        }),
    };
    const config = (label: string) => ({ [id]: { driver: driverKind, config: { label } } });
    const { registry, mutator } = yield* makeProviderInstanceRegistry({
      drivers: [driver],
      configMap: config("initial"),
    });
    const original = (yield* registry.getInstance(id))!;
    const firstEvent = yield* original.adapter.streamEvents.pipe(Stream.runHead, Effect.forkScoped);
    const active = {
      provider: driverKind,
      threadId,
      status: "running",
      activeTurnId: turnId,
    } as ProviderSession;
    yield* Ref.set(sessions, [active]);
    yield* mutator.reconcile(config("obsolete"));
    yield* mutator.reconcile(config("latest"));
    expect(closed).toEqual([]);
    expect((yield* original.snapshot.getSnapshot).message).toContain("等待当前轮次");
    expect((yield* original.snapshot.getSnapshot).auth.status).toBe("authenticated");
    const subscription = yield* registry.subscribeChanges;
    yield* Ref.set(sessions, []);
    yield* Queue.offer(events, {
      eventId: EventId.make("done"),
      type: "turn.completed",
      threadId,
      turnId,
      provider: driverKind,
      createdAt: "2026-09-05T00:00:00.000Z",
      payload: { state: "completed" },
    } as ProviderRuntimeEvent);
    yield* PubSub.take(subscription);
    expect((yield* Fiber.join(firstEvent))._tag).toBe("Some");
    expect(built).toEqual(["initial", "latest"]);
    expect(closed).toEqual(["initial"]);
    expect((yield* registry.getInstance(id))?.displayName).toBe("latest");
    const next = (yield* registry.getInstance(id))!;
    const secondEvent = yield* next.adapter.streamEvents.pipe(Stream.runHead, Effect.forkScoped);
    yield* Ref.set(sessions, [active]);
    yield* mutator.reconcile({});
    yield* PubSub.take(subscription);
    expect(yield* registry.getInstance(id)).toBeDefined();
    yield* Ref.set(sessions, []);
    yield* Queue.offer(events, { type: "session.exited", threadId } as ProviderRuntimeEvent);
    yield* PubSub.take(subscription);
    expect((yield* Fiber.join(secondEvent))._tag).toBe("Some");
    expect(yield* registry.getInstance(id)).toBeUndefined();
    expect(closed).toEqual(["initial", "latest"]);
    yield* mutator.reconcile(config("in-flight"));
    yield* PubSub.take(subscription);
    const working = (yield* registry.getInstance(id))!;
    const running = yield* working.adapter
      .sendTurn({ threadId, input: [] } as unknown as Parameters<
        ProviderInstance["adapter"]["sendTurn"]
      >[0])
      .pipe(Effect.forkScoped);
    yield* Deferred.await(started);
    // 即使 CLI 尚未登记 session，启动/发送中的操作也不能被配置重建杀掉。
    yield* mutator.reconcile(config("after-flight"));
    yield* PubSub.take(subscription);
    expect(closed).toEqual(["initial", "latest"]);
    yield* Deferred.succeed(finish, undefined);
    yield* Fiber.join(running);
    yield* PubSub.take(subscription);
    expect((yield* registry.getInstance(id))?.displayName).toBe("after-flight");
    expect(closed).toEqual(["initial", "latest", "in-flight"]);
  }).pipe(Effect.scoped),
);
