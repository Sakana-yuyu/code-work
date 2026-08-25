import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { type HttpClient } from "effect/unstable/http";

import {
  type ByokChatMessage,
  type ByokToolDescriptor,
  streamChat,
} from "../provider/Layers/byokChatClient.ts";

import {
  ByokAgentModelError,
  type ByokAgentTool,
  type ByokAgentMessage,
  type ByokAgentModelDriver,
} from "./ByokAgentLoop.ts";

export interface OpenAiByokModelDriverOptions {
  readonly baseURL: string;
  readonly apiKey: string;
  readonly modelId: string;
  readonly systemPrompt?: string;
  readonly signal?: AbortSignal;
}

const toChatMessage = (message: ByokAgentMessage): ByokChatMessage => {
  if (message.role === "tool") {
    return {
      role: "tool",
      toolCallId: message.toolCallId,
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

/** 将 OpenAI-compatible BYOK 流转换为协议无关的 Agent ModelDriver 事件。 */
export const makeOpenAiByokModelDriver = (
  httpClient: HttpClient.HttpClient,
  options: OpenAiByokModelDriverOptions,
): ByokAgentModelDriver => ({
  complete: (input) => {
    const stream = streamChat(httpClient, {
      protocol: "openai",
      baseURL: options.baseURL,
      apiKey: options.apiKey,
      modelId: options.modelId,
      messages: input.messages.map(toChatMessage),
      tools: input.tools.map(toToolDescriptor),
      agentLoop: true,
      ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    }).pipe(
      Stream.flatMap((event) => {
        if (event.type === "reasoning") {
          return Stream.empty;
        }
        return Stream.succeed(
          event.type === "text"
            ? ({ type: "text_delta", text: event.text } as const)
            : ({
                type: "tool_call",
                toolCallId: event.toolCallId,
                canonicalToolName: event.canonicalToolName,
                arguments: event.arguments,
              } as const),
        );
      }),
      Stream.mapError(
        (error) =>
          new ByokAgentModelError({
            code: "byok_engine_error",
            detail: error.message,
          }),
      ),
    );

    return Stream.concat(stream, Stream.succeed({ type: "model_completed" as const }));
  },
});

export const OpenAiByokModelDriverOptionsSchema = Schema.Struct({
  baseURL: Schema.String,
  apiKey: Schema.String,
  modelId: Schema.String,
  systemPrompt: Schema.optional(Schema.String),
});
