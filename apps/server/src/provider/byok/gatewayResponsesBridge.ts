/**
 * 将 Codex 的 Responses 请求接入仅提供 Chat Completions 的中转线路。
 * 只转换可无损表达的文本、图片 URL、函数和自定义工具；不认识的输入直接拒绝。
 */
import * as Stream from "effect/Stream";

import * as NodeCrypto from "node:crypto";

type JsonRecord = Record<string, unknown>;
const record = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const id = (prefix: string): string => `${prefix}_${NodeCrypto.randomUUID().replace(/-/gu, "")}`;
const event = (type: string, fields: JsonRecord): string =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;

interface ToolSpec {
  readonly responseName: string;
  readonly kind: "function" | "custom";
}

const chatToolName = (name: string): string => name.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 64);

export interface ResponsesChatRequest {
  readonly body: JsonRecord;
  readonly tools: ReadonlyMap<string, ToolSpec>;
  readonly model: string;
  readonly stream: boolean;
  readonly createdAt: number;
}

export type ResponsesChatTranslation =
  | { readonly ok: true; readonly value: ResponsesChatRequest }
  | { readonly ok: false; readonly reason: string };

const contentToChat = (content: unknown): string | readonly JsonRecord[] | undefined => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts: JsonRecord[] = [];
  for (const part of content) {
    if (!record(part)) return undefined;
    if (
      (part.type === "input_text" || part.type === "output_text") &&
      typeof part.text === "string"
    ) {
      parts.push({ type: "text", text: part.text });
    } else if (part.type === "input_image" && typeof part.image_url === "string") {
      parts.push({ type: "image_url", image_url: { url: part.image_url } });
    } else {
      return undefined;
    }
  }
  return parts;
};

const toolOutputText = (output: unknown): string | undefined => {
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) return undefined;
  const parts: string[] = [];
  for (const part of output) {
    if (!record(part) || typeof part.text !== "string") return undefined;
    parts.push(part.text);
  }
  return parts.join("\n");
};

/** 失败时返回明确原因，避免把工具或多模态上下文悄悄丢弃。 */
export const responsesToChatRequest = (
  source: unknown,
  model: string,
  createdAt: number,
): ResponsesChatTranslation => {
  if (!record(source)) return { ok: false, reason: "Responses request must be a JSON object." };
  if (source.previous_response_id !== undefined || source.conversation !== undefined) {
    return { ok: false, reason: "Stored Responses conversation state cannot be bridged." };
  }
  if (source.background === true || source.prompt !== undefined) {
    return { ok: false, reason: "Background or stored prompt requests cannot be bridged." };
  }
  if (record(source.text) && record(source.text.format) && source.text.format.type !== "text") {
    return { ok: false, reason: "Structured Responses output format cannot be bridged." };
  }
  const tools = new Map<string, ToolSpec>();
  const responseToChatName = new Map<string, string>();
  const chatTools: JsonRecord[] = [];
  if (source.tools !== undefined && !Array.isArray(source.tools)) {
    return { ok: false, reason: "Responses tools must be an array." };
  }
  for (const rawItem of Array.isArray(source.tools) ? source.tools : []) {
    const item = typeof rawItem === "string" ? { type: "custom", name: rawItem } : rawItem;
    if (!record(item) || typeof item.name !== "string" || !item.name.trim()) {
      return { ok: false, reason: "Unsupported Responses tool definition." };
    }
    if (item.type !== "function" && item.type !== "custom") {
      return { ok: false, reason: `Responses tool '${item.type}' cannot be bridged.` };
    }
    const chatName = chatToolName(item.name);
    if (!chatName || tools.has(chatName) || responseToChatName.has(item.name)) {
      return { ok: false, reason: "Responses tool names collide after normalization." };
    }
    tools.set(chatName, { responseName: item.name, kind: item.type });
    responseToChatName.set(item.name, chatName);
    const parameters =
      item.type === "custom"
        ? { type: "object", properties: { input: { type: "string" } }, required: ["input"] }
        : record(item.parameters)
          ? item.parameters
          : { type: "object", properties: {} };
    const description = [
      typeof item.description === "string" ? item.description : "",
      item.type === "custom" && record(item.format)
        ? `Original input format: ${JSON.stringify(item.format)}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
    chatTools.push({
      type: "function",
      function: {
        name: chatName,
        ...(description ? { description } : {}),
        parameters,
      },
    });
  }

  const messages: JsonRecord[] = [];
  if (typeof source.instructions === "string" && source.instructions.length > 0) {
    messages.push({ role: "system", content: source.instructions });
  } else if (source.instructions !== undefined) {
    return { ok: false, reason: "Non-text Responses instructions cannot be bridged." };
  }
  const input =
    typeof source.input === "string" ? [{ role: "user", content: source.input }] : source.input;
  if (!Array.isArray(input)) return { ok: false, reason: "Responses input must be text or items." };
  for (const item of input) {
    if (!record(item)) return { ok: false, reason: "Unsupported Responses input item." };
    if (item.type === "reasoning") {
      if (item.encrypted_content !== undefined) {
        return { ok: false, reason: "Encrypted reasoning history cannot be bridged." };
      }
      const summary = Array.isArray(item.summary)
        ? item.summary
            .filter(record)
            .map((part) => part.text)
            .filter((text): text is string => typeof text === "string")
            .join("\n")
        : "";
      if (summary.length > 0) messages.push({ role: "assistant", content: summary });
      continue;
    }
    if (item.type === "function_call" || item.type === "custom_tool_call") {
      if (typeof item.call_id !== "string" || typeof item.name !== "string") {
        return { ok: false, reason: "Tool call is missing its ID or name." };
      }
      const name = responseToChatName.get(item.name) ?? chatToolName(item.name);
      const spec = tools.get(name);
      if (item.type === "custom_tool_call" && spec?.kind !== "custom") {
        return { ok: false, reason: "Custom tool call has no matching definition." };
      }
      if (!name) return { ok: false, reason: "Tool call has no compatible name." };
      if (spec === undefined) {
        tools.set(name, { responseName: item.name, kind: "function" });
      }
      const args =
        item.type === "custom_tool_call"
          ? JSON.stringify({ input: item.input })
          : typeof item.arguments === "string"
            ? item.arguments
            : undefined;
      if (args === undefined) return { ok: false, reason: "Tool call arguments are missing." };
      const call = { id: item.call_id, type: "function", function: { name, arguments: args } };
      const previous = messages.at(-1);
      if (previous?.role === "assistant" && Array.isArray(previous.tool_calls)) {
        previous.tool_calls.push(call);
      } else {
        messages.push({ role: "assistant", content: null, tool_calls: [call] });
      }
      continue;
    }
    if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      const output = toolOutputText(item.output);
      if (typeof item.call_id !== "string" || output === undefined) {
        return { ok: false, reason: "Tool output cannot be represented as chat text." };
      }
      messages.push({ role: "tool", tool_call_id: item.call_id, content: output });
      continue;
    }
    if (item.type !== undefined && item.type !== "message") {
      return { ok: false, reason: `Responses input '${item.type}' cannot be bridged.` };
    }
    if (!["system", "developer", "user", "assistant"].includes(String(item.role))) {
      return { ok: false, reason: "Responses message has an unsupported role." };
    }
    const content = contentToChat(item.content);
    if (content === undefined)
      return { ok: false, reason: "Responses message content cannot be bridged." };
    messages.push({ role: item.role === "developer" ? "system" : item.role, content });
  }

  const toolChoice = source.tool_choice;
  let chatToolChoice: unknown;
  if (typeof toolChoice === "string" && ["auto", "none", "required"].includes(toolChoice)) {
    chatToolChoice = toolChoice;
  } else if (
    record(toolChoice) &&
    (toolChoice.type === "function" || toolChoice.type === "custom") &&
    typeof toolChoice.name === "string"
  ) {
    const name = responseToChatName.get(toolChoice.name);
    if (name === undefined)
      return { ok: false, reason: "Selected Responses tool is not declared." };
    chatToolChoice = { type: "function", function: { name } };
  } else if (toolChoice !== undefined) {
    return { ok: false, reason: "Responses tool choice cannot be bridged." };
  }
  const stream = source.stream === true;
  return {
    ok: true,
    value: {
      model,
      stream,
      tools,
      createdAt,
      body: {
        model,
        messages,
        ...(chatTools.length > 0 ? { tools: chatTools } : {}),
        ...(chatTools.length > 0 && chatToolChoice !== undefined
          ? { tool_choice: chatToolChoice }
          : {}),
        ...(chatTools.length > 0 && typeof source.parallel_tool_calls === "boolean"
          ? { parallel_tool_calls: source.parallel_tool_calls }
          : {}),
        ...(typeof source.max_output_tokens === "number"
          ? { max_tokens: source.max_output_tokens }
          : {}),
        ...(typeof source.temperature === "number" ? { temperature: source.temperature } : {}),
        ...(typeof source.top_p === "number" ? { top_p: source.top_p } : {}),
        ...(record(source.reasoning) && typeof source.reasoning.effort === "string"
          ? { reasoning_effort: source.reasoning.effort }
          : {}),
        ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
      },
    },
  };
};

const usageOf = (value: unknown): JsonRecord => {
  const usage = record(value) ? value : {};
  const input = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
  const output = typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: typeof usage.total_tokens === "number" ? usage.total_tokens : input + output,
  };
};

const toolItem = (call: unknown, tools: ReadonlyMap<string, ToolSpec>): JsonRecord | undefined => {
  if (!record(call) || !record(call.function) || typeof call.function.name !== "string")
    return undefined;
  const callId = typeof call.id === "string" ? call.id : id("call");
  const args = typeof call.function.arguments === "string" ? call.function.arguments : "{}";
  const spec = tools.get(call.function.name);
  if (spec?.kind === "custom") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(args);
    } catch {
      return undefined;
    }
    if (!record(parsed) || typeof parsed.input !== "string") return undefined;
    return {
      id: id("ctc"),
      type: "custom_tool_call",
      call_id: callId,
      name: spec.responseName,
      input: parsed.input,
    };
  }
  try {
    JSON.parse(args);
  } catch {
    return undefined;
  }
  return {
    id: id("fc"),
    type: "function_call",
    call_id: callId,
    name: spec?.responseName ?? call.function.name,
    arguments: args,
  };
};

const responseBase = (
  model: string,
  responseId: string,
  status: string,
  output: readonly JsonRecord[],
  usage: unknown,
  createdAt: number,
): JsonRecord => ({
  id: responseId,
  object: "response",
  created_at: createdAt,
  status,
  model,
  output,
  usage: usageOf(usage),
  error: null,
  incomplete_details: null,
});

/** 非流式 Chat 响应转换；结构不完整或自定义工具输入损坏时拒绝伪造成功。 */
export const chatCompletionToResponses = (
  source: unknown,
  request: ResponsesChatRequest,
):
  | { readonly ok: true; readonly body: JsonRecord }
  | { readonly ok: false; readonly reason: string } => {
  if (!record(source) || !Array.isArray(source.choices) || !record(source.choices[0])) {
    return { ok: false, reason: "Chat completion has no choice." };
  }
  const choice = source.choices[0];
  if (!record(choice.message))
    return { ok: false, reason: "Chat completion has no assistant message." };
  const message = choice.message;
  const output: JsonRecord[] = [];
  if (typeof message.content === "string" && message.content.length > 0) {
    output.push({
      id: id("msg"),
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: message.content, annotations: [] }],
    });
  }
  for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    const item = toolItem(call, request.tools);
    if (item === undefined) return { ok: false, reason: "Chat tool call cannot be converted." };
    output.push(item);
  }
  if (output.length === 0 && choice.finish_reason !== "stop") {
    return { ok: false, reason: "Chat completion has no convertible output." };
  }
  const finishReason = choice.finish_reason;
  if (
    !["stop", "tool_calls", "function_call", "length", "content_filter"].includes(
      String(finishReason),
    )
  ) {
    return { ok: false, reason: "Chat completion has no recognized finish reason." };
  }
  const incompleteReason =
    finishReason === "length"
      ? "max_output_tokens"
      : finishReason === "content_filter"
        ? "content_filter"
        : null;
  return {
    ok: true,
    body: {
      ...responseBase(
        request.model,
        id("resp"),
        incompleteReason === null ? "completed" : "incomplete",
        output,
        source.usage,
        request.createdAt,
      ),
      ...(incompleteReason === null ? {} : { incomplete_details: { reason: incompleteReason } }),
    },
  };
};

/** 有些中转忽略 stream 参数并返回 JSON；仍生成完整 Responses 事件序列。 */
export const chatCompletionToResponsesSse = (body: JsonRecord): string => {
  const initial = { ...body, status: "in_progress", output: [] };
  let result = event("response.created", { response: initial });
  result += event("response.in_progress", { response: initial });
  const output = Array.isArray(body.output) ? body.output : [];
  for (const [outputIndex, item] of output.entries()) {
    if (!record(item)) continue;
    result += event("response.output_item.added", {
      output_index: outputIndex,
      item: { ...item, status: "in_progress" },
    });
    if (item.type === "message" && Array.isArray(item.content)) {
      const part = item.content[0];
      if (record(part) && typeof part.text === "string") {
        result += event("response.content_part.added", {
          item_id: item.id,
          output_index: outputIndex,
          content_index: 0,
          part: { ...part, text: "" },
        });
        result += event("response.output_text.delta", {
          item_id: item.id,
          output_index: outputIndex,
          content_index: 0,
          delta: part.text,
        });
        result += event("response.output_text.done", {
          item_id: item.id,
          output_index: outputIndex,
          content_index: 0,
          text: part.text,
        });
        result += event("response.content_part.done", {
          item_id: item.id,
          output_index: outputIndex,
          content_index: 0,
          part,
        });
      }
    } else if (item.type === "function_call" && typeof item.arguments === "string") {
      result += event("response.function_call_arguments.delta", {
        item_id: item.id,
        output_index: outputIndex,
        delta: item.arguments,
      });
      result += event("response.function_call_arguments.done", {
        item_id: item.id,
        output_index: outputIndex,
        arguments: item.arguments,
      });
    }
    result += event("response.output_item.done", { output_index: outputIndex, item });
  }
  return (
    result +
    event(body.status === "incomplete" ? "response.incomplete" : "response.completed", {
      response: body,
    })
  );
};

/** Chat SSE → Responses SSE；仅在收到正常结束标记后发送 completed。 */
export class ChatStreamToResponsesSse {
  readonly #request: ResponsesChatRequest;
  readonly #responseId = id("resp");
  #pending = "";
  #started = false;
  #finished = false;
  #done = false;
  #finishReason: string | null = null;
  #text = "";
  #messageId: string | null = null;
  #messageOutputIndex: number | null = null;
  #nextOutputIndex = 0;
  #output = new Map<number, JsonRecord>();
  #tools = new Map<
    number,
    { id: string; callId: string; name: string; args: string; outputIndex: number; opened: boolean }
  >();
  #usage: unknown;
  #failure: string | null = null;

  constructor(request: ResponsesChatRequest) {
    this.#request = request;
  }

  #start(): string {
    if (this.#started) return "";
    this.#started = true;
    const response = responseBase(
      this.#request.model,
      this.#responseId,
      "in_progress",
      [],
      undefined,
      this.#request.createdAt,
    );
    return event("response.created", { response }) + event("response.in_progress", { response });
  }

  #line(line: string): string {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return "";
    const payload = trimmed.slice(5).trim();
    if (payload === "[DONE]") {
      this.#done = true;
      return "";
    }
    let data: unknown;
    try {
      data = JSON.parse(payload);
    } catch {
      this.#failure = "Invalid Chat SSE JSON.";
      return "";
    }
    if (!record(data)) return "";
    if (data.error !== undefined) {
      this.#failure = "Chat upstream returned an error event.";
      return "";
    }
    if (data.usage !== undefined) this.#usage = data.usage;
    const choice =
      Array.isArray(data.choices) && record(data.choices[0]) ? data.choices[0] : undefined;
    if (!choice) return this.#start();
    const delta = record(choice.delta) ? choice.delta : {};
    let result = this.#start();
    if (typeof delta.content === "string" && delta.content.length > 0) {
      if (this.#messageId === null) {
        this.#messageId = id("msg");
        const outputIndex = this.#nextOutputIndex++;
        this.#messageOutputIndex = outputIndex;
        result += event("response.output_item.added", {
          output_index: outputIndex,
          item: {
            id: this.#messageId,
            type: "message",
            status: "in_progress",
            role: "assistant",
            content: [],
          },
        });
        result += event("response.content_part.added", {
          item_id: this.#messageId,
          output_index: outputIndex,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        });
      }
      this.#text += delta.content;
      result += event("response.output_text.delta", {
        item_id: this.#messageId,
        output_index: this.#messageOutputIndex,
        content_index: 0,
        delta: delta.content,
      });
    }
    for (const rawCall of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      if (!record(rawCall)) continue;
      const chatIndex = typeof rawCall.index === "number" ? rawCall.index : 0;
      let call = this.#tools.get(chatIndex);
      const fn = record(rawCall.function) ? rawCall.function : {};
      if (!call) {
        call = {
          id: id("fc"),
          callId: typeof rawCall.id === "string" ? rawCall.id : id("call"),
          name: "",
          args: "",
          outputIndex: this.#nextOutputIndex++,
          opened: false,
        };
        this.#tools.set(chatIndex, call);
      }
      if (typeof rawCall.id === "string") call.callId = rawCall.id;
      if (typeof fn.name === "string") call.name = fn.name;
      const fragment = typeof fn.arguments === "string" ? fn.arguments : "";
      if (!call.opened && call.name.length > 0) {
        call.opened = true;
        const spec = this.#request.tools.get(call.name);
        const custom = spec?.kind === "custom";
        const responseName = spec?.responseName ?? call.name;
        result += event("response.output_item.added", {
          output_index: call.outputIndex,
          item: custom
            ? {
                id: call.id,
                type: "custom_tool_call",
                status: "in_progress",
                call_id: call.callId,
                name: responseName,
                input: "",
              }
            : {
                id: call.id,
                type: "function_call",
                status: "in_progress",
                call_id: call.callId,
                name: responseName,
                arguments: "",
              },
        });
        if (!custom && call.args.length > 0) {
          result += event("response.function_call_arguments.delta", {
            item_id: call.id,
            output_index: call.outputIndex,
            delta: call.args,
          });
        }
      }
      if (fragment.length > 0) {
        call.args += fragment;
        if (call.opened && this.#request.tools.get(call.name)?.kind !== "custom") {
          result += event("response.function_call_arguments.delta", {
            item_id: call.id,
            output_index: call.outputIndex,
            delta: fragment,
          });
        }
      }
    }
    if (typeof choice.finish_reason === "string") this.#finishReason = choice.finish_reason;
    return result;
  }

  push(chunk: string): string {
    if (this.#finished) return "";
    this.#pending += chunk;
    let result = "";
    let end = this.#pending.indexOf("\n");
    while (end >= 0) {
      result += this.#line(this.#pending.slice(0, end));
      this.#pending = this.#pending.slice(end + 1);
      end = this.#pending.indexOf("\n");
    }
    return result;
  }

  complete(): string {
    if (this.#finished) return "";
    this.#finished = true;
    let result = this.#pending.trim() ? this.#line(this.#pending) : "";
    result += this.#start();
    const output = () =>
      [...this.#output.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
    if (!this.#done || this.#failure !== null || this.#finishReason === null) {
      const response = {
        ...responseBase(
          this.#request.model,
          this.#responseId,
          "failed",
          output(),
          this.#usage,
          this.#request.createdAt,
        ),
        error: {
          code: "upstream_error",
          message: this.#failure ?? "Chat stream ended before a successful finish.",
        },
      };
      return result + event("response.failed", { response });
    }
    if (this.#messageId !== null && this.#messageOutputIndex !== null) {
      const outputIndex = this.#messageOutputIndex;
      const part = { type: "output_text", text: this.#text, annotations: [] };
      result += event("response.output_text.done", {
        item_id: this.#messageId,
        output_index: outputIndex,
        content_index: 0,
        text: this.#text,
      });
      result += event("response.content_part.done", {
        item_id: this.#messageId,
        output_index: outputIndex,
        content_index: 0,
        part,
      });
      const item = {
        id: this.#messageId,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [part],
      };
      this.#output.set(outputIndex, item);
      result += event("response.output_item.done", { output_index: outputIndex, item });
    }
    for (const call of [...this.#tools.values()].sort((a, b) => a.outputIndex - b.outputIndex)) {
      const item = toolItem(
        { id: call.callId, function: { name: call.name, arguments: call.args } },
        this.#request.tools,
      );
      if (item === undefined || !call.opened) {
        const response = {
          ...responseBase(
            this.#request.model,
            this.#responseId,
            "failed",
            output(),
            this.#usage,
            this.#request.createdAt,
          ),
          error: { code: "invalid_tool_call", message: "Chat tool call cannot be converted." },
        };
        return result + event("response.failed", { response });
      }
      result +=
        item.type === "custom_tool_call"
          ? event("response.custom_tool_call_input.done", {
              item_id: call.id,
              output_index: call.outputIndex,
              input: item.input,
            })
          : event("response.function_call_arguments.done", {
              item_id: call.id,
              output_index: call.outputIndex,
              arguments: call.args,
            });
      this.#output.set(call.outputIndex, { ...item, id: call.id });
      result += event("response.output_item.done", {
        output_index: call.outputIndex,
        item: { ...item, id: call.id },
      });
    }
    const incompleteReason =
      this.#finishReason === "length"
        ? "max_output_tokens"
        : this.#finishReason === "content_filter"
          ? "content_filter"
          : null;
    if (
      incompleteReason === null &&
      !["stop", "tool_calls", "function_call"].includes(this.#finishReason)
    ) {
      const response = {
        ...responseBase(
          this.#request.model,
          this.#responseId,
          "failed",
          output(),
          this.#usage,
          this.#request.createdAt,
        ),
        error: {
          code: "upstream_error",
          message: "Chat stream has an unrecognized finish reason.",
        },
      };
      return result + event("response.failed", { response });
    }
    const response = {
      ...responseBase(
        this.#request.model,
        this.#responseId,
        incompleteReason === null ? "completed" : "incomplete",
        output(),
        this.#usage,
        this.#request.createdAt,
      ),
      ...(incompleteReason === null ? {} : { incomplete_details: { reason: incompleteReason } }),
    };
    return (
      result +
      event(incompleteReason === null ? "response.completed" : "response.incomplete", { response })
    );
  }
}

export const transformChatStreamToResponsesSse = <E>(
  source: Stream.Stream<Uint8Array, E>,
  request: ResponsesChatRequest,
): Stream.Stream<Uint8Array, E> => {
  const translator = new ChatStreamToResponsesSse(request);
  return Stream.concat(
    source.pipe(
      Stream.decodeText(),
      Stream.flatMap((chunk) => {
        const converted = translator.push(chunk);
        return converted.length > 0 ? Stream.make(converted) : Stream.empty;
      }),
    ),
    Stream.suspend(() => Stream.make(translator.complete())),
  ).pipe(Stream.encodeText);
};
