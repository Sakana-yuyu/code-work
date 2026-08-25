import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpBody, HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as Stream from "effect/Stream";

import { makeOpenAiByokModelDriver } from "./OpenAiByokModelDriver.ts";

const decoder = new TextDecoder();
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

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
            { role: "tool", toolCallId: "call-0", content: '{"status":"succeeded"}' },
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
});
