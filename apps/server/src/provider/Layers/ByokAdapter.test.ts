import * as NodeServices from "@effect/platform-node/NodeServices";
import { ByokSettings, ProviderInstanceId, ThreadId } from "@codework/contracts";
import { createModelSelection } from "@codework/shared/model";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
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
  for (const runtimeMode of [
    "full-access",
    "approval-required",
    "auto-accept-edits",
    "auto",
  ] as const) {
    it.effect(`普通项目线程按 ${runtimeMode} 权限提供工具`, () => {
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
          usage: { prompt_tokens: 1_200, completion_tokens: 10, total_tokens: 1_210 },
        }),
        sse(
          { choices: [{ delta: { content: "已读取仓库代码，开始审查。" }, finish_reason: null }] },
          {
            choices: [{ delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 1_210, completion_tokens: 20, total_tokens: 1_230 },
          },
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
          runtimeMode,
          modelSelection: createModelSelection(instanceId, "deepseek-v4-flash"),
        });
        yield* adapter.sendTurn({
          threadId,
          input: "审查当前项目有什么问题",
          modelSelection: createModelSelection(instanceId, "deepseek-v4-flash"),
        });
        const events = Array.from(yield* Fiber.join(eventsFiber));

        const usageEvents = events.filter((event) => event.type === "thread.token-usage.updated");
        expect(usageEvents.map((event) => event.payload.usage.usedTokens)).toEqual([1_210, 1_230]);
        expect(usageEvents[1]?.payload.usage.totalProcessedTokens).toBe(2_440);
        expect(invocations).toHaveLength(1);
        expect(invocations[0]).toMatchObject({
          canonicalToolName: "workspace.read_file",
          runtimeMode,
          workspaceRoot,
          threadId,
          arguments: { cwd: workspaceRoot, relativePath: "README.md" },
        });
        if (runtimeMode === "full-access") {
          expect(requests[0]).toMatchObject({
            tools: expect.arrayContaining([
              expect.objectContaining({
                function: expect.objectContaining({
                  name: "workspace_write_file",
                  parameters: expect.objectContaining({
                    required: ["cwd", "relativePath", "contents"],
                  }),
                }),
              }),
              expect.objectContaining({
                function: expect.objectContaining({ name: "terminal_exec" }),
              }),
            ]),
          });
        } else {
          for (const name of [
            "workspace_write_file",
            "terminal_exec",
            "terminal_kill",
            "terminal_close",
          ]) {
            expect(requests[0]).not.toMatchObject({
              tools: expect.arrayContaining([
                expect.objectContaining({ function: expect.objectContaining({ name }) }),
              ]),
            });
          }
        }
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
  }

  it.effect("图片流式回合把 x-request-id 关联 id 透传到事件里", () => {
    const capturedHeaders: Array<Record<string, string>> = [];
    const responses = [
      sse(
        { choices: [{ delta: { content: "看图回答。", finish_reason: null } }] },
        {
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        },
      ),
    ];
    const httpClient = HttpClient.make((request) =>
      Effect.sync(() => {
        capturedHeaders.push({ ...(request.headers as Record<string, string>) });
        const body = responses.shift();
        if (body === undefined) throw new Error("收到未预期的 BYOK 请求");
        return HttpClientResponse.fromWeb(
          request,
          new Response(body, { headers: { "content-type": "text/event-stream" } }),
        );
      }),
    );
    const attachmentId = "byokimg-11111111-2222-4333-8444-555555555555";

    return Effect.gen(function* () {
      const serverConfig = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.makeDirectory(serverConfig.attachmentsDir, { recursive: true });
      yield* fileSystem.writeFile(
        `${serverConfig.attachmentsDir}/${attachmentId}.png`,
        new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      );

      const adapter = yield* makeByokAdapter(settings, { instanceId });
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
        input: "看看这张图",
        attachments: [
          { type: "image", id: attachmentId, name: "dot.png", mimeType: "image/png", sizeBytes: 4 },
        ],
        modelSelection: createModelSelection(instanceId, "deepseek-v4-flash"),
      });
      const events = Array.from(yield* Fiber.join(eventsFiber));

      const headerRequestId = capturedHeaders[0]?.["x-request-id"];
      expect(headerRequestId).toBeTruthy();
      expect(events.filter((event) => event.type === "thread.token-usage.updated")).toMatchObject([
        {
          payload: {
            usage: { usedTokens: 120, maxTokens: 128_000, inputTokens: 100, outputTokens: 20 },
          },
        },
      ]);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "content.delta",
            providerRefs: { providerRequestId: headerRequestId },
          }),
          expect.objectContaining({
            type: "turn.completed",
            payload: { state: "completed" },
            providerRefs: { providerRequestId: headerRequestId },
          }),
        ]),
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(ServerConfig.layerTest(workspaceRoot, { prefix: "byok-adapter-test-" })),
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.provide(NodeServices.layer),
    );
  });

  for (const usageCase of [
    {
      name: "完整用量",
      usage: {
        prompt_tokens: 1_200,
        completion_tokens: 300,
        total_tokens: 1_500,
        prompt_tokens_details: { cached_tokens: 200 },
      },
      contextWindowTokens: 128_000,
      usedTokens: 1_500,
    },
    {
      name: "只有输出时不伪造上下文",
      usage: { completion_tokens: 300 },
      contextWindowTokens: 128_000,
      usedTokens: undefined,
    },
    {
      name: "无效容量仍保留真实用量",
      usage: { prompt_tokens: 1_200, completion_tokens: 300 },
      contextWindowTokens: 0,
      usedTokens: 1_500,
    },
    {
      name: "保留零用量",
      usage: { prompt_tokens: 0, completion_tokens: 0 },
      contextWindowTokens: 128_000,
      usedTokens: 0,
    },
  ]) {
    it.effect(`BYOK Agent 上报上下文窗口活动：${usageCase.name}`, () => {
      const requests: Array<Record<string, unknown>> = [];
      const httpClient = HttpClient.make((request) =>
        Effect.sync(() => {
          if (request.body instanceof HttpBody.Uint8Array) {
            requests.push(decodeJson(decoder.decode(request.body.body)) as Record<string, unknown>);
          }
          return HttpClientResponse.fromWeb(
            request,
            new Response(
              sse(
                { choices: [{ delta: { content: "完成。" }, finish_reason: null }] },
                { choices: [{ delta: {}, finish_reason: "stop" }], usage: usageCase.usage },
                {
                  choices: [],
                  usage: usageCase.usage,
                },
              ),
              { headers: { "content-type": "text/event-stream" } },
            ),
          );
        }),
      );
      const toolBroker = ToolBroker.ToolBroker.of({
        invoke: (input) =>
          Effect.succeed({
            invocationId: `invocation-${input.toolCallId}`,
            taskId: input.taskId,
            runId: input.runId,
            toolCallId: input.toolCallId,
            canonicalToolName: input.canonicalToolName,
            status: "succeeded" as const,
            result: {},
            startedAtUnixMs: 1,
            finishedAtUnixMs: 2,
          }),
        cancel: () => Effect.void,
      });

      return Effect.gen(function* () {
        const adapter = yield* makeByokAdapter(
          {
            ...settings,
            adapters: settings.adapters.map((adapter) => ({
              ...adapter,
              contextWindowTokens: usageCase.contextWindowTokens,
            })),
          },
          { instanceId, toolBroker },
        );
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
          input: "回答问题",
          modelSelection: createModelSelection(instanceId, "deepseek-v4-flash"),
        });
        const events = Array.from(yield* Fiber.join(eventsFiber));

        expect(requests[0]).toMatchObject({ stream_options: { include_usage: true } });
        const usageEvents = events.filter((event) => event.type === "thread.token-usage.updated");
        if (usageCase.usedTokens === undefined) {
          expect(usageEvents).toEqual([]);
        } else {
          expect(usageEvents).toHaveLength(1);
          expect(usageEvents[0]?.payload.usage).toMatchObject({
            usedTokens: usageCase.usedTokens,
            lastUsedTokens: usageCase.usedTokens,
            inputTokens: usageCase.usage.prompt_tokens,
            outputTokens: usageCase.usage.completion_tokens,
          });
          expect(usageEvents[0]?.payload.usage.maxTokens).toBe(
            usageCase.contextWindowTokens || undefined,
          );
          expect(usageEvents[0]?.payload.usage.totalProcessedTokens).toBeUndefined();
        }
      }).pipe(
        Effect.scoped,
        Effect.provide(ServerConfig.layerTest(workspaceRoot, { prefix: "byok-adapter-test-" })),
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.provide(NodeServices.layer),
      );
    });
  }
});
