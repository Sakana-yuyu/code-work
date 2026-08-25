import * as Effect from "effect/Effect";

import {
  CompositionAgentDriverAlreadyRegisteredError,
  CompositionAgentDriverInvalidError,
  makeCompositionAgentDriverRegistry,
  type CompositionAgentDriverRegistry,
} from "./CompositionAgentDriverRegistry.ts";
import { makeCompositionRuntimeAgentDriver } from "./CompositionRuntimeAgentDriver.ts";
import type {
  CompositionRuntimeAdapter,
  CompositionRuntimeAdapterFailure,
} from "./CompositionRuntimeAdapter.ts";
import type { CompositionRuntimeAdapterRegistry } from "./CompositionRuntimeAdapterRegistry.ts";

export interface CompositionRuntimeAgentDriverProjection {
  readonly registry: CompositionAgentDriverRegistry;
  readonly refresh: Effect.Effect<
    void,
    | CompositionAgentDriverAlreadyRegisteredError
    | CompositionAgentDriverInvalidError
    | CompositionRuntimeAdapterFailure
  >;
}

export interface CompositionRuntimeAgentDriverProjectionOptions {
  readonly adapterRegistry: Pick<CompositionRuntimeAdapterRegistry, "list">;
  readonly registry?: CompositionAgentDriverRegistry;
}

const projectedAgentIdsFor = (
  adapter: CompositionRuntimeAdapter,
): Effect.Effect<ReadonlyArray<string>, CompositionRuntimeAdapterFailure> =>
  adapter.listAgents().pipe(Effect.map((agents) => agents.map((agent) => agent.agentId)));

export const makeCompositionRuntimeAgentDriverProjection = (
  options: CompositionRuntimeAgentDriverProjectionOptions,
): CompositionRuntimeAgentDriverProjection => {
  const registry = options.registry ?? makeCompositionAgentDriverRegistry();
  const projectedAgentIds = new Set<string>();

  const refresh = Effect.gen(function* () {
    const adapters = yield* options.adapterRegistry.list;
    const liveAgentIds = new Set<string>();

    for (const adapter of adapters) {
      const agentIds = yield* projectedAgentIdsFor(adapter);
      for (const agentId of agentIds) {
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
