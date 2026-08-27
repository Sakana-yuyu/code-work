import { it as effectIt } from "@effect/vitest";
import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpBody, HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as Stream from "effect/Stream";

import { makeByokModelDriver, makeOpenAiByokModelDriver } from "./OpenAiByokModelDriver.ts";

const decoder = new TextDecoder();
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const makeClient = (sseText: string) => {
  const captured: unknown[] = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      if (request.body instanceof HttpBody.Uint8Array) {
        captured.push(decodeJson(decoder.decode(request.body.body)));
      }
      return HttpClientResponse.fromWeb(
        request,
        new Response(sseText, { headers: { "content-type": "text/event-stream" } }),
      );
    }),
  );
  return { client, captured };
};

describe("OpenAiByokModelDriver", () => {
  it("maps BYOK events and replays agent messages and tools", async () => {
    const { client, captured } = makeClient(
      [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"workspace.read_file","arguments":"{\\"cwd\\":\\"C:/workspace\\"}"}}]}}]}',
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

    const events = await Effect.runPromise(
      Stream.runCollect(
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
      ),
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
          function: { name: "workspace.read_file", description: "Read a text file" },
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
                name: "workspace.read_file",
                arguments: '{"cwd":"C:/workspace","relativePath":"package.json"}',
              },
            },
          ],
        },
        { role: "tool", tool_call_id: "call-0", content: '{"status":"succeeded"}' },
      ],
    });
  });

  it("maps BYOK transport failures to the agent model error", async () => {
    const client = HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response("no", { status: 503 }))),
    );
    const driver = makeOpenAiByokModelDriver(client, {
      baseURL: "https://api.openai.com/v1",
      apiKey: "k",
      modelId: "gpt",
    });

    await expect(
      Effect.runPromise(Stream.runCollect(driver.complete({ messages: [], tools: [], turn: 1 }))),
    ).rejects.toMatchObject({ code: "byok_engine_error" });
  });

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
});

describe("ByokModelDriver", () => {
  it("maps Anthropic tool calls and sends canonical tool results", async () => {
    const { client, captured } = makeClient(
      [
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call-anthropic","name":"workspace.read_file"}}',
        "",
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"cwd\\":\\"C:/workspace\\"}"}}',
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

    const events = await Effect.runPromise(
      Stream.runCollect(
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
      ),
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
  });

  it("maps Gemini function calls and replays tool messages", async () => {
    const { client, captured } = makeClient(
      [
        'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"workspace.read_file","args":{"cwd":"C:/workspace"}}}]}}]}',
        "",
      ].join("\n"),
    );
    const driver = makeByokModelDriver(client, {
      protocol: "gemini",
      baseURL: "https://generativelanguage.googleapis.com",
      apiKey: "k",
      modelId: "gemini-2.5-pro",
    });

    const events = await Effect.runPromise(
      Stream.runCollect(
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
      ),
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
          functionDeclarations: [{ name: "workspace.read_file", description: "Read a text file" }],
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
  });
});
