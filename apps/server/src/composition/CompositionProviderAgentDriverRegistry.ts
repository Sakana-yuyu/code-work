import { ProviderInstanceId } from "@codework/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";

import type { ProviderInstanceRegistryShape } from "../provider/Services/ProviderInstanceRegistry.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import type { ProviderServiceShape } from "../provider/Services/ProviderService.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { makeCompositionProviderAgentDriver } from "./CompositionProviderAgentDriver.ts";
import {
  CompositionRuntimeToolBridgeService,
  type CompositionRuntimeToolBridgeShape,
} from "./CompositionRuntimeToolBridge.ts";
import {
  CompositionAgentDriverAlreadyRegisteredError,
  CompositionAgentDriverInvalidError,
  CompositionAgentDriverRegistryService,
  makeCompositionAgentDriverRegistry,
  type CompositionAgentDriverRegistry,
} from "./CompositionAgentDriverRegistry.ts";

export const PROVIDER_AGENT_PREFIX = "provider:";

export const compositionProviderAgentId = (instanceId: ProviderInstanceId | string): string =>
  `${PROVIDER_AGENT_PREFIX}${instanceId}`;

const isCompositionProviderAgentId = (agentId: string): boolean =>
  agentId.startsWith(PROVIDER_AGENT_PREFIX);

export interface CompositionProviderAgentDriverProjection {
  readonly registry: CompositionAgentDriverRegistry;
  readonly refresh: Effect.Effect<
    void,
    CompositionAgentDriverAlreadyRegisteredError | CompositionAgentDriverInvalidError
  >;
}

export interface CompositionProviderAgentDriverProjectionOptions {
  readonly providerRegistry: Pick<ProviderInstanceRegistryShape, "listInstances">;
  readonly providerService: Pick<
    ProviderServiceShape,
    | "startSession"
    | "sendTurn"
    | "interruptTurn"
    | "stopSession"
    | "handshakeCapabilities"
    | "revokeCapabilityHandshake"
    | "configureToolBroker"
    | "clearToolBroker"
  > &
    Partial<Pick<ProviderServiceShape, "listSessions">>;
  readonly toolBrokerBridge?: CompositionRuntimeToolBridgeShape;
  readonly registry?: CompositionAgentDriverRegistry;
}

export interface CompositionProviderAgentDriverProjectionServiceShape extends CompositionProviderAgentDriverProjection {}

export class CompositionProviderAgentDriverProjectionService extends Context.Service<
  CompositionProviderAgentDriverProjectionService,
  CompositionProviderAgentDriverProjectionServiceShape
>()(
  "codework/composition/CompositionProviderAgentDriverRegistry/CompositionProviderAgentDriverProjectionService",
) {}

/**
 * 将 Code Work 的 ProviderInstance 事实源投影成 Composition Agent Driver。
 * 会话与取消统一通过 ProviderService，避免绕过会话目录和运行时事件。
 */
export const makeCompositionProviderAgentDriverProjection = (
  options: CompositionProviderAgentDriverProjectionOptions,
): CompositionProviderAgentDriverProjection => {
  const registry = options.registry ?? makeCompositionAgentDriverRegistry();
  const projectedAgentIds = new Set<string>();
  const projectedAdapters = new Map<string, object>();

  const refresh = Effect.gen(function* () {
    const instances = yield* options.providerRegistry.listInstances;
    const liveAgentIds = new Set<string>();

    for (const instance of instances) {
      // BYOK 使用进程内 Agent Loop，由专用 projection 提供 Driver，避免同一
      // ProviderInstance 同时注册成会话型 Driver 和 ToolBroker 型 Driver。
      if (instance.driverKind === "byok") continue;
      const agentId = compositionProviderAgentId(instance.instanceId);
      liveAgentIds.add(agentId);
      const existing = yield* registry.get(agentId);
      if (existing !== undefined && projectedAdapters.get(agentId) === instance.adapter) {
        continue;
      }
      if (existing !== undefined) {
        yield* registry.unregister(agentId);
        projectedAgentIds.delete(agentId);
        projectedAdapters.delete(agentId);
      }

      const instanceAdapter = instance.adapter;
      const canonicalTools = instanceAdapter?.capabilities.toolBrokerCanonicalTools ?? [];
      const supportsToolBroker =
        options.toolBrokerBridge !== undefined &&
        canonicalTools.length > 0 &&
        instanceAdapter?.handshakeCapabilities !== undefined &&
        instanceAdapter.revokeCapabilityHandshake !== undefined &&
        instanceAdapter?.configureToolBroker !== undefined &&
        instanceAdapter.clearToolBroker !== undefined;
      const handshakeCapabilities = supportsToolBroker
        ? (input: Parameters<ProviderServiceShape["handshakeCapabilities"]>[1]) =>
            options.providerService.handshakeCapabilities(instance.instanceId, input)
        : undefined;
      const driver = makeCompositionProviderAgentDriver({
        agentId,
        runtimeId: agentId,
        providerInstanceId: instance.instanceId,
        providerKind: instance.driverKind,
        ...(instance.displayName === undefined ? {} : { displayName: instance.displayName }),
        ...(options.toolBrokerBridge === undefined
          ? {}
          : { toolBrokerBridge: options.toolBrokerBridge }),
        toolBrokerCanonicalTools: canonicalTools,
        getSnapshot: () =>
          instance.snapshot.getSnapshot.pipe(
            Effect.map((value) => ({
              enabled: value.enabled,
              installed: value.installed,
              status: value.status,
              ...(value.availability === undefined ? {} : { availability: value.availability }),
              version: value.version,
            })),
          ),
        adapter: {
          ...(handshakeCapabilities === undefined
            ? {}
            : {
                handshakeCapabilities,
                revokeCapabilityHandshake: (input) =>
                  options.providerService.revokeCapabilityHandshake(instance.instanceId, input),
                configureToolBroker: (input) =>
                  options.providerService.configureToolBroker(instance.instanceId, input),
                clearToolBroker: (threadId) =>
                  options.providerService.clearToolBroker(instance.instanceId, threadId),
              }),
          ...(options.providerService.listSessions === undefined
            ? {}
            : { listSessions: options.providerService.listSessions }),
          startSession: (input) => options.providerService.startSession(input.threadId, input),
          sendTurn: (input) => options.providerService.sendTurn(input),
          interruptTurn: (threadId, turnId) =>
            options.providerService.interruptTurn({
              threadId,
              ...(turnId === undefined ? {} : { turnId }),
            }),
          stopSession: (threadId) => options.providerService.stopSession({ threadId }),
        },
      });
      yield* registry.register(driver);
      projectedAgentIds.add(agentId);
      projectedAdapters.set(agentId, instance.adapter);
    }

    for (const agentId of projectedAgentIds) {
      if (!liveAgentIds.has(agentId) && isCompositionProviderAgentId(agentId)) {
        yield* registry.unregister(agentId);
        projectedAgentIds.delete(agentId);
        projectedAdapters.delete(agentId);
      }
    }
  });

  return { registry, refresh };
};

const live = Effect.gen(function* () {
  const providerRegistry = yield* ProviderInstanceRegistry;
  const providerService = yield* ProviderService;
  const toolBrokerBridgeOption = yield* Effect.serviceOption(CompositionRuntimeToolBridgeService);
  const agentDriverRegistry = yield* CompositionAgentDriverRegistryService;
  const projection = makeCompositionProviderAgentDriverProjection({
    providerRegistry,
    providerService,
    ...(Option.isSome(toolBrokerBridgeOption)
      ? { toolBrokerBridge: toolBrokerBridgeOption.value }
      : {}),
    registry: agentDriverRegistry,
  });

  yield* projection.refresh;
  const subscription = yield* providerRegistry.subscribeChanges;
  yield* Effect.forkScoped(
    Effect.forever(
      PubSub.take(subscription).pipe(
        Effect.flatMap(() => projection.refresh),
        Effect.catchCause((cause) =>
          Effect.logError("Composition Provider Agent Driver 刷新失败", { cause }),
        ),
      ),
    ),
  );

  return projection;
});

export const layer = Layer.effect(CompositionProviderAgentDriverProjectionService, live);

export const makeCompositionProviderAgentDriverProjectionFromInstanceId = (
  instanceId: string,
): { readonly agentId: string; readonly providerInstanceId: ProviderInstanceId } => {
  const providerInstanceId = ProviderInstanceId.make(instanceId);
  return {
    agentId: compositionProviderAgentId(providerInstanceId),
    providerInstanceId,
  };
};
