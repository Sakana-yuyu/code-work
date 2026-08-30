import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderSession,
} from "@codework/contracts";
import * as Effect from "effect/Effect";

import { makeCompositionProviderAgentDriver } from "./CompositionProviderAgentDriver.ts";

const providerInstanceId = ProviderInstanceId.make("codex-recovery");
const task = {
  taskId: "task-provider-recovery",
  projectId: "project-provider-recovery",
  threadId: "thread-provider-recovery",
  assigneeKind: "agent" as const,
  assigneeId: "provider:codex-recovery",
  mode: "serial" as const,
  status: "queued" as const,
  promptDigest: "sha256:provider-recovery",
  dependsOnTaskIds: [],
  createdAtUnixMs: 1,
  updatedAtUnixMs: 1,
};

const run = {
  runId: "run-provider-recovery",
  taskId: task.taskId,
  agentId: task.assigneeId,
  runtimeId: task.assigneeId,
  status: "queued" as const,
  attempt: 1,
  capabilityGrantIds: [],
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
    payloadDigest: "sha256:payload-provider-recovery",
    capabilityDigest: "sha256:capability-provider-recovery",
    state: "dispatching" as const,
    revision: 2,
    claimId: "claim-provider-recovery",
    runtimeTaskId: null,
    capabilityHandshakeId: null,
    outcomeCode: null,
    outcomeDetail: null,
    createdAtUnixMs: 1,
    updatedAtUnixMs: 2,
  },
  capabilityIds: [],
};

const activeSession = {
  provider: ProviderDriverKind.make("codex"),
  providerInstanceId,
  status: "running",
  runtimeMode: "full-access",
  threadId: ThreadId.make(task.threadId),
  activeTurnId: TurnId.make("turn-provider-recovery"),
  createdAt: "2026-08-30T00:00:00.000Z",
  updatedAt: "2026-08-30T00:00:01.000Z",
} satisfies ProviderSession;

const makeDriver = (sessions: ReadonlyArray<ProviderSession>) =>
  makeCompositionProviderAgentDriver({
    agentId: task.assigneeId,
    runtimeId: run.runtimeId,
    providerInstanceId,
    adapter: {
      listSessions: () => Effect.succeed(sessions),
      startSession: () => Effect.die("恢复核对不应启动 Provider session"),
      sendTurn: () => Effect.die("恢复核对不应发送 Provider turn"),
      interruptTurn: () => Effect.die("恢复核对不应中断 Provider turn"),
      stopSession: () => Effect.die("恢复核对不应停止 Provider session"),
    },
  });

it.effect("Provider 仅凭同实例、同 thread 的 activeTurnId 恢复 runtime receipt", () =>
  Effect.gen(function* () {
    const driver = makeDriver([activeSession]);

    expect(driver.startRecoveryPolicy).toEqual({
      mode: "reconcile-only",
      requiredReceipt: "runtime-task",
      capabilityGrantReplay: { mode: "verified" },
    });
    if (driver.reconcileStart === undefined) {
      return yield* Effect.die("Provider Driver 必须提供 reconcileStart。");
    }

    expect(yield* driver.reconcileStart(reconcileInput)).toEqual({
      action: "accepted",
      runtimeTaskId: "provider:codex-recovery:thread-provider-recovery:turn-provider-recovery",
    });
  }),
);

it.effect("Provider 没有可证明的活动 turn 时要求人工收口，不重放外部启动", () =>
  Effect.gen(function* () {
    const driver = makeDriver([{ ...activeSession, activeTurnId: undefined, status: "ready" }]);
    if (driver.reconcileStart === undefined) {
      return yield* Effect.die("Provider Driver 必须提供 reconcileStart。");
    }

    expect(yield* driver.reconcileStart(reconcileInput)).toEqual({
      action: "manual",
      code: "run_start_provider_active_turn_missing",
      detail: "Provider session 存在但没有可证明的 activeTurnId，需要人工核对外部启动结果。",
    });
  }),
);

it.effect("Provider session 非 running 时即使残留 activeTurnId 也不得恢复 receipt", () =>
  Effect.gen(function* () {
    const driver = makeDriver([{ ...activeSession, status: "ready" }]);
    if (driver.reconcileStart === undefined) {
      return yield* Effect.die("Provider Driver 必须提供 reconcileStart。");
    }

    expect(yield* driver.reconcileStart(reconcileInput)).toEqual({
      action: "manual",
      code: "run_start_provider_session_not_running",
      detail: "Provider session 当前不是 running，不能把残留 activeTurnId 当作启动 receipt。",
    });
  }),
);

it.effect("Provider thread 存在其他实例 session 时拒绝猜测启动归属", () =>
  Effect.gen(function* () {
    const driver = makeDriver([
      activeSession,
      {
        ...activeSession,
        providerInstanceId: ProviderInstanceId.make("other-provider-instance"),
      },
    ]);
    if (driver.reconcileStart === undefined) {
      return yield* Effect.die("Provider Driver 必须提供 reconcileStart。");
    }

    expect(yield* driver.reconcileStart(reconcileInput)).toEqual({
      action: "manual",
      code: "run_start_provider_session_scope_conflict",
      detail: "Provider thread 的活动 session 归属不唯一，拒绝猜测 Run Start receipt。",
    });
  }),
);
