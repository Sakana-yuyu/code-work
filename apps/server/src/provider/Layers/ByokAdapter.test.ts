import * as NodeServices from "@effect/platform-node/NodeServices";
import { ByokSettings, ProviderInstanceId, ThreadId } from "@codework/contracts";
import { createModelSelection } from "@codework/shared/model";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpBody, HttpClient, HttpClientResponse } from "effect/unstable/http";

import { ServerConfig } from "../../config.ts";
import * as ToolBroker from "../../composition/ToolBroker.ts";
import { makeByokAdapter } from "./ByokAdapter.ts";

const decoder = new TextDecoder();
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const workspaceRoot = process.cwd();
const instanceId = ProviderInstanceId.make("byok-test");
const threadId = ThreadId.make("thread-byok-project-tools");
const settings = Schema.decodeUnknownSync(ByokSettings)({
  enabled: true,
  adapters: [
    {
      id: "deepseek-v4-flash",
      displayName: "DeepSeek V4 Flash",
      protocol: "openai",
      baseURL: "https://example.test/v1",
      apiKey: "test-key",
      modelId: "deepseek-v4-flash",
      contextWindowTokens: 128_000,
    },
  ],
});

const sse = (...payloads: ReadonlyArray<unknown>): string =>
  [...payloads.map((payload) => `data: ${encodeJson(payload)}\n`), "data: [DONE]\n"].join("\n");

describe("ByokAdapter", () => {
  it.effect("普通项目线程通过 Agent Loop 调用代码审查工具", () => {
    const requests: Array<Record<string, unknown>> = [];
    const responses = [
      sse({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call-readme",
                  function: {
                    name: "workspace.read_file",
                    arguments: encodeJson({ cwd: workspaceRoot, relativePath: "README.md" }),
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
      sse(
        { choices: [{ delta: { content: "已读取仓库代码，开始审查。" }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ),
    ];
    const httpClient = HttpClient.make((request) =>
      Effect.sync(() => {
        if (request.body instanceof HttpBody.Uint8Array) {
          requests.push(decodeJson(decoder.decode(request.body.body)) as Record<string, unknown>);
        }
        const body = responses.shift();
        if (body === undefined) throw new Error("收到未预期的 BYOK 请求");
        return HttpClientResponse.fromWeb(
          request,
          new Response(body, { headers: { "content-type": "text/event-stream" } }),
        );
      }),
    );
    const invocations: ToolBroker.ToolBrokerInput[] = [];
    const toolBroker = ToolBroker.ToolBroker.of({
      invoke: (input) =>
        Effect.sync(() => {
          invocations.push(input);
          return {
            invocationId: `invocation-${input.toolCallId}`,
            taskId: input.taskId,
            runId: input.runId,
            toolCallId: input.toolCallId,
            canonicalToolName: input.canonicalToolName,
            status: "succeeded" as const,
            result: { relativePath: "README.md", contents: "# Code Work" },
            startedAtUnixMs: 1,
            finishedAtUnixMs: 2,
          };
        }),
      cancel: () => Effect.void,
    });

    return Effect.gen(function* () {
      const adapter = yield* makeByokAdapter(settings, { instanceId, toolBroker });
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* adapter.startSession({
        threadId,
        cwd: workspaceRoot,
        runtimeMode: "full-access",
        modelSelection: createModelSelection(instanceId, "deepseek-v4-flash"),
      });
      yield* adapter.sendTurn({
        threadId,
        input: "审查当前项目有什么问题",
        modelSelection: createModelSelection(instanceId, "deepseek-v4-flash"),
      });
      const events = Array.from(yield* Fiber.join(eventsFiber));

      expect(invocations).toHaveLength(1);
      expect(invocations[0]).toMatchObject({
        canonicalToolName: "workspace.read_file",
        workspaceRoot,
        threadId,
        arguments: { cwd: workspaceRoot, relativePath: "README.md" },
      });
      expect(requests[0]).toMatchObject({
        tools: expect.arrayContaining([
          expect.objectContaining({
            function: expect.objectContaining({ name: "workspace_read_file" }),
          }),
          expect.objectContaining({ function: expect.objectContaining({ name: "git_status" }) }),
          expect.objectContaining({ function: expect.objectContaining({ name: "git_diff" }) }),
        ]),
      });
      expect(requests[1]).toMatchObject({
        messages: expect.arrayContaining([
          expect.objectContaining({ role: "tool", tool_call_id: "call-readme" }),
        ]),
      });
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "content.delta",
            payload: expect.objectContaining({ delta: "已读取仓库代码，开始审查。" }),
          }),
          expect.objectContaining({ type: "turn.completed", payload: { state: "completed" } }),
        ]),
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(ServerConfig.layerTest(workspaceRoot, { prefix: "byok-adapter-test-" })),
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.provide(NodeServices.layer),
    );
  });
});
