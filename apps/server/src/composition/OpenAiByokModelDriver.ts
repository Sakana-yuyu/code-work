import type { ByokModelAdapter } from "@codework/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { type HttpClient } from "effect/unstable/http";

import {
  type ByokChatEvent,
  type ByokEngineError,
  type ByokChatMessage,
  type ByokToolDescriptor,
  streamChat,
} from "../provider/Layers/byokChatClient.ts";

import {
  ByokAgentModelError,
  type ByokAgentModelEvent,
  type ByokAgentTool,
  type ByokAgentMessage,
  type ByokAgentModelDriver,
} from "./ByokAgentLoop.ts";

export interface ByokModelDriverOptions {
  readonly protocol: ByokModelAdapter["protocol"];
  readonly baseURL: string;
  readonly apiKey: string;
  readonly modelId: string;
  readonly contextWindowTokens?: number;
  readonly systemPrompt?: string;
  readonly signal?: AbortSignal;
}

export type OpenAiByokModelDriverOptions = Omit<ByokModelDriverOptions, "protocol">;

const toChatMessage = (message: ByokAgentMessage): ByokChatMessage => {
  if (message.role === "tool") {
    return {
      role: "tool",
      toolCallId: message.toolCallId,
      canonicalToolName: message.canonicalToolName,
      content: message.content,
    };
  }

  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: message.content,
      ...(message.toolCalls !== undefined ? { toolCalls: message.toolCalls } : {}),
    };
  }

  return { role: "user", content: message.content };
};

const toToolDescriptor = (tool: ByokAgentTool): ByokToolDescriptor => tool;

const toAgentModelEvent = (event: ByokChatEvent): ByokAgentModelEvent | undefined => {
  if (event.type === "reasoning") return undefined;
  if (event.type === "completed") {
    return {
      type: "model_completed",
      ...(event.inputTokens === undefined ? {} : { inputTokens: event.inputTokens }),
      ...(event.cachedInputTokens === undefined
        ? {}
        : { cachedInputTokens: event.cachedInputTokens }),
      ...(event.outputTokens === undefined ? {} : { outputTokens: event.outputTokens }),
      ...(event.reasoningTokens === undefined ? {} : { reasoningTokens: event.reasoningTokens }),
      ...(event.totalTokens === undefined ? {} : { totalTokens: event.totalTokens }),
    };
  }
  if (event.type === "text") return { type: "text_delta", text: event.text };
  return {
    type: "tool_call",
    toolCallId: event.toolCallId,
    canonicalToolName: event.canonicalToolName,
    arguments: event.arguments,
  };
};

/** 将三类 BYOK 原生协议流转换为协议无关的 Agent ModelDriver 事件。 */
export const makeByokModelDriver = (
  httpClient: HttpClient.HttpClient,
  options: ByokModelDriverOptions,
): ByokAgentModelDriver => ({
  complete: (input): Stream.Stream<ByokAgentModelEvent, ByokAgentModelError> =>
    Stream.suspend(() => {
      let outputEmitted = false;
      const request = (maxOutputTokens?: number) =>
        streamChat(httpClient, {
          protocol: options.protocol,
          baseURL: options.baseURL,
          apiKey: options.apiKey,
          modelId: options.modelId,
          messages: input.messages.map(toChatMessage),
          tools: input.tools.map(toToolDescriptor),
          agentLoop: true,
          includeUsage: true,
          ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
          ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
        });

      return request().pipe(
        Stream.tap((event) =>
          Effect.sync(() => {
            if (event.type !== "reasoning" && (event.type !== "text" || event.text.length > 0)) {
              outputEmitted = true;
            }
          }),
        ),
        Stream.catchTag("ByokEngineError", (error) => {
          if (error.reason !== "output_truncated" || outputEmitted) return Stream.fail(error);
          // 无文本或工具输出时只恢复一次；这是本端预算，不代表供应商支持的输出上限。
          const contextWindow = options.contextWindowTokens;
          const recoveryBudget =
            contextWindow !== undefined && Number.isFinite(contextWindow) && contextWindow > 0
              ? Math.max(1, Math.min(16_384, Math.floor(contextWindow / 2)))
              : 16_384;
          return request(recoveryBudget);
        }),
        Stream.map(toAgentModelEvent),
        Stream.filter((event): event is ByokAgentModelEvent => event !== undefined),
        Stream.mapError(
          (error: ByokEngineError) =>
            new ByokAgentModelError({
              code: error.reason === "context_overflow" ? "context_overflow" : "byok_engine_error",
              detail: error.message,
              reason: error.reason,
              ...(error.retryable === undefined ? {} : { retryable: error.retryable }),
              ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
            }),
        ),
      );
    }),
});

/** 保留旧工厂名，避免已有 OpenAI BYOK 调用方发生破坏性变更。 */
export const makeOpenAiByokModelDriver = (
  httpClient: HttpClient.HttpClient,
  options: OpenAiByokModelDriverOptions,
): ByokAgentModelDriver => makeByokModelDriver(httpClient, { ...options, protocol: "openai" });

export const OpenAiByokModelDriverOptionsSchema = Schema.Struct({
  baseURL: Schema.String,
  apiKey: Schema.String,
  modelId: Schema.String,
  contextWindowTokens: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  systemPrompt: Schema.optional(Schema.String),
});
