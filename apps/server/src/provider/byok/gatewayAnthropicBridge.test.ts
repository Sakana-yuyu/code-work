import { describe, expect, it } from "@effect/vitest";

import {
  ChatStreamToAnthropicSse,
  anthropicMessagesToChatBody,
  chatCompletionToAnthropicMessage,
  chatErrorToAnthropicType,
  estimateAnthropicPromptTokens,
} from "./gatewayAnthropicBridge.ts";

describe("anthropicMessagesToChatBody", () => {
  it("translates system, text, tools and generation options", () => {
    const body = anthropicMessagesToChatBody(
      {
        model: "claude-x",
        system: [{ type: "text", text: "You are Code Work." }],
        max_tokens: 256,
        temperature: 0.4,
        top_p: 0.9,
        stop_sequences: ["\nuser:", "STOP"],
        tools: [
          {
            name: "shell.exec",
            description: "Run a command",
            input_schema: { type: "object", properties: { cmd: { type: "string" } } },
          },
        ],
        tool_choice: { type: "tool", name: "shell.exec" },
        messages: [
          { role: "user", content: "list the files" },
          { role: "assistant", content: "Sure." },
        ],
        stream: true,
      },
      "deepseek-chat",
    );
    expect(body).toEqual({
      model: "deepseek-chat",
      messages: [
        { role: "system", content: "You are Code Work." },
        { role: "user", content: "list the files" },
        { role: "assistant", content: "Sure." },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "shell_exec",
            description: "Run a command",
            parameters: { type: "object", properties: { cmd: { type: "string" } } },
          },
        },
      ],
      tool_choice: { type: "function", function: { name: "shell_exec" } },
      max_tokens: 256,
      temperature: 0.4,
      top_p: 0.9,
      stop: ["\nuser:", "STOP"],
      stream: true,
    });
  });

  it("maps tool_use and tool_result turns so chat round-trips keep call order", () => {
    const body = anthropicMessagesToChatBody(
      {
        model: "claude-x",
        max_tokens: 64,
        messages: [
          { role: "user", content: "run it" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "Running." },
              { type: "tool_use", id: "toolu_1", name: "shell.exec", input: { cmd: "ls" } },
            ],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "toolu_1", content: "a.txt\nb.txt" },
              { type: "tool_result", tool_use_id: "gone", content: "missing", is_error: true },
              { type: "text", text: "and then?" },
            ],
          },
        ],
      },
      "upstream-model",
    );
    expect(body).toMatchObject({
      messages: [
        { role: "user", content: "run it" },
        {
          role: "assistant",
          content: "Running.",
          tool_calls: [
            {
              id: "toolu_1",
              type: "function",
              function: { name: "shell_exec", arguments: '{"cmd":"ls"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "toolu_1", content: "a.txt\nb.txt" },
        { role: "tool", tool_call_id: "gone", content: "Error: missing" },
        { role: "user", content: "and then?" },
      ],
    });
  });

  it("drops thinking blocks and summarizes image blocks", () => {
    const body = anthropicMessagesToChatBody(
      {
        model: "claude-x",
        messages: [
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "hmm", signature: "sig" },
              { type: "text", text: "answer" },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: "aGk=" },
              },
            ],
          },
        ],
      },
      "m",
    );
    expect(body).toMatchObject({
      messages: [
        { role: "assistant", content: "answer" },
        { role: "user", content: [{ type: "text", text: "[image: image/png]" }] },
      ],
    });
  });

  it("maps tool_choice auto/any/none", () => {
    const translate = (tool_choice: unknown): unknown =>
      anthropicMessagesToChatBody({ tool_choice }, "m").tool_choice;
    expect(translate({ type: "auto" })).toBe("auto");
    expect(translate({ type: "any" })).toBe("required");
    expect(translate({ type: "none" })).toBe("none");
    expect(translate(undefined)).toBeUndefined();
  });
});

describe("ChatStreamToAnthropicSse", () => {
  const parseEvents = (text: string): { event: string; data: Record<string, unknown> }[] => {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    for (const block of text.split("\n\n").filter((entry) => entry.trim().length > 0)) {
      const lines = block.split("\n");
      const event = lines.find((line) => line.startsWith("event: "))?.slice(7) ?? "";
      const dataLine = lines.find((line) => line.startsWith("data: "))?.slice(6) ?? "{}";
      events.push({ event, data: JSON.parse(dataLine) as Record<string, unknown> });
    }
    return events;
  };

  it("translates text, tool calls, finish reason and usage", () => {
    const translator = new ChatStreamToAnthropicSse("upstream-model");
    let out = "";
    // First push ends mid-JSON-line to exercise the partial-line buffer.
    out += translator.push('data: {"choices":[{"delta":{"role":"assistant","content":"Hel');
    out += translator.push('lo"}}],"usage":{"prompt_tokens":12}}\n');
    out += translator.push(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"shell_exec","arguments":"{\\"cmd\\""}}]}}]}\n',
    );
    out += translator.push(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"ls\\"}"}}]}}]}\n',
    );
    out += translator.push(
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":12,"completion_tokens":7}}\n',
    );
    out += translator.push("data: [DONE]\n");
    out += translator.complete();

    const events = parseEvents(out);
    const names = events.map((entry) => entry.event);

    expect(names[0]).toBe("message_start");
    expect(names).toContain("content_block_start");
    expect(names).toContain("content_block_delta");

    expect(names.at(-1)).toBe("message_stop");

    const messageStart = events.find((entry) => entry.event === "message_start");
    expect((messageStart?.data.message as Record<string, unknown>).model).toBe("upstream-model");
    // Usage arrived in the same line as the first content chunk, so the
    // message_start already carries the real input token count.
    expect((messageStart?.data.message as Record<string, unknown>).usage).toEqual({
      input_tokens: 12,
      output_tokens: 0,
    });

    const toolStart = events.find(
      (entry) =>
        entry.event === "content_block_start" &&
        (entry.data.content_block as Record<string, unknown>).type === "tool_use",
    );
    expect(toolStart?.data.content_block).toMatchObject({ id: "call_1", name: "shell_exec" });

    const jsonDelta = events
      .filter((entry) => entry.event === "content_block_delta")
      .map((entry) => entry.data.delta as Record<string, unknown>)
      .filter((delta) => delta.type === "input_json_delta")
      .map((delta) => delta.partial_json)
      .join("");
    expect(JSON.parse(jsonDelta)).toEqual({ cmd: "ls" });

    const messageDelta = events.find((entry) => entry.event === "message_delta");
    expect(messageDelta?.data.delta).toEqual({ stop_reason: "tool_use", stop_sequence: null });
    expect(messageDelta?.data.usage).toEqual({ output_tokens: 7 });

    const text = events
      .filter((entry) => entry.event === "content_block_delta")
      .map((entry) => entry.data.delta as Record<string, unknown>)
      .filter((delta) => delta.type === "text_delta")
      .map((delta) => delta.text)
      .join("");
    expect(text).toBe("Hello");
  });

  it("drops reasoning deltas and closes open blocks exactly once", () => {
    const translator = new ChatStreamToAnthropicSse("m");
    let out = "";
    out += translator.push('data: {"choices":[{"delta":{"reasoning_content":"secret"}}]}\n');
    out += translator.push('data: {"choices":[{"delta":{"content":"ok"}}]}\n');
    out += translator.push('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n');
    out += translator.complete();
    expect(out).not.toContain("secret");
    expect(out.match(/event: message_stop/gu)?.length).toBe(1);
    expect(out.match(/event: content_block_stop/gu)?.length).toBe(1);
  });
});

describe("chatCompletionToAnthropicMessage", () => {
  it("builds text + tool_use content with usage and stop reason", () => {
    const message = chatCompletionToAnthropicMessage(
      {
        id: "chatcmpl-1",
        choices: [
          {
            message: {
              content: "done",
              tool_calls: [
                {
                  id: "call_9",
                  type: "function",
                  function: { name: "shell_exec", arguments: '{"cmd":"ls"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 21, completion_tokens: 5 },
      },
      "upstream-model",
    );
    expect(message).toMatchObject({
      id: "chatcmpl-1",
      type: "message",
      role: "assistant",
      model: "upstream-model",
      stop_reason: "tool_use",
      usage: { input_tokens: 21, output_tokens: 5 },
      content: [
        { type: "text", text: "done" },
        { type: "tool_use", id: "call_9", name: "shell_exec", input: { cmd: "ls" } },
      ],
    });
  });

  it("keeps invalid tool arguments as empty input instead of throwing", () => {
    const message = chatCompletionToAnthropicMessage(
      {
        choices: [
          { message: { tool_calls: [{ id: "c", function: { name: "t", arguments: "nope" } }] } },
        ],
      },
      "m",
    );
    expect((message.content as unknown[])[0]).toMatchObject({ type: "tool_use", input: {} });
  });
});

describe("estimateAnthropicPromptTokens", () => {
  it("estimates from system, text and tool inputs", () => {
    const toolInput = { cmd: "y".repeat(8) };
    const tokens = estimateAnthropicPromptTokens({
      system: "abcd".repeat(4),
      messages: [
        { role: "user", content: "x".repeat(16) },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t", name: "n", input: toolInput }],
        },
      ],
    });
    expect(tokens).toBe(Math.ceil((16 + 16 + JSON.stringify(toolInput).length) / 4));
    expect(estimateAnthropicPromptTokens({})).toBe(1);
  });
});

describe("chatErrorToAnthropicType", () => {
  it("maps common upstream statuses", () => {
    expect(chatErrorToAnthropicType(400)).toBe("invalid_request_error");
    expect(chatErrorToAnthropicType(401)).toBe("authentication_error");
    expect(chatErrorToAnthropicType(403)).toBe("permission_error");
    expect(chatErrorToAnthropicType(404)).toBe("not_found_error");
    expect(chatErrorToAnthropicType(429)).toBe("rate_limit_error");
    expect(chatErrorToAnthropicType(503)).toBe("api_error");
  });
});
