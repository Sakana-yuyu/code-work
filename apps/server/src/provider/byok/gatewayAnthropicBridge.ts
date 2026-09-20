/**
 * gatewayAnthropicBridge — cross-protocol translation for the BYOK gateway.
 *
 * Claude Code speaks the Anthropic Messages wire, but most BYOK channels are
 * OpenAI chat-completions endpoints. When a routed Claude instance selects one
 * of those channels, the gateway bridges instead of passing through: requests
 * are translated Messages → chat completions, and responses (streaming SSE or
 * JSON) are translated back. Codex keeps its per-protocol passthrough — a
 * Responses → Messages bridge does not exist yet, so anthropic-protocol
 * adapters stay invisible to openai-routed harnesses.
 *
 * Pure translation lives here; HTTP concerns (status, headers, error
 * rendering) stay in modelGateway.
 *
 * @module provider/byok/gatewayAnthropicBridge
 */
import * as Stream from "effect/Stream";

import * as NodeCrypto from "node:crypto";

/** Paths an anthropic client may bridge to an openai-protocol adapter. */
export const BRIDGEABLE_ANTHROPIC_PATHS: ReadonlySet<string> = new Set([
  "/v1/messages",
  "/v1/messages/count_tokens",
]);

const TOOL_NAME_MAX_LENGTH = 64;

const sanitizeToolName = (name: string): string => {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  return cleaned.length > TOOL_NAME_MAX_LENGTH ? cleaned.slice(0, TOOL_NAME_MAX_LENGTH) : cleaned;
};

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const blocksOf = (content: unknown): readonly unknown[] => {
  if (typeof content === "string") return content.length > 0 ? [content] : [];
  return Array.isArray(content) ? content : [];
};

const textBlockText = (block: unknown): string => {
  if (typeof block === "string") return block;
  if (isRecord(block) && block.type === "text" && typeof block.text === "string") return block.text;
  return "";
};

/** Concatenates the text of a string-or-blocks content field. */
const joinText = (content: unknown): string =>
  blocksOf(content)
    .map(textBlockText)
    .filter((text) => text.length > 0)
    .join("");

interface TranslatedMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string | null;
  readonly toolCalls?: readonly UnknownRecord[];
  readonly toolCallId?: string;
}

const imageRef = (block: UnknownRecord): string => {
  const source = isRecord(block.source) ? block.source : {};
  if (source.type === "base64" && typeof source.data === "string") {
    const media = typeof source.media_type === "string" ? source.media_type : "image/png";
    return `[image: ${media}]`;
  }
  if (typeof source.url === "string") return `[image: ${source.url}]`;
  return "[image]";
};

const toolResultText = (block: UnknownRecord): string => {
  const parts = blocksOf(block.content).map((part) => {
    const text = textBlockText(part);
    if (text.length > 0) return text;
    if (isRecord(part) && part.type === "image") return imageRef(part);
    return "";
  });
  const text = parts.filter((entry) => entry.length > 0).join("\n");
  return block.is_error === true ? `Error: ${text}` : text;
};

const translateToolChoice = (value: unknown): unknown => {
  if (!isRecord(value)) return undefined;
  switch (value.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "none":
    case "disabled":
      return "none";
    case "tool":
      return typeof value.name === "string"
        ? { type: "function", function: { name: sanitizeToolName(value.name) } }
        : "auto";
    default:
      return undefined;
  }
};

/**
 * Translates an Anthropic `/v1/messages` request body into an OpenAI
 * chat-completions body for `modelId` (the adapter's real upstream model
 * name). Thinking blocks are dropped: bridged upstreams have no Anthropic
 * thinking parameter, and replaying unsigned thinking blocks would fail
 * downstream validation anyway.
 */
export const anthropicMessagesToChatBody = (body: unknown, modelId: string): UnknownRecord => {
  const request = isRecord(body) ? body : {};
  const messages: UnknownRecord[] = [];

  const system = request.system;
  const systemText =
    typeof system === "string" ? system : system === undefined ? "" : joinText(system);
  if (systemText.trim().length > 0) messages.push({ role: "system", content: systemText });

  const anthropicMessages = Array.isArray(request.messages) ? request.messages : [];
  for (const entry of anthropicMessages) {
    if (!isRecord(entry)) continue;
    const role = entry.role === "assistant" ? "assistant" : "user";
    const toolCalls: UnknownRecord[] = [];
    const toolResults: UnknownRecord[] = [];
    const textParts: string[] = [];
    const imageParts: UnknownRecord[] = [];

    for (const block of blocksOf(entry.content)) {
      if (typeof block === "string") {
        textParts.push(block);
        continue;
      }
      if (!isRecord(block)) continue;
      switch (block.type) {
        case "text": {
          const text = textBlockText(block);
          if (text.length > 0) textParts.push(text);
          break;
        }
        case "image": {
          imageParts.push({ type: "text", text: imageRef(block) });
          break;
        }
        case "tool_use": {
          if (typeof block.name === "string") {
            toolCalls.push({
              id: typeof block.id === "string" ? block.id : `call_${NodeCrypto.randomUUID()}`,
              type: "function",
              function: {
                name: sanitizeToolName(block.name),
                arguments: JSON.stringify(block.input ?? {}),
              },
            });
          }
          break;
        }
        case "tool_result": {
          toolResults.push({
            role: "tool",
            tool_call_id: typeof block.tool_use_id === "string" ? block.tool_use_id : "",
            content: toolResultText(block),
          });
          break;
        }
        default:
          // thinking / redacted_thinking / documents have no chat equivalent.
          break;
      }
    }

    if (role === "assistant") {
      const text = textParts.join("");
      messages.push({
        role: "assistant",
        ...(text.length > 0 ? { content: text } : { content: null }),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }
    // Anthropic puts tool results in the user turn right after the assistant
    // tool calls; chat requires each tool message directly after that
    // assistant message, with any leftover text trailing as a user message.
    for (const toolResult of toolResults) messages.push(toolResult);
    const userContent =
      imageParts.length > 0
        ? [...textParts.map((text) => ({ type: "text", text })), ...imageParts]
        : textParts.join("");
    if (typeof userContent !== "string" || userContent.length > 0) {
      messages.push({ role: "user", content: userContent });
    }
  }

  const tools = Array.isArray(request.tools)
    ? request.tools.filter(isRecord).filter((tool) => typeof tool.name === "string")
    : [];
  const stop = Array.isArray(request.stop_sequences)
    ? request.stop_sequences.filter((entry): entry is string => typeof entry === "string")
    : undefined;

  return {
    model: modelId,
    messages,
    ...(tools.length > 0
      ? {
          tools: tools.map((tool) => ({
            type: "function",
            function: {
              name: sanitizeToolName(String(tool.name)),
              ...(typeof tool.description === "string" ? { description: tool.description } : {}),
              ...(isRecord(tool.input_schema) ? { parameters: tool.input_schema } : {}),
            },
          })),
        }
      : {}),
    ...(request.tool_choice !== undefined
      ? (() => {
          const choice = translateToolChoice(request.tool_choice);
          return choice === undefined ? {} : { tool_choice: choice };
        })()
      : {}),
    ...(typeof request.max_tokens === "number" ? { max_tokens: request.max_tokens } : {}),
    ...(typeof request.temperature === "number" ? { temperature: request.temperature } : {}),
    ...(typeof request.top_p === "number" ? { top_p: request.top_p } : {}),
    ...(stop !== undefined && stop.length > 0 ? { stop } : {}),
    ...(request.stream === true ? { stream: true } : {}),
  };
};

const chatStopReasonToAnthropic = (finish: unknown): string => {
  switch (finish) {
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "content_filter":
      return "refusal";
    default:
      return "end_turn";
  }
};

const chatUsageOf = (value: unknown): { input: number; output: number } => {
  if (!isRecord(value)) return { input: 0, output: 0 };
  const number = (entry: unknown): number => (typeof entry === "number" && entry > 0 ? entry : 0);
  return {
    input: number(value.prompt_tokens) + number(value.input_tokens),
    output: number(value.completion_tokens) + number(value.output_tokens),
  };
};

/** Translates a non-streaming chat-completions response into a Messages payload. */
export const chatCompletionToAnthropicMessage = (body: unknown, model: string): UnknownRecord => {
  const response = isRecord(body) ? body : {};
  const choice = Array.isArray(response.choices) ? (response.choices[0] ?? {}) : {};
  const message = isRecord(choice.message) ? choice.message : {};
  const content: UnknownRecord[] = [];
  const text = typeof message.content === "string" ? message.content : joinText(message.content);
  if (text.length > 0) content.push({ type: "text", text });
  for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    if (!isRecord(call) || !isRecord(call.function) || typeof call.function.name !== "string") {
      continue;
    }
    let input: unknown = {};
    if (typeof call.function.arguments === "string" && call.function.arguments.length > 0) {
      try {
        input = JSON.parse(call.function.arguments);
      } catch {
        input = {};
      }
    }
    content.push({
      type: "tool_use",
      id: typeof call.id === "string" ? call.id : `call_${NodeCrypto.randomUUID()}`,
      name: call.function.name,
      input,
    });
  }
  const usage = chatUsageOf(response.usage);
  return {
    id: typeof response.id === "string" ? response.id : `msg_${NodeCrypto.randomUUID()}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: chatStopReasonToAnthropic(choice.finish_reason),
    stop_sequence: null,
    usage: { input_tokens: usage.input, output_tokens: usage.output },
  };
};

/** Rough prompt-token estimate for bridged count_tokens calls. */
export const estimateAnthropicPromptTokens = (body: unknown): number => {
  const request = isRecord(body) ? body : {};
  let chars = joinText(request.system).length;
  for (const entry of Array.isArray(request.messages) ? request.messages : []) {
    if (!isRecord(entry)) continue;
    for (const block of blocksOf(entry.content)) {
      if (isRecord(block) && block.type === "tool_use") {
        chars += JSON.stringify(block.input ?? {}).length;
        continue;
      }
      chars += textBlockText(block).length;
    }
  }
  return Math.max(1, Math.ceil(chars / 4));
};

const sseEvent = (name: string, payload: unknown): string =>
  `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;

const randomId = (prefix: string): string =>
  `${prefix}_${NodeCrypto.randomUUID().replace(/-/gu, "")}`;

/**
 * Stateful chat-SSE → anthropic-SSE translator. Feed decoded upstream text
 * (chunks may split lines); it returns the anthropic events to forward, and
 * `complete()` flushes the closing events after the upstream stream ends.
 */
export class ChatStreamToAnthropicSse {
  readonly #model: string;
  readonly #messageId: string;
  #pending = "";
  #started = false;
  #textIndex: number | null = null;
  #nextIndex = 0;
  readonly #toolBlocks = new Map<number, { readonly index: number; opened: boolean }>();
  #stopReason: string | null = null;
  #inputTokens = 0;
  #outputTokens = 0;
  #finished = false;

  constructor(model: string) {
    this.#model = model;
    this.#messageId = randomId("msg");
  }

  #start(): string {
    if (this.#started) return "";
    this.#started = true;
    return sseEvent("message_start", {
      type: "message_start",
      message: {
        id: this.#messageId,
        type: "message",
        role: "assistant",
        model: this.#model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: this.#inputTokens, output_tokens: 0 },
      },
    });
  }

  #blockStart(index: number, block: UnknownRecord): string {
    return sseEvent("content_block_start", {
      type: "content_block_start",
      index,
      content_block: block,
    });
  }

  #blockDelta(index: number, delta: UnknownRecord): string {
    return sseEvent("content_block_delta", { type: "content_block_delta", index, delta });
  }

  #blockStop(index: number): string {
    return sseEvent("content_block_stop", { type: "content_block_stop", index });
  }

  #openText(): string {
    if (this.#textIndex !== null) return "";
    const index = this.#nextIndex++;
    this.#textIndex = index;
    return this.#blockStart(index, { type: "text", text: "" });
  }

  #closeText(): string {
    if (this.#textIndex === null) return "";
    const events = this.#blockStop(this.#textIndex);
    this.#textIndex = null;
    return events;
  }

  /** Consumes one upstream line (`data: …`); returns the events to emit. */
  #consumeLine(line: string): string {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return "";
    const payload = trimmed.slice(5).trim();
    if (payload.length === 0 || payload === "[DONE]") return "";
    let chunk: unknown;
    try {
      chunk = JSON.parse(payload);
    } catch {
      return "";
    }
    if (!isRecord(chunk)) return "";
    const usage = chatUsageOf(chunk.usage);
    this.#inputTokens = Math.max(this.#inputTokens, usage.input);
    this.#outputTokens = Math.max(this.#outputTokens, usage.output);
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    const choice = isRecord(choices[0]) ? choices[0] : undefined;
    if (choice === undefined) return this.#started ? "" : this.#start();
    const delta = isRecord(choice.delta) ? choice.delta : {};
    let events = this.#start();

    const text = typeof delta.content === "string" ? delta.content : "";
    if (text.length > 0 && this.#textIndex === null) events += this.#openText();
    if (text.length > 0 && this.#textIndex !== null) {
      events += this.#blockDelta(this.#textIndex, { type: "text_delta", text });
    }

    for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      if (!isRecord(call)) continue;
      const chatIndex = typeof call.index === "number" ? call.index : 0;
      let block = this.#toolBlocks.get(chatIndex);
      if (block === undefined) {
        events += this.#closeText();
        const index = this.#nextIndex++;
        const fn = isRecord(call.function) ? call.function : {};
        block = { index, opened: true };
        this.#toolBlocks.set(chatIndex, block);
        events += this.#blockStart(index, {
          type: "tool_use",
          id: typeof call.id === "string" && call.id.length > 0 ? call.id : randomId("toolu"),
          name: typeof fn.name === "string" ? fn.name : "",
          input: {},
        });
      }
      const fragment =
        isRecord(call.function) && typeof call.function.arguments === "string"
          ? call.function.arguments
          : "";
      if (fragment.length > 0) {
        events += this.#blockDelta(block.index, {
          type: "input_json_delta",
          partial_json: fragment,
        });
      }
    }

    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      this.#stopReason = chatStopReasonToAnthropic(choice.finish_reason);
    }
    return events;
  }

  push(chunk: string): string {
    if (this.#finished) return "";
    this.#pending += chunk;
    let events = "";
    let index = this.#pending.indexOf("\n");
    while (index >= 0) {
      events += this.#consumeLine(this.#pending.slice(0, index));
      this.#pending = this.#pending.slice(index + 1);
      index = this.#pending.indexOf("\n");
    }
    return events;
  }

  /** Emits the closing sequence; idempotent, safe to call once at stream end. */
  complete(): string {
    if (this.#finished) return "";
    this.#finished = true;
    if (this.#pending.trim().length > 0) {
      this.#consumeLine(this.#pending);
      this.#pending = "";
    }
    let events = this.#start();
    events += this.#closeText();
    for (const block of this.#toolBlocks.values()) {
      if (block.opened) events += this.#blockStop(block.index);
    }
    events += sseEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: this.#stopReason ?? "end_turn", stop_sequence: null },
      usage: { output_tokens: this.#outputTokens },
    });
    events += sseEvent("message_stop", { type: "message_stop" });
    return events;
  }
}

/**
 * Wraps an upstream chat-completions SSE stream so a Messages client receives
 * a valid anthropic event stream.
 */
export const transformChatStreamToAnthropicSse = <E>(
  stream: Stream.Stream<Uint8Array, E>,
  model: string,
): Stream.Stream<Uint8Array, E> => {
  const translator = new ChatStreamToAnthropicSse(model);
  // complete() must run when the upstream ends, not when this stream is
  // built — otherwise it flips the translator's finished flag before any
  // chunk flows through.
  return Stream.concat(
    stream.pipe(
      Stream.decodeText(),
      Stream.flatMap((chunk) => {
        const events = translator.push(chunk);
        return events.length > 0 ? Stream.make(events) : Stream.empty;
      }),
    ),
    Stream.suspend(() => Stream.make(translator.complete())),
  ).pipe(Stream.encodeText);
};

/** Maps an upstream chat error payload onto the anthropic error taxonomy. */
export const chatErrorToAnthropicType = (status: number): string => {
  if (status === 400) return "invalid_request_error";
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 429) return "rate_limit_error";
  if (status >= 500) return "api_error";
  return "invalid_request_error";
};
