import { it as effectIt } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { HttpBody, HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as Stream from "effect/Stream";

import { makeByokModelDriver, makeOpenAiByokModelDriver } from "./OpenAiByokModelDriver.ts";

const decoder = new TextDecoder();
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const makeClient = (sseText: string | ReadonlyArray<string>) => {
  const captured: unknown[] = [];
  let requestIndex = 0;
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      if (request.body instanceof HttpBody.Uint8Array) {
        captured.push(decodeJson(decoder.decode(request.body.body)));
      }
      return HttpClientResponse.fromWeb(
        request,
        new Response(
          typeof sseText === "string" ? sseText : (sseText[requestIndex++] ?? sseText.at(-1)),
          { headers: { "content-type": "text/event-stream" } },
        ),
      );
    }),
  );
  return { client, captured };
};

describe("OpenAiByokModelDriver", () => {
  effectIt.effect("maps BYOK events and replays agent messages and tools", () =>
    Effect.gen(function* () {
      const { client, captured } = makeClient(
        [
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"workspace.read_file","arguments":"{\\"cwd\\":\\"C:/workspace\\"}"}}]},"finish_reason":"tool_calls"}]}',
          "",
          "data: [DONE]",
          "",
        ].join("\n"),
      );
      const driver = makeOpenAiByokModelDriver(client, {
        baseURL: "https://api.openai.com/v1",
        apiKey: "k",
        modelId: "gpt",
      });

      const events = yield* Stream.runCollect(
        driver.complete({
          turn: 2,
          messages: [
            { role: "user", content: "read README" },
            {
              role: "assistant",
              content: "",
              toolCalls: [
                {
                  toolCallId: "call-0",
                  canonicalToolName: "workspace.read_file",
                  arguments: { cwd: "C:/workspace", relativePath: "package.json" },
                },
              ],
            },
            {
              role: "tool",
              toolCallId: "call-0",
              canonicalToolName: "workspace.read_file",
              content: '{"status":"succeeded"}',
            },
          ],
          tools: [
            {
              canonicalToolName: "workspace.read_file",
              description: "Read a text file",
              parameters: { type: "object" },
            },
          ],
        }),
      );

      expect(Array.from(events)).toEqual([
        {
          type: "tool_call",
          toolCallId: "call-1",
          canonicalToolName: "workspace.read_file",
          arguments: { cwd: "C:/workspace" },
        },
        { type: "model_completed" },
      ]);
      expect(captured[0]).toMatchObject({
        model: "gpt",
        tools: [
          {
            type: "function",
            function: { name: "workspace_read_file", description: "Read a text file" },
          },
        ],
        messages: [
          { role: "user", content: "read README" },
          {
            role: "assistant",
            tool_calls: [
              {
                id: "call-0",
                function: {
                  name: "workspace_read_file",
                  arguments: '{"cwd":"C:/workspace","relativePath":"package.json"}',
                },
              },
            ],
          },
          { role: "tool", tool_call_id: "call-0", content: '{"status":"succeeded"}' },
        ],
      });
    }),
  );

  effectIt.effect("preserves retry metadata on BYOK provider failures", () =>
    Effect.gen(function* () {
      const client = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response("no", { status: 503, headers: { "retry-after": "2" } }),
          ),
        ),
      );
      const driver = makeOpenAiByokModelDriver(client, {
        baseURL: "https://api.openai.com/v1",
        apiKey: "k",
        modelId: "gpt",
      });

      const error = yield* Effect.flip(
        Stream.runCollect(driver.complete({ messages: [], tools: [], turn: 1 })),
      );
      expect(error).toMatchObject({
        code: "byok_engine_error",
        reason: "unavailable",
        retryable: true,
        retryAfterMs: 2_000,
      });
    }),
  );

  effectIt.effect("maps provider context overflow to a dedicated agent model error", () =>
    Effect.gen(function* () {
      const client = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(
              encodeJson({
                error: {
                  code: "context_length_exceeded",
                  message: "This model's maximum context length was exceeded.",
                },
              }),
              { status: 400, headers: { "content-type": "application/json" } },
            ),
          ),
        ),
      );
      const driver = makeOpenAiByokModelDriver(client, {
        baseURL: "https://api.openai.com/v1",
        apiKey: "k",
        modelId: "gpt",
      });

      const error = yield* Effect.flip(
        Stream.runCollect(driver.complete({ messages: [], tools: [], turn: 1 })),
      );
      expect(error).toMatchObject({ code: "context_overflow" });
    }),
  );

  effectIt.effect("maps AbortSignal interruption to a non-retryable canceled error", () =>
    Effect.gen(function* () {
      const controller = new AbortController();
      const started = yield* Deferred.make<void>();
      let calls = 0;
      const client = HttpClient.make(() =>
        Effect.sync(() => {
          calls += 1;
        }).pipe(Effect.andThen(Deferred.succeed(started, undefined)), Effect.andThen(Effect.never)),
      );
      const driver = makeOpenAiByokModelDriver(client, {
        baseURL: "https://api.openai.com/v1",
        apiKey: "k",
        modelId: "gpt",
        signal: controller.signal,
      });
      const fiber = yield* Stream.runCollect(
        driver.complete({ messages: [], tools: [], turn: 1 }),
      ).pipe(Effect.forkChild);

      yield* Deferred.await(started);
      controller.abort();

      const error = yield* Effect.flip(Fiber.join(fiber));
      expect(error).toMatchObject({
        code: "byok_engine_error",
        reason: "canceled",
        retryable: false,
      });
      expect(calls).toBe(1);
    }),
  );

  effectIt.effect(
    "does not synthesize completion when the provider stream has no terminal event",
    () =>
      Effect.gen(function* () {
        const { client } = makeClient('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
        const driver = makeOpenAiByokModelDriver(client, {
          baseURL: "https://api.openai.com/v1",
          apiKey: "k",
          modelId: "gpt",
        });

        const error = yield* Effect.flip(
          Stream.runCollect(driver.complete({ messages: [], tools: [], turn: 1 })),
        );
        expect(error).toMatchObject({
          code: "byok_engine_error",
          reason: "terminal_event_missing",
          retryable: false,
        });
      }),
  );

  effectIt.effect("preserves output truncation as a non-retryable model error", () =>
    Effect.gen(function* () {
      const { client, captured } = makeClient(
        [
          'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"length"}]}',
          "",
          "data: [DONE]",
          "",
        ].join("\n"),
      );
      const driver = makeOpenAiByokModelDriver(client, {
        baseURL: "https://api.openai.com/v1",
        apiKey: "k",
        modelId: "gpt",
      });

      const error = yield* Effect.flip(
        Stream.runCollect(driver.complete({ messages: [], tools: [], turn: 1 })),
      );
      expect(error).toMatchObject({
        code: "byok_engine_error",
        reason: "output_truncated",
        retryable: false,
      });
      expect(captured).toHaveLength(1);
    }),
  );

  effectIt.effect("无可见输出的截断只恢复一次并保留成功请求的最终用量", () =>
    Effect.gen(function* () {
      const { client, captured } = makeClient([
        'data: {"choices":[{"delta":{"reasoning_content":"思考中"},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n',
        [
          'data: {"choices":[{"delta":{"content":"完成"},"finish_reason":"stop"}]}',
          "",
          'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120,"completion_tokens_details":{"reasoning_tokens":10}}}',
          "",
          "data: [DONE]",
          "",
        ].join("\n"),
      ]);
      const driver = makeOpenAiByokModelDriver(client, {
        baseURL: "https://api.openai.com/v1",
        apiKey: "k",
        modelId: "gpt",
      });

      const events = yield* Stream.runCollect(
        driver.complete({ messages: [{ role: "user", content: "修复问题" }], tools: [], turn: 1 }),
      );

      expect(Array.from(events)).toEqual([
        { type: "text_delta", text: "完成" },
        {
          type: "model_completed",
          inputTokens: 100,
          outputTokens: 20,
          reasoningTokens: 10,
          totalTokens: 120,
        },
      ]);
      expect(captured).toHaveLength(2);
      expect(captured[0]).not.toHaveProperty("max_tokens");
      expect(captured[1]).toMatchObject({
        max_tokens: 16_384,
        messages: [{ role: "user", content: "修复问题" }],
        stream_options: { include_usage: true },
      });
    }),
  );

  effectIt.effect("第二次无输出截断立即失败且不伪造完成事件", () =>
    Effect.gen(function* () {
      const { client, captured } = makeClient(
        'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n',
      );
      const driver = makeOpenAiByokModelDriver(client, {
        baseURL: "https://api.openai.com/v1",
        apiKey: "k",
        modelId: "gpt",
      });
      const emitted: unknown[] = [];

      const error = yield* Effect.flip(
        driver.complete({ messages: [], tools: [], turn: 1 }).pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              emitted.push(event);
            }),
          ),
        ),
      );

      expect(error).toMatchObject({ reason: "output_truncated", retryable: false });
      expect(captured).toHaveLength(2);
      expect(emitted).toEqual([]);
    }),
  );

  effectIt.effect("恢复输出预算不超过已知上下文窗口的一半", () =>
    Effect.gen(function* () {
      const { client, captured } = makeClient([
        'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n',
        'data: {"choices":[{"delta":{"content":"完成"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      ]);
      const driver = makeOpenAiByokModelDriver(client, {
        baseURL: "https://api.openai.com/v1",
        apiKey: "k",
        modelId: "gpt",
        contextWindowTokens: 8_192,
      });

      yield* Stream.runCollect(driver.complete({ messages: [], tools: [], turn: 1 }));

      expect(captured).toHaveLength(2);
      expect(captured[1]).toMatchObject({ max_tokens: 4_096 });
    }),
  );

  effectIt.effect("供应商拒绝恢复输出参数时保留请求错误且不继续重试", () =>
    Effect.gen(function* () {
      let calls = 0;
      const client = HttpClient.make((request) =>
        Effect.sync(() =>
          HttpClientResponse.fromWeb(
            request,
            ++calls === 1
              ? new Response(
                  'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n',
                  { headers: { "content-type": "text/event-stream" } },
                )
              : new Response('{"error":{"message":"max_tokens exceeds output limit"}}', {
                  status: 400,
                  headers: { "content-type": "application/json" },
                }),
          ),
        ),
      );
      const driver = makeOpenAiByokModelDriver(client, {
        baseURL: "https://api.openai.com/v1",
        apiKey: "k",
        modelId: "gpt",
      });

      const error = yield* Effect.flip(
        Stream.runCollect(driver.complete({ messages: [], tools: [], turn: 1 })),
      );

      expect(error).toMatchObject({ reason: "invalid_request", retryable: false });
      expect(error.detail).toContain("exceeds output limit");
      expect(calls).toBe(2);
    }),
  );
});

describe("ByokModelDriver", () => {
  effectIt.effect("已经发出工具调用的流截断后不重放请求", () =>
    Effect.gen(function* () {
      const { client, captured } = makeClient(
        [
          'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"workspace.write_file","args":{"text":"内容"}}}]}}]}',
          "",
          'data: {"candidates":[{"content":{"parts":[]},"finishReason":"MAX_TOKENS"}]}',
          "",
        ].join("\n"),
      );
      const driver = makeByokModelDriver(client, {
        protocol: "gemini",
        baseURL: "https://generativelanguage.googleapis.com",
        apiKey: "k",
        modelId: "gemini-2.5-pro",
      });
      const emitted: unknown[] = [];

      const error = yield* Effect.flip(
        driver.complete({ messages: [], tools: [], turn: 1 }).pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              emitted.push(event);
            }),
          ),
        ),
      );

      expect(error).toMatchObject({ reason: "output_truncated", retryable: false });
      expect(captured).toHaveLength(1);
      expect(emitted).toEqual([
        {
          type: "tool_call",
          toolCallId: "gemini-tool-workspace.write_file",
          canonicalToolName: "workspace.write_file",
          arguments: { text: "内容" },
        },
      ]);
    }),
  );

  effectIt.effect("maps Anthropic tool calls and sends canonical tool results", () =>
    Effect.gen(function* () {
      const { client, captured } = makeClient(
        [
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call-anthropic","name":"workspace.read_file"}}',
          "",
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"cwd\\":\\"C:/workspace\\"}"}}',
          "",
          'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}',
          "",
          'data: {"type":"message_stop"}',
          "",
        ].join("\n"),
      );
      const driver = makeByokModelDriver(client, {
        protocol: "anthropic",
        baseURL: "https://api.anthropic.com",
        apiKey: "k",
        modelId: "claude",
      });

      const events = yield* Stream.runCollect(
        driver.complete({
          turn: 2,
          messages: [
            { role: "user", content: "read README" },
            {
              role: "assistant",
              content: "",
              toolCalls: [
                {
                  toolCallId: "call-0",
                  canonicalToolName: "workspace.read_file",
                  arguments: { cwd: "C:/workspace" },
                },
              ],
            },
            {
              role: "tool",
              toolCallId: "call-0",
              canonicalToolName: "workspace.read_file",
              content: '{"status":"succeeded"}',
            },
          ],
          tools: [],
        }),
      );

      expect(Array.from(events)).toEqual([
        {
          type: "tool_call",
          toolCallId: "call-anthropic",
          canonicalToolName: "workspace.read_file",
          arguments: { cwd: "C:/workspace" },
        },
        { type: "model_completed" },
      ]);
      expect(captured[0]).toMatchObject({
        messages: [
          { role: "user", content: "read README" },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "call-0",
                name: "workspace.read_file",
                input: { cwd: "C:/workspace" },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "call-0",
                content: '{"status":"succeeded"}',
              },
            ],
          },
        ],
      });
    }),
  );

  effectIt.effect("maps Gemini function calls and replays tool messages", () =>
    Effect.gen(function* () {
      const { client, captured } = makeClient(
        [
          'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"workspace.read_file","args":{"cwd":"C:/workspace"}}}]},"finishReason":"STOP"}]}',
          "",
        ].join("\n"),
      );
      const driver = makeByokModelDriver(client, {
        protocol: "gemini",
        baseURL: "https://generativelanguage.googleapis.com",
        apiKey: "k",
        modelId: "gemini-2.5-pro",
      });

      const events = yield* Stream.runCollect(
        driver.complete({
          turn: 1,
          messages: [
            { role: "user", content: "read README" },
            {
              role: "tool",
              toolCallId: "gemini-tool-workspace.read_file",
              canonicalToolName: "workspace.read_file",
              content: '{"status":"succeeded"}',
            },
          ],
          tools: [
            {
              canonicalToolName: "workspace.read_file",
              description: "Read a text file",
              parameters: { type: "object" },
            },
          ],
        }),
      );

      expect(Array.from(events)).toEqual([
        {
          type: "tool_call",
          toolCallId: "gemini-tool-workspace.read_file",
          canonicalToolName: "workspace.read_file",
          arguments: { cwd: "C:/workspace" },
        },
        { type: "model_completed" },
      ]);
      expect(captured[0]).toMatchObject({
        tools: [
          {
            functionDeclarations: [
              { name: "workspace.read_file", description: "Read a text file" },
            ],
          },
        ],
        contents: [
          { role: "user" },
          {
            role: "user",
            parts: [
              {
                functionResponse: {
                  name: "workspace.read_file",
                  response: { result: '{"status":"succeeded"}' },
                },
              },
            ],
          },
        ],
      });
    }),
  );
});
