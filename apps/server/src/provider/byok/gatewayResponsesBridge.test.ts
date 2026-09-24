import { describe, expect, it } from "vite-plus/test";

import {
  ChatStreamToResponsesSse,
  chatCompletionToResponses,
  responsesToChatRequest,
} from "./gatewayResponsesBridge.ts";

const request = (body: unknown) => {
  const converted = responsesToChatRequest(body, "upstream-model", 1_700_000_000);
  if (!converted.ok) throw new Error(converted.reason);
  return converted.value;
};

const eventsOf = (sse: string): Array<Record<string, unknown>> =>
  sse.split("\n\n").flatMap((frame) => {
    const data = frame.split("\n").find((line) => line.startsWith("data: "));
    return data === undefined ? [] : [JSON.parse(data.slice(6)) as Record<string, unknown>];
  });

describe("Responses → Chat Completions", () => {
  it("保留消息、图片、函数调用 ID、工具结果与用量请求", () => {
    const translated = request({
      model: "gateway-alias",
      instructions: "Review the code.",
      stream: true,
      tools: [{ type: "function", name: "read_file", parameters: { type: "object" } }],
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "Inspect" },
            { type: "input_image", image_url: "data:image/png;base64,AA==" },
          ],
        },
        {
          type: "function_call",
          call_id: "call-1",
          name: "read_file",
          arguments: '{"path":"a.ts"}',
        },
        { type: "function_call_output", call_id: "call-1", output: "file contents" },
      ],
    });
    expect(translated.body).toMatchObject({
      model: "upstream-model",
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: "system", content: "Review the code." },
        {
          role: "user",
          content: [
            { type: "text", text: "Inspect" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } },
          ],
        },
        {
          role: "assistant",
          tool_calls: [
            { id: "call-1", function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
          ],
        },
        { role: "tool", tool_call_id: "call-1", content: "file contents" },
      ],
    });
  });

  it("将自定义工具输入封装为 Chat 函数参数", () => {
    const translated = request({
      tools: [{ type: "custom", name: "apply_patch" }],
      input: [
        {
          type: "custom_tool_call",
          call_id: "call-patch",
          name: "apply_patch",
          input: "*** patch",
        },
        { type: "custom_tool_call_output", call_id: "call-patch", output: "ok" },
      ],
    });
    expect(translated.body.messages).toMatchObject([
      {
        role: "assistant",
        tool_calls: [{ id: "call-patch", function: { arguments: '{"input":"*** patch"}' } }],
      },
      { role: "tool", tool_call_id: "call-patch", content: "ok" },
    ]);
  });

  it("并行函数调用合并为同一条 Chat 助手消息", () => {
    const translated = request({
      input: [
        { type: "function_call", call_id: "call-a", name: "read_a", arguments: "{}" },
        { type: "function_call", call_id: "call-b", name: "read_b", arguments: "{}" },
        { type: "function_call_output", call_id: "call-a", output: "A" },
        { type: "function_call_output", call_id: "call-b", output: "B" },
      ],
    });
    expect(translated.body.messages).toMatchObject([
      { role: "assistant", tool_calls: [{ id: "call-a" }, { id: "call-b" }] },
      { role: "tool", tool_call_id: "call-a" },
      { role: "tool", tool_call_id: "call-b" },
    ]);
  });

  it("不兼容 Chat 命名规则的函数名在请求与回复中保持对应", () => {
    const translated = request({
      tools: [{ type: "function", name: "repo.read/file", parameters: { type: "object" } }],
      input: [
        { type: "function_call", call_id: "call-2", name: "repo.read/file", arguments: "{}" },
      ],
      tool_choice: { type: "function", name: "repo.read/file" },
    });
    expect(translated.body).toMatchObject({
      tools: [{ function: { name: "repo_read_file" } }],
      tool_choice: { function: { name: "repo_read_file" } },
      messages: [{ tool_calls: [{ function: { name: "repo_read_file" } }] }],
    });
    const result = chatCompletionToResponses(
      {
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              tool_calls: [{ id: "call-3", function: { name: "repo_read_file", arguments: "{}" } }],
            },
          },
        ],
      },
      translated,
    );
    expect(result).toMatchObject({
      ok: true,
      body: { output: [{ type: "function_call", name: "repo.read/file" }] },
    });
    const stream = new ChatStreamToResponsesSse(translated);
    let output = stream.push(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-4","function":{"name":"repo_read_file","arguments":"{}"}}]}}]}\n\n',
    );
    output += stream.push(
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n',
    );
    output += stream.complete();
    const toolEvents = eventsOf(output).filter(
      (item) =>
        item.type === "response.output_item.added" || item.type === "response.output_item.done",
    );
    expect(toolEvents.map((item) => (item.item as { name: string }).name)).toEqual([
      "repo.read/file",
      "repo.read/file",
    ]);
  });

  it("遇到无法无损转换的会话状态或工具类型时明确拒绝", () => {
    expect(
      responsesToChatRequest({ previous_response_id: "resp-1", input: "hi" }, "m", 1),
    ).toMatchObject({ ok: false });
    expect(
      responsesToChatRequest({ input: "hi", text: { format: { type: "json_schema" } } }, "m", 1),
    ).toMatchObject({ ok: false });
    expect(
      responsesToChatRequest(
        { input: [{ type: "reasoning", encrypted_content: "opaque" }] },
        "m",
        1,
      ),
    ).toMatchObject({ ok: false });
    expect(
      responsesToChatRequest(
        { input: "hi", tools: [{ type: "web_search_preview", name: "search" }] },
        "m",
        1,
      ),
    ).toMatchObject({ ok: false });
    expect(
      responsesToChatRequest(
        { input: [{ role: "user", content: [{ type: "input_file", file_id: "file-1" }] }] },
        "m",
        1,
      ),
    ).toMatchObject({ ok: false });
  });
});

describe("Chat Completions → Responses", () => {
  const translatedRequest = request({
    input: "hi",
    tools: [{ type: "custom", name: "apply_patch" }],
  });

  it("非流式回复携带文本、工具调用与用量", () => {
    const result = chatCompletionToResponses(
      {
        id: "chat-1",
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: "I will edit.",
              tool_calls: [
                {
                  id: "call-1",
                  function: { name: "apply_patch", arguments: '{"input":"*** patch"}' },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
      },
      translatedRequest,
    );
    expect(result).toMatchObject({
      ok: true,
      body: {
        status: "completed",
        model: "upstream-model",
        usage: { input_tokens: 11, output_tokens: 7 },
        output: [
          { type: "message", content: [{ text: "I will edit." }] },
          { type: "custom_tool_call", call_id: "call-1", input: "*** patch" },
        ],
      },
    });
  });

  it("输出达到长度限制时保留 incomplete 终态", () => {
    const json = chatCompletionToResponses(
      { choices: [{ finish_reason: "length", message: { content: "partial" } }] },
      translatedRequest,
    );
    expect(json).toMatchObject({
      ok: true,
      body: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
    });
    const stream = new ChatStreamToResponsesSse(translatedRequest);
    let events = stream.push(
      'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"length"}]}\n\n',
    );
    events += stream.push("data: [DONE]\n\n") + stream.complete();
    expect(eventsOf(events).map((item) => item.type)).toContain("response.incomplete");
    expect(eventsOf(events).map((item) => item.type)).not.toContain("response.completed");
  });

  it("SSE 数据行跨传输块时仍只输出一次正文", () => {
    const stream = new ChatStreamToResponsesSse(translatedRequest);
    let output = stream.push('data: {"choices":[{"delta":{"content":"你');
    output += stream.push('好"},"finish_reason":"stop"}]}\n\n');
    output += stream.push("data: [DONE]\n\n") + stream.complete();
    const events = eventsOf(output);
    expect(events.filter((item) => item.type === "response.output_text.delta")).toMatchObject([
      { delta: "你好" },
    ]);
    expect(events.filter((item) => item.type === "response.completed")).toHaveLength(1);
  });

  it("流式文本与工具调用有独立 output_index，且未正常结束不伪造完成", () => {
    const bridge = new ChatStreamToResponsesSse(translatedRequest);
    let output = bridge.push('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n');
    output += bridge.push(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"apply_patch","arguments":"{\\\"input\\\":\\\"patch\\\"}"}}]}}]}\n\n',
    );
    output += bridge.push(
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":3,"completion_tokens":4}}\n\n',
    );
    output += bridge.push("data: [DONE]\n\n");
    output += bridge.complete();
    const events = eventsOf(output);
    expect(events.map((item) => item.type)).toContain("response.completed");
    const added = events.filter((item) => item.type === "response.output_item.added");
    expect(added.map((item) => item.output_index)).toEqual([0, 1]);
    const completed = events.find((item) => item.type === "response.completed");
    expect(completed?.response).toMatchObject({
      output: [
        { type: "message" },
        { type: "custom_tool_call", call_id: "call-1", input: "patch" },
      ],
      usage: { input_tokens: 3, output_tokens: 4 },
    });

    const broken = new ChatStreamToResponsesSse(translatedRequest);
    const premature =
      broken.push('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n') + broken.complete();
    expect(eventsOf(premature).map((item) => item.type)).toContain("response.failed");
    expect(eventsOf(premature).map((item) => item.type)).not.toContain("response.completed");
  });
});
