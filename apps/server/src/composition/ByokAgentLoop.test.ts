import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ToolBroker from "./ToolBroker.ts";
import { listCompositionAgentTools } from "./CompositionToolRegistry.ts";
import {
  ByokAgentModelError,
  runByokAgentLoop,
  type ByokAgentModelDriver,
} from "./ByokAgentLoop.ts";

const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeUnknownJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const makeResult = (input: ToolBroker.ToolBrokerInput): ToolBroker.ToolBrokerResult => ({
  invocationId: `invocation-${input.idempotencyKey}`,
  taskId: input.taskId,
  runId: input.runId,
  toolCallId: input.toolCallId,
  canonicalToolName: input.canonicalToolName,
  status: "succeeded",
  result: { contents: "workspace result" },
  startedAtUnixMs: 1,
  finishedAtUnixMs: 2,
});

const baseInput = {
  taskId: "task-1",
  runId: "run-1",
  agentId: "agent-1",
  runtimeId: "byok-instance",
  workspaceRoot: "C:/workspace",
  prompt: "inspect the workspace",
  capabilityGrantIds: ["t3.workspace.read_file"],
  tools: [
    {
      canonicalToolName: "workspace.read_file",
      description: "Read a text file",
      parameters: { type: "object" },
    },
  ],
};

describe("ByokAgentLoop", () => {
  it.effect("参数无效时提供现有签名，模型修正后只执行一次有效写入并结束", () =>
    Effect.gen(function* () {
      const writeTool = listCompositionAgentTools().find(
        (tool) => tool.canonicalToolName === "workspace.write_file",
      );
      expect(writeTool).toBeDefined();
      if (writeTool === undefined) return;
      const calls: unknown[] = [];
      let writes = 0;
      const correctArguments = {
        cwd: baseInput.workspaceRoot,
        relativePath: "byok-full-access-check.txt",
        contents: "蓝鹈鹕-8426",
      };
      const broker = ToolBroker.ToolBroker.of({
        invoke: (input) =>
          Effect.sync(() => {
            calls.push(input.arguments);
            if (calls.length === 1) {
              return {
                ...makeResult(input),
                status: "failed" as const,
                result: undefined,
                errorCode: "tool_arguments_invalid",
              };
            }
            expect(input.arguments).toEqual(correctArguments);
            writes += 1;
            return makeResult(input);
          }),
        cancel: () => Effect.void,
      });
      const model: ByokAgentModelDriver = {
        complete: (input) => {
          if (input.turn === 3)
            return Stream.fromIterable([
              { type: "text_delta", text: "文件已创建" },
              { type: "model_completed" },
            ]);
          let argumentsValue: unknown = {
            path: "byok-full-access-check.txt",
            contents: "蓝鹈鹕-8426",
          };
          if (input.turn === 2) {
            const feedback = input.messages.at(-1);
            expect(feedback?.role).toBe("tool");
            expect(decodeUnknownJson(feedback?.content ?? "{}")).toMatchObject({
              status: "failed",
              errorCode: "tool_arguments_invalid",
              parameters: writeTool.parameters,
              workspaceRoot: baseInput.workspaceRoot,
              hint: expect.stringContaining("修正参数"),
            });
            argumentsValue = correctArguments;
          }
          return Stream.fromIterable([
            {
              type: "tool_call",
              toolCallId: `write-${input.turn}`,
              canonicalToolName: writeTool.canonicalToolName,
              arguments: argumentsValue,
            },
            { type: "model_completed" },
          ]);
        },
      };
      const result = yield* runByokAgentLoop(
        {
          ...baseInput,
          tools: [writeTool],
          runtimeMode: "full-access",
          capabilityGrantIds: ["t3.workspace.write_file"],
        },
        model,
        broker,
      );
      expect(result).toMatchObject({ text: "文件已创建", rounds: 3 });
      expect(calls).toHaveLength(2);
      expect(calls[0]).toEqual({ path: "byok-full-access-check.txt", contents: "蓝鹈鹕-8426" });
      expect(writes).toBe(1);
    }),
  );

  it.effect("参数纠错签名超过结果预算时保留有界原始错误", () =>
    Effect.gen(function* () {
      const broker = ToolBroker.ToolBroker.of({
        invoke: (input) =>
          Effect.succeed({
            ...makeResult(input),
            status: "failed" as const,
            result: undefined,
            errorCode: "tool_arguments_invalid",
          }),
        cancel: () => Effect.void,
      });
      const model: ByokAgentModelDriver = {
        complete: (input) => {
          if (input.turn === 2) {
            const feedback = input.messages.at(-1);
            expect(feedback?.content.length).toBeLessThanOrEqual(160);
            expect(decodeUnknownJson(feedback?.content ?? "{}")).toEqual({
              status: "failed",
              errorCode: "tool_arguments_invalid",
            });
            return Stream.fromIterable([{ type: "model_completed" }]);
          }
          return Stream.fromIterable([
            {
              type: "tool_call",
              toolCallId: "invalid-large-schema",
              canonicalToolName: "workspace.read_file",
              arguments: {},
            },
            { type: "model_completed" },
          ]);
        },
      };
      yield* runByokAgentLoop(
        {
          ...baseInput,
          maxToolResultChars: 160,
          tools: [
            {
              ...baseInput.tools[0]!,
              parameters: { type: "object", description: "很长的签名".repeat(1_000) },
            },
          ],
        },
        model,
        broker,
      );
    }),
  );

  it("executes one tool call, deduplicates its terminal replay, reinjects the result, and continues", async () => {
    const modelInputs: Array<Parameters<ByokAgentModelDriver["complete"]>[0]> = [];
    let brokerCalls = 0;
    let capturedRuntimeId: string | undefined;
    const broker = ToolBroker.ToolBroker.of({
      invoke: (input) =>
        Effect.sync(() => {
          brokerCalls += 1;
          capturedRuntimeId = input.runtimeId;
          return makeResult(input);
        }),
      cancel: () => Effect.void,
    });
    const model: ByokAgentModelDriver = {
      complete: (input) => {
        modelInputs.push(input);
        return modelInputs.length === 1
          ? Stream.fromIterable([
              {
                type: "tool_call" as const,
                toolCallId: "call-1",
                canonicalToolName: "workspace.read_file",
                arguments: { cwd: "C:/workspace", relativePath: "README.md" },
              },
              {
                type: "tool_call" as const,
                toolCallId: "call-1",
                canonicalToolName: "workspace.read_file",
                arguments: { cwd: "C:/workspace", relativePath: "README.md" },
              },
              { type: "model_completed" as const },
            ])
          : Stream.fromIterable([
              { type: "text_delta" as const, text: "done" },
              { type: "model_completed" as const },
            ]);
      },
    };

    const result = await Effect.runPromise(runByokAgentLoop(baseInput, model, broker));

    expect(result.text).toBe("done");
    expect(result.rounds).toBe(2);
    expect(brokerCalls).toBe(1);
    expect(capturedRuntimeId).toBe("byok-instance");
    expect(modelInputs[1]?.messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "tool", toolCallId: "call-1" })]),
    );
  });

  it("把本轮思考与全部工具调用聚合进单条 assistant 消息回放", async () => {
    let secondInput: Parameters<ByokAgentModelDriver["complete"]>[0] | undefined;
    const broker = ToolBroker.ToolBroker.of({
      invoke: (input) => Effect.succeed(makeResult(input)),
      cancel: () => Effect.void,
    });
    const model: ByokAgentModelDriver = {
      complete: (input) => {
        if (input.turn === 2) {
          secondInput = input;
          return Stream.fromIterable([{ type: "model_completed" as const }]);
        }
        return Stream.fromIterable([
          { type: "reasoning_delta" as const, text: "需要先读" },
          { type: "reasoning_delta" as const, text: "两个文件" },
          { type: "reasoning_signature" as const, signature: "sig-round-1" },
          {
            type: "tool_call" as const,
            toolCallId: "call-a",
            canonicalToolName: "workspace.read_file",
            arguments: { relativePath: "a.txt" },
          },
          {
            type: "tool_call" as const,
            toolCallId: "call-b",
            canonicalToolName: "workspace.read_file",
            arguments: { relativePath: "b.txt" },
          },
          { type: "model_completed" as const },
        ]);
      },
    };

    await Effect.runPromise(runByokAgentLoop(baseInput, model, broker));

    expect(secondInput?.messages).toEqual([
      { role: "user", content: baseInput.prompt },
      {
        role: "assistant",
        content: "",
        reasoningContent: "需要先读两个文件",
        reasoningSignature: "sig-round-1",
        toolCalls: [
          {
            toolCallId: "call-a",
            canonicalToolName: "workspace.read_file",
            arguments: { relativePath: "a.txt" },
          },
          {
            toolCallId: "call-b",
            canonicalToolName: "workspace.read_file",
            arguments: { relativePath: "b.txt" },
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "call-a",
        canonicalToolName: "workspace.read_file",
        content: encodeUnknownJson({
          status: "succeeded",
          result: { contents: "workspace result" },
        }),
      },
      {
        role: "tool",
        toolCallId: "call-b",
        canonicalToolName: "workspace.read_file",
        content: encodeUnknownJson({
          status: "succeeded",
          result: { contents: "workspace result" },
        }),
      },
    ]);
  });

  it.effect("流式回调：思考增量与工具开始事件按发生顺序到达", () =>
    Effect.gen(function* () {
      const reasoningDeltas: string[] = [];
      const startedTools: string[] = [];
      const completedTools: string[] = [];
      const broker = ToolBroker.ToolBroker.of({
        invoke: (input) =>
          Effect.sync(() => {
            completedTools.push(input.canonicalToolName);
            return makeResult(input);
          }),
        cancel: () => Effect.void,
      });
      const model: ByokAgentModelDriver = {
        complete: (input) => {
          if (input.turn === 2) {
            return Stream.fromIterable([{ type: "model_completed" as const }]);
          }
          return Stream.fromIterable([
            { type: "reasoning_delta" as const, text: "思考片段" },
            {
              type: "tool_call" as const,
              toolCallId: "call-stream",
              canonicalToolName: "workspace.read_file",
              arguments: { relativePath: "README.md" },
            },
            { type: "model_completed" as const },
          ]);
        },
      };

      yield* runByokAgentLoop(
        {
          ...baseInput,
          onReasoningCheckpoint: (checkpoint) =>
            Effect.sync(() => {
              reasoningDeltas.push(checkpoint.delta);
            }),
          onToolStarted: (toolCall) =>
            Effect.sync(() => {
              startedTools.push(toolCall.toolCallId);
            }),
        },
        model,
        broker,
      );

      expect(reasoningDeltas).toEqual(["思考片段"]);
      expect(startedTools).toEqual(["call-stream"]);
      expect(completedTools).toEqual(["workspace.read_file"]);
    }),
  );

  it("reinjects a denied or failed broker result as an error tool message", async () => {
    let secondInput: Parameters<ByokAgentModelDriver["complete"]>[0] | undefined;
    const broker = ToolBroker.ToolBroker.of({
      invoke: (input) =>
        Effect.succeed({
          ...makeResult(input),
          status: "denied" as const,
          result: undefined,
          errorCode: "tool_approval_required",
        }),
      cancel: () => Effect.void,
    });
    const model: ByokAgentModelDriver = {
      complete: (input) => {
        if (input.turn === 2) {
          secondInput = input;
          return Stream.fromIterable([
            { type: "text_delta" as const, text: "approval needed" },
            { type: "model_completed" as const },
          ]);
        }
        return Stream.fromIterable([
          {
            type: "tool_call" as const,
            toolCallId: "call-denied",
            canonicalToolName: "workspace.write_file",
            arguments: { cwd: "C:/workspace", relativePath: "x.txt", contents: "x" },
          },
          { type: "model_completed" as const },
        ]);
      },
    };

    const result = await Effect.runPromise(
      runByokAgentLoop(
        {
          ...baseInput,
          capabilityGrantIds: ["t3.workspace.write_file"],
          maxToolResultChars: 160,
          tools: [
            {
              canonicalToolName: "workspace.write_file",
              description: "Write a text file",
              parameters: { type: "object" },
            },
          ],
        },
        model,
        broker,
      ),
    );

    expect(result.text).toBe("approval needed");
    expect(secondInput?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "tool",
          content: encodeUnknownJson({
            status: "denied",
            errorCode: "tool_approval_required",
          }),
        }),
      ]),
    );
  });

  it("runs the same loop for native non-OpenAI BYOK protocols", async () => {
    const broker = ToolBroker.ToolBroker.of({
      invoke: (input) => Effect.succeed(makeResult(input)),
      cancel: () => Effect.void,
    });
    const model: ByokAgentModelDriver = {
      complete: () =>
        Stream.fromIterable([
          { type: "text_delta" as const, text: "anthropic works" },
          { type: "model_completed" as const },
        ]),
    };

    await expect(
      Effect.runPromise(runByokAgentLoop({ ...baseInput, protocol: "anthropic" }, model, broker)),
    ).resolves.toMatchObject({ text: "anthropic works", rounds: 1 });
  });

  it("replays the canonical tool name with each tool result message", async () => {
    let secondInput: Parameters<ByokAgentModelDriver["complete"]>[0] | undefined;
    const broker = ToolBroker.ToolBroker.of({
      invoke: (input) => Effect.succeed(makeResult(input)),
      cancel: () => Effect.void,
    });
    const model: ByokAgentModelDriver = {
      complete: (input) => {
        if (input.turn === 2) {
          secondInput = input;
          return Stream.fromIterable([{ type: "model_completed" as const }]);
        }
        return Stream.fromIterable([
          {
            type: "tool_call" as const,
            toolCallId: "call-canonical",
            canonicalToolName: "workspace.read_file",
            arguments: { cwd: "C:/workspace", relativePath: "README.md" },
          },
          { type: "model_completed" as const },
        ]);
      },
    };

    await Effect.runPromise(runByokAgentLoop(baseInput, model, broker));

    expect(secondInput?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "tool",
          toolCallId: "call-canonical",
          canonicalToolName: "workspace.read_file",
        }),
      ]),
    );
  });

  it.effect("超过 64 轮后仍继续执行，并在模型完成时收敛", () =>
    Effect.gen(function* () {
      let modelCalls = 0;
      const model: ByokAgentModelDriver = {
        complete: (input) => {
          modelCalls += 1;
          return input.turn === 65
            ? Stream.fromIterable([
                { type: "text_delta" as const, text: "done" },
                { type: "model_completed" as const },
              ])
            : Stream.fromIterable([
                {
                  type: "tool_call" as const,
                  toolCallId: `call-loop-${input.turn}`,
                  canonicalToolName: "workspace.read_file",
                  arguments: { cwd: "C:/workspace", relativePath: "README.md" },
                },
                { type: "model_completed" as const },
              ]);
        },
      };
      const broker = ToolBroker.ToolBroker.of({
        invoke: (input) => Effect.succeed(makeResult(input)),
        cancel: () => Effect.void,
      });

      const result = yield* runByokAgentLoop({ ...baseInput, maxRounds: 1 }, model, broker);

      expect(result.text).toBe("done");
      expect(result.rounds).toBe(65);
      expect(modelCalls).toBe(65);
    }),
  );

  it.effect("超过消息预算时只向模型重放最近的完整工具轮次", () =>
    Effect.gen(function* () {
      const modelInputs: Array<Parameters<ByokAgentModelDriver["complete"]>[0]> = [];
      const idempotencyKeys: string[] = [];
      const broker = ToolBroker.ToolBroker.of({
        invoke: (input) =>
          Effect.sync(() => {
            idempotencyKeys.push(input.idempotencyKey);
            return {
              ...makeResult(input),
              result: { contents: `result-${input.toolCallId}` },
            };
          }),
        cancel: () => Effect.void,
      });
      const model: ByokAgentModelDriver = {
        complete: (input) => {
          modelInputs.push(input);
          return input.turn === 6
            ? Stream.fromIterable([
                { type: "text_delta" as const, text: "done" },
                { type: "model_completed" as const },
              ])
            : Stream.fromIterable([
                {
                  type: "tool_call" as const,
                  toolCallId: `call-${input.turn}`,
                  canonicalToolName: "workspace.read_file",
                  arguments: { relativePath: `file-${input.turn}.txt` },
                },
                { type: "model_completed" as const },
              ]);
        },
      };

      const result = yield* runByokAgentLoop(
        { ...baseInput, maxContextMessages: 5 },
        model,
        broker,
      );
      const finalMessages = modelInputs[5]?.messages ?? [];

      expect(result.text).toBe("done");
      expect(result.rounds).toBe(6);
      expect(finalMessages).toHaveLength(5);
      expect(finalMessages[0]).toEqual({ role: "user", content: baseInput.prompt });
      expect(finalMessages.slice(1).map((message) => message.role)).toEqual([
        "assistant",
        "tool",
        "assistant",
        "tool",
      ]);
      expect(
        finalMessages
          .filter((message) => message.role === "tool")
          .map((message) => message.toolCallId),
      ).toEqual(["call-4", "call-5"]);
      for (const message of finalMessages) {
        if (message.role !== "tool") continue;
        expect(
          finalMessages.some(
            (candidate) =>
              candidate.role === "assistant" &&
              candidate.toolCalls?.some(
                (toolCall) => toolCall.toolCallId === message.toolCallId,
              ) === true,
          ),
        ).toBe(true);
      }
      expect(idempotencyKeys).toEqual([
        "run-1:call-1",
        "run-1:call-2",
        "run-1:call-3",
        "run-1:call-4",
        "run-1:call-5",
      ]);
      expect(result.messages).toEqual(finalMessages);
    }),
  );

  it.effect("字符预算内全量重放且请求前缀跨轮稳定", () =>
    Effect.gen(function* () {
      const modelInputs: Array<Parameters<ByokAgentModelDriver["complete"]>[0]> = [];
      const broker = ToolBroker.ToolBroker.of({
        invoke: (input) =>
          Effect.succeed({
            ...makeResult(input),
            result: { contents: `result-${input.toolCallId}` },
          }),
        cancel: () => Effect.void,
      });
      const model: ByokAgentModelDriver = {
        complete: (input) => {
          modelInputs.push(input);
          return input.turn === 5
            ? Stream.fromIterable([
                { type: "text_delta" as const, text: "done" },
                { type: "model_completed" as const },
              ])
            : Stream.fromIterable([
                {
                  type: "tool_call" as const,
                  toolCallId: `call-${input.turn}`,
                  canonicalToolName: "workspace.read_file",
                  arguments: { relativePath: `file-${input.turn}.txt` },
                },
                { type: "model_completed" as const },
              ]);
        },
      };

      const result = yield* runByokAgentLoop(
        { ...baseInput, maxContextChars: 100_000 },
        model,
        broker,
      );

      expect(result.text).toBe("done");
      expect(result.rounds).toBe(5);
      expect(modelInputs.map((input) => input.messages.length)).toEqual([1, 3, 5, 7, 9]);
      for (let index = 1; index < modelInputs.length; index += 1) {
        const previous = modelInputs[index - 1]?.messages ?? [];
        const next = modelInputs[index]?.messages ?? [];
        expect(next.slice(0, previous.length)).toEqual(previous);
      }
    }),
  );

  it.effect("超过字符预算时整体裁剪一次保留最近轮次，预算内不再逐轮滑动", () =>
    Effect.gen(function* () {
      const modelInputs: Array<Parameters<ByokAgentModelDriver["complete"]>[0]> = [];
      const broker = ToolBroker.ToolBroker.of({
        invoke: (input) =>
          Effect.succeed({
            ...makeResult(input),
            result: { contents: "x".repeat(4_000) },
          }),
        cancel: () => Effect.void,
      });
      const model: ByokAgentModelDriver = {
        complete: (input) => {
          modelInputs.push(input);
          return input.turn === 5
            ? Stream.fromIterable([
                { type: "text_delta" as const, text: "done" },
                { type: "model_completed" as const },
              ])
            : Stream.fromIterable([
                {
                  type: "tool_call" as const,
                  toolCallId: `call-${input.turn}`,
                  canonicalToolName: "workspace.read_file",
                  arguments: { relativePath: `file-${input.turn}.txt` },
                },
                { type: "model_completed" as const },
              ]);
        },
      };

      const result = yield* runByokAgentLoop(
        { ...baseInput, maxContextChars: 10_000 },
        model,
        broker,
      );

      expect(result.text).toBe("done");
      // 前三轮预算内全量重放；第四轮超过 10_000 字符触发整体裁剪。
      expect(modelInputs.map((input) => input.messages.length)).toEqual([1, 3, 5, 3, 5]);
      const compacted = modelInputs[3]?.messages ?? [];
      expect(compacted[0]).toEqual({ role: "user", content: baseInput.prompt });
      expect(
        compacted
          .filter((message) => message.role === "tool")
          .map((message) => (message.role === "tool" ? message.toolCallId : "")),
      ).toEqual(["call-3"]);
      // 裁剪后的新前缀保持稳定并继续增长，而不是每轮再滑。
      const afterCompaction = modelInputs[4]?.messages ?? [];
      expect(afterCompaction.slice(0, compacted.length)).toEqual(compacted);
      expect(
        afterCompaction
          .filter((message) => message.role === "tool")
          .map((message) => (message.role === "tool" ? message.toolCallId : "")),
      ).toEqual(["call-3", "call-4"]);
    }),
  );

  it.effect("字符预算小于单个工具轮次时仍至少保留最近一轮", () =>
    Effect.gen(function* () {
      const modelInputs: Array<Parameters<ByokAgentModelDriver["complete"]>[0]> = [];
      const broker = ToolBroker.ToolBroker.of({
        invoke: (input) =>
          Effect.succeed({
            ...makeResult(input),
            result: { contents: "x".repeat(4_000) },
          }),
        cancel: () => Effect.void,
      });
      const model: ByokAgentModelDriver = {
        complete: (input) => {
          modelInputs.push(input);
          return input.turn === 3
            ? Stream.fromIterable([
                { type: "text_delta" as const, text: "done" },
                { type: "model_completed" as const },
              ])
            : Stream.fromIterable([
                {
                  type: "tool_call" as const,
                  toolCallId: `call-${input.turn}`,
                  canonicalToolName: "workspace.read_file",
                  arguments: { relativePath: `file-${input.turn}.txt` },
                },
                { type: "model_completed" as const },
              ]);
        },
      };

      const result = yield* runByokAgentLoop({ ...baseInput, maxContextChars: 500 }, model, broker);

      expect(result.text).toBe("done");
      const secondCall = modelInputs[1]?.messages ?? [];
      expect(secondCall).toHaveLength(3);
      expect(secondCall[0]).toEqual({ role: "user", content: baseInput.prompt });
      expect(
        secondCall.some((message) => message.role === "tool" && message.toolCallId === "call-1"),
      ).toBe(true);
    }),
  );

  it.effect("超长成功工具结果会被裁剪为有界且有效的 JSON", () =>
    Effect.gen(function* () {
      const maxToolResultChars = 160;
      let secondInput: Parameters<ByokAgentModelDriver["complete"]>[0] | undefined;
      const broker = ToolBroker.ToolBroker.of({
        invoke: (input) =>
          Effect.succeed({
            ...makeResult(input),
            result: { contents: "x".repeat(2_000) },
          }),
        cancel: () => Effect.void,
      });
      const model: ByokAgentModelDriver = {
        complete: (input) => {
          if (input.turn === 2) {
            secondInput = input;
            return Stream.fromIterable([
              { type: "text_delta" as const, text: "done" },
              { type: "model_completed" as const },
            ]);
          }
          return Stream.fromIterable([
            {
              type: "tool_call" as const,
              toolCallId: "call-large-result",
              canonicalToolName: "workspace.read_file",
              arguments: { relativePath: "large.txt" },
            },
            { type: "model_completed" as const },
          ]);
        },
      };

      yield* runByokAgentLoop({ ...baseInput, maxToolResultChars }, model, broker);
      const toolMessage = secondInput?.messages.find((message) => message.role === "tool");
      expect(toolMessage?.content.length).toBeLessThanOrEqual(maxToolResultChars);
      expect(decodeUnknownJson(toolMessage?.content ?? "")).toMatchObject({
        status: "succeeded",
        truncated: true,
        truncationReason: "max_tool_result_chars",
        originalCharCount: expect.any(Number),
        resultPreview: expect.any(String),
      });
    }),
  );

  it.effect("未超过预算时保持原有工具消息结构和内容", () =>
    Effect.gen(function* () {
      let secondInput: Parameters<ByokAgentModelDriver["complete"]>[0] | undefined;
      const broker = ToolBroker.ToolBroker.of({
        invoke: (input) => Effect.succeed(makeResult(input)),
        cancel: () => Effect.void,
      });
      const model: ByokAgentModelDriver = {
        complete: (input) => {
          if (input.turn === 2) {
            secondInput = input;
            return Stream.fromIterable([{ type: "model_completed" as const }]);
          }
          return Stream.fromIterable([
            {
              type: "tool_call" as const,
              toolCallId: "call-small-result",
              canonicalToolName: "workspace.read_file",
              arguments: { relativePath: "README.md" },
            },
            { type: "model_completed" as const },
          ]);
        },
      };

      yield* runByokAgentLoop(
        { ...baseInput, maxContextMessages: 3, maxToolResultChars: 500 },
        model,
        broker,
      );

      expect(secondInput?.messages).toEqual([
        { role: "user", content: baseInput.prompt },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              toolCallId: "call-small-result",
              canonicalToolName: "workspace.read_file",
              arguments: { relativePath: "README.md" },
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "call-small-result",
          canonicalToolName: "workspace.read_file",
          content: encodeUnknownJson({
            status: "succeeded",
            result: { contents: "workspace result" },
          }),
        },
      ]);
    }),
  );

  it.effect("上下文溢出时在同一逻辑轮次仅用最近完整工具轮次恢复一次", () =>
    Effect.gen(function* () {
      const modelInputs: Array<Parameters<ByokAgentModelDriver["complete"]>[0]> = [];
      let brokerCalls = 0;
      const broker = ToolBroker.ToolBroker.of({
        invoke: (input) =>
          Effect.sync(() => {
            brokerCalls += 1;
            return makeResult(input);
          }),
        cancel: () => Effect.void,
      });
      const model: ByokAgentModelDriver = {
        complete: (input) => {
          modelInputs.push(input);
          if (modelInputs.length === 3) {
            return Stream.fail(
              new ByokAgentModelError({ code: "context_overflow", detail: "context too large" }),
            );
          }
          if (modelInputs.length === 4) {
            return Stream.fromIterable([
              { type: "text_delta" as const, text: "recovered" },
              { type: "model_completed" as const },
            ]);
          }
          return Stream.fromIterable([
            {
              type: "tool_call" as const,
              toolCallId: `call-${input.turn}`,
              canonicalToolName: "workspace.read_file",
              arguments: { relativePath: `${input.turn}.txt` },
            },
            { type: "model_completed" as const },
          ]);
        },
      };

      const result = yield* runByokAgentLoop(
        { ...baseInput, maxContextMessages: 5 },
        model,
        broker,
      );

      expect(result.text).toBe("recovered");
      expect(result.rounds).toBe(3);
      expect(modelInputs.map((input) => input.turn)).toEqual([1, 2, 3, 3]);
      expect(modelInputs[2]?.messages).toHaveLength(5);
      expect(modelInputs[3]?.messages).toHaveLength(3);
      expect(modelInputs[3]?.messages).toEqual([
        { role: "user", content: baseInput.prompt },
        expect.objectContaining({ role: "assistant" }),
        expect.objectContaining({ role: "tool", toolCallId: "call-2" }),
      ]);
      expect(brokerCalls).toBe(2);
      expect(result.messages).toEqual(modelInputs[3]?.messages);
    }),
  );

  it.effect("恢复请求再次溢出时原样失败且不重复工具调用", () =>
    Effect.gen(function* () {
      let modelCalls = 0;
      let brokerCalls = 0;
      const broker = ToolBroker.ToolBroker.of({
        invoke: (input) =>
          Effect.sync(() => {
            brokerCalls += 1;
            return makeResult(input);
          }),
        cancel: () => Effect.void,
      });
      const model: ByokAgentModelDriver = {
        complete: (input) => {
          modelCalls += 1;
          if (modelCalls >= 3) {
            return Stream.fail(
              new ByokAgentModelError({ code: "context_overflow", detail: "still too large" }),
            );
          }
          return Stream.fromIterable([
            {
              type: "tool_call" as const,
              toolCallId: `call-${input.turn}`,
              canonicalToolName: "workspace.read_file",
              arguments: { relativePath: `${input.turn}.txt` },
            },
            { type: "model_completed" as const },
          ]);
        },
      };

      const error = yield* Effect.flip(
        runByokAgentLoop({ ...baseInput, maxContextMessages: 5 }, model, broker),
      );

      expect(error).toMatchObject({ code: "context_overflow", detail: "still too large" });
      expect(modelCalls).toBe(4);
      expect(brokerCalls).toBe(2);
    }),
  );

  it.effect("普通模型错误不触发上下文恢复", () =>
    Effect.gen(function* () {
      let modelCalls = 0;
      const broker = ToolBroker.ToolBroker.of({
        invoke: (input) => Effect.succeed(makeResult(input)),
        cancel: () => Effect.void,
      });
      const model: ByokAgentModelDriver = {
        complete: () => {
          modelCalls += 1;
          return Stream.fail(
            new ByokAgentModelError({ code: "byok_engine_error", detail: "unauthorized" }),
          );
        },
      };

      const error = yield* Effect.flip(runByokAgentLoop(baseInput, model, broker));

      expect(error).toMatchObject({ code: "byok_engine_error", detail: "unauthorized" });
      expect(modelCalls).toBe(1);
    }),
  );

  it.effect("仅断流时同一 turn 最多轮询 10 次", () =>
    Effect.gen(function* () {
      let modelCalls = 0;
      const broker = ToolBroker.ToolBroker.of({
        invoke: (input) => Effect.succeed(makeResult(input)),
        cancel: () => Effect.void,
      });
      const model: ByokAgentModelDriver = {
        complete: () => {
          modelCalls += 1;
          return modelCalls <= 10
            ? Stream.fail(
                new ByokAgentModelError({
                  code: "byok_engine_error",
                  detail: "stream disconnected",
                  reason: "transport_error",
                  retryable: true,
                }),
              )
            : Stream.fromIterable([
                { type: "text_delta" as const, text: "recovered" },
                { type: "model_completed" as const },
              ]);
        },
      };

      const result = yield* runByokAgentLoop(baseInput, model, broker);

      expect(result.text).toBe("recovered");
      expect(result.rounds).toBe(1);
      expect(modelCalls).toBe(11);
    }),
  );

  it.effect("已产生模型输出后失败时不重试也不执行工具", () =>
    Effect.gen(function* () {
      let modelCalls = 0;
      let brokerCalls = 0;
      const broker = ToolBroker.ToolBroker.of({
        invoke: (input) =>
          Effect.sync(() => {
            brokerCalls += 1;
            return makeResult(input);
          }),
        cancel: () => Effect.void,
      });
      const model: ByokAgentModelDriver = {
        complete: () => {
          modelCalls += 1;
          return Stream.succeed({ type: "text_delta" as const, text: "partial" }).pipe(
            Stream.concat(
              Stream.fail(
                new ByokAgentModelError({
                  code: "byok_engine_error",
                  detail: "stream disconnected",
                  reason: "transport_error",
                  retryable: true,
                }),
              ),
            ),
          );
        },
      };

      const error = yield* Effect.flip(runByokAgentLoop(baseInput, model, broker));

      expect(error).toMatchObject({ reason: "transport_error", retryable: true });
      expect(modelCalls).toBe(1);
      expect(brokerCalls).toBe(0);
    }),
  );

  it.effect("模型输出截断后携带部分回答续写一次", () =>
    Effect.gen(function* () {
      const checkpoints: Array<{
        readonly turn: number;
        readonly chunkIndex: number;
        readonly delta: string;
        readonly cumulativeUtf8Bytes: number;
      }> = [];
      let brokerCalls = 0;
      const broker = ToolBroker.ToolBroker.of({
        invoke: (input) =>
          Effect.sync(() => {
            brokerCalls += 1;
            return makeResult(input);
          }),
        cancel: () => Effect.void,
      });
      const modelInputs: Array<Parameters<ByokAgentModelDriver["complete"]>[0]> = [];
      const model: ByokAgentModelDriver = {
        complete: (input) => {
          modelInputs.push(input);
          return modelInputs.length === 1
            ? Stream.fromIterable([
                { type: "text_delta" as const, text: "部分" },
                { type: "text_delta" as const, text: "输出" },
              ]).pipe(
                Stream.concat(
                  Stream.fail(
                    new ByokAgentModelError({
                      code: "byok_engine_error",
                      detail: "output truncated",
                      reason: "output_truncated",
                      retryable: false,
                    }),
                  ),
                ),
              )
            : Stream.fromIterable([
                { type: "text_delta" as const, text: "继续完成" },
                { type: "model_completed" as const },
              ]);
        },
      };

      const result = yield* runByokAgentLoop(
        {
          ...baseInput,
          onTextCheckpoint: (checkpoint) =>
            Effect.sync(() => {
              checkpoints.push(checkpoint);
            }),
        },
        model,
        broker,
      );

      expect(result.text).toBe("部分输出继续完成");
      expect(modelInputs).toHaveLength(2);
      expect(modelInputs[1]?.messages.slice(-2)).toEqual([
        { role: "assistant", content: "部分输出" },
        {
          role: "user",
          content:
            "Continue exactly where the previous response stopped. Do not repeat prior text.",
        },
      ]);
      expect(checkpoints).toEqual([
        { turn: 1, chunkIndex: 0, delta: "部分", cumulativeUtf8Bytes: 6 },
        { turn: 1, chunkIndex: 1, delta: "输出", cumulativeUtf8Bytes: 12 },
        { turn: 1, chunkIndex: 2, delta: "继续完成", cumulativeUtf8Bytes: 24 },
      ]);
      expect(brokerCalls).toBe(0);
    }),
  );

  for (const truncatedFirst of [true, false]) {
    it.effect(`${truncatedFirst ? "截断续写后" : "已有正文后"}上下文溢出不重新回答`, () =>
      Effect.gen(function* () {
        let modelCalls = 0;
        let brokerCalls = 0;
        const checkpoints: Array<{ readonly delta: string; readonly chunkIndex: number }> = [];
        const broker = ToolBroker.ToolBroker.of({
          invoke: (input) =>
            Effect.sync(() => {
              brokerCalls += 1;
              return makeResult(input);
            }),
          cancel: () => Effect.void,
        });
        const contextError = new ByokAgentModelError({
          code: "context_overflow",
          reason: "context_overflow",
          detail: "context too large",
          retryable: true,
        });
        const model: ByokAgentModelDriver = {
          complete: () => {
            modelCalls += 1;
            if (modelCalls === 1) {
              return Stream.succeed({ type: "text_delta" as const, text: "A" }).pipe(
                Stream.concat(
                  Stream.fail(
                    truncatedFirst
                      ? new ByokAgentModelError({
                          code: "byok_engine_error",
                          reason: "output_truncated",
                          detail: "output truncated",
                        })
                      : contextError,
                  ),
                ),
              );
            }
            if (truncatedFirst && modelCalls === 2) return Stream.fail(contextError);
            return Stream.fromIterable([
              { type: "text_delta" as const, text: "重新回答" },
              { type: "model_completed" as const },
            ]);
          },
        };

        const error = yield* Effect.flip(
          runByokAgentLoop(
            {
              ...baseInput,
              onTextCheckpoint: (checkpoint) =>
                Effect.sync(() => {
                  checkpoints.push(checkpoint);
                }),
            },
            model,
            broker,
          ),
        );

        expect(error).toBe(contextError);
        expect(modelCalls).toBe(truncatedFirst ? 2 : 1);
        expect(checkpoints).toEqual([
          { turn: 1, chunkIndex: 0, delta: "A", cumulativeUtf8Bytes: 1 },
        ]);
        expect(brokerCalls).toBe(0);
      }),
    );
  }

  for (const reason of ["output_truncated", "terminal_event_missing"] as const) {
    it.effect(`${reason} 即使误标为可重试也不会重放请求`, () =>
      Effect.gen(function* () {
        let modelCalls = 0;
        const broker = ToolBroker.ToolBroker.of({
          invoke: (input) => Effect.succeed(makeResult(input)),
          cancel: () => Effect.void,
        });
        const model: ByokAgentModelDriver = {
          complete: () => {
            modelCalls += 1;
            return Stream.fail(
              new ByokAgentModelError({
                code: "byok_engine_error",
                detail: reason,
                reason,
                retryable: true,
              }),
            );
          },
        };

        const error = yield* Effect.flip(runByokAgentLoop(baseInput, model, broker));

        expect(error).toMatchObject({ reason });
        expect(modelCalls).toBe(1);
      }),
    );
  }

  it.effect("工具调用尚未收口即截断时不执行 ToolBroker", () =>
    Effect.gen(function* () {
      let brokerCalls = 0;
      const broker = ToolBroker.ToolBroker.of({
        invoke: (input) =>
          Effect.sync(() => {
            brokerCalls += 1;
            return makeResult(input);
          }),
        cancel: () => Effect.void,
      });
      const model: ByokAgentModelDriver = {
        complete: () =>
          Stream.succeed({
            type: "tool_call" as const,
            toolCallId: "call-truncated",
            canonicalToolName: "workspace.read_file",
            arguments: { relativePath: "README.md" },
          }).pipe(
            Stream.concat(
              Stream.fail(
                new ByokAgentModelError({
                  code: "byok_engine_error",
                  detail: "output truncated",
                  reason: "output_truncated",
                  retryable: false,
                }),
              ),
            ),
          ),
      };

      const error = yield* Effect.flip(runByokAgentLoop(baseInput, model, broker));

      expect(error).toMatchObject({ reason: "output_truncated" });
      expect(brokerCalls).toBe(0);
    }),
  );

  it.effect("非断流瞬时失败不触发轮询", () =>
    Effect.gen(function* () {
      let modelCalls = 0;
      const broker = ToolBroker.ToolBroker.of({
        invoke: (input) => Effect.succeed(makeResult(input)),
        cancel: () => Effect.void,
      });
      const model: ByokAgentModelDriver = {
        complete: () => {
          modelCalls += 1;
          return Stream.fail(
            new ByokAgentModelError({
              code: "byok_engine_error",
              detail: "unavailable",
              reason: "unavailable",
              retryable: true,
            }),
          );
        },
      };

      const error = yield* Effect.flip(runByokAgentLoop(baseInput, model, broker));

      expect(error).toMatchObject({ detail: "unavailable", retryable: true });
      expect(modelCalls).toBe(1);
    }),
  );

  it.effect("已有工具轮次后的 503 不轮询且不会重复调用 ToolBroker", () =>
    Effect.gen(function* () {
      const turns: number[] = [];
      let brokerCalls = 0;
      const broker = ToolBroker.ToolBroker.of({
        invoke: (input) =>
          Effect.sync(() => {
            brokerCalls += 1;
            return makeResult(input);
          }),
        cancel: () => Effect.void,
      });
      const model: ByokAgentModelDriver = {
        complete: (input) => {
          turns.push(input.turn);
          if (turns.length === 1) {
            return Stream.fromIterable([
              {
                type: "tool_call" as const,
                toolCallId: "call-before-retry",
                canonicalToolName: "workspace.read_file",
                arguments: { relativePath: "README.md" },
              },
              { type: "model_completed" as const },
            ]);
          }
          if (turns.length === 2) {
            return Stream.fail(
              new ByokAgentModelError({
                code: "byok_engine_error",
                detail: "HTTP 503",
                reason: "unavailable",
                retryable: true,
              }),
            );
          }
          return Stream.fromIterable([
            { type: "text_delta" as const, text: "done" },
            { type: "model_completed" as const },
          ]);
        },
      };

      const error = yield* Effect.flip(runByokAgentLoop(baseInput, model, broker));

      expect(error).toMatchObject({ detail: "HTTP 503", retryable: true });
      expect(turns).toEqual([1, 2]);
      expect(brokerCalls).toBe(1);
    }),
  );

  it.effect("取消错误即使被标记为可重试也不会重放请求", () =>
    Effect.gen(function* () {
      let modelCalls = 0;
      const broker = ToolBroker.ToolBroker.of({
        invoke: (input) => Effect.succeed(makeResult(input)),
        cancel: () => Effect.void,
      });
      const model: ByokAgentModelDriver = {
        complete: () => {
          modelCalls += 1;
          return Stream.fail(
            new ByokAgentModelError({
              code: "byok_engine_error",
              detail: "canceled",
              reason: "canceled",
              retryable: true,
            }),
          );
        },
      };

      const error = yield* Effect.flip(runByokAgentLoop(baseInput, model, broker));

      expect(error).toMatchObject({ reason: "canceled" });
      expect(modelCalls).toBe(1);
    }),
  );

  it.effect("限流错误不按 Retry-After 轮询", () =>
    Effect.gen(function* () {
      let modelCalls = 0;
      const broker = ToolBroker.ToolBroker.of({
        invoke: (input) => Effect.succeed(makeResult(input)),
        cancel: () => Effect.void,
      });
      const model: ByokAgentModelDriver = {
        complete: () => {
          modelCalls += 1;
          return Stream.fail(
            new ByokAgentModelError({
              code: "byok_engine_error",
              detail: "rate limited",
              reason: "rate_limit",
              retryable: true,
              retryAfterMs: 5_000,
            }),
          );
        },
      };
      const error = yield* Effect.flip(runByokAgentLoop(baseInput, model, broker));

      expect(error).toMatchObject({ detail: "rate limited", reason: "rate_limit" });
      expect(modelCalls).toBe(1);
    }),
  );
});
