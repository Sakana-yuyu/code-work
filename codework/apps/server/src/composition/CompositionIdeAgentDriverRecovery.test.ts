import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";

import { makeCompositionIdeAgentDriver } from "./CompositionIdeAgentDriver.ts";
import {
  makeCompositionIdeSessionRegistry,
  type CompositionIdeAdapter,
} from "./CompositionIdeSessionRegistry.ts";

const task = {
  taskId: "task-ide-recovery",
  projectId: "project-ide-recovery",
  assigneeKind: "agent" as const,
  assigneeId: "ide:vscode-recovery",
  mode: "serial" as const,
  status: "queued" as const,
  promptDigest: "sha256:ide-recovery",
  dependsOnTaskIds: [],
  createdAtUnixMs: 1,
  updatedAtUnixMs: 1,
};

const run = {
  runId: "run-ide-recovery",
  taskId: task.taskId,
  agentId: task.assigneeId,
  runtimeId: task.assigneeId,
  status: "queued" as const,
  attempt: 1,
  capabilityGrantIds: ["grant-ide-recovery"],
};

const reconcileInput = {
  task,
  run,
  intent: {
    taskId: task.taskId,
    runId: run.runId,
    previousRunId: null,
    agentId: run.agentId,
    runtimeId: run.runtimeId,
    attempt: run.attempt,
    payloadDigest: "sha256:payload-ide-recovery",
    capabilityDigest: "sha256:capability-ide-recovery",
    state: "dispatching" as const,
    revision: 2,
    claimId: "claim-ide-recovery",
    runtimeTaskId: null,
    capabilityHandshakeId: null,
    outcomeCode: null,
    outcomeDetail: null,
    createdAtUnixMs: 1,
    updatedAtUnixMs: 2,
  },
  capabilityIds: ["ide.invoke"],
};

it.effect("IDE 恢复只探测现有 session：离线延后，在线但无查询协议时人工收口", () =>
  Effect.gen(function* () {
    const registry = makeCompositionIdeSessionRegistry();
    const driver = makeCompositionIdeAgentDriver({
      registry,
      sessionId: "vscode-recovery",
      profile: "vscode_ide",
    });

    expect(driver.startRecoveryPolicy).toEqual({
      mode: "reconcile-only",
      requiredReceipt: "runtime-task",
      capabilityGrantReplay: { mode: "verified" },
    });
    if (driver.reconcileStart === undefined) {
      return yield* Effect.die("IDE Driver 必须提供 reconcileStart。");
    }

    expect(yield* driver.reconcileStart(reconcileInput)).toEqual({
      action: "defer",
      code: "run_start_ide_session_unavailable",
      detail: "IDE session 尚未连接或探测未就绪，Run Start 恢复已延后。",
    });

    let handshakeCalls = 0;
    let invokeCalls = 0;
    const adapter: CompositionIdeAdapter = {
      sessionId: "vscode-recovery",
      profile: "vscode_ide",
      probe: () =>
        Effect.succeed({
          sessionId: "vscode-recovery",
          profile: "vscode_ide",
          status: "ready",
          verifiedOperations: ["task.start", "task.cancel", "task.events"],
        }),
      handshake: (input) => {
        handshakeCalls += 1;
        return Effect.succeed({
          ...input,
          profile: "vscode_ide" as const,
          status: "accepted" as const,
          handshakeId: "unexpected-handshake",
          acceptedGrantIds: [...input.capabilityGrantIds],
          verifiedOperations: [...input.requestedOperations],
        });
      },
      invoke: () => {
        invokeCalls += 1;
        return Effect.succeed({ runtimeTaskId: "unexpected-runtime-task" });
      },
    };
    yield* registry.register(adapter);

    expect(yield* driver.reconcileStart(reconcileInput)).toEqual({
      action: "manual",
      code: "run_start_ide_task_query_unsupported",
      detail: "IDE session 已连接，但当前 bridge 没有旧任务查询协议，禁止盲目重放 task.start。",
    });
    expect(handshakeCalls).toBe(0);
    expect(invokeCalls).toBe(0);
  }),
);
