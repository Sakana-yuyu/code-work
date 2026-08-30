import type { CompositionTask, CompositionTaskRun } from "@codework/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { CompositionRunStartIntent } from "../persistence/Services/CompositionRunStartStore.ts";
import { makeCompositionAgentDriverRegistry } from "./CompositionAgentDriverRegistry.ts";
import {
  CompositionAgentDriverFailure,
  type CompositionAgentDriver,
} from "./CompositionOrchestrator.ts";
import {
  planCompositionRunStartRecoveries,
  type CompositionRunStartRecoveryCandidate,
} from "./CompositionRunStartRecoveryPolicy.ts";

const reconciled = new Set(["provider-sessions", "ide-sessions", "runtime-adapters"] as const);

const makeCandidate = (
  suffix: string,
  overrides: Partial<CompositionRunStartRecoveryCandidate> = {},
): CompositionRunStartRecoveryCandidate => {
  const task = {
    taskId: `task-${suffix}`,
    projectId: "project-run-start-recovery",
    assigneeKind: "agent" as const,
    assigneeId: `agent-${suffix}`,
    mode: "serial" as const,
    status: "queued" as const,
    promptDigest: `sha256:prompt-${suffix}`,
    dependsOnTaskIds: [],
    createdAtUnixMs: 1,
    updatedAtUnixMs: 1,
  } satisfies CompositionTask;
  const run = {
    runId: `run-${suffix}`,
    taskId: task.taskId,
    agentId: task.assigneeId,
    runtimeId: `runtime-${suffix}`,
    status: "queued" as const,
    attempt: 1,
    capabilityGrantIds: [],
  } satisfies CompositionTaskRun;
  const intent = {
    taskId: task.taskId,
    runId: run.runId,
    previousRunId: null,
    agentId: run.agentId,
    runtimeId: run.runtimeId,
    attempt: run.attempt,
    payloadDigest: `sha256:payload-${suffix}`,
    capabilityDigest: `sha256:capability-${suffix}`,
    state: "dispatching" as const,
    revision: 3,
    claimId: `claim-${suffix}`,
    runtimeTaskId: null,
    capabilityHandshakeId: null,
    outcomeCode: null,
    outcomeDetail: null,
    createdAtUnixMs: 1,
    updatedAtUnixMs: 2,
  } satisfies CompositionRunStartIntent;
  return {
    task,
    run,
    intent,
    capabilityIds: [],
    ...overrides,
  };
};

const makeDriver = (
  candidate: CompositionRunStartRecoveryCandidate,
  overrides: Partial<CompositionAgentDriver> = {},
): CompositionAgentDriver => ({
  agentId: candidate.intent.agentId,
  runtimeId: candidate.intent.runtimeId,
  startRecoveryPolicy: {
    mode: "idempotent-replay",
    requiredReceipt: "runtime-task",
    capabilityGrantReplay: { mode: "none" },
  },
  startTask: () => Effect.succeed({ runtimeTaskId: `runtime-task-${candidate.intent.runId}` }),
  cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
  ...overrides,
});

it.effect("所有启动恢复决策都等待 Provider、IDE 与 Runtime reconcile 门禁", () =>
  Effect.gen(function* () {
    const candidate = makeCandidate("gated");
    let reconcileCalls = 0;
    const registry = makeCompositionAgentDriverRegistry();
    yield* registry.register(
      makeDriver(candidate, {
        reconcileStart: () =>
          Effect.sync(() => {
            reconcileCalls += 1;
            return { action: "replay" as const };
          }),
      }),
    );

    const [plan] = yield* planCompositionRunStartRecoveries({
      candidates: [candidate],
      driverRegistry: registry,
      reconciled: new Set(["ide-sessions", "runtime-adapters"] as const),
    });

    assert.deepEqual(plan, {
      taskId: candidate.task.taskId,
      runId: candidate.run.runId,
      action: "defer",
      code: "run_start_provider_sessions_reconciliation_pending",
      detail: "Provider session 启动收口尚未完成，Run Start 恢复已延后。",
    });
    assert.equal(reconcileCalls, 0);
  }),
);

it.effect("单个 Driver defect 被隔离，后续可安全重放的意图仍会完成规划", () =>
  Effect.gen(function* () {
    const broken = makeCandidate("broken");
    const healthy = makeCandidate("healthy");
    const registry = makeCompositionAgentDriverRegistry();
    yield* registry.register(
      makeDriver(broken, {
        reconcileStart: () => Effect.die(new Error("driver secret must not escape")),
      }),
    );
    yield* registry.register(makeDriver(healthy));

    const plans = yield* planCompositionRunStartRecoveries({
      candidates: [broken, healthy],
      driverRegistry: registry,
      reconciled,
    });

    assert.deepEqual(
      plans.map(({ runId, action, code }) => ({ runId, action, code })),
      [
        {
          runId: broken.run.runId,
          action: "defer",
          code: "run_start_driver_reconciliation_failed",
        },
        { runId: healthy.run.runId, action: "replay", code: undefined },
      ],
    );
    assert.notInclude(plans[0]?.detail ?? "", "driver secret");
  }),
);

it.effect("Driver 被移除时只延后当前意图，不阻断其他 Driver", () =>
  Effect.gen(function* () {
    const removed = makeCandidate("removed");
    const healthy = makeCandidate("remaining");
    const registry = makeCompositionAgentDriverRegistry();
    yield* registry.register(makeDriver(healthy));

    const plans = yield* planCompositionRunStartRecoveries({
      candidates: [removed, healthy],
      driverRegistry: registry,
      reconciled,
    });

    assert.deepEqual(
      plans.map(({ runId, action, code }) => ({ runId, action, code })),
      [
        {
          runId: removed.run.runId,
          action: "defer",
          code: "run_start_agent_driver_unavailable",
        },
        { runId: healthy.run.runId, action: "replay", code: undefined },
      ],
    );
  }),
);

it.effect("单个 Driver typed failure 不泄露详情，也不阻断后续恢复项", () =>
  Effect.gen(function* () {
    const broken = makeCandidate("typed-failure");
    const healthy = makeCandidate("after-typed-failure");
    const registry = makeCompositionAgentDriverRegistry();
    yield* registry.register(
      makeDriver(broken, {
        reconcileStart: () =>
          Effect.fail(
            new CompositionAgentDriverFailure({
              code: "provider_probe_failed",
              detail: "sensitive provider failure detail",
            }),
          ),
      }),
    );
    yield* registry.register(makeDriver(healthy));

    const plans = yield* planCompositionRunStartRecoveries({
      candidates: [broken, healthy],
      driverRegistry: registry,
      reconciled,
    });

    assert.deepEqual(
      plans.map(({ runId, action, code }) => ({ runId, action, code })),
      [
        {
          runId: broken.run.runId,
          action: "defer",
          code: "run_start_driver_reconciliation_failed",
        },
        { runId: healthy.run.runId, action: "replay", code: undefined },
      ],
    );
    assert.notInclude(plans[0]?.detail ?? "", "sensitive provider failure detail");
  }),
);

it.effect("Task、Run 与持久启动意图身份不一致时 quarantine，且不调用 Driver", () =>
  Effect.gen(function* () {
    const candidate = makeCandidate("identity-mismatch");
    let reconcileCalls = 0;
    const registry = makeCompositionAgentDriverRegistry();
    yield* registry.register(
      makeDriver(candidate, {
        reconcileStart: () =>
          Effect.sync(() => {
            reconcileCalls += 1;
            return { action: "replay" as const };
          }),
      }),
    );

    const mismatches: ReadonlyArray<CompositionRunStartRecoveryCandidate> = [
      { ...candidate, run: { ...candidate.run, taskId: "task-corrupted" } },
      { ...candidate, intent: { ...candidate.intent, taskId: "task-intent-corrupted" } },
      { ...candidate, intent: { ...candidate.intent, runId: "run-intent-corrupted" } },
      { ...candidate, intent: { ...candidate.intent, agentId: "agent-intent-corrupted" } },
      { ...candidate, intent: { ...candidate.intent, runtimeId: "runtime-intent-corrupted" } },
      { ...candidate, intent: { ...candidate.intent, attempt: candidate.intent.attempt + 1 } },
    ];
    for (const mismatch of mismatches) {
      const [plan] = yield* planCompositionRunStartRecoveries({
        candidates: [mismatch],
        driverRegistry: registry,
        reconciled,
      });

      assert.deepEqual(plan, {
        taskId: mismatch.task.taskId,
        runId: mismatch.run.runId,
        action: "quarantine",
        code: "run_start_recovery_identity_mismatch",
        detail: "Task、Run 与持久 Run Start 意图的身份不一致，已阻止自动恢复。",
      });
    }
    assert.equal(reconcileCalls, 0);
  }),
);

it.effect("旧密文缺 capabilityIds 时稳定 quarantine，绝不按空授权重放", () =>
  Effect.gen(function* () {
    const candidate = makeCandidate("legacy-capabilities", { capabilityIds: null });
    const registry = makeCompositionAgentDriverRegistry();
    yield* registry.register(makeDriver(candidate));

    const [plan] = yield* planCompositionRunStartRecoveries({
      candidates: [candidate],
      driverRegistry: registry,
      reconciled,
    });

    assert.deepEqual(plan, {
      taskId: candidate.task.taskId,
      runId: candidate.run.runId,
      action: "quarantine",
      code: "run_start_legacy_input_capabilities_unknown",
      detail: "旧加密输入无法确认 capabilityIds，已阻止自动外部启动。",
    });
  }),
);

it.effect("reconcile-only Driver 不能把未验证的 replay 决策升级为外部重放", () =>
  Effect.gen(function* () {
    const candidate = makeCandidate("reconcile-only");
    const registry = makeCompositionAgentDriverRegistry();
    yield* registry.register(
      makeDriver(candidate, {
        startRecoveryPolicy: {
          mode: "reconcile-only",
          requiredReceipt: "runtime-task",
          capabilityGrantReplay: { mode: "none" },
        },
        reconcileStart: () => Effect.succeed({ action: "replay" as const }),
      }),
    );

    const [plan] = yield* planCompositionRunStartRecoveries({
      candidates: [candidate],
      driverRegistry: registry,
      reconciled,
    });

    assert.equal(plan?.action, "manual");
    assert.equal(plan?.code, "run_start_driver_replay_policy_conflict");
  }),
);

it.effect("Driver reconcile 得到可验证 receipt 时只恢复接受事实，不调用 startTask", () =>
  Effect.gen(function* () {
    const candidate = makeCandidate("accepted");
    let startCalls = 0;
    const registry = makeCompositionAgentDriverRegistry();
    yield* registry.register(
      makeDriver(candidate, {
        startTask: () =>
          Effect.sync(() => {
            startCalls += 1;
            return { runtimeTaskId: "unexpected" };
          }),
        reconcileStart: () =>
          Effect.succeed({
            action: "accepted" as const,
            runtimeTaskId: "runtime-task-reconciled",
          }),
      }),
    );

    const [plan] = yield* planCompositionRunStartRecoveries({
      candidates: [candidate],
      driverRegistry: registry,
      reconciled,
    });

    assert.deepEqual(plan, {
      taskId: candidate.task.taskId,
      runId: candidate.run.runId,
      action: "accept",
      runtimeTaskId: "runtime-task-reconciled",
      capabilityHandshakeId: null,
    });
    assert.equal(startCalls, 0);
  }),
);
