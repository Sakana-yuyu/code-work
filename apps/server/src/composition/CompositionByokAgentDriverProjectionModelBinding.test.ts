import { expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@codework/contracts";
import * as Effect from "effect/Effect";

import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import {
  compositionByokAgentId,
  makeCompositionByokAgentDriverProjection,
} from "./CompositionByokAgentDriverRegistry.ts";

it.effect("BYOK Projection 为结构化 Run 启用当前 Provider 配置校验", () =>
  Effect.gen(function* () {
    const instanceId = ProviderInstanceId.make("byok-projection");
    const agentId = compositionByokAgentId(instanceId);
    const instance = {
      instanceId,
      driverKind: ProviderDriverKind.make("byok"),
      enabled: true,
      composition: {
        defaultModelId: "adapter-coder",
        modelDescriptors: [
          {
            adapterId: "adapter-coder",
            modelId: "deepseek-coder-v3",
            protocol: "openai" as const,
            baseURL: "https://api.example.test/v1",
            configurationDigest: "sha256:current",
          },
        ],
        resolveModelDriver: () => Effect.die("配置漂移必须在模型驱动解析前失败"),
      },
    } as unknown as ProviderInstance;
    const projection = makeCompositionByokAgentDriverProjection({
      providerRegistry: {
        listInstances: Effect.succeed([instance]),
      },
      agentService: {
        run: () => Effect.die("配置漂移必须在 Agent Service 调用前失败"),
      },
      checkpointStore: { appendEventIfNew: () => Effect.succeed(true) },
    });
    yield* projection.refresh;
    const driver = yield* projection.registry.get(agentId);

    const error = yield* Effect.flip(
      driver!.startTask({
        task: {
          taskId: "task-projection-model",
          projectId: "project-1",
          assigneeKind: "agent",
          assigneeId: agentId,
          mode: "serial",
          status: "queued",
          promptDigest: "sha256:prompt",
          dependsOnTaskIds: [],
          createdAtUnixMs: 1,
          updatedAtUnixMs: 1,
        },
        run: {
          runId: "run-projection-model",
          taskId: "task-projection-model",
          agentId,
          runtimeId: `byok:${instanceId}`,
          status: "queued",
          attempt: 1,
          modelSnapshot: {
            kind: "byok",
            providerInstanceId: instanceId,
            adapterId: "adapter-coder",
            modelId: "deepseek-coder-v3",
            adapterConfigDigest: "sha256:stale",
          },
          capabilityGrantIds: [],
        },
        prompt: "完成任务",
        workspaceRoot: "C:/workspace",
        model: "adapter-coder",
      }),
    );

    expect(error.code).toBe("squad_model_configuration_changed");
  }),
);
