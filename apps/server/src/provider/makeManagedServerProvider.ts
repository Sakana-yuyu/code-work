import {
  DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL,
  type ServerProvider,
  ServerSettingsError,
} from "@codework/contracts";
import { resolveServerBackgroundActivitySettings } from "@codework/shared/backgroundActivitySettings";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import type * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { ProviderCatalogForceRefresh } from "./ProviderCatalogCache.ts";
import type { ServerProviderShape } from "./Services/ServerProvider.ts";

interface ProviderSnapshotState {
  readonly snapshot: ServerProvider;
  readonly enrichmentGeneration: number;
}

export const makeManagedServerProvider = Effect.fn("makeManagedServerProvider")(function* <
  Settings,
>(input: {
  readonly maintenanceCapabilities: ServerProviderShape["maintenanceCapabilities"];
  readonly getSettings: Effect.Effect<Settings, ServerSettingsError>;
  readonly streamSettings: Stream.Stream<Settings>;
  readonly haveSettingsChanged: (previous: Settings, next: Settings) => boolean;
  readonly initialSnapshot: (settings: Settings) => Effect.Effect<ServerProvider>;
  readonly checkProvider: Effect.Effect<ServerProvider, ServerSettingsError>;
  /** 目录缓存接入后，手动刷新不能加入已经可能读取旧缓存的普通检查。 */
  readonly usesCatalogCache?: boolean;
  /** 在任何快照对外可见前应用模型路由等必要约束，不等待异步补充信息。 */
  readonly prepareSnapshot?: (snapshot: ServerProvider) => Effect.Effect<ServerProvider>;
  readonly enrichSnapshot?: (input: {
    readonly settings: Settings;
    readonly snapshot: ServerProvider;
    readonly getSnapshot: Effect.Effect<ServerProvider>;
    readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  }) => Effect.Effect<void>;
  readonly refreshInterval?: Duration.Input;
}): Effect.fn.Return<
  ServerProviderShape,
  ServerSettingsError,
  Scope.Scope | BackgroundPolicy.BackgroundPolicy | ServerSettingsService
> {
  const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
  const serverSettings = yield* ServerSettingsService;
  const refreshSemaphore = yield* Semaphore.make(1);
  const changesPubSub = yield* Effect.acquireRelease(
    PubSub.unbounded<ServerProvider>(),
    PubSub.shutdown,
  );
  const initialSettings = yield* input.getSettings;
  const prepareSnapshot = input.prepareSnapshot ?? Effect.succeed;
  const initialSnapshot = yield* input
    .initialSnapshot(initialSettings)
    .pipe(Effect.flatMap(prepareSnapshot));
  const snapshotStateRef = yield* Ref.make<ProviderSnapshotState>({
    snapshot: initialSnapshot,
    enrichmentGeneration: 0,
  });
  const settingsRef = yield* Ref.make(initialSettings);
  const enrichmentFiberRef = yield* Ref.make<Fiber.Fiber<void, unknown> | null>(null);
  const scope = yield* Effect.scope;
  const refreshes = new Set<{
    readonly settings: Settings;
    readonly catalogForceRefresh: boolean;
    readonly deferred: Deferred.Deferred<Exit.Exit<ServerProvider, ServerSettingsError>>;
  }>();

  const publishEnrichedSnapshot = Effect.fn("publishEnrichedSnapshot")(function* (
    generation: number,
    settings: Settings,
    enrichedSnapshot: ServerProvider,
  ) {
    const nextSnapshot = yield* prepareSnapshot(enrichedSnapshot);
    const currentSettings = yield* input.getSettings.pipe(Effect.result);
    if (
      currentSettings._tag === "Failure" ||
      input.haveSettingsChanged(settings, currentSettings.success)
    )
      return;
    const snapshotToPublish = yield* Ref.modify(snapshotStateRef, (state) => {
      if (state.enrichmentGeneration !== generation || Equal.equals(state.snapshot, nextSnapshot)) {
        return [null, state] as const;
      }
      return [
        nextSnapshot,
        {
          ...state,
          snapshot: nextSnapshot,
        },
      ] as const;
    });
    if (snapshotToPublish === null) {
      return;
    }
    yield* PubSub.publish(changesPubSub, snapshotToPublish);
  });

  const restartSnapshotEnrichment = Effect.fn("restartSnapshotEnrichment")(function* (
    settings: Settings,
    snapshot: ServerProvider,
    generation: number,
  ) {
    const previousFiber = yield* Ref.getAndSet(enrichmentFiberRef, null);
    if (previousFiber) {
      yield* Fiber.interrupt(previousFiber).pipe(Effect.ignore);
    }

    if (!input.enrichSnapshot) {
      return;
    }

    const fiber = yield* input
      .enrichSnapshot({
        settings,
        snapshot,
        getSnapshot: Ref.get(snapshotStateRef).pipe(Effect.map((state) => state.snapshot)),
        publishSnapshot: (nextSnapshot) =>
          publishEnrichedSnapshot(generation, settings, nextSnapshot),
      })
      .pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(scope));

    yield* Ref.set(enrichmentFiberRef, fiber);
  });

  const applySnapshotBase = Effect.fn("applySnapshotBase")(function* (
    nextSettings: Settings,
    catalogForceRefresh: boolean,
  ) {
    // 排队期间及探测期间都可能更新快照设置；过期检查不能发布或启动补充探测。
    if (input.haveSettingsChanged(nextSettings, yield* input.getSettings)) {
      return yield* Ref.get(snapshotStateRef).pipe(Effect.map((state) => state.snapshot));
    }

    const nextSnapshot = yield* input.checkProvider.pipe(
      Effect.provideService(ProviderCatalogForceRefresh, catalogForceRefresh),
      Effect.flatMap(prepareSnapshot),
    );
    if (input.haveSettingsChanged(nextSettings, yield* input.getSettings)) {
      return yield* Ref.get(snapshotStateRef).pipe(Effect.map((state) => state.snapshot));
    }
    const nextGeneration = yield* Ref.modify(snapshotStateRef, (state) => {
      const generation = input.enrichSnapshot
        ? state.enrichmentGeneration + 1
        : state.enrichmentGeneration;
      return [
        generation,
        {
          snapshot: nextSnapshot,
          enrichmentGeneration: generation,
        },
      ] as const;
    });
    yield* Ref.set(settingsRef, nextSettings);
    yield* PubSub.publish(changesPubSub, nextSnapshot);
    yield* restartSnapshotEnrichment(nextSettings, nextSnapshot, nextGeneration);
    return nextSnapshot;
  });
  const applySnapshot = Effect.fn("applySnapshot")(function* (
    nextSettings: Settings,
    options?: { readonly forceRefresh?: boolean; readonly catalogForceRefresh?: boolean },
  ) {
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        if (scope.state._tag === "Closed") return yield* Effect.interrupt;
        const previousSettings = yield* Ref.get(settingsRef);
        const deferred = yield* Deferred.make<Exit.Exit<ServerProvider, ServerSettingsError>>();
        const catalogForceRefresh = options?.catalogForceRefresh === true;
        const refresh = { settings: nextSettings, catalogForceRefresh, deferred };
        // 查找与登记在同一个同步步骤完成，自动让出不会创建重复的排队检查。
        const pending = yield* Effect.sync(() => {
          const existing = [...refreshes].find(
            (active) =>
              !input.haveSettingsChanged(active.settings, nextSettings) &&
              (input.usesCatalogCache !== true ||
                !catalogForceRefresh ||
                active.catalogForceRefresh),
          );
          if (existing) return existing;
          if (
            options?.forceRefresh !== true &&
            !input.haveSettingsChanged(previousSettings, nextSettings)
          )
            return null;
          refreshes.add(refresh);
          return refresh;
        });
        if (pending === null) {
          yield* Ref.set(settingsRef, nextSettings);
          return yield* Ref.get(snapshotStateRef).pipe(Effect.map((state) => state.snapshot));
        }
        if (pending !== refresh)
          return yield* restore(Deferred.await(pending.deferred).pipe(Effect.flatten));
        // 探测属于 provider 生命周期，其可中断性不继承调用者，取消只结束自身等待。
        yield* refreshSemaphore
          .withPermits(1)(applySnapshotBase(nextSettings, catalogForceRefresh))
          .pipe(
            Effect.interruptible,
            Effect.onExit((exit) =>
              Effect.sync(() => refreshes.delete(refresh)).pipe(
                // 先唤醒全部等待者，再各自重放退出值，避免中断清理打断共享唤醒。
                Effect.andThen(Deferred.succeed(deferred, exit)),
              ),
            ),
            Effect.forkIn(scope, { startImmediately: true, uninterruptible: true }),
          );
        return yield* restore(Deferred.await(deferred).pipe(Effect.flatten));
      }),
    );
  });

  const refreshSnapshot = Effect.fn("refreshSnapshot")(function* (catalogForceRefresh: boolean) {
    const nextSettings = yield* input.getSettings;
    return yield* applySnapshot(nextSettings, { forceRefresh: true, catalogForceRefresh });
  });

  const hasProviderStatusDemand = Effect.gen(function* () {
    const state = yield* Ref.get(snapshotStateRef);
    const instanceId = state.snapshot.instanceId;
    const [genericDemand, instanceDemand] = yield* Effect.all([
      backgroundPolicy.shouldRunScopeWork({ type: "provider-status" }),
      backgroundPolicy.shouldRunScopeWork({ type: "provider-status", instanceId }),
    ]);
    return genericDemand || instanceDemand;
  });

  const getRefreshInterval =
    input.refreshInterval !== undefined
      ? Effect.succeed(input.refreshInterval)
      : serverSettings.getSettings.pipe(
          Effect.map(
            (settings) =>
              resolveServerBackgroundActivitySettings(settings).providerHealthRefreshInterval,
          ),
          Effect.orElseSucceed(() => DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL),
        );

  const refreshIntervalChanges = yield* Queue.sliding<void>(1);
  if (input.refreshInterval === undefined) {
    const serverSettingsChanges = yield* serverSettings.subscribeChanges;
    yield* serverSettingsChanges.pipe(
      Stream.map((settings) =>
        Duration.toMillis(
          resolveServerBackgroundActivitySettings(settings).providerHealthRefreshInterval,
        ),
      ),
      Stream.changes,
      Stream.runForEach(() => Queue.offer(refreshIntervalChanges, undefined).pipe(Effect.asVoid)),
      Effect.forkScoped,
    );
  }

  yield* Stream.runForEach(input.streamSettings, (nextSettings) =>
    Effect.asVoid(applySnapshot(nextSettings)),
  ).pipe(Effect.forkScoped);

  yield* Effect.forever(
    getRefreshInterval.pipe(
      Effect.flatMap((refreshInterval) =>
        Effect.raceFirst(
          Effect.sleep(
            Duration.toMillis(Duration.fromInputUnsafe(refreshInterval)) <= 0
              ? "60 seconds"
              : refreshInterval,
          ).pipe(Effect.as(true)),
          Queue.take(refreshIntervalChanges).pipe(Effect.as(false)),
        ).pipe(
          Effect.flatMap((intervalElapsed) =>
            intervalElapsed && Duration.toMillis(Duration.fromInputUnsafe(refreshInterval)) > 0
              ? hasProviderStatusDemand.pipe(
                  Effect.flatMap((shouldRefresh) =>
                    shouldRefresh ? refreshSnapshot(false).pipe(Effect.asVoid) : Effect.void,
                  ),
                )
              : Effect.void,
          ),
        ),
      ),
      Effect.ignoreCause({ log: true }),
    ),
  ).pipe(Effect.forkScoped);

  yield* applySnapshot(initialSettings, { forceRefresh: true }).pipe(
    Effect.ignoreCause({ log: true }),
    Effect.forkScoped,
  );

  return {
    maintenanceCapabilities: input.maintenanceCapabilities,
    getSnapshot: Ref.get(snapshotStateRef).pipe(Effect.map((state) => state.snapshot)),
    refresh: refreshSnapshot(true).pipe(Effect.tapError(Effect.logError), Effect.orDie),
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub);
    },
    get subscribeChanges() {
      return PubSub.subscribe(changesPubSub);
    },
  } satisfies ServerProviderShape;
});
