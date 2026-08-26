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
  "codework/composition/CompositionRuntimeAgentDriverProjection/CompositionRuntimeAgentDriverProjectionService",
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
  const projectedAgents = new Map<
    string,
    {
      readonly adapter: CompositionRuntimeAdapter;
      readonly driver: ReturnType<typeof makeCompositionRuntimeAgentDriver>;
    }
  >();

  const refresh = Effect.gen(function* () {
    const adapters = yield* options.adapterRegistry.list;
    const liveAgentIds = new Set<string>();

    for (const adapter of adapters) {
      const agents = yield* projectedAgentsFor(adapter);
      for (const agent of agents) {
        const agentId = agent.agentId;
        liveAgentIds.add(agentId);
        const projected = projectedAgents.get(agentId);
        let existing = yield* registry.get(agentId);
        if (projected?.adapter === adapter && existing === projected.driver) continue;
        if (projected !== undefined) {
          if (existing === projected.driver) {
            yield* registry.unregister(agentId);
            existing = undefined;
          }
          projectedAgents.delete(agentId);
        }
        if (existing !== undefined) continue;

        const driver = makeCompositionRuntimeAgentDriver({ adapter, agentId });
        yield* registry.register(driver);
        projectedAgents.set(agentId, { adapter, driver });
      }
    }

    for (const [agentId, projected] of projectedAgents) {
      if (!liveAgentIds.has(agentId)) {
        const existing = yield* registry.get(agentId);
        if (existing === projected.driver) yield* registry.unregister(agentId);
        projectedAgents.delete(agentId);
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
