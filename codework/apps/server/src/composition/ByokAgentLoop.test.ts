import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ToolBroker from "./ToolBroker.ts";
import {
  ByokAgentModelError,
  ByokAgentLoopMaxRoundsError,
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

  it("stops before an unbounded model/tool loop", async () => {
    const model: ByokAgentModelDriver = {
      complete: (input) =>
        Stream.fromIterable([
          {
            type: "tool_call" as const,
            toolCallId: `call-loop-${input.turn}`,
            canonicalToolName: "workspace.read_file",
            arguments: { cwd: "C:/workspace", relativePath: "README.md" },
          },
          { type: "model_completed" as const },
        ]),
    };
    const broker = ToolBroker.ToolBroker.of({
      invoke: (input) => Effect.succeed(makeResult(input)),
      cancel: () => Effect.void,
    });

    await expect(
      Effect.runPromise(runByokAgentLoop({ ...baseInput, maxRounds: 2 }, model, broker)),
    ).rejects.toBeInstanceOf(ByokAgentLoopMaxRoundsError);
  });

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
        { ...baseInput, maxRounds: 6, maxContextMessages: 5 },
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
        { ...baseInput, maxRounds: 3, maxContextMessages: 5 },
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
        runByokAgentLoop({ ...baseInput, maxRounds: 3, maxContextMessages: 5 }, model, broker),
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
});
