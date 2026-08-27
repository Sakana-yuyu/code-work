import { it as effectIt } from "@effect/vitest";
import { describe, expect, it } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { HttpBody, HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as Stream from "effect/Stream";

import {
  ByokEngineError,
  collectChatText,
  streamChat,
  type ByokChatEvent,
  type ByokToolDescriptor,
  type ByokStreamChatInput,
} from "./byokChatClient.ts";

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

const textDecoder = new TextDecoder();
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const decodeRequestBody = (body: HttpBody.HttpBody): unknown => {
  if (body instanceof HttpBody.Uint8Array) {
    try {
      return JSON.parse(textDecoder.decode(body.body));
    } catch {
      return undefined;
    }
  }
  return undefined;
};

const makeClient = (
  sseText: string,
  status = 200,
  contentType = "text/event-stream",
  headers: Readonly<Record<string, string>> = {},
): { client: HttpClient.HttpClient; captured: CapturedRequest[] } => {
  const captured: CapturedRequest[] = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      captured.push({
        url: request.url,
        headers: { ...(request.headers as Record<string, string>) },
        body: decodeRequestBody(request.body),
      });
      return HttpClientResponse.fromWeb(
        request,
        new Response(sseText, {
          status,
          headers: { "content-type": contentType, ...headers },
        }),
      );
    }),
  );
  return { client, captured };
};

const baseErrorInput: ByokStreamChatInput = {
  protocol: "openai",
  baseURL: "https://api.openai.com/v1",
  apiKey: "k",
  modelId: "gpt",
  messages: [{ role: "user", content: "hi" }],
};

const runError = (client: HttpClient.HttpClient, input: ByokStreamChatInput) =>
  Stream.runCollect(streamChat(client, input));

const runEvents = async (client: HttpClient.HttpClient, input: ByokStreamChatInput) => {
  const events: ByokChatEvent[] = [];
  await Effect.runPromise(
    Stream.runForEach(streamChat(client, input), (event) =>
      Effect.sync(() => {
        events.push(event);
      }),
    ),
  );
  return events;
};

const GEMINI_SSE = [
  'data: {"candidates":[{"content":{"parts":[{"text":"thinking hard","thought":true}]}}]}',
  "",
  'data: {"candidates":[{"content":{"parts":[{"text":"Hello"},{"text":" world"}]}}]}',
  "",
  'data: {"candidates":[{"finishReason":"STOP"}]}',
  "",
].join("\n");

describe("byokChatClient gemini protocol", () => {
  it("streams text and thought parts with the native request shape", async () => {
    const { client, captured } = makeClient(GEMINI_SSE);

    const events = await runEvents(client, {
      protocol: "gemini",
      baseURL: "https://generativelanguage.googleapis.com",
      apiKey: "gemini-secret",
      modelId: "gemini-2.5-pro",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "again" },
      ],
      systemPrompt: "Be terse.",
    });

    expect(events).toEqual([
      { type: "reasoning", text: "thinking hard" },
      { type: "text", text: "Hello" },
      { type: "text", text: " world" },
    ]);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse",
    );
    expect(captured[0]?.headers["x-goog-api-key"]).toBe("gemini-secret");
    expect(captured[0]?.body).toEqual({
      contents: [
        { role: "user", parts: [{ text: "hi" }] },
        { role: "model", parts: [{ text: "hello" }] },
        { role: "user", parts: [{ text: "again" }] },
      ],
      systemInstruction: { parts: [{ text: "Be terse." }] },
    });
  });

  it("keeps an explicit version segment in the base URL", async () => {
    const { client, captured } = makeClient(GEMINI_SSE);
    await runEvents(client, {
      protocol: "gemini",
      baseURL: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "k",
      modelId: "m",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(captured[0]?.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/m:streamGenerateContent?alt=sse",
    );
  });

  it("collects text while discarding reasoning", async () => {
    const { client } = makeClient(GEMINI_SSE);
    const text = await Effect.runPromise(
      collectChatText(
        streamChat(client, {
          protocol: "gemini",
          baseURL: "https://generativelanguage.googleapis.com",
          apiKey: "k",
          modelId: "m",
          messages: [{ role: "user", content: "hi" }],
        }),
      ),
    );
    expect(text).toBe("Hello world");
  });
});

describe("byokChatClient provider errors", () => {
  effectIt.effect("normalizes OpenAI rate limits and clamps Retry-After", () =>
    Effect.gen(function* () {
      const { client } = makeClient(
        encodeUnknownJson({
          error: { type: "rate_limit_error", message: "Too many requests." },
        }),
        429,
        "application/json",
        { "retry-after": "45" },
      );

      const error = yield* Effect.flip(runError(client, baseErrorInput));
      expect(error).toMatchObject({
        reason: "rate_limit",
        status: 429,
        retryable: true,
        retryAfterMs: 30_000,
      });
    }),
  );

  for (const status of [503, 529]) {
    effectIt.effect(`normalizes Anthropic ${status} overloads as retryable`, () =>
      Effect.gen(function* () {
        const { client } = makeClient(
          encodeUnknownJson({
            type: "error",
            error: { type: "overloaded_error", message: "Capacity is temporarily exhausted." },
          }),
          status,
          "application/json",
        );

        const error = yield* Effect.flip(
          runError(client, {
            ...baseErrorInput,
            protocol: "anthropic",
            baseURL: "https://api.anthropic.com",
            modelId: "claude",
          }),
        );
        expect(error).toMatchObject({ reason: "unavailable", status, retryable: true });
      }),
    );
  }

  effectIt.effect("normalizes Gemini unavailable responses as retryable", () =>
    Effect.gen(function* () {
      const { client } = makeClient(
        encodeUnknownJson({
          error: { code: 503, status: "UNAVAILABLE", message: "Service temporarily unavailable." },
        }),
        503,
        "application/json",
      );

      const error = yield* Effect.flip(
        runError(client, {
          ...baseErrorInput,
          protocol: "gemini",
          baseURL: "https://generativelanguage.googleapis.com",
          modelId: "gemini-2.5-pro",
        }),
      );
      expect(error).toMatchObject({ reason: "unavailable", status: 503, retryable: true });
    }),
  );

  effectIt.effect("normalizes HTTP and SSE request timeouts as retryable", () =>
    Effect.gen(function* () {
      const { client: httpClient } = makeClient("request timeout", 408, "text/plain");
      const httpError = yield* Effect.flip(runError(httpClient, baseErrorInput));
      expect(httpError).toMatchObject({ reason: "timeout", status: 408, retryable: true });

      const { client: sseClient } = makeClient(
        ['data: {"error":{"type":"request_timeout","message":"stream timed out"}}', ""].join("\n"),
      );
      const sseError = yield* Effect.flip(runError(sseClient, baseErrorInput));
      expect(sseError).toMatchObject({ reason: "timeout", retryable: true });
    }),
  );

  effectIt.effect("normalizes OpenAI context_length_exceeded responses", () =>
    Effect.gen(function* () {
      const { client } = makeClient(
        encodeUnknownJson({
          error: {
            message: "This model's maximum context length is 128000 tokens.",
            type: "invalid_request_error",
            code: "context_length_exceeded",
          },
        }),
        400,
        "application/json",
      );

      const error = yield* Effect.flip(runError(client, baseErrorInput));
      expect(error).toMatchObject({
        _tag: "ByokEngineError",
        reason: "context_overflow",
        status: 400,
        retryable: false,
        detail: expect.stringContaining("context_length_exceeded"),
      });
    }),
  );

  effectIt.effect("normalizes Anthropic prompt-too-long responses", () =>
    Effect.gen(function* () {
      const { client } = makeClient(
        encodeUnknownJson({
          type: "error",
          error: { type: "invalid_request_error", message: "prompt is too long: 210000 tokens" },
        }),
        400,
        "application/json",
      );

      const error = yield* Effect.flip(
        runError(client, {
          ...baseErrorInput,
          protocol: "anthropic",
          baseURL: "https://api.anthropic.com",
          modelId: "claude",
        }),
      );
      expect(error).toMatchObject({ reason: "context_overflow", status: 400 });
    }),
  );

  effectIt.effect("normalizes Gemini maximum-input-token responses", () =>
    Effect.gen(function* () {
      const { client } = makeClient(
        encodeUnknownJson({
          error: {
            code: 400,
            status: "INVALID_ARGUMENT",
            message: "The input token count exceeds the maximum number of tokens allowed.",
          },
        }),
        400,
        "application/json",
      );

      const error = yield* Effect.flip(
        runError(client, {
          ...baseErrorInput,
          protocol: "gemini",
          baseURL: "https://generativelanguage.googleapis.com",
          modelId: "gemini-2.5-pro",
        }),
      );
      expect(error).toMatchObject({ reason: "context_overflow", status: 400 });
    }),
  );

  effectIt.effect(
    "normalizes a context overflow error carried inside a successful SSE response",
    () =>
      Effect.gen(function* () {
        const { client } = makeClient(
          [
            'data: {"error":{"code":"context_too_large","message":"Your input exceeds the context window."}}',
            "",
          ].join("\n"),
        );

        const error = yield* Effect.flip(runError(client, baseErrorInput));
        expect(error).toMatchObject({
          reason: "context_overflow",
          detail: expect.stringContaining("context_too_large"),
        });
      }),
  );

  effectIt.effect("normalizes an overloaded error carried inside a successful SSE response", () =>
    Effect.gen(function* () {
      const { client } = makeClient(
        [
          'data: {"type":"error","error":{"type":"overloaded_error","message":"capacity"}}',
          "",
        ].join("\n"),
      );

      const error = yield* Effect.flip(
        runError(client, {
          ...baseErrorInput,
          protocol: "anthropic",
          baseURL: "https://api.anthropic.com",
          modelId: "claude",
        }),
      );
      expect(error).toMatchObject({ reason: "unavailable", retryable: true });
    }),
  );

  for (const [status, reason] of [
    [400, "invalid_request"],
    [404, "invalid_request"],
    [422, "invalid_request"],
    [401, "authentication_error"],
    [403, "authentication_error"],
  ] as const) {
    effectIt.effect(`normalizes non-retryable HTTP ${status} responses`, () =>
      Effect.gen(function* () {
        const secret = "sk-provider-secret-123456";
        const { client } = makeClient(
          encodeUnknownJson({
            error: {
              message: `request rejected; authorization: Bearer ${secret}`,
              api_key: secret,
              padding: "界".repeat(10_000),
            },
          }),
          status,
          "application/json",
        );

        const result = yield* Effect.flip(runError(client, baseErrorInput));

        expect(result).toBeInstanceOf(ByokEngineError);
        expect(result).toMatchObject({ reason, status, retryable: false });
        expect(result.detail).not.toContain(secret);
        expect(new TextEncoder().encode(result.detail).byteLength).toBeLessThanOrEqual(2_048);
        expect(result.detail).toContain("...[truncated]");
      }),
    );
  }

  effectIt.effect("interrupts an in-flight provider request as canceled", () =>
    Effect.gen(function* () {
      const controller = new AbortController();
      const started = yield* Deferred.make<void>();
      let calls = 0;
      const client = HttpClient.make(() =>
        Effect.sync(() => {
          calls += 1;
        }).pipe(Effect.andThen(Deferred.succeed(started, undefined)), Effect.andThen(Effect.never)),
      );
      const fiber = yield* runError(client, { ...baseErrorInput, signal: controller.signal }).pipe(
        Effect.forkChild,
      );

      yield* Deferred.await(started);
      expect(calls).toBe(1);
      controller.abort();

      const error = yield* Effect.flip(Fiber.join(fiber));
      expect(error).toMatchObject({ reason: "canceled", retryable: false });
      expect(calls).toBe(1);
    }),
  );
});

describe("byokChatClient multimodal parts", () => {
  const imageMessage = {
    role: "user" as const,
    content: [
      { type: "text", text: "what is this?" },
      { type: "image", mimeType: "image/png", dataBase64: "aW1n" },
    ] as const,
  };

  it("encodes openai image parts as image_url data URLs", async () => {
    const { client, captured } = makeClient(
      ['data: {"choices":[{"delta":{"content":"cat"}}]}', "", "data: [DONE]", ""].join("\n"),
    );
    await runEvents(client, {
      protocol: "openai",
      baseURL: "https://api.openai.com/v1",
      apiKey: "k",
      modelId: "gpt",
      messages: [imageMessage],
    });
    const message = (captured[0]?.body as { messages: Array<{ content: unknown }> }).messages[0];
    expect(message?.content).toEqual([
      { type: "text", text: "what is this?" },
      { type: "image_url", image_url: { url: "data:image/png;base64,aW1n" } },
    ]);
  });

  it("encodes anthropic image parts as base64 source blocks", async () => {
    const { client, captured } = makeClient(
      ['data: {"type":"content_block_delta","delta":{"text":"cat"}}', ""].join("\n"),
    );
    await runEvents(client, {
      protocol: "anthropic",
      baseURL: "https://api.anthropic.com",
      apiKey: "k",
      modelId: "claude",
      messages: [imageMessage],
    });
    const message = (captured[0]?.body as { messages: Array<{ content: unknown }> }).messages[0];
    expect(message?.content).toEqual([
      { type: "text", text: "what is this?" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1n" } },
    ]);
  });

  it("encodes gemini image parts as inlineData", async () => {
    const { client, captured } = makeClient(GEMINI_SSE);
    await runEvents(client, {
      protocol: "gemini",
      baseURL: "https://generativelanguage.googleapis.com",
      apiKey: "k",
      modelId: "m",
      messages: [imageMessage],
    });
    const content = (captured[0]?.body as { contents: Array<{ parts: unknown[] }> }).contents[0];
    expect(content?.parts).toEqual([
      { text: "what is this?" },
      { inlineData: { mimeType: "image/png", data: "aW1n" } },
    ]);
  });
});

describe("byokChatClient existing protocols", () => {
  it("still parses openai deltas", async () => {
    const { client } = makeClient(
      ['data: {"choices":[{"delta":{"content":"hey"}}]}', "", "data: [DONE]", ""].join("\n"),
    );
    const events = await runEvents(client, {
      protocol: "openai",
      baseURL: "https://api.openai.com/v1",
      apiKey: "k",
      modelId: "gpt",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(events).toEqual([{ type: "text", text: "hey" }]);
  });

  it("still parses anthropic deltas", async () => {
    const { client } = makeClient(
      [
        'data: {"type":"content_block_delta","delta":{"text":"yo"}}',
        "",
        'data: {"type":"message_stop"}',
        "",
      ].join("\n"),
    );
    const events = await runEvents(client, {
      protocol: "anthropic",
      baseURL: "https://api.anthropic.com",
      apiKey: "k",
      modelId: "claude",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(events).toEqual([{ type: "text", text: "yo" }]);
  });
});

describe("byokChatClient OpenAI tool calls", () => {
  it("advertises canonical tools and joins streamed tool-call argument fragments", async () => {
    const { client, captured } = makeClient(
      [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"workspace.read_file","arguments":"{\\"cwd\\":\\"C:/workspace\\",\\"relativePath\\":\\"READ"}}]}}]}',
        "",
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ME.md\\"}"}}]},"finish_reason":"tool_calls"}]}',
        "",
        "data: [DONE]",
        "",
      ].join("\n"),
    );
    const tools: ReadonlyArray<ByokToolDescriptor> = [
      {
        canonicalToolName: "workspace.read_file",
        description: "Read a text file",
        parameters: { type: "object", properties: { cwd: { type: "string" } } },
      },
    ];

    const events = await runEvents(client, {
      protocol: "openai",
      baseURL: "https://api.openai.com/v1",
      apiKey: "k",
      modelId: "gpt",
      messages: [{ role: "user", content: "read README" }],
      tools,
      agentLoop: true,
    });

    expect(events).toEqual([
      {
        type: "tool_call",
        toolCallId: "call-1",
        canonicalToolName: "workspace.read_file",
        arguments: { cwd: "C:/workspace", relativePath: "README.md" },
      },
    ]);
    expect(captured[0]?.body).toMatchObject({
      tools: [
        {
          type: "function",
          function: {
            name: "workspace.read_file",
            description: "Read a text file",
            parameters: { type: "object", properties: { cwd: { type: "string" } } },
          },
        },
      ],
      stream: true,
    });
  });

  it("replays assistant tool calls and tool results using the OpenAI message shape", async () => {
    const { client, captured } = makeClient(
      'data: {"choices":[{"delta":{"content":"done"}}]}\n\ndata: [DONE]\n',
    );

    await runEvents(client, {
      protocol: "openai",
      baseURL: "https://api.openai.com/v1",
      apiKey: "k",
      modelId: "gpt",
      messages: [
        { role: "user", content: "read README" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              toolCallId: "call-1",
              canonicalToolName: "workspace.read_file",
              arguments: { cwd: "C:/workspace", relativePath: "README.md" },
            },
          ],
        },
        { role: "tool", toolCallId: "call-1", content: '{"status":"succeeded"}' },
      ],
    });

    expect(captured[0]?.body).toMatchObject({
      messages: [
        { role: "user", content: "read README" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: {
                name: "workspace.read_file",
                arguments: '{"cwd":"C:/workspace","relativePath":"README.md"}',
              },
            },
          ],
        },
        { role: "tool", tool_call_id: "call-1", content: '{"status":"succeeded"}' },
      ],
    });
  });

  it("returns an engine error for malformed tool-call arguments", async () => {
    const malformedPayload = JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call-1",
                function: { name: "workspace.read_file", arguments: "not-json" },
              },
            ],
          },
        },
      ],
    });
    const { client } = makeClient(`data: ${malformedPayload}\n\ndata: [DONE]\n`);

    await expect(
      runEvents(client, {
        protocol: "openai",
        baseURL: "https://api.openai.com/v1",
        apiKey: "k",
        modelId: "gpt",
        messages: [{ role: "user", content: "read README" }],
        tools: [
          {
            canonicalToolName: "workspace.read_file",
            description: "Read a text file",
            parameters: { type: "object" },
          },
        ],
        agentLoop: true,
      }),
    ).rejects.toThrow("tool call arguments are not valid JSON");
  });
});

describe("byokChatClient multi-protocol tool calls", () => {
  const tools: ReadonlyArray<ByokToolDescriptor> = [
    {
      canonicalToolName: "workspace.read_file",
      description: "Read a text file",
      parameters: { type: "object", properties: { cwd: { type: "string" } } },
    },
  ];

  it("advertises and aggregates Anthropic tool_use input deltas", async () => {
    const { client, captured } = makeClient(
      [
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call-anthropic","name":"workspace.read_file"}}',
        "",
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"cwd\\":\\"C:/workspace\\""}}',
        "",
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"}"}}',
        "",
        'data: {"type":"message_stop"}',
        "",
      ].join("\n"),
    );

    const events = await runEvents(client, {
      protocol: "anthropic",
      baseURL: "https://api.anthropic.com",
      apiKey: "k",
      modelId: "claude",
      messages: [{ role: "user", content: "read README" }],
      tools,
      agentLoop: true,
    });

    expect(events).toEqual([
      {
        type: "tool_call",
        toolCallId: "call-anthropic",
        canonicalToolName: "workspace.read_file",
        arguments: { cwd: "C:/workspace" },
      },
    ]);
    expect(captured[0]?.body).toMatchObject({
      tools: [
        {
          name: "workspace.read_file",
          description: "Read a text file",
          input_schema: { type: "object", properties: { cwd: { type: "string" } } },
        },
      ],
    });
  });

  it("advertises and parses Gemini function calls", async () => {
    const { client, captured } = makeClient(
      [
        'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"workspace.read_file","args":{"cwd":"C:/workspace"}}}]}}]}',
        "",
      ].join("\n"),
    );

    const events = await runEvents(client, {
      protocol: "gemini",
      baseURL: "https://generativelanguage.googleapis.com",
      apiKey: "k",
      modelId: "gemini-2.5-pro",
      messages: [{ role: "user", content: "read README" }],
      tools,
      agentLoop: true,
    });

    expect(events).toEqual([
      {
        type: "tool_call",
        toolCallId: expect.any(String),
        canonicalToolName: "workspace.read_file",
        arguments: { cwd: "C:/workspace" },
      },
    ]);
    expect(captured[0]?.body).toMatchObject({
      tools: [
        {
          functionDeclarations: [
            {
              name: "workspace.read_file",
              description: "Read a text file",
              parameters: { type: "object", properties: { cwd: { type: "string" } } },
            },
          ],
        },
      ],
    });
  });
});
