import { describe, expect } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import {
  CompositionAgentServiceError,
  makeCompositionAgentService,
} from "./CompositionAgentService.ts";
import { ByokAgentModelError, type ByokAgentModelDriver } from "./ByokAgentLoop.ts";
import type * as ToolBroker from "./ToolBroker.ts";
import type * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import { makeCompositionAgentServiceFromRegistry } from "./CompositionAgentService.ts";
import { makeCompositionCapabilityRegistry } from "./CapabilityRegistry.ts";
import { makeCapabilityGrantRegistry } from "./CapabilityGrantRegistry.ts";

const makeBroker = (): ToolBroker.ToolBroker["Service"] => ({
  invoke: () =>
    Effect.succeed({
      invocationId: "invocation-1",
      taskId: "task-1",
      runId: "run-1",
      toolCallId: "call-1",
      canonicalToolName: "workspace.read_file",
      status: "succeeded" as const,
      result: { contents: "ok" },
      startedAtUnixMs: 1,
      finishedAtUnixMs: 2,
    }),
  cancel: () => Effect.void,
});

const modelDriver: ByokAgentModelDriver = {
  complete: () =>
    Stream.succeed({ type: "text_delta" as const, text: "完成" }).pipe(
      Stream.concat(Stream.succeed({ type: "model_completed" as const })),
    ),
};

const input = {
  providerInstanceId: "byok",
  modelId: "openai/gpt-5",
  taskId: "task-1",
  runId: "run-1",
  agentId: "agent-1",
  workspaceRoot: "C:/workspace",
  prompt: "检查项目",
  capabilityGrantIds: [],
  tools: [],
};

describe("CompositionAgentService", () => {
  effectIt.effect("runs the explicit agent loop through the resolved model driver", () =>
    Effect.gen(function* () {
      let capturedRuntimeId: string | undefined;
      const broker: ToolBroker.ToolBroker["Service"] = {
        invoke: (brokerInput) => {
          capturedRuntimeId = brokerInput.runtimeId;
          return Effect.succeed({
            invocationId: "invocation-1",
            taskId: brokerInput.taskId,
            runId: brokerInput.runId,
            toolCallId: brokerInput.toolCallId,
            canonicalToolName: brokerInput.canonicalToolName,
            status: "succeeded" as const,
            result: { contents: "ok" },
          });
        },
        cancel: () => Effect.void,
      };
      let turn = 0;
      const loopModel: ByokAgentModelDriver = {
        complete: () => {
          turn += 1;
          return turn === 1
            ? Stream.succeed({
                type: "tool_call" as const,
                toolCallId: "call-runtime-context",
                canonicalToolName: "workspace.read_file",
                arguments: { cwd: "C:/workspace", relativePath: "README.md" },
              }).pipe(Stream.concat(Stream.succeed({ type: "model_completed" as const })))
            : modelDriver.complete({ messages: [], tools: [], turn });
        },
      };
      const service = makeCompositionAgentService({
        broker,
        resolveModelDriver: () => Effect.succeed(loopModel),
      });

      const result = yield* service.run(input);
      expect(result).toMatchObject({
        text: "完成",
        rounds: 2,
      });
      expect(capturedRuntimeId).toBe(input.providerInstanceId);
    }),
  );

  effectIt.effect("把模型文本 checkpoint 逐段传给调用方", () =>
    Effect.gen(function* () {
      const checkpoints: string[] = [];
      const service = makeCompositionAgentService({
        broker: makeBroker(),
        resolveModelDriver: () => Effect.succeed(modelDriver),
      });

      const result = yield* service.run({
        ...input,
        onTextCheckpoint: (checkpoint) =>
          Effect.sync(() => {
            checkpoints.push(checkpoint.delta);
          }),
      });
      expect(result).toMatchObject({ text: "完成" });
      expect(checkpoints).toEqual(["完成"]);
    }),
  );

  effectIt.effect("把取消 signal 传递给 Provider Model Driver", () =>
    Effect.gen(function* () {
      const controller = new AbortController();
      let receivedSignal: AbortSignal | undefined;
      const service = makeCompositionAgentService({
        broker: makeBroker(),
        resolveModelDriver: (input) => {
          receivedSignal = input.signal;
          return Effect.succeed(modelDriver);
        },
      });

      yield* service.run({ ...input, signal: controller.signal });
      expect(receivedSignal).toBe(controller.signal);
    }),
  );

  effectIt.effect(
    "preserves a resolver error instead of silently falling back to legacy text",
    () =>
      Effect.gen(function* () {
        const error = new CompositionAgentServiceError({
          code: "agent_loop_unsupported",
          detail: "protocol anthropic is not supported",
        });
        const service = makeCompositionAgentService({
          broker: makeBroker(),
          resolveModelDriver: () => Effect.fail(error),
        });

        const received = yield* Effect.flip(service.run(input));
        expect(received).toMatchObject({
          code: "agent_loop_unsupported",
        });
      }),
  );

  effectIt.effect("保留模型驱动返回的稳定失败码", () =>
    Effect.gen(function* () {
      const service = makeCompositionAgentService({
        broker: makeBroker(),
        resolveModelDriver: () =>
          Effect.succeed({
            complete: () =>
              Stream.fail(
                new ByokAgentModelError({
                  code: "temporary_model_failure",
                  detail: "Provider 暂时不可用",
                }),
              ),
          }),
      });

      const error = yield* Effect.flip(service.run(input));
      expect(error).toMatchObject({ code: "temporary_model_failure" });
    }),
  );

  effectIt.effect(
    "returns a stable error when the selected provider has no composition driver",
    () =>
      Effect.gen(function* () {
        const registry = {
          getInstance: () => Effect.succeed(void 0),
          listInstances: Effect.succeed([]),
          listUnavailable: Effect.succeed([]),
          streamChanges: Stream.empty,
          subscribeChanges: Effect.die("not used in this test"),
        } satisfies ProviderInstanceRegistry.ProviderInstanceRegistry["Service"];
        const service = makeCompositionAgentServiceFromRegistry(registry, makeBroker());

        const error = yield* Effect.flip(service.run(input));
        expect(error).toMatchObject({
          code: "provider_composition_unavailable",
        });
      }),
  );

  effectIt.effect("启动 Agent Loop 时把 capability ID 签发为 task-scoped grant", () =>
    Effect.gen(function* () {
      const capturedGrantIds: string[][] = [];
      const revokedGrantIds: string[] = [];
      let turn = 0;
      const loopModel: ByokAgentModelDriver = {
        complete: () => {
          turn += 1;
          return turn === 1
            ? Stream.succeed({
                type: "tool_call" as const,
                toolCallId: "call-1",
                canonicalToolName: "workspace.read_file",
                arguments: { cwd: "C:/workspace", relativePath: "README.md" },
              }).pipe(Stream.concat(Stream.succeed({ type: "model_completed" as const })))
            : Stream.succeed({ type: "text_delta" as const, text: "完成" }).pipe(
                Stream.concat(Stream.succeed({ type: "model_completed" as const })),
              );
        },
      };
      const broker: ToolBroker.ToolBroker["Service"] = {
        invoke: (brokerInput) => {
          capturedGrantIds.push([...brokerInput.capabilityGrantIds]);
          return Effect.succeed({
            invocationId: "invocation-1",
            taskId: brokerInput.taskId,
            runId: brokerInput.runId,
            toolCallId: brokerInput.toolCallId,
            canonicalToolName: brokerInput.canonicalToolName,
            status: "succeeded" as const,
            result: { contents: "ok" },
          });
        },
        cancel: () => Effect.void,
      };
      const capabilityRegistry = makeCompositionCapabilityRegistry();
      const baseGrantRegistry = makeCapabilityGrantRegistry({
        capabilityRegistry,
        now: () => 1000,
      });
      const grantRegistry = {
        ...baseGrantRegistry,
        revoke: (revokeInput: { readonly grantId: string }) =>
          baseGrantRegistry
            .revoke(revokeInput)
            .pipe(Effect.tap(() => Effect.sync(() => revokedGrantIds.push(revokeInput.grantId)))),
      };
      const service = makeCompositionAgentService({
        broker,
        grantRegistry,
        resolveModelDriver: () => Effect.succeed(loopModel),
      });

      yield* service.run({
        ...input,
        capabilityGrantIds: ["t3.workspace.read_file"],
      });
      expect(capturedGrantIds[0]?.[0]).toMatch(/^grant-/);
      expect(revokedGrantIds).toEqual(capturedGrantIds[0]);
    }),
  );

  effectIt.effect("把上下文与工具结果预算传递给 BYOK Loop", () =>
    Effect.gen(function* () {
      const modelInputs: Array<Parameters<ByokAgentModelDriver["complete"]>[0]> = [];
      const loopModel: ByokAgentModelDriver = {
        complete: (modelInput) => {
          modelInputs.push(modelInput);
          return modelInput.turn === 3
            ? Stream.fromIterable([
                { type: "text_delta" as const, text: "完成" },
                { type: "model_completed" as const },
              ])
            : Stream.fromIterable([
                {
                  type: "tool_call" as const,
                  toolCallId: `call-budget-${modelInput.turn}`,
                  canonicalToolName: "workspace.read_file",
                  arguments: { relativePath: `file-${modelInput.turn}.txt` },
                },
                { type: "model_completed" as const },
              ]);
        },
      };
      const broker: ToolBroker.ToolBroker["Service"] = {
        invoke: (brokerInput) =>
          Effect.succeed({
            invocationId: `invocation-${brokerInput.toolCallId}`,
            taskId: brokerInput.taskId,
            runId: brokerInput.runId,
            toolCallId: brokerInput.toolCallId,
            canonicalToolName: brokerInput.canonicalToolName,
            status: "succeeded" as const,
            result: { contents: "x".repeat(2_000) },
          }),
        cancel: () => Effect.void,
      };
      const service = makeCompositionAgentService({
        broker,
        resolveModelDriver: () => Effect.succeed(loopModel),
      });

      const result = yield* service.run({
        ...input,
        tools: [
          {
            canonicalToolName: "workspace.read_file",
            description: "读取文件",
            parameters: { type: "object" },
          },
        ],
        maxRounds: 3,
        maxContextMessages: 3,
        maxToolResultChars: 220,
      });
      const finalMessages = modelInputs[2]?.messages ?? [];

      expect(result.text).toBe("完成");
      expect(finalMessages).toHaveLength(3);
      expect(finalMessages[1]).toMatchObject({
        role: "assistant",
        toolCalls: [{ toolCallId: "call-budget-2" }],
      });
      expect(finalMessages[2]).toMatchObject({ role: "tool", toolCallId: "call-budget-2" });
      if (finalMessages[2]?.role === "tool") {
        expect(finalMessages[2].content.length).toBeLessThanOrEqual(220);
      }
    }),
  );
});
