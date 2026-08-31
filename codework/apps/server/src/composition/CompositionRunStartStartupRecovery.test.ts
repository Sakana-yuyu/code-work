import { assert, it } from "@effect/vitest";
import type { CompositionTask, CompositionTaskRun } from "@codework/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

import type { CompositionRunStartIntent } from "../persistence/Services/CompositionRunStartStore.ts";
import type {
  CompositionTaskInputStoreError,
  CompositionTaskInputStoreShape,
} from "../persistence/Services/CompositionTaskInputStore.ts";
import type { CompositionTaskStoreShape } from "../persistence/Services/CompositionTaskStore.ts";
import { makeCompositionAgentDriverRegistry } from "./CompositionAgentDriverRegistry.ts";
import { makeCompositionRunStartDigests } from "./CompositionRunStartLifecycle.ts";
import {
  recoverCompositionRunStarts,
  type CompositionRunStartStartupRecoveryOptions,
} from "./CompositionRunStartStartupRecovery.ts";

const reconciled = new Set(["provider-sessions", "ide-sessions", "runtime-adapters"] as const);

type StartupRecoveryFixture = {
  readonly task: CompositionTask;
  readonly run: CompositionTaskRun;
  readonly intent: CompositionRunStartIntent;
  readonly recoveryInput: Parameters<CompositionTaskInputStoreShape["save"]>[0];
  readonly externalTargetIdentity: {
    readonly runtimeKind: string;
    readonly providerInstanceId: string | null;
    readonly adapterId: string | null;
    readonly modelIdentity: string | null;
    readonly configDigest: string | null;
    readonly sessionMode: string | null;
  };
};

const makeFixture = (suffix: string): StartupRecoveryFixture => {
  const task: CompositionTask = {
    taskId: `task-run-start-startup-${suffix}`,
    projectId: `project-run-start-startup-${suffix}`,
    assigneeKind: "agent",
    assigneeId: `agent-run-start-startup-${suffix}`,
    mode: "serial",
    status: "queued",
    promptDigest: `sha256:prompt-run-start-startup-${suffix}`,
    dependsOnTaskIds: [],
    createdAtUnixMs: 1,
    updatedAtUnixMs: 1,
  };
  const run: CompositionTaskRun = {
    taskId: task.taskId,
    runId: `run-run-start-startup-${suffix}`,
    agentId: task.assigneeId,
    runtimeId: `runtime-run-start-startup-${suffix}`,
    status: "queued",
    attempt: 1,
    capabilityGrantIds: [],
  };
  const workspaceRootDigest = `sha256:workspace-run-start-startup-${suffix}`;
  const model = `model-run-start-startup-${suffix}`;
  const externalTargetIdentity = {
    runtimeKind: "provider",
    providerInstanceId: null,
    adapterId: null,
    modelIdentity: model,
    configDigest: null,
    sessionMode: "test",
  };
  const capabilityIds = ["t3.workspace.read_file"];
  const digests = makeCompositionRunStartDigests({
    taskId: task.taskId,
    projectId: task.projectId,
    runId: run.runId,
    previousRunId: null,
    assigneeKind: task.assigneeKind,
    assigneeId: task.assigneeId,
    mode: task.mode,
    dependsOnTaskIds: task.dependsOnTaskIds,
    agentId: run.agentId,
    runtimeId: run.runtimeId,
    attempt: run.attempt,
    promptDigest: task.promptDigest,
    workspaceRootDigest,
    model,
    externalTargetIdentity,
    capabilityIds,
  });
  const intent: CompositionRunStartIntent = {
    taskId: task.taskId,
    runId: run.runId,
    previousRunId: null,
    agentId: run.agentId,
    runtimeId: run.runtimeId,
    attempt: run.attempt,
    ...digests,
    state: "dispatching",
    revision: 3,
    claimId: `claim-run-start-startup-${suffix}`,
    ownerEpoch: 1,
    ownerLeaseExpiresAtUnixMs: 100,
    runtimeTaskId: null,
    capabilityHandshakeId: null,
    outcomeCode: null,
    outcomeDetail: null,
    createdAtUnixMs: 1,
    updatedAtUnixMs: 2,
  };
  const recoveryInput = {
    taskId: task.taskId,
    prompt: `恢复 ${task.taskId}`,
    workspaceRoot: `C:/workspace/${suffix}`,
    workspaceRootDigest,
    model,
    capabilityIds,
  } satisfies Parameters<CompositionTaskInputStoreShape["save"]>[0];

  return { task, run, intent, recoveryInput, externalTargetIdentity };
};

const makeOptions = (input: {
  readonly intents: ReadonlyArray<CompositionRunStartIntent>;
  readonly fixtures: ReadonlyMap<string, StartupRecoveryFixture>;
  readonly driverRegistry: ReturnType<typeof makeCompositionAgentDriverRegistry>;
  readonly execute: CompositionRunStartStartupRecoveryOptions["executor"]["execute"];
  readonly recordUnrecoverable?: CompositionRunStartStartupRecoveryOptions["executor"]["recordUnrecoverable"];
  readonly inputStore?: Pick<CompositionTaskInputStoreShape, "get">;
  readonly runStartStore?: CompositionRunStartStartupRecoveryOptions["runStartStore"];
  readonly reconciled?: CompositionRunStartStartupRecoveryOptions["reconciled"];
}): CompositionRunStartStartupRecoveryOptions => ({
  runStartStore:
    input.runStartStore ??
    ({
      getRecoverableScanUpperBound: Effect.succeed(
        Option.fromNullishOr(
          input.intents
            .map((intent) => intent.runId)
            .toSorted()
            .at(-1),
        ),
      ),
      listRecoverable: () => Effect.succeed(input.intents),
    } satisfies CompositionRunStartStartupRecoveryOptions["runStartStore"]),
  taskStore: {
    getTask: (taskId) => Effect.succeed(Option.fromNullishOr(input.fixtures.get(taskId)?.task)),
    getRun: (runId) =>
      Effect.succeed(
        Option.fromNullishOr(
          [...input.fixtures.values()].find((fixture) => fixture.run.runId === runId)?.run,
        ),
      ),
  } satisfies Pick<CompositionTaskStoreShape, "getTask" | "getRun">,
  inputStore:
    input.inputStore ??
    ({
      get: (taskId) =>
        Effect.succeed(Option.fromNullishOr(input.fixtures.get(taskId)?.recoveryInput)),
    } satisfies Pick<CompositionTaskInputStoreShape, "get">),
  driverRegistry: input.driverRegistry,
  reconciled: input.reconciled ?? reconciled,
  executor: {
    execute: input.execute,
    recordUnrecoverable:
      input.recordUnrecoverable ??
      ((unrecoverable) =>
        Effect.succeed({
          taskId: unrecoverable.intent.taskId,
          runId: unrecoverable.intent.runId,
          action: "quarantine" as const,
          code: unrecoverable.code,
          detail: unrecoverable.detail,
        })),
  },
});

it.effect("前 200 个 transient defer 不得饿死第 201 个可恢复候选", () =>
  Effect.gen(function* () {
    const fixtures = Array.from({ length: 201 }, (_, index) => makeFixture(`fair-${index + 1}`));
    const fixtureByTaskId = new Map(fixtures.map((fixture) => [fixture.task.taskId, fixture]));
    const intents = fixtures
      .map((fixture) => fixture.intent)
      .toSorted((left, right) =>
        left.updatedAtUnixMs === right.updatedAtUnixMs
          ? left.runId.localeCompare(right.runId)
          : left.updatedAtUnixMs - right.updatedAtUnixMs,
      );
    const executions: string[] = [];
    const driverRegistry = makeCompositionAgentDriverRegistry();
    const receipt = yield* recoverCompositionRunStarts(
      makeOptions({
        intents,
        fixtures: fixtureByTaskId,
        driverRegistry,
        runStartStore: {
          getRecoverableScanUpperBound: Effect.succeed(
            Option.fromNullishOr(
              intents
                .map((intent) => intent.runId)
                .toSorted()
                .at(-1),
            ),
          ),
          listRecoverable: ({ limit, after, throughRunId }) => {
            assert.equal(limit, 200);
            return Effect.succeed(
              intents
                .filter(
                  (intent) =>
                    (after === undefined || intent.runId > after.runId) &&
                    (throughRunId === undefined || intent.runId <= throughRunId),
                )
                .slice(0, limit),
            );
          },
        },
        execute: (input) =>
          Effect.sync(() => {
            executions.push(input.candidate.run.runId);
            return input.plan;
          }),
      }),
    );

    assert.equal(executions.length, 201);
    assert.include(executions, intents[200]?.runId ?? "");
    assert.equal(receipt.plans.length, 201);
    assert.isTrue(receipt.plans.every((plan) => plan.action === "defer"));
  }),
);

it.effect("扫描期间候选 updatedAt 变化不得让同一 Run 在单次恢复中重复执行", () =>
  Effect.gen(function* () {
    const fixtures = Array.from({ length: 201 }, (_, index) =>
      makeFixture(`stable-scan-${index + 1}`),
    );
    const fixtureByTaskId = new Map(fixtures.map((fixture) => [fixture.task.taskId, fixture]));
    let intents = fixtures
      .map((fixture) => fixture.intent)
      .toSorted((left, right) =>
        left.updatedAtUnixMs === right.updatedAtUnixMs
          ? left.runId.localeCompare(right.runId)
          : left.updatedAtUnixMs - right.updatedAtUnixMs,
      );
    const firstRunId = intents[0]?.runId ?? "";
    const executions: string[] = [];
    const driverRegistry = makeCompositionAgentDriverRegistry();

    const receipt = yield* recoverCompositionRunStarts(
      makeOptions({
        intents,
        fixtures: fixtureByTaskId,
        driverRegistry,
        runStartStore: {
          getRecoverableScanUpperBound: Effect.succeed(
            Option.fromNullishOr(
              intents
                .map((intent) => intent.runId)
                .toSorted()
                .at(-1),
            ),
          ),
          listRecoverable: ({ limit, after, throughRunId }) =>
            Effect.sync(() =>
              intents
                .filter(
                  (intent) =>
                    (after === undefined || intent.runId > after.runId) &&
                    (throughRunId === undefined || intent.runId <= throughRunId),
                )
                .toSorted((left, right) => left.runId.localeCompare(right.runId))
                .slice(0, limit),
            ),
        },
        execute: (input) =>
          Effect.sync(() => {
            executions.push(input.candidate.run.runId);
            if (input.candidate.run.runId === firstRunId) {
              intents = intents.map((intent) =>
                intent.runId === firstRunId
                  ? { ...intent, updatedAtUnixMs: intent.updatedAtUnixMs + 10_000 }
                  : intent,
              );
            }
            return input.plan;
          }),
      }),
    );

    assert.equal(new Set(executions).size, 201);
    assert.equal(executions.length, 201);
    assert.equal(receipt.plans.length, 201);
  }),
);

it.effect("启动扫描遇到 settled 意图时必须跳过，不能把 queued Run 再次交给执行器", () =>
  Effect.gen(function* () {
    const fixture = makeFixture("settled-queued");
    const settled = { ...fixture.intent, state: "settled" as const };
    const executions: string[] = [];
    const receipt = yield* recoverCompositionRunStarts(
      makeOptions({
        intents: [settled],
        fixtures: new Map([[fixture.task.taskId, fixture]]),
        driverRegistry: makeCompositionAgentDriverRegistry(),
        execute: (input) =>
          Effect.sync(() => {
            executions.push(input.candidate.run.runId);
            return input.plan;
          }),
      }),
    );

    assert.deepEqual(receipt.plans, []);
    assert.deepEqual(executions, []);
  }),
);

it.effect("恢复 receipt 使用所有候选中最早的 lease 唤醒时间", () =>
  Effect.gen(function* () {
    const later = makeFixture("retry-later");
    const earlier = makeFixture("retry-earlier");
    const driverRegistry = makeCompositionAgentDriverRegistry();

    const receipt = yield* recoverCompositionRunStarts(
      makeOptions({
        intents: [later.intent, earlier.intent],
        fixtures: new Map([
          [later.task.taskId, later],
          [earlier.task.taskId, earlier],
        ]),
        driverRegistry,
        execute: ({ candidate, plan }) =>
          Effect.succeed({
            ...plan,
            retryAtUnixMs: candidate.run.runId === earlier.run.runId ? 120 : 240,
          }),
      }),
    );

    assert.equal(receipt.nextRecoveryAtUnixMs, 120);
  }),
);

it.effect("已验证 receipt 的启动恢复只投影 accepted，不重复调用 Driver.startTask", () =>
  Effect.gen(function* () {
    const fixture = makeFixture("accepted");
    const driverRegistry = makeCompositionAgentDriverRegistry();
    let starts = 0;
    const executions: string[] = [];
    yield* driverRegistry.register({
      agentId: fixture.run.agentId,
      runtimeId: fixture.run.runtimeId,
      getStartIdentity: () => fixture.externalTargetIdentity,
      startRecoveryPolicy: { mode: "reconcile-only", requiredReceipt: "runtime-task" },
      reconcileStart: () =>
        Effect.succeed({
          action: "accepted" as const,
          runtimeTaskId: "runtime-task-run-start-startup-accepted",
        }),
      startTask: () =>
        Effect.sync(() => {
          starts += 1;
          return { runtimeTaskId: "unexpected" };
        }),
      cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
    });

    const receipt = yield* recoverCompositionRunStarts(
      makeOptions({
        intents: [fixture.intent],
        fixtures: new Map([[fixture.task.taskId, fixture]]),
        driverRegistry,
        execute: (input) =>
          Effect.sync(() => {
            executions.push(input.plan.action);
            return input.plan;
          }),
      }),
    );

    assert.equal(starts, 0);
    assert.deepEqual(executions, ["accept"]);
    assert.deepEqual(
      receipt.plans.map((plan) => plan.action),
      ["accept"],
    );
  }),
);

it.effect("旧密文缺 capabilityIds 时隔离意图且不调用 Driver.startTask", () =>
  Effect.gen(function* () {
    const fixture = makeFixture("legacy-capabilities");
    const legacyFixture: StartupRecoveryFixture = {
      task: fixture.task,
      run: fixture.run,
      intent: fixture.intent,
      recoveryInput: {
        taskId: fixture.recoveryInput.taskId,
        prompt: fixture.recoveryInput.prompt,
        workspaceRoot: fixture.recoveryInput.workspaceRoot,
        ...(fixture.recoveryInput.workspaceRootDigest === undefined
          ? {}
          : { workspaceRootDigest: fixture.recoveryInput.workspaceRootDigest }),
        ...(fixture.recoveryInput.model === undefined
          ? {}
          : { model: fixture.recoveryInput.model }),
      },
      externalTargetIdentity: fixture.externalTargetIdentity,
    };
    const driverRegistry = makeCompositionAgentDriverRegistry();
    let starts = 0;
    yield* driverRegistry.register({
      agentId: legacyFixture.run.agentId,
      runtimeId: legacyFixture.run.runtimeId,
      getStartIdentity: () => legacyFixture.externalTargetIdentity,
      startRecoveryPolicy: { mode: "idempotent-replay", requiredReceipt: "runtime-task" },
      startTask: () =>
        Effect.sync(() => {
          starts += 1;
          return { runtimeTaskId: "unexpected" };
        }),
      cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
    });
    const executions: string[] = [];

    const receipt = yield* recoverCompositionRunStarts(
      makeOptions({
        intents: [legacyFixture.intent],
        fixtures: new Map([[legacyFixture.task.taskId, legacyFixture]]),
        driverRegistry,
        execute: (input) =>
          Effect.sync(() => {
            executions.push(input.plan.action);
            return input.plan;
          }),
      }),
    );

    assert.equal(starts, 0);
    assert.deepEqual(executions, ["quarantine"]);
    assert.equal(receipt.plans[0]?.code, "run_start_legacy_input_capabilities_unknown");
  }),
);

it.effect("单个候选加载 defect 被隔离，紧邻健康候选仍会执行", () =>
  Effect.gen(function* () {
    const broken = makeFixture("candidate-defect");
    const healthy = makeFixture("candidate-healthy");
    const driverRegistry = makeCompositionAgentDriverRegistry();
    yield* driverRegistry.register({
      agentId: healthy.run.agentId,
      runtimeId: healthy.run.runtimeId,
      getStartIdentity: () => healthy.externalTargetIdentity,
      startRecoveryPolicy: { mode: "idempotent-replay", requiredReceipt: "runtime-task" },
      startTask: () => Effect.succeed({ runtimeTaskId: "runtime-task-candidate-healthy" }),
      cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
    });
    const executions: string[] = [];
    const unrecoverable: string[] = [];
    const options = makeOptions({
      intents: [broken.intent, healthy.intent],
      fixtures: new Map([
        [broken.task.taskId, broken],
        [healthy.task.taskId, healthy],
      ]),
      driverRegistry,
      execute: (input) =>
        Effect.sync(() => {
          executions.push(input.candidate.run.runId);
          return input.plan;
        }),
      recordUnrecoverable: (input) =>
        Effect.sync(() => {
          unrecoverable.push(input.intent.runId);
          return {
            taskId: input.intent.taskId,
            runId: input.intent.runId,
            action: "defer" as const,
            code: input.code,
            detail: input.detail,
          };
        }),
      inputStore: {
        get: (taskId) =>
          taskId === broken.task.taskId
            ? Effect.die("候选输入解密 defect")
            : Effect.succeed(
                Option.fromNullishOr(
                  taskId === healthy.task.taskId ? healthy.recoveryInput : undefined,
                ),
              ),
      },
    });

    const receipt = yield* recoverCompositionRunStarts(options);

    assert.deepEqual(unrecoverable, [broken.run.runId]);
    assert.deepEqual(executions, [healthy.run.runId]);
    assert.deepEqual(
      receipt.plans.map((plan) => plan.runId),
      [broken.run.runId, healthy.run.runId],
    );
  }),
);

it.effect("中断与 defect 混合时启动恢复必须传播中断", () =>
  Effect.gen(function* () {
    const fixture = makeFixture("mixed-interrupt");
    const driverRegistry = makeCompositionAgentDriverRegistry();
    const mixedCause = Cause.fromReasons<CompositionTaskInputStoreError>([
      Cause.makeInterruptReason(0),
      Cause.makeDieReason(new Error("startup-recovery-defect")),
    ]);
    const options = makeOptions({
      intents: [fixture.intent],
      fixtures: new Map([[fixture.task.taskId, fixture]]),
      driverRegistry,
      execute: () => Effect.die("unused"),
      inputStore: {
        get: () => Effect.failCause(mixedCause),
      },
    });

    const exit = yield* Effect.exit(recoverCompositionRunStarts(options));

    assert.isTrue(Exit.isFailure(exit));
    if (Exit.isFailure(exit)) {
      assert.isTrue(Cause.interruptors(exit.cause).size > 0);
    }
  }),
);
