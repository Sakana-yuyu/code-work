import { ProviderInstanceId } from "@codework/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";

import type { ByokAgentTool } from "./ByokAgentLoop.ts";
import {
  CompositionAgentService,
  type CompositionAgentServiceShape,
} from "./CompositionAgentService.ts";
import {
  CompositionAgentDriverAlreadyRegisteredError,
  type CompositionAgentDriverRegistry,
  CompositionAgentDriverInvalidError,
  makeCompositionAgentDriverRegistry,
} from "./CompositionAgentDriverRegistry.ts";
import { makeCompositionByokAgentDriver } from "./CompositionByokAgentDriver.ts";
import { CompositionAgentDriverFailure } from "./CompositionOrchestrator.ts";
import { makeCompositionSquadModelBindingResolver } from "./CompositionSquadModelBindingResolver.ts";
import { listCompositionToolDescriptors } from "./CompositionToolRegistry.ts";
import {
  CompositionMcpToolRegistry,
  type CompositionMcpToolRegistryShape,
} from "./CompositionMcpToolRegistry.ts";
import { compositionProviderAgentId } from "./CompositionProviderAgentDriverRegistry.ts";
import {
  ProviderInstanceRegistry,
  type ProviderInstanceRegistryShape,
} from "../provider/Services/ProviderInstanceRegistry.ts";
import { CompositionAgentDriverRegistryService } from "./CompositionAgentDriverRegistry.ts";
import {
  CompositionTaskStore,
  type CompositionTaskStoreShape,
} from "../persistence/Services/CompositionTaskStore.ts";

export const compositionByokAgentId = (instanceId: ProviderInstanceId | string): string =>
  compositionProviderAgentId(instanceId);

export interface CompositionByokAgentDriverProjection {
  readonly registry: CompositionAgentDriverRegistry;
  readonly refresh: Effect.Effect<
    void,
    CompositionAgentDriverAlreadyRegisteredError | CompositionAgentDriverInvalidError
  >;
}

export interface CompositionByokAgentDriverProjectionOptions {
  readonly providerRegistry: Pick<ProviderInstanceRegistryShape, "listInstances">;
  readonly agentService: CompositionAgentServiceShape;
  readonly checkpointStore: Pick<CompositionTaskStoreShape, "appendEventIfNew">;
  readonly checkpointHistory?: Pick<CompositionTaskStoreShape, "listEvents">;
  readonly mcpToolRegistry?: CompositionMcpToolRegistryShape;
  readonly registry?: CompositionAgentDriverRegistry;
}

export interface CompositionByokAgentDriverProjectionServiceShape extends CompositionByokAgentDriverProjection {}

export class CompositionByokAgentDriverProjectionService extends Context.Service<
  CompositionByokAgentDriverProjectionService,
  CompositionByokAgentDriverProjectionServiceShape
>()(
  "codework/composition/CompositionByokAgentDriverRegistry/CompositionByokAgentDriverProjectionService",
) {}

const coreTools = (): ReadonlyArray<ByokAgentTool> =>
  listCompositionToolDescriptors().map((descriptor) => ({
    canonicalToolName: descriptor.capabilityId.slice("t3.".length),
    description: `${descriptor.capabilityId} (${descriptor.status})`,
    parameters: { type: "object" },
  }));

export const makeCompositionByokAgentDriverProjection = (
  options: CompositionByokAgentDriverProjectionOptions,
): CompositionByokAgentDriverProjection => {
  const registry = options.registry ?? makeCompositionAgentDriverRegistry();
  const modelBindings = makeCompositionSquadModelBindingResolver({
    providerRegistry: {
      getInstance: (instanceId) =>
        options.providerRegistry.listInstances.pipe(
          Effect.map((instances) =>
            instances.find((instance) => instance.instanceId === instanceId),
          ),
        ),
      listInstances: options.providerRegistry.listInstances,
    },
    agentDrivers: registry,
  });
  const projectedAgentIds = new Set<string>();

  const refresh = Effect.gen(function* () {
    const instances = yield* options.providerRegistry.listInstances;
    const liveAgentIds = new Set<string>();

    for (const instance of instances) {
      if (instance.driverKind !== "byok") continue;
      const agentId = compositionByokAgentId(instance.instanceId);
      liveAgentIds.add(agentId);
      if ((yield* registry.get(agentId)) !== undefined) continue;

      const driver = makeCompositionByokAgentDriver({
        agentId,
        runtimeId: `byok:${instance.instanceId}`,
        providerInstanceId: instance.instanceId,
        providerKind: "byok",
        ...(instance.displayName === undefined ? {} : { displayName: instance.displayName }),
        ...(instance.composition?.defaultModelId === undefined
          ? {}
          : { defaultModel: instance.composition.defaultModelId }),
        agentService: options.agentService,
        checkpointStore: options.checkpointStore,
        ...(options.checkpointHistory === undefined
          ? {}
          : { checkpointHistory: options.checkpointHistory }),
        validateRunModel: (input) =>
          modelBindings.validateByokRun(input).pipe(
            Effect.mapError(
              (error) =>
                new CompositionAgentDriverFailure({
                  code: error.code,
                  detail: error.detail,
                }),
            ),
          ),
        listTools: () =>
          Effect.gen(function* () {
            const dynamicTools =
              options.mcpToolRegistry === undefined
                ? []
                : (yield* options.mcpToolRegistry.list()).filter(
                    (tool) => tool.trusted && tool.status === "available",
                  );
            return [
              ...coreTools(),
              ...dynamicTools.map((tool) => ({
                canonicalToolName: tool.canonicalToolName,
                description: tool.description,
                parameters: tool.inputSchema,
              })),
            ];
          }),
      });
      yield* registry.register(driver);
      projectedAgentIds.add(agentId);
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
  const providerRegistry = yield* ProviderInstanceRegistry;
  const agentService = yield* CompositionAgentService;
  const mcpToolRegistry = yield* Effect.serviceOption(CompositionMcpToolRegistry);
  const driverRegistry = yield* CompositionAgentDriverRegistryService;
  const checkpointStore = yield* CompositionTaskStore;
  const projection = makeCompositionByokAgentDriverProjection({
    providerRegistry,
    agentService,
    checkpointStore,
    checkpointHistory: checkpointStore,
    ...(mcpToolRegistry._tag === "Some" ? { mcpToolRegistry: mcpToolRegistry.value } : {}),
    registry: driverRegistry,
  });
  yield* projection.refresh;
  const subscription = yield* providerRegistry.subscribeChanges;
  yield* Effect.forkScoped(
    Effect.forever(
      PubSub.take(subscription).pipe(
        Effect.flatMap(() => projection.refresh),
        Effect.catchCause((cause) =>
          Effect.logError("Composition BYOK Agent Driver 刷新失败", { cause }),
        ),
      ),
    ),
  );
  return projection;
});

export const layer = Layer.effect(CompositionByokAgentDriverProjectionService, live);
