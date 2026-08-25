import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { HttpBody, HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as Stream from "effect/Stream";

import {
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
        new Response(sseText, { headers: { "content-type": "text/event-stream" } }),
      );
    }),
  );
  return { client, captured };
};

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
