import * as Effect from "effect/Effect";

import type {
  ProviderToolBrokerBridge,
  ProviderToolBrokerContext,
} from "../provider/Services/ProviderAdapter.ts";
import type { CompositionRuntimeToolBridgeShape } from "./CompositionRuntimeToolBridge.ts";

export type CompositionProviderToolBrokerContext = ProviderToolBrokerContext;

export type CompositionProviderToolBrokerBridgeOptions = {
  readonly runtimeBridge: CompositionRuntimeToolBridgeShape;
  readonly context: CompositionProviderToolBrokerContext;
  readonly timeoutMs?: number;
};

/** 将 Provider 原生回调绑定到可信 Run 作用域，实际执行仍由 Code Work ToolBroker 决策。 */
export const makeCompositionProviderToolBrokerBridge = (
  options: CompositionProviderToolBrokerBridgeOptions,
): ProviderToolBrokerBridge => {
  const timeoutMs = options.timeoutMs ?? 30_000;

  return {
    invoke: (input, requestApproval) =>
      options.runtimeBridge.invoke(
        {
          runtimeId: options.context.runtimeId,
          taskId: options.context.taskId,
          runId: options.context.runId,
          agentId: options.context.agentId,
          capabilityGrantIds: options.context.capabilityGrantIds,
          capabilityHandshakeId: options.context.capabilityHandshakeId,
          toolCallId: input.toolCallId,
          canonicalToolName: input.canonicalToolName,
          arguments: input.arguments,
          idempotencyKey: input.idempotencyKey,
        },
        options.context.runtimeMode,
        { timeoutMs, ...(requestApproval === undefined ? {} : { requestApproval }) },
      ),
    cancel: (input) =>
      options.runtimeBridge
        .cancel({
          runtimeId: options.context.runtimeId,
          taskId: options.context.taskId,
          runId: options.context.runId,
          agentId: options.context.agentId,
          capabilityGrantIds: options.context.capabilityGrantIds,
          capabilityHandshakeId: options.context.capabilityHandshakeId,
          toolCallId: input.toolCallId,
          canonicalToolName: input.canonicalToolName,
          idempotencyKey: input.idempotencyKey,
        })
        .pipe(Effect.asVoid),
  };
};
