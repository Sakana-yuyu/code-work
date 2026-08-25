import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import type { ProviderRuntimeEvent } from "@t3tools/contracts";
import type { PersistenceSqlError } from "../persistence/Errors.ts";
import { CompositionTaskStore } from "../persistence/Services/CompositionTaskStore.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { CompositionAgentDriverRegistryService } from "./CompositionAgentDriverRegistry.ts";
import { CompositionOrchestratorService } from "./CompositionOrchestratorService.ts";
import { projectCompositionRuntimeEvent } from "./CompositionTaskRuntimeProjector.ts";
import { CompositionRuntimeAdapterRegistryService } from "./CompositionRuntimeAdapterRegistry.ts";
import type { CompositionAgentDriverFailure } from "./CompositionOrchestrator.ts";
import * as CapabilityGrantRegistry from "./CapabilityGrantRegistry.ts";

export interface CompositionTaskRuntimeProjectionServiceShape {
  readonly projectRuntimeEvent: (
    event: ProviderRuntimeEvent,
  ) => Effect.Effect<
    void,
    | PersistenceSqlError
    | CapabilityGrantRegistry.CapabilityGrantPersistenceError
    | CompositionAgentDriverFailure
  >;
}

export class CompositionTaskRuntimeProjectionService extends Context.Service<
  CompositionTaskRuntimeProjectionService,
  CompositionTaskRuntimeProjectionServiceShape
>()("t3/composition/CompositionTaskRuntimeProjectionService") {}

const live = Effect.gen(function* () {
  const store = yield* CompositionTaskStore;
  const provider = yield* ProviderService;
  const driverRegistry = yield* CompositionAgentDriverRegistryService;
  const orchestrator = yield* CompositionOrchestratorService;
  const grantRegistry = yield* CapabilityGrantRegistry.CapabilityGrantRegistry;
  const runtimeAdapters = yield* CompositionRuntimeAdapterRegistryService;
  const projectRuntimeEvent = (event: Parameters<typeof projectCompositionRuntimeEvent>[2]) =>
    projectCompositionRuntimeEvent(store, driverRegistry, event, grantRegistry, () =>
      orchestrator.resumeReadyTasks().pipe(
        Effect.asVoid,
        Effect.catchCause((cause) => Effect.logError("Composition Task 依赖恢复失败", { cause })),
      ),
    );

  const projectRuntimeEventWithLogging = (event: ProviderRuntimeEvent) =>
    projectRuntimeEvent(event).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("Composition Task Runtime 事件投影失败", { cause }),
      ),
    );

  yield* Stream.runForEach(provider.streamEvents, projectRuntimeEventWithLogging).pipe(
    Effect.forkScoped,
  );

  const runningRuntimeStreams = new Set<string>();
  const startRuntimeStreams = Effect.gen(function* () {
    const adapters = yield* runtimeAdapters.list;
    for (const adapter of adapters) {
      if (runningRuntimeStreams.has(adapter.runtimeId)) continue;
      runningRuntimeStreams.add(adapter.runtimeId);
      yield* Stream.runForEach(adapter.streamEvents(), projectRuntimeEventWithLogging).pipe(
        Effect.ensuring(Effect.sync(() => runningRuntimeStreams.delete(adapter.runtimeId))),
        Effect.catchCause((cause) =>
          Effect.logError("Composition Runtime Adapter 事件流失败", {
            runtimeId: adapter.runtimeId,
            cause,
          }),
        ),
        Effect.forkScoped,
      );
    }
  });

  yield* startRuntimeStreams;
  const runtimeSubscription = yield* runtimeAdapters.subscribeChanges;
  yield* Effect.forkScoped(
    Effect.forever(
      PubSub.take(runtimeSubscription).pipe(
        Effect.flatMap(() => startRuntimeStreams),
        Effect.catchCause((cause) =>
          Effect.logError("Composition Runtime Adapter 事件流刷新失败", { cause }),
        ),
      ),
    ),
  );

  return { projectRuntimeEvent } satisfies CompositionTaskRuntimeProjectionServiceShape;
});

export const layer = Layer.effect(CompositionTaskRuntimeProjectionService, live);
