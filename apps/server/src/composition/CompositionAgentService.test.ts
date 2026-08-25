import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import {
  CompositionAgentServiceError,
  makeCompositionAgentService,
} from "./CompositionAgentService.ts";
import type { ByokAgentModelDriver } from "./ByokAgentLoop.ts";
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
  it("runs the explicit agent loop through the resolved model driver", async () => {
    const service = makeCompositionAgentService({
      broker: makeBroker(),
      resolveModelDriver: () => Effect.succeed(modelDriver),
    });

    await expect(Effect.runPromise(service.run(input))).resolves.toMatchObject({
      text: "完成",
      rounds: 1,
    });
  });

  it("preserves a resolver error instead of silently falling back to legacy text", async () => {
    const error = new CompositionAgentServiceError({
      code: "agent_loop_unsupported",
      detail: "protocol anthropic is not supported",
    });
    const service = makeCompositionAgentService({
      broker: makeBroker(),
      resolveModelDriver: () => Effect.fail(error),
    });

    await expect(Effect.runPromise(service.run(input))).rejects.toMatchObject({
      code: "agent_loop_unsupported",
    });
  });

  it("returns a stable error when the selected provider has no composition driver", async () => {
    const registry = {
      getInstance: () => Effect.succeed(void 0),
      listInstances: Effect.succeed([]),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.die("not used in this test"),
    } satisfies ProviderInstanceRegistry.ProviderInstanceRegistry["Service"];
    const service = makeCompositionAgentServiceFromRegistry(registry, makeBroker());

    await expect(Effect.runPromise(service.run(input))).rejects.toMatchObject({
      code: "provider_composition_unavailable",
    });
  });

  it("启动 Agent Loop 时把 capability ID 签发为 task-scoped grant", async () => {
    const capturedGrantIds: string[][] = [];
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
    const grantRegistry = makeCapabilityGrantRegistry({ capabilityRegistry, now: () => 1000 });
    const service = makeCompositionAgentService({
      broker,
      grantRegistry,
      resolveModelDriver: () => Effect.succeed(loopModel),
    });

    await Effect.runPromise(
      service.run({
        ...input,
        capabilityGrantIds: ["t3.workspace.read_file"],
      }),
    );
    expect(capturedGrantIds[0]?.[0]).toMatch(/^grant-/);
  });
});
