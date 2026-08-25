/**
 * byokChatClient — unified streaming chat client for BYOK model adapters.
 *
 * Talks directly to OpenAI-compatible, Anthropic-compatible, and native
 * Gemini chat APIs using the credentials stored in `ByokSettings.adapters`.
 * There is no intermediate gateway: each call is one streaming HTTP request
 * whose server-sent events are parsed into a flat `ByokChatEvent` stream.
 *
 *   - `openai` protocol: `POST ${baseURL}/chat/completions` with
 *     `stream: true`; `choices[0].delta.content` is text and
 *     `choices[0].delta.reasoning_content` (DeepSeek style) is reasoning.
 *     `data: [DONE]` terminates the stream.
 *   - `anthropic` protocol: `POST ${baseURL}/v1/messages` with `x-api-key` +
 *     `anthropic-version: 2023-06-01` and `stream: true`;
 *     `content_block_delta.delta.text` is text and `delta.thinking` is
 *     reasoning. `message_stop` terminates the stream.
 *   - `gemini` protocol: `POST
 *     ${baseURL}/v1beta/models/{model}:streamGenerateContent?alt=sse` with
 *     `x-goog-api-key`; roles map user→`user`, assistant→`model`, and the
 *     system prompt becomes top-level `systemInstruction`. Each SSE payload
 *     carries `candidates[0].content.parts[]`; parts flagged `thought: true`
 *     are reasoning. The stream ends without a terminator chunk.
 *
 * @module provider/Layers/byokChatClient
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { type HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import type { ByokModelAdapter, ByokSettings } from "@t3tools/contracts";

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
  | { readonly type: "reasoning"; readonly text: string };

/** One failed BYOK engine request (transport, non-2xx, or malformed SSE). */
export class ByokEngineError extends Schema.TaggedErrorClass<ByokEngineError>()("ByokEngineError", {
  url: Schema.String,
  detail: Schema.String,
}) {
  override get message(): string {
    return `BYOK engine request to ${this.url} failed: ${this.detail}`;
  }
}

/** One image part carried inline as base64 (multimodal user input). */
export interface ByokImagePart {
  readonly type: "image";
  readonly mimeType: string;
  readonly dataBase64: string;
}

export type ByokContentPart = { readonly type: "text"; readonly text: string } | ByokImagePart;

export interface ByokChatMessage {
  readonly role: "user" | "assistant";
  /** Plain text, or multimodal parts when the turn carried image attachments. */
  readonly content: string | ReadonlyArray<ByokContentPart>;
}

export interface ByokStreamChatInput {
  readonly protocol: ByokModelAdapter["protocol"];
  readonly baseURL: string;
  readonly apiKey: string;
  readonly modelId: string;
  readonly messages: ReadonlyArray<ByokChatMessage>;
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

const geminiMessageParts = (
  content: ByokChatMessage["content"],
): ReadonlyArray<Record<string, unknown>> =>
  (typeof content === "string" ? [{ text: content }] : [...content]).map((part) =>
    "text" in part
      ? { text: part.text }
      : { inlineData: { mimeType: part.mimeType, data: part.dataBase64 } },
  );

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

const isTerminalSsePayload = (
  protocol: ByokModelAdapter["protocol"],
  payload: Record<string, unknown>,
): boolean => protocol === "anthropic" && payload.type === "message_stop";

const sseDataPrefix = "data:";

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
  const toEngineError = (cause: unknown) =>
    new ByokEngineError({
      url: requestUrl,
      detail: byokErrorDetail(cause),
    });

  const systemPrompt = input.systemPrompt?.trim() ?? "";
  const requestEffect =
    input.protocol === "openai"
      ? HttpClientRequest.post(openaiUrl(input.baseURL)).pipe(
          HttpClientRequest.setHeader("authorization", `Bearer ${input.apiKey}`),
          HttpClientRequest.bodyJson({
            model: input.modelId,
            messages: [
              ...(systemPrompt.length > 0 ? [{ role: "system", content: systemPrompt }] : []),
              ...input.messages.map((message) => ({
                role: message.role,
                content: openaiMessageContent(message.content),
              })),
            ],
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
                parts: geminiMessageParts(message.content),
              })),
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
              messages: input.messages.map((message) => ({
                role: message.role,
                content: anthropicMessageContent(message.content),
              })),
              ...(systemPrompt.length > 0 ? { system: systemPrompt } : {}),
              max_tokens: 8192,
              stream: true,
            }),
          );

  const events = HttpClientResponse.stream(
    Effect.flatMap(requestEffect, (prepared) => httpClient.execute(prepared)).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.mapError(toEngineError),
    ),
  ).pipe(
    Stream.mapError(toEngineError),
    Stream.decodeText(),
    Stream.splitLines,
    Stream.filter((line) => line.startsWith(sseDataPrefix)),
    Stream.map((line) => line.slice(sseDataPrefix.length).trim()),
    Stream.map((data) => (data === "[DONE]" ? undefined : parseJsonLine(data))),
    Stream.takeWhile((payload): payload is Record<string, unknown> => {
      if (payload === undefined) {
        // openai `data: [DONE]` terminator.
        return false;
      }
      return !isTerminalSsePayload(input.protocol, payload);
    }),
    Stream.flatMap((payload) => Stream.fromIterable(eventsFromSsePayload(input.protocol, payload))),
  );

  return events;
};

/** Effect that completes when the abort signal fires. */
const abortEffect = (signal: AbortSignal): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    if (signal.aborted) {
      resume(Effect.void);
      return;
    }
    signal.addEventListener("abort", () => resume(Effect.void), { once: true });
  });

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
