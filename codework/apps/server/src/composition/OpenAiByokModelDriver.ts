import type { ByokModelAdapter } from "@codework/contracts";
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
  if (event.type === "completed") return { type: "model_completed" };
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
  complete: (input): Stream.Stream<ByokAgentModelEvent, ByokAgentModelError> => {
    const stream: Stream.Stream<ByokAgentModelEvent, ByokAgentModelError> = streamChat(httpClient, {
      protocol: options.protocol,
      baseURL: options.baseURL,
      apiKey: options.apiKey,
      modelId: options.modelId,
      messages: input.messages.map(toChatMessage),
      tools: input.tools.map(toToolDescriptor),
      agentLoop: true,
      ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    }).pipe(
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

    return stream;
  },
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
  systemPrompt: Schema.optional(Schema.String),
});
