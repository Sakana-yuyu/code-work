import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";

import {
  CompositionAgentDriverAlreadyRegisteredError,
  CompositionAgentDriverInvalidError,
  makeCompositionAgentDriverRegistry,
  CompositionAgentDriverRegistryService,
  type CompositionAgentDriverRegistry,
} from "./CompositionAgentDriverRegistry.ts";
import { makeCompositionRuntimeAgentDriver } from "./CompositionRuntimeAgentDriver.ts";
import type {
  CompositionRuntimeAdapter,
  CompositionRuntimeAdapterFailure,
  CompositionRuntimeAgent,
} from "./CompositionRuntimeAdapter.ts";
import {
  CompositionRuntimeAdapterRegistryService,
  type CompositionRuntimeAdapterRegistry,
} from "./CompositionRuntimeAdapterRegistry.ts";
import { CompositionRuntimeSettingsReconcilerService } from "./CompositionRuntimeSettings.ts";

export interface CompositionRuntimeAgentDriverProjection {
  readonly registry: CompositionAgentDriverRegistry;
  readonly refresh: Effect.Effect<
    void,
    | CompositionAgentDriverAlreadyRegisteredError
    | CompositionAgentDriverInvalidError
    | CompositionRuntimeAdapterFailure
  >;
}

export interface CompositionRuntimeAgentDriverProjectionServiceShape extends CompositionRuntimeAgentDriverProjection {}

export class CompositionRuntimeAgentDriverProjectionService extends Context.Service<
  CompositionRuntimeAgentDriverProjectionService,
  CompositionRuntimeAgentDriverProjectionServiceShape
>()(
  "t3/composition/CompositionRuntimeAgentDriverProjection/CompositionRuntimeAgentDriverProjectionService",
) {}

export interface CompositionRuntimeAgentDriverProjectionOptions {
  readonly adapterRegistry: Pick<CompositionRuntimeAdapterRegistry, "list">;
  readonly registry?: CompositionAgentDriverRegistry;
}

const projectedAgentsFor = (
  adapter: CompositionRuntimeAdapter,
): Effect.Effect<ReadonlyArray<CompositionRuntimeAgent>, CompositionRuntimeAdapterFailure> =>
  adapter.listAgents();

export const makeCompositionRuntimeAgentDriverProjection = (
  options: CompositionRuntimeAgentDriverProjectionOptions,
): CompositionRuntimeAgentDriverProjection => {
  const registry = options.registry ?? makeCompositionAgentDriverRegistry();
  const projectedAgentIds = new Set<string>();

  const refresh = Effect.gen(function* () {
    const adapters = yield* options.adapterRegistry.list;
    const liveAgentIds = new Set<string>();

    for (const adapter of adapters) {
      const agents = yield* projectedAgentsFor(adapter);
      for (const agent of agents) {
        const agentId = agent.agentId;
        liveAgentIds.add(agentId);
        const existing = yield* registry.get(agentId);
        if (existing !== undefined) continue;

        yield* registry.register(makeCompositionRuntimeAgentDriver({ adapter, agentId }));
        projectedAgentIds.add(agentId);
      }
    }

    for (const agentId of projectedAgentIds) {
      if (!liveAgentIds.has(agentId)) {
        yield* registry.unregister(agentId);
        projectedAgentIds.delete(agentId);
      }
    }
  });

  return { registry, refresh };
};

const live = Effect.gen(function* () {
  const runtimeSettings = yield* CompositionRuntimeSettingsReconcilerService;
  yield* runtimeSettings.ready;
  const adapterRegistry = yield* CompositionRuntimeAdapterRegistryService;
  const agentDriverRegistry = yield* CompositionAgentDriverRegistryService;
  const projection = makeCompositionRuntimeAgentDriverProjection({
    adapterRegistry,
    registry: agentDriverRegistry,
  });

  yield* projection.refresh;
  const subscription = yield* adapterRegistry.subscribeChanges;
  yield* Effect.forkScoped(
    Effect.forever(
      PubSub.take(subscription).pipe(
        Effect.flatMap(() => projection.refresh),
        Effect.catchCause((cause) =>
          Effect.logError("Composition Runtime Agent Driver 刷新失败", { cause }),
        ),
      ),
    ),
  );

  return projection;
});

export const layer = Layer.effect(CompositionRuntimeAgentDriverProjectionService, live);
