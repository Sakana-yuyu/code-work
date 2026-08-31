import { it as effectIt } from "@effect/vitest";
import { expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";

import { makeCompositionRuntimeAgentDriver } from "./CompositionRuntimeAgentDriver.ts";
import { makeInMemoryCompositionRuntimeAdapter } from "./CompositionRuntimeAdapter.ts";

const makeReconcileInput = (runtimeId: string, agentId: string) => {
  const task = {
    taskId: "task-runtime-recovery",
    projectId: "project-runtime-recovery",
    assigneeKind: "agent" as const,
    assigneeId: agentId,
    mode: "serial" as const,
    status: "queued" as const,
    promptDigest: "sha256:runtime-recovery",
    dependsOnTaskIds: [],
    createdAtUnixMs: 1,
    updatedAtUnixMs: 1,
  };
  const run = {
    runId: "run-runtime-recovery",
    taskId: task.taskId,
    agentId,
    runtimeId,
    status: "queued" as const,
    attempt: 1,
    capabilityGrantIds: [],
  };
  return {
    task,
    run,
    intent: {
      taskId: task.taskId,
      runId: run.runId,
      previousRunId: null,
      agentId,
      runtimeId,
      attempt: run.attempt,
      payloadDigest: "sha256:payload-runtime-recovery",
      capabilityDigest: "sha256:capability-runtime-recovery",
      state: "dispatching" as const,
      revision: 2,
      claimId: "claim-runtime-recovery",
      ownerEpoch: 1,
      ownerLeaseExpiresAtUnixMs: 1_000,
      runtimeTaskId: null,
      capabilityHandshakeId: null,
      outcomeCode: null,
      outcomeDetail: null,
      createdAtUnixMs: 1,
      updatedAtUnixMs: 2,
    },
    capabilityIds: [],
  };
};

it("内存 Runtime Adapter 明确声明跨进程启动只能人工恢复", () => {
  const adapter = makeInMemoryCompositionRuntimeAdapter({ runtimeId: "runtime-memory-recovery" });
  const driver = makeCompositionRuntimeAgentDriver({
    adapter,
    agentId: "runtime-memory-recovery:agent",
  });

  expect(adapter.startRecoveryPolicy).toEqual({
    mode: "manual",
    requiredReceipt: "runtime-task",
    capabilityGrantReplay: { mode: "verified" },
  });
  expect(driver.startRecoveryPolicy).toEqual(adapter.startRecoveryPolicy);
  expect(driver.reconcileStart).toBeUndefined();
});

effectIt.effect("Runtime Agent Driver 原样采用 Adapter 的恢复策略与核对结果", () =>
  Effect.gen(function* () {
    const base = makeInMemoryCompositionRuntimeAdapter({ runtimeId: "runtime-delegated-recovery" });
    const adapter = {
      ...base,
      startRecoveryPolicy: {
        mode: "reconcile-only" as const,
        requiredReceipt: "runtime-task" as const,
        capabilityGrantReplay: { mode: "verified" as const },
      },
      reconcileStart: () =>
        Effect.succeed({
          action: "accepted" as const,
          runtimeTaskId: "runtime-delegated-task",
        }),
    };
    const driver = makeCompositionRuntimeAgentDriver({
      adapter,
      agentId: "runtime-delegated-recovery:agent",
    });

    expect(driver.startRecoveryPolicy).toEqual(adapter.startRecoveryPolicy);
    if (driver.reconcileStart === undefined) {
      return yield* Effect.die("Runtime Agent Driver 必须转接 Adapter.reconcileStart。");
    }
    expect(
      yield* driver.reconcileStart(
        makeReconcileInput(adapter.runtimeId, "runtime-delegated-recovery:agent"),
      ),
    ).toEqual({
      action: "accepted",
      runtimeTaskId: "runtime-delegated-task",
    });
  }),
);
