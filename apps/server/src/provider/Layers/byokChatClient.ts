/**
 * byokChatClient — unified streaming chat client for BYOK model adapters.
 *
 * Talks directly to OpenAI-compatible, Anthropic-compatible, and native
 * Gemini chat APIs using the credentials stored in `ByokSettings.adapters`.
 * There is no intermediate gateway: each call is one streaming HTTP request
 * whose server-sent events are parsed into a flat `ByokChatEvent` stream.
 *
 *   - `openai` protocol: `POST ${baseURL}/chat/completions` with
 *     `stream: true`; `choices[0].delta.content` is text,
 *     `choices[0].delta.reasoning_content` (DeepSeek style) is reasoning, and
 *     `choices[0].delta.tool_calls` is accumulated before being decoded.
 *     `choices[0].finish_reason` 标记模型终态；`[DONE]` 只表示传输结束。
 *   - `anthropic` protocol: `POST ${baseURL}/v1/messages` with `x-api-key` +
 *     `anthropic-version: 2023-06-01` and `stream: true`;
 *     `content_block_delta.delta.text` is text and `delta.thinking` is
 *     reasoning。只有 `message_delta.stop_reason` 后续收到 `message_stop` 才算完成。
 *   - `gemini` protocol: `POST
 *     ${baseURL}/v1beta/models/{model}:streamGenerateContent?alt=sse` with
 *     `x-goog-api-key`; roles map user→`user`, assistant→`model`, and the
 *     system prompt becomes top-level `systemInstruction`. Each SSE payload
 *     carries `candidates[0].content.parts[]`; parts flagged `thought: true`
 *     are reasoning。`candidates[0].finishReason` 标记模型终态。
 *
 * @module provider/Layers/byokChatClient
 */
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { type HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import type { ByokModelAdapter, ByokSettings } from "@codework/contracts";

import { collectUint8StreamText } from "../../stream/collectUint8StreamText.ts";

/**
 * Resolve the model adapter for a selected model slug. Matches by adapter id
 * (the canonical model slug surfaced in snapshots) or by upstream modelId;
 * falls back to the first configured adapter when nothing matches.
 */
export const byokAdapterForModel = (
  settings: ByokSettings,
  model: string | undefined,
): ByokModelAdapter | undefined => {
  const adapters = settings.adapters;
  if (adapters.length === 0) {
    return undefined;
  }
  if (model !== undefined && model.trim().length > 0) {
    const matched = adapters.find((adapter) => adapter.id === model || adapter.modelId === model);
    if (matched !== undefined) {
      return matched;
    }
    const separator = model.indexOf("/");
    if (separator > 0) {
      const adapterId = model.slice(0, separator);
      const discoveredModelId = model.slice(separator + 1);
      const adapter = adapters.find((candidate) => candidate.id === adapterId);
      if (adapter !== undefined && discoveredModelId.trim().length > 0) {
        return { ...adapter, modelId: discoveredModelId };
      }
    }
  }
  return adapters[0];
};

/** One streaming chat chunk emitted by a BYOK model adapter. */
export type ByokChatEvent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "reasoning"; readonly text: string }
  | { readonly type: "completed"; readonly finishReason: string }
  | {
      readonly type: "tool_call";
      readonly toolCallId: string;
      readonly canonicalToolName: string;
      readonly arguments: unknown;
    };

/** 提供给 OpenAI-compatible 模型的规范工具元数据。 */
export interface ByokToolDescriptor {
  readonly canonicalToolName: string;
  readonly description: string;
  readonly parameters: unknown;
}

/** One failed BYOK engine request (transport, non-2xx, or malformed SSE). */
export class ByokEngineError extends Schema.TaggedErrorClass<ByokEngineError>()("ByokEngineError", {
  url: Schema.String,
  reason: Schema.Literals([
    "authentication_error",
    "rate_limit",
    "invalid_request",
    "unavailable",
    "timeout",
    "canceled",
    "context_overflow",
    "provider_error",
    "transport_error",
    "invalid_response",
    "output_truncated",
    "terminal_event_missing",
  ]),
  status: Schema.optional(Schema.Int),
  retryable: Schema.optional(Schema.Boolean),
  retryAfterMs: Schema.optional(Schema.Int),
  detail: Schema.String,
}) {
  override get message(): string {
    const status = this.status === undefined ? "" : ` status=${this.status}`;
    return `BYOK engine request to ${this.url} failed (${this.reason}${status}): ${this.detail}`;
  }
}

const isByokEngineError = Schema.is(ByokEngineError);

/** One image part carried inline as base64 (multimodal user input). */
export interface ByokImagePart {
  readonly type: "image";
  readonly mimeType: string;
  readonly dataBase64: string;
}

export type ByokContentPart = { readonly type: "text"; readonly text: string } | ByokImagePart;

export interface ByokChatMessage {
  readonly role: "user" | "assistant" | "tool";
  /** Plain text, or multimodal parts when the turn carried image attachments. */
  readonly content: string | ReadonlyArray<ByokContentPart>;
  readonly toolCallId?: string;
  readonly canonicalToolName?: string;
  readonly toolCalls?: ReadonlyArray<{
    readonly toolCallId: string;
    readonly canonicalToolName: string;
    readonly arguments: unknown;
  }>;
}

export interface ByokStreamChatInput {
  readonly protocol: ByokModelAdapter["protocol"];
  readonly baseURL: string;
  readonly apiKey: string;
  readonly modelId: string;
  readonly messages: ReadonlyArray<ByokChatMessage>;
  /** 向 agent loop 模型声明的规范工具。 */
  readonly tools?: ReadonlyArray<ByokToolDescriptor>;
  /** 标记显式 agent loop 请求；旧文本调用保持未设置。 */
  readonly agentLoop?: boolean;
  /**
   * Rendered prompt-template text. Sent as a leading system message on the
   * openai protocol and as the top-level `system` field on anthropic.
   */
  readonly systemPrompt?: string | undefined;
  /** Optional abort signal; when it fires the stream ends immediately. */
  readonly signal?: AbortSignal | undefined;
}

const byokErrorDetail = (cause: unknown): string => {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message;
  }
  return String(cause);
};

const BYOK_ERROR_RESPONSE_MAX_BYTES = 8 * 1_024;
const BYOK_ERROR_DETAIL_MAX_BYTES = 2 * 1_024;
const BYOK_RETRY_AFTER_MAX_MS = 30_000;
const byokSecretPatterns = [
  /(authorization\s*[:=]\s*bearer\s+)([^\s"',;}]+)/giu,
  /((?:api[_-]?key|access[_-]?token|authorization|password|secret|token)(?![a-z])\s*["']?\s*[:=]\s*["']?)([^\s"',;}]+)/giu,
];

const redactByokErrorDetail = (value: string, apiKey: string): string => {
  const key = apiKey.trim();
  const withoutConfiguredKey = key.length === 0 ? value : value.replaceAll(key, "[REDACTED]");
  return byokSecretPatterns.reduce(
    (current, pattern) => current.replace(pattern, "$1[REDACTED]"),
    withoutConfiguredKey,
  );
};

const limitUtf8 = (value: string, maxBytes: number): string => {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(value);
  if (encoded.byteLength <= maxBytes) return value;

  const marker = "...[truncated]";
  const markerBytes = encoder.encode(marker).byteLength;
  const prefixBudget = Math.max(0, maxBytes - markerBytes);
  let prefix = "";
  let prefixBytes = 0;
  for (const character of value) {
    const characterBytes = encoder.encode(character).byteLength;
    if (prefixBytes + characterBytes > prefixBudget) break;
    prefix += character;
    prefixBytes += characterBytes;
  }
  return `${prefix}${marker}`;
};

const isContextOverflowDetail = (detail: string): boolean => {
  const normalized = detail.toLowerCase();
  return (
    normalized.includes("context_too_large") ||
    normalized.includes("context_length_exceeded") ||
    normalized.includes("maximum context length") ||
    normalized.includes("exceeds the context window") ||
    normalized.includes("exceeds context window") ||
    normalized.includes("prompt is too long") ||
    (normalized.includes("input token count") &&
      (normalized.includes("exceeds the maximum") || normalized.includes("exceeds maximum")))
  );
};

type ByokEngineErrorReason = ByokEngineError["reason"];

const hasDetailMarker = (detail: string, markers: ReadonlyArray<string>): boolean => {
  const normalized = detail.toLowerCase();
  return markers.some((marker) => normalized.includes(marker));
};

const classifyProviderError = (
  detail: string,
  status?: number,
): { readonly reason: ByokEngineErrorReason; readonly retryable: boolean } => {
  if (isContextOverflowDetail(detail)) {
    return { reason: "context_overflow", retryable: false };
  }
  if (status === 401 || status === 403) {
    return { reason: "authentication_error", retryable: false };
  }
  if (status === 400 || status === 404 || status === 422) {
    return { reason: "invalid_request", retryable: false };
  }
  if (status === 408) {
    return { reason: "timeout", retryable: true };
  }
  if (status === 429) {
    return { reason: "rate_limit", retryable: true };
  }
  if (status !== undefined && status >= 500 && status <= 599) {
    return { reason: "unavailable", retryable: true };
  }
  if (
    hasDetailMarker(detail, [
      "request_timeout",
      "request timeout",
      "timed out",
      "deadline exceeded",
      "stream idle timeout",
    ])
  ) {
    return { reason: "timeout", retryable: true };
  }
  if (
    hasDetailMarker(detail, [
      "rate_limit",
      "rate limit",
      "too many requests",
      "resource_exhausted",
      "resource exhausted",
    ])
  ) {
    return { reason: "rate_limit", retryable: true };
  }
  if (
    hasDetailMarker(detail, [
      "overloaded_error",
      '"overloaded"',
      '"unavailable"',
      "temporarily unavailable",
      "server_error",
    ])
  ) {
    return { reason: "unavailable", retryable: true };
  }
  if (
    hasDetailMarker(detail, [
      "authentication_error",
      "unauthorized",
      "invalid api key",
      "incorrect api key",
    ])
  ) {
    return { reason: "authentication_error", retryable: false };
  }
  if (hasDetailMarker(detail, ["invalid_request_error", "invalid_argument", "bad request"])) {
    return { reason: "invalid_request", retryable: false };
  }
  return { reason: "provider_error", retryable: false };
};

const classifyTransportError = (
  detail: string,
  canceled: boolean,
): { readonly reason: ByokEngineErrorReason; readonly retryable: boolean } => {
  if (canceled) return { reason: "canceled", retryable: false };
  return hasDetailMarker(detail, [
    "request timeout",
    "request_timeout",
    "timed out",
    "timeout",
    "deadline exceeded",
    "etimedout",
  ])
    ? { reason: "timeout", retryable: true }
    : { reason: "transport_error", retryable: true };
};

const parseRetryAfterMs = (raw: string | undefined, nowUnixMs: number): number | undefined => {
  const value = raw?.trim();
  if (value === undefined || value.length === 0) return undefined;

  let delayMs: number | undefined;
  if (/^\d+$/u.test(value)) {
    const seconds = Number(value);
    if (Number.isSafeInteger(seconds)) delayMs = seconds * 1_000;
  } else {
    const retryAt = DateTime.make(value);
    if (Option.isSome(retryAt)) {
      delayMs = Math.max(0, DateTime.toEpochMillis(retryAt.value) - nowUnixMs);
    }
  }
  if (delayMs === undefined || !Number.isSafeInteger(delayMs) || delayMs < 0) return undefined;
  return Math.min(delayMs, BYOK_RETRY_AFTER_MAX_MS);
};

const providerPayloadErrorDetail = (payload: Record<string, unknown>): string | undefined => {
  const error = payload.error;
  if (typeof error === "string") {
    const detail = error.trim();
    return detail.length === 0 ? undefined : detail;
  }
  if (error === undefined || error === null) return undefined;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

const providerResponseError = (
  response: HttpClientResponse.HttpClientResponse,
  requestUrl: string,
  apiKey: string,
): Effect.Effect<never, ByokEngineError> =>
  Effect.gen(function* () {
    const collected = yield* collectUint8StreamText({
      stream: response.stream,
      maxBytes: BYOK_ERROR_RESPONSE_MAX_BYTES,
    }).pipe(
      Effect.orElseSucceed(() => ({
        text: "",
        truncated: false,
        bytes: 0,
        invalidUtf8: false,
      })),
    );
    const responseDetail = collected.text.trim();
    const rawDetail =
      responseDetail.length === 0
        ? `HTTP ${response.status}`
        : `${responseDetail}${collected.truncated ? "\n[response truncated]" : ""}`;
    const detail = limitUtf8(redactByokErrorDetail(rawDetail, apiKey), BYOK_ERROR_DETAIL_MAX_BYTES);
    const classification = classifyProviderError(rawDetail, response.status);
    const retryAfterMs = classification.retryable
      ? parseRetryAfterMs(
          response.headers["retry-after"],
          DateTime.toEpochMillis(yield* DateTime.now),
        )
      : undefined;
    return yield* new ByokEngineError({
      url: requestUrl,
      ...classification,
      status: response.status,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      detail,
    });
  });

/** Normalize a base URL into a bare origin-ish prefix (no trailing slash). */
const trimBaseURL = (baseURL: string): string => baseURL.trim().replace(/\/+$/u, "");

const openaiMessageContent = (
  content: ByokChatMessage["content"],
): string | ReadonlyArray<Record<string, unknown>> =>
  typeof content === "string"
    ? content
    : content.map((part) =>
        part.type === "text"
          ? { type: "text", text: part.text }
          : {
              type: "image_url",
              image_url: { url: `data:${part.mimeType};base64,${part.dataBase64}` },
            },
      );

const anthropicMessageContent = (
  content: ByokChatMessage["content"],
): string | ReadonlyArray<Record<string, unknown>> =>
  typeof content === "string"
    ? content
    : content.map((part) =>
        part.type === "text"
          ? { type: "text", text: part.text }
          : {
              type: "image",
              source: { type: "base64", media_type: part.mimeType, data: part.dataBase64 },
            },
      );

const geminiMessageParts = (message: ByokChatMessage): ReadonlyArray<Record<string, unknown>> =>
  message.role === "tool"
    ? [
        {
          functionResponse: {
            name: message.canonicalToolName ?? message.toolCallId ?? "tool",
            response: { result: message.content },
          },
        },
      ]
    : [
        ...(typeof message.content === "string"
          ? [{ text: message.content }]
          : [...message.content].map((part) =>
              "text" in part
                ? { text: part.text }
                : { inlineData: { mimeType: part.mimeType, data: part.dataBase64 } },
            )),
        ...(message.role === "assistant" && message.toolCalls !== undefined
          ? message.toolCalls.map((toolCall) => ({
              functionCall: {
                name: toolCall.canonicalToolName,
                args: toolCall.arguments,
              },
            }))
          : []),
      ];

const anthropicMessage = (message: ByokChatMessage): Record<string, unknown> => {
  if (message.role === "tool") {
    return {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: message.toolCallId,
          content: message.content,
        },
      ],
    };
  }

  if (message.role === "assistant" && message.toolCalls !== undefined) {
    return {
      role: "assistant",
      content: [
        ...(typeof message.content === "string"
          ? message.content.length > 0
            ? [{ type: "text", text: message.content }]
            : []
          : anthropicMessageContent(message.content)),
        ...message.toolCalls.map((toolCall) => ({
          type: "tool_use",
          id: toolCall.toolCallId,
          name: toolCall.canonicalToolName,
          input: toolCall.arguments,
        })),
      ],
    };
  }

  return {
    role: message.role,
    content: anthropicMessageContent(message.content),
  };
};

const openaiUrl = (baseURL: string): string => `${trimBaseURL(baseURL)}/chat/completions`;
const anthropicUrl = (baseURL: string): string => `${trimBaseURL(baseURL)}/v1/messages`;
/**
 * Gemini streaming URL. A version segment (`/v1beta`, `/v1`, `/v1alpha`) is
 * appended only when the configured base URL does not already end in one.
 */
const geminiUrl = (baseURL: string, modelId: string): string => {
  const base = trimBaseURL(baseURL);
  const versioned = /\/v1(?:beta|alpha)?$/iu.test(base) ? base : `${base}/v1beta`;
  return `${versioned}/models/${encodeURIComponent(modelId.trim())}:streamGenerateContent?alt=sse`;
};

const parseJsonLine = (line: string): Record<string, unknown> | undefined => {
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const openaiMessage = (message: ByokChatMessage): Record<string, unknown> => {
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      content: message.content,
    };
  }

  if (
    message.role === "assistant" &&
    message.toolCalls !== undefined &&
    message.toolCalls.length > 0
  ) {
    return {
      role: "assistant",
      content: message.content,
      tool_calls: message.toolCalls.map((toolCall) => ({
        id: toolCall.toolCallId,
        type: "function",
        function: {
          name: toolCall.canonicalToolName,
          arguments: encodeUnknownJson(toolCall.arguments),
        },
      })),
    };
  }

  return {
    role: message.role,
    content: openaiMessageContent(message.content),
  };
};

type OpenAiToolCallState = {
  readonly toolCallId: string | undefined;
  readonly canonicalToolName: string | undefined;
  readonly argumentsText: string;
};

type OpenAiToolCallAccumulator = ReadonlyMap<number, OpenAiToolCallState>;

type OpenAiToolCallFragment = {
  readonly index: number;
  readonly id: string | undefined;
  readonly name: string | undefined;
  readonly arguments: string | undefined;
};

type OpenAiToolCallJsonEvent = {
  readonly type: "tool_call_json";
  readonly toolCallId: string | undefined;
  readonly canonicalToolName: string | undefined;
  readonly argumentsText: string;
};

type ByokStreamErrorEvent = {
  readonly type: "stream_error";
  readonly reason: ByokEngineErrorReason;
  readonly detail: string;
};

type ByokSseItem =
  | { readonly type: "payload"; readonly payload: Record<string, unknown> }
  | { readonly type: "done" }
  | { readonly type: "invalid_json" }
  | { readonly type: "eof" };

type OpenAiStreamEvent = ByokChatEvent | OpenAiToolCallJsonEvent | ByokStreamErrorEvent;

type AnthropicToolCallState = {
  readonly toolCallId: string | undefined;
  readonly canonicalToolName: string | undefined;
  readonly argumentsText: string;
};

type AnthropicToolCallAccumulator = ReadonlyMap<number, AnthropicToolCallState>;

type AnthropicToolCallJsonEvent = {
  readonly type: "tool_call_json";
  readonly toolCallId: string | undefined;
  readonly canonicalToolName: string | undefined;
  readonly argumentsText: string;
};

type AnthropicStreamEvent = ByokChatEvent | AnthropicToolCallJsonEvent | ByokStreamErrorEvent;

type OpenAiStreamState = {
  readonly toolCalls: OpenAiToolCallAccumulator;
  readonly terminalSeen: boolean;
};

type AnthropicStreamState = {
  readonly toolCalls: AnthropicToolCallAccumulator;
  readonly stopReason: string | undefined;
  readonly terminalSeen: boolean;
};

type GeminiStreamState = {
  readonly terminalSeen: boolean;
};

type ByokTerminalEvent =
  | Extract<ByokChatEvent, { readonly type: "completed" }>
  | ByokStreamErrorEvent;

const outputTruncationFinishReasons = new Set([
  "length",
  "max_tokens",
  "max_output_tokens",
  "incomplete",
  "model_context_window_exceeded",
]);

const successfulFinishReasons = {
  openai: new Set(["stop", "tool_calls", "function_call"]),
  anthropic: new Set(["end_turn", "tool_use", "stop_sequence", "refusal"]),
  gemini: new Set(["stop"]),
} satisfies Record<ByokModelAdapter["protocol"], ReadonlySet<string>>;

const streamErrorEvent = (reason: ByokEngineErrorReason, detail: string): ByokStreamErrorEvent => ({
  type: "stream_error",
  reason,
  detail,
});

const missingTerminalEvent = (protocol: ByokModelAdapter["protocol"]): ByokStreamErrorEvent =>
  streamErrorEvent(
    "terminal_event_missing",
    `${protocol} provider stream ended without a valid terminal event.`,
  );

const terminalEventForFinishReason = (
  protocol: ByokModelAdapter["protocol"],
  finishReason: string,
): ByokTerminalEvent => {
  const normalized = finishReason.trim().toLowerCase();
  if (outputTruncationFinishReasons.has(normalized)) {
    return streamErrorEvent(
      "output_truncated",
      `${protocol} provider output was truncated (${finishReason}).`,
    );
  }
  if (successfulFinishReasons[protocol].has(normalized)) {
    return { type: "completed", finishReason };
  }
  return streamErrorEvent(
    "provider_error",
    `${protocol} provider stream ended with unsupported finish reason ${finishReason}.`,
  );
};

const openAiFinishReason = (payload: Record<string, unknown>): string | undefined => {
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0 || !isRecord(choices[0])) {
    return undefined;
  }
  return asString(choices[0].finish_reason);
};

const anthropicStopReason = (payload: Record<string, unknown>): string | undefined => {
  if (payload.type !== "message_delta" || !isRecord(payload.delta)) return undefined;
  return asString(payload.delta.stop_reason);
};

const geminiFinishReason = (payload: Record<string, unknown>): string | undefined => {
  const candidates = payload.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0 || !isRecord(candidates[0])) {
    return undefined;
  }
  return asString(candidates[0].finishReason);
};

const isProtocolTransportTerminator = (
  protocol: ByokModelAdapter["protocol"],
  item: ByokSseItem,
): boolean => {
  if (item.type === "done") return true;
  if (item.type !== "payload") return false;
  if (protocol === "openai") return openAiFinishReason(item.payload) !== undefined;
  if (protocol === "anthropic") return item.payload.type === "message_stop";
  return geminiFinishReason(item.payload) !== undefined;
};

const openaiToolCallFragments = (
  payload: Record<string, unknown>,
): ReadonlyArray<OpenAiToolCallFragment> => {
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0 || !isRecord(choices[0])) {
    return [];
  }
  const delta = choices[0].delta;
  if (!isRecord(delta) || !Array.isArray(delta.tool_calls)) {
    return [];
  }

  return delta.tool_calls.flatMap((candidate) => {
    if (
      !isRecord(candidate) ||
      typeof candidate.index !== "number" ||
      !Number.isInteger(candidate.index)
    ) {
      return [];
    }
    const functionValue = isRecord(candidate.function) ? candidate.function : undefined;
    const id = asString(candidate.id);
    const name = functionValue === undefined ? undefined : asString(functionValue.name);
    return [
      {
        index: candidate.index,
        id,
        name,
        arguments:
          functionValue !== undefined && typeof functionValue.arguments === "string"
            ? functionValue.arguments
            : undefined,
      },
    ];
  });
};

const openaiToolCallJsonEvents = (
  state: OpenAiToolCallAccumulator,
): ReadonlyArray<OpenAiToolCallJsonEvent> =>
  [...state.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, toolCall]) => ({
      type: "tool_call_json" as const,
      toolCallId: toolCall.toolCallId,
      canonicalToolName: toolCall.canonicalToolName,
      argumentsText: toolCall.argumentsText,
    }));

const anthropicToolCallJsonEvents = (
  state: AnthropicToolCallAccumulator,
): ReadonlyArray<AnthropicToolCallJsonEvent> =>
  [...state.values()].map((toolCall) => ({
    type: "tool_call_json" as const,
    toolCallId: toolCall.toolCallId,
    canonicalToolName: toolCall.canonicalToolName,
    argumentsText: toolCall.argumentsText,
  }));

const anthropicToolCallStateForPayload = (
  state: AnthropicToolCallAccumulator,
  payload: Record<string, unknown>,
): AnthropicToolCallAccumulator => {
  const index = typeof payload.index === "number" ? payload.index : undefined;
  if (index === undefined || !Number.isInteger(index)) return state;

  if (payload.type === "content_block_start" && isRecord(payload.content_block)) {
    const block = payload.content_block;
    if (block.type !== "tool_use") return state;
    const next = new Map(state);
    next.set(index, {
      toolCallId: asString(block.id),
      canonicalToolName: asString(block.name),
      argumentsText: "",
    });
    return next;
  }

  if (payload.type !== "content_block_delta" || !isRecord(payload.delta)) return state;
  const delta = payload.delta;
  if (delta.type !== "input_json_delta" || typeof delta.partial_json !== "string") {
    return state;
  }
  const previous = state.get(index);
  if (previous === undefined) return state;
  const next = new Map(state);
  next.set(index, {
    ...previous,
    argumentsText: `${previous.argumentsText}${delta.partial_json}`,
  });
  return next;
};

/** Translate one SSE `data:` payload into zero or more chat events. */
const eventsFromSsePayload = (
  protocol: ByokModelAdapter["protocol"],
  payload: Record<string, unknown>,
): ReadonlyArray<ByokChatEvent> => {
  if (protocol === "openai") {
    const choices = payload.choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      return [];
    }
    const delta = isRecord(choices[0]) ? choices[0].delta : undefined;
    if (!isRecord(delta)) {
      return [];
    }
    const reasoning = asString(delta.reasoning_content);
    const content = asString(delta.content);
    return [
      ...(reasoning ? [{ type: "reasoning", text: reasoning } as const] : []),
      ...(content ? [{ type: "text", text: content } as const] : []),
    ];
  }

  if (protocol === "gemini") {
    const candidates = payload.candidates;
    if (!Array.isArray(candidates) || candidates.length === 0) {
      return [];
    }
    const content = isRecord(candidates[0]) ? candidates[0].content : undefined;
    const parts = isRecord(content) && Array.isArray(content.parts) ? content.parts : [];
    const events: ByokChatEvent[] = [];
    for (const part of parts) {
      if (!isRecord(part)) continue;
      if (isRecord(part.functionCall)) {
        const name = asString(part.functionCall.name);
        if (name !== undefined) {
          events.push({
            type: "tool_call",
            toolCallId: `gemini-tool-${name}`,
            canonicalToolName: name,
            arguments: part.functionCall.args ?? {},
          });
        }
        continue;
      }
      const text = asString(part.text);
      if (text === undefined) continue;
      // Gemini 2.5 thinking summaries arrive as parts flagged `thought: true`.
      events.push(part.thought === true ? { type: "reasoning", text } : { type: "text", text });
    }
    return events;
  }

  // anthropic
  if (payload.type !== "content_block_delta") {
    return [];
  }
  const delta = payload.delta;
  if (!isRecord(delta)) {
    return [];
  }
  const thinking = asString(delta.thinking);
  const text = asString(delta.text);
  return [
    ...(thinking ? [{ type: "reasoning", text: thinking } as const] : []),
    ...(text ? [{ type: "text", text } as const] : []),
  ];
};

const sseDataPrefix = "data:";

/** 等待外部 AbortSignal，并在调用方中断时移除监听器。 */
const abortEffect = (signal: AbortSignal): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    if (signal.aborted) {
      resume(Effect.void);
      return;
    }
    const onAbort = () => resume(Effect.void);
    signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });

/**
 * Stream a chat completion from a BYOK model adapter. Interruption of the
 * consuming fiber aborts the underlying request; an explicit `signal` also
 * ends the stream as soon as it fires.
 */
export const streamChat = (
  httpClient: HttpClient.HttpClient,
  input: ByokStreamChatInput,
): Stream.Stream<ByokChatEvent, ByokEngineError> => {
  const requestUrl =
    input.protocol === "openai"
      ? openaiUrl(input.baseURL)
      : input.protocol === "gemini"
        ? geminiUrl(input.baseURL, input.modelId)
        : anthropicUrl(input.baseURL);
  const toEngineError = (
    cause: unknown,
    reason: "transport_error" | "invalid_response" = "invalid_response",
  ) => {
    if (isByokEngineError(cause)) return cause;
    const detail = limitUtf8(
      redactByokErrorDetail(byokErrorDetail(cause), input.apiKey),
      BYOK_ERROR_DETAIL_MAX_BYTES,
    );
    const classification =
      reason === "transport_error"
        ? classifyTransportError(detail, input.signal?.aborted === true)
        : { reason, retryable: false };
    return new ByokEngineError({ url: requestUrl, ...classification, detail });
  };
  const interruptOnAbort = <A>(
    stream: Stream.Stream<A, ByokEngineError>,
  ): Stream.Stream<A, ByokEngineError> =>
    input.signal === undefined
      ? stream
      : stream.pipe(
          Stream.interruptWhen(
            abortEffect(input.signal).pipe(
              Effect.andThen(
                Effect.fail(
                  new ByokEngineError({
                    url: requestUrl,
                    reason: "canceled",
                    retryable: false,
                    detail: "Provider request was canceled.",
                  }),
                ),
              ),
            ),
          ),
        );

  const systemPrompt = input.systemPrompt?.trim() ?? "";
  const requestEffect =
    input.protocol === "openai"
      ? HttpClientRequest.post(openaiUrl(input.baseURL)).pipe(
          HttpClientRequest.setHeader("authorization", `Bearer ${input.apiKey}`),
          HttpClientRequest.bodyJson({
            model: input.modelId,
            messages: [
              ...(systemPrompt.length > 0 ? [{ role: "system", content: systemPrompt }] : []),
              ...input.messages.map(openaiMessage),
            ],
            ...(input.tools !== undefined && input.tools.length > 0
              ? {
                  tools: input.tools.map((tool) => ({
                    type: "function",
                    function: {
                      name: tool.canonicalToolName,
                      description: tool.description,
                      parameters: tool.parameters,
                    },
                  })),
                }
              : {}),
            stream: true,
          }),
        )
      : input.protocol === "gemini"
        ? HttpClientRequest.post(requestUrl).pipe(
            HttpClientRequest.setHeader("x-goog-api-key", input.apiKey),
            HttpClientRequest.setHeader("content-type", "application/json"),
            HttpClientRequest.bodyJson({
              contents: input.messages.map((message) => ({
                role: message.role === "assistant" ? "model" : "user",
                parts: geminiMessageParts(message),
              })),
              ...(input.tools !== undefined && input.tools.length > 0
                ? {
                    tools: [
                      {
                        functionDeclarations: input.tools.map((tool) => ({
                          name: tool.canonicalToolName,
                          description: tool.description,
                          parameters: tool.parameters,
                        })),
                      },
                    ],
                  }
                : {}),
              ...(systemPrompt.length > 0
                ? { systemInstruction: { parts: [{ text: systemPrompt }] } }
                : {}),
            }),
          )
        : HttpClientRequest.post(anthropicUrl(input.baseURL)).pipe(
            HttpClientRequest.setHeader("x-api-key", input.apiKey),
            HttpClientRequest.setHeader("anthropic-version", "2023-06-01"),
            HttpClientRequest.bodyJson({
              model: input.modelId,
              messages: input.messages.map(anthropicMessage),
              ...(systemPrompt.length > 0 ? { system: systemPrompt } : {}),
              ...(input.tools !== undefined && input.tools.length > 0
                ? {
                    tools: input.tools.map((tool) => ({
                      name: tool.canonicalToolName,
                      description: tool.description,
                      input_schema: tool.parameters,
                    })),
                  }
                : {}),
              max_tokens: 8192,
              stream: true,
            }),
          );

  const sseItems: Stream.Stream<ByokSseItem, ByokEngineError> = HttpClientResponse.stream(
    Effect.flatMap(requestEffect, (prepared) => httpClient.execute(prepared)).pipe(
      Effect.mapError((cause) => toEngineError(cause, "transport_error")),
      Effect.flatMap((response) =>
        response.status >= 200 && response.status < 300
          ? Effect.succeed(response)
          : providerResponseError(response, requestUrl, input.apiKey),
      ),
    ),
  ).pipe(
    Stream.mapError((cause) => toEngineError(cause, "transport_error")),
    Stream.decodeText(),
    Stream.splitLines,
    Stream.filter((line) => line.startsWith(sseDataPrefix)),
    Stream.map((line) => line.slice(sseDataPrefix.length).trim()),
    Stream.map((data): ByokSseItem => {
      if (data === "[DONE]") return { type: "done" };
      const payload = parseJsonLine(data);
      return payload === undefined ? { type: "invalid_json" } : { type: "payload", payload };
    }),
    Stream.mapEffect((item): Effect.Effect<ByokSseItem, ByokEngineError> => {
      if (item.type === "invalid_json") {
        return Effect.fail(
          new ByokEngineError({
            url: requestUrl,
            reason: "invalid_response",
            retryable: false,
            detail: "Provider SSE data was not valid JSON.",
          }),
        );
      }
      if (item.type !== "payload") return Effect.succeed(item);
      const rawDetail = providerPayloadErrorDetail(item.payload);
      if (rawDetail === undefined) return Effect.succeed(item);
      const classification = classifyProviderError(rawDetail);
      return Effect.fail(
        new ByokEngineError({
          url: requestUrl,
          ...classification,
          detail: limitUtf8(
            redactByokErrorDetail(rawDetail, input.apiKey),
            BYOK_ERROR_DETAIL_MAX_BYTES,
          ),
        }),
      );
    }),
    Stream.takeUntil((item) => isProtocolTransportTerminator(input.protocol, item)),
    Stream.concat(Stream.succeed({ type: "eof" } as ByokSseItem)),
  );

  if (input.protocol === "gemini") {
    const geminiEvents: Stream.Stream<ByokChatEvent | ByokStreamErrorEvent, ByokEngineError> =
      Stream.mapAccum(
        sseItems,
        (): GeminiStreamState => ({ terminalSeen: false }),
        (
          state,
          item,
        ): readonly [GeminiStreamState, ReadonlyArray<ByokChatEvent | ByokStreamErrorEvent>] => {
          if (state.terminalSeen) return [state, []];
          if (item.type !== "payload") {
            return [{ terminalSeen: true }, [missingTerminalEvent("gemini")]];
          }
          const events = eventsFromSsePayload("gemini", item.payload);
          const finishReason = geminiFinishReason(item.payload);
          if (finishReason === undefined) return [state, events];
          return [
            { terminalSeen: true },
            [...events, terminalEventForFinishReason("gemini", finishReason)],
          ];
        },
      );
    return interruptOnAbort(
      geminiEvents.pipe(
        Stream.mapEffect((event) =>
          event.type === "stream_error"
            ? Effect.fail(
                new ByokEngineError({
                  url: requestUrl,
                  reason: event.reason,
                  retryable: false,
                  detail: event.detail,
                }),
              )
            : Effect.succeed(event),
        ),
      ),
    );
  }

  if (input.protocol === "anthropic") {
    const anthropicEvents: Stream.Stream<AnthropicStreamEvent, ByokEngineError> = Stream.mapAccum(
      sseItems,
      (): AnthropicStreamState => ({
        toolCalls: new Map<number, AnthropicToolCallState>(),
        stopReason: undefined,
        terminalSeen: false,
      }),
      (state, item): readonly [AnthropicStreamState, ReadonlyArray<AnthropicStreamEvent>] => {
        if (state.terminalSeen) return [state, []];
        if (item.type !== "payload") {
          return [{ ...state, terminalSeen: true }, [missingTerminalEvent("anthropic")]];
        }

        const toolCalls = anthropicToolCallStateForPayload(state.toolCalls, item.payload);
        const stopReason = anthropicStopReason(item.payload) ?? state.stopReason;
        const events = eventsFromSsePayload("anthropic", item.payload);
        if (item.payload.type !== "message_stop") {
          return [{ toolCalls, stopReason, terminalSeen: false }, events];
        }
        if (stopReason === undefined) {
          return [
            { toolCalls, stopReason, terminalSeen: true },
            [...events, missingTerminalEvent("anthropic")],
          ];
        }

        const terminalEvent = terminalEventForFinishReason("anthropic", stopReason);
        return [
          { toolCalls: new Map(), stopReason, terminalSeen: true },
          [
            ...events,
            ...(terminalEvent.type === "completed" ? anthropicToolCallJsonEvents(toolCalls) : []),
            terminalEvent,
          ],
        ];
      },
    );

    return interruptOnAbort(
      anthropicEvents.pipe(
        Stream.mapEffect((event: AnthropicStreamEvent) => {
          if (event.type === "stream_error") {
            return Effect.fail(
              new ByokEngineError({
                url: requestUrl,
                reason: event.reason,
                retryable: false,
                detail: event.detail,
              }),
            );
          }
          if (event.type !== "tool_call_json") return Effect.succeed(event);
          if (event.toolCallId === undefined || event.canonicalToolName === undefined) {
            return Effect.fail(
              toEngineError(new Error("Anthropic tool call ended without an id or function name.")),
            );
          }
          const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))(
            event.argumentsText.length === 0 ? "{}" : event.argumentsText,
          );
          return Option.isNone(decoded)
            ? Effect.fail(
                toEngineError(new Error("Anthropic tool call arguments are not valid JSON.")),
              )
            : Effect.succeed({
                type: "tool_call" as const,
                toolCallId: event.toolCallId,
                canonicalToolName: event.canonicalToolName,
                arguments: decoded.value,
              });
        }),
      ),
    );
  }

  const openaiEvents: Stream.Stream<OpenAiStreamEvent, ByokEngineError> = Stream.mapAccum(
    sseItems,
    (): OpenAiStreamState => ({
      toolCalls: new Map<number, OpenAiToolCallState>(),
      terminalSeen: false,
    }),
    (state, item): readonly [OpenAiStreamState, ReadonlyArray<OpenAiStreamEvent>] => {
      if (state.terminalSeen) return [state, []];
      if (item.type !== "payload") {
        return [{ ...state, terminalSeen: true }, [missingTerminalEvent("openai")]];
      }

      const toolCalls = new Map(state.toolCalls);
      for (const fragment of openaiToolCallFragments(item.payload)) {
        const previous = toolCalls.get(fragment.index);
        toolCalls.set(fragment.index, {
          toolCallId: fragment.id ?? previous?.toolCallId,
          canonicalToolName: fragment.name ?? previous?.canonicalToolName,
          argumentsText: `${previous?.argumentsText ?? ""}${fragment.arguments ?? ""}`,
        });
      }
      const events = eventsFromSsePayload("openai", item.payload);
      const finishReason = openAiFinishReason(item.payload);
      if (finishReason === undefined) {
        return [{ toolCalls, terminalSeen: false }, events];
      }

      const normalizedFinishReason =
        toolCalls.size > 0 && finishReason.trim().toLowerCase() === "stop"
          ? "tool_calls"
          : finishReason;
      const terminalEvent = terminalEventForFinishReason("openai", normalizedFinishReason);
      return [
        { toolCalls: new Map(), terminalSeen: true },
        [
          ...events,
          ...(terminalEvent.type === "completed" ? openaiToolCallJsonEvents(toolCalls) : []),
          terminalEvent,
        ],
      ];
    },
  );

  return interruptOnAbort(
    openaiEvents.pipe(
      Stream.mapEffect((event: OpenAiStreamEvent) => {
        if (event.type === "stream_error") {
          return Effect.fail(
            new ByokEngineError({
              url: requestUrl,
              reason: event.reason,
              retryable: false,
              detail: event.detail,
            }),
          );
        }
        if (event.type !== "tool_call_json") {
          return Effect.succeed(event);
        }
        if (event.toolCallId === undefined || event.canonicalToolName === undefined) {
          return Effect.fail(
            toEngineError(new Error("OpenAI tool call ended without an id or function name.")),
          );
        }
        const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))(
          event.argumentsText,
        );
        return Option.isNone(decoded)
          ? Effect.fail(toEngineError(new Error("OpenAI tool call arguments are not valid JSON.")))
          : Effect.succeed({
              type: "tool_call" as const,
              toolCallId: event.toolCallId,
              canonicalToolName: event.canonicalToolName,
              arguments: decoded.value,
            });
      }),
    ),
  );
};

/** Consume a `streamChat` stream element-by-element, honoring an abort signal. */
export const runChatEvents = <E2, R2>(
  stream: Stream.Stream<ByokChatEvent, ByokEngineError>,
  onEvent: (event: ByokChatEvent) => Effect.Effect<void, E2, R2>,
  signal?: AbortSignal | undefined,
): Effect.Effect<void, ByokEngineError | E2, R2> => {
  const consume = Stream.runForEach(stream, onEvent);
  return signal === undefined ? consume : Effect.race(consume, abortEffect(signal));
};

/** Collect a `streamChat` stream into concatenated text, discarding reasoning. */
export const collectChatText = (
  stream: Stream.Stream<ByokChatEvent, ByokEngineError>,
  signal?: AbortSignal | undefined,
): Effect.Effect<string, ByokEngineError> => {
  const collect = Stream.runFold(
    stream,
    () => "",
    (acc, event) => (event.type === "text" ? acc + event.text : acc),
  );
  return signal === undefined
    ? collect
    : Effect.race(collect, abortEffect(signal).pipe(Effect.as("")));
};
