import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";

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

const timeoutCode = () => ({
  status: "failed" as const,
  errorCode: "tool_timeout",
});

/** 将 Provider 原生回调绑定到可信 Run 作用域，实际执行仍由 Code Work ToolBroker 决策。 */
export const makeCompositionProviderToolBrokerBridge = (
  options: CompositionProviderToolBrokerBridgeOptions,
): ProviderToolBrokerBridge => {
  const timeoutMs = options.timeoutMs ?? 30_000;

  return {
    invoke: (input) =>
      options.runtimeBridge
        .invoke({
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
        })
        .pipe(
          Effect.timeoutOption(Duration.millis(timeoutMs)),
          Effect.map((result) => (result._tag === "Some" ? result.value : timeoutCode())),
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
