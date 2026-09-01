import { expect, it } from "@effect/vitest";
import type { CompositionTaskRunModelSnapshot } from "@codework/contracts";
import * as Effect from "effect/Effect";

import { makeCompositionByokAgentDriver } from "./CompositionByokAgentDriver.ts";
import { CompositionAgentDriverFailure } from "./CompositionOrchestrator.ts";

const task = {
  taskId: "task-model-binding",
  projectId: "project-1",
  assigneeKind: "agent" as const,
  assigneeId: "provider:byok-primary",
  mode: "serial" as const,
  status: "queued" as const,
  promptDigest: "sha256:prompt",
  dependsOnTaskIds: [],
  createdAtUnixMs: 1,
  updatedAtUnixMs: 1,
};

const modelSnapshot: CompositionTaskRunModelSnapshot = {
  kind: "byok",
  providerInstanceId: "byok-primary",
  adapterId: "adapter-coder",
  modelId: "deepseek-coder-v3",
  adapterConfigDigest: "sha256:adapter-coder-v1",
};

const run = {
  runId: "run-model-binding",
  taskId: task.taskId,
  agentId: task.assigneeId,
  runtimeId: "byok:byok-primary",
  status: "queued" as const,
  attempt: 1,
  modelSnapshot,
  capabilityGrantIds: [],
};

const validationFailure = () =>
  new CompositionAgentDriverFailure({
    code: "squad_model_configuration_changed",
    detail: "Adapter 配置已变化",
  });

it.effect("首次启动在调用模型前校验持久化模型快照", () =>
  Effect.gen(function* () {
    const validations: unknown[] = [];
    const driver = makeCompositionByokAgentDriver({
      agentId: task.assigneeId,
      runtimeId: "byok:byok-primary",
      providerInstanceId: "byok-primary",
      validateRunModel: (input) =>
        Effect.sync(() => {
          validations.push(input);
        }),
      agentService: {
        run: () => Effect.never,
      },
      checkpointStore: { appendEventIfNew: () => Effect.succeed(true) },
      listTools: () => Effect.succeed([]),
    });

    yield* driver.startTask({
      task,
      run,
      prompt: "完成任务",
      workspaceRoot: "C:/workspace",
      model: modelSnapshot.adapterId,
    });

    expect(validations).toEqual([
      {
        agentId: task.assigneeId,
        providerInstanceId: "byok-primary",
        model: modelSnapshot.adapterId,
        modelSnapshot,
      },
    ]);
    yield* driver.cancelTask({ task, run, reason: "测试完成" });
  }),
);

it.effect("首次启动在快照校验失败时不创建运行 Fiber", () =>
  Effect.gen(function* () {
    let serviceCalls = 0;
    const driver = makeCompositionByokAgentDriver({
      agentId: task.assigneeId,
      runtimeId: "byok:byok-primary",
      providerInstanceId: "byok-primary",
      validateRunModel: () => Effect.fail(validationFailure()),
      agentService: {
        run: () => {
          serviceCalls += 1;
          return Effect.succeed({ text: "完成", messages: [], rounds: 1 });
        },
      },
      checkpointStore: { appendEventIfNew: () => Effect.succeed(true) },
      listTools: () => Effect.succeed([]),
    });

    const error = yield* Effect.flip(
      driver.startTask({
        task,
        run,
        prompt: "完成任务",
        workspaceRoot: "C:/workspace",
        model: modelSnapshot.adapterId,
      }),
    );

    expect(error.code).toBe("squad_model_configuration_changed");
    expect(serviceCalls).toBe(0);
  }),
);

it.effect("跨重启恢复在读取 checkpoint 前重新校验模型快照", () =>
  Effect.gen(function* () {
    let historyReads = 0;
    const driver = makeCompositionByokAgentDriver({
      agentId: task.assigneeId,
      runtimeId: "byok:byok-primary",
      providerInstanceId: "byok-primary",
      validateRunModel: () => Effect.fail(validationFailure()),
      agentService: {
        run: () => Effect.succeed({ text: "完成", messages: [], rounds: 1 }),
      },
      checkpointStore: { appendEventIfNew: () => Effect.succeed(true) },
      checkpointHistory: {
        listEvents: () => {
          historyReads += 1;
          return Effect.succeed([]);
        },
      },
      listTools: () => Effect.succeed([]),
    });

    const error = yield* Effect.flip(driver.resumeTask!({ task, run, reason: "进程重启后恢复" }));

    expect(error.code).toBe("squad_model_configuration_changed");
    expect(historyReads).toBe(0);
  }),
);
