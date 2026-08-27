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
import {
  compositionIdeAgentId,
  makeCompositionIdeAgentDriver,
} from "./CompositionIdeAgentDriver.ts";
import {
  CompositionIdeSessionRegistryService,
  type CompositionIdeAdapter,
  type CompositionIdeSessionRegistry,
} from "./CompositionIdeSessionRegistry.ts";

export interface CompositionIdeAgentDriverProjection {
  readonly registry: CompositionAgentDriverRegistry;
  readonly refresh: Effect.Effect<
    void,
    CompositionAgentDriverAlreadyRegisteredError | CompositionAgentDriverInvalidError
  >;
}

export class CompositionIdeAgentDriverProjectionService extends Context.Service<
  CompositionIdeAgentDriverProjectionService,
  CompositionIdeAgentDriverProjection
>()(
  "codework/composition/CompositionIdeAgentDriverProjection/CompositionIdeAgentDriverProjectionService",
) {}

export const makeCompositionIdeAgentDriverProjection = (options: {
  readonly sessionRegistry: Pick<
    CompositionIdeSessionRegistry,
    "list" | "subscribeChanges" | "get" | "resolve" | "handshake" | "invoke" | "revokeHandshake"
  >;
  readonly registry?: CompositionAgentDriverRegistry;
}): CompositionIdeAgentDriverProjection => {
  const registry = options.registry ?? makeCompositionAgentDriverRegistry();
  const projected = new Map<
    string,
    {
      readonly session: CompositionIdeAdapter;
      readonly driver: ReturnType<typeof makeCompositionIdeAgentDriver>;
    }
  >();

  const refresh = Effect.gen(function* () {
    const sessions = yield* options.sessionRegistry.list;
    const liveIds = new Set<string>();
    for (const session of sessions) {
      const agentId = compositionIdeAgentId(session.sessionId);
      liveIds.add(agentId);
      const current = projected.get(agentId);
      const existing = yield* registry.get(agentId);
      if (current?.session === session && existing === current.driver) continue;
      if (current !== undefined) {
        if (existing === current.driver) yield* registry.unregister(agentId);
        projected.delete(agentId);
      }
      if (existing !== undefined && current === undefined) continue;
      const driver = makeCompositionIdeAgentDriver({
        registry: options.sessionRegistry,
        sessionId: session.sessionId,
        profile: session.profile,
        agentId,
      });
      yield* registry.register(driver);
      projected.set(agentId, { session, driver });
    }
    for (const [agentId, current] of projected) {
      if (liveIds.has(agentId)) continue;
      const existing = yield* registry.get(agentId);
      if (existing === current.driver) yield* registry.unregister(agentId);
      projected.delete(agentId);
    }
  });

  return { registry, refresh };
};

const live = Effect.gen(function* () {
  const sessionRegistry = yield* CompositionIdeSessionRegistryService;
  const registry = yield* CompositionAgentDriverRegistryService;
  const projection = makeCompositionIdeAgentDriverProjection({ sessionRegistry, registry });
  yield* projection.refresh;
  const subscription = yield* sessionRegistry.subscribeChanges;
  yield* Effect.forkScoped(
    Effect.forever(
      PubSub.take(subscription).pipe(
        Effect.flatMap(() => projection.refresh),
        Effect.catchCause((cause) => Effect.logError("IDE Agent Driver 刷新失败", { cause })),
      ),
    ),
  );
  return projection;
});

export const layer = Layer.effect(CompositionIdeAgentDriverProjectionService, live);
