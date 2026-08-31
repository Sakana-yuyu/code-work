import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { CompositionRunStartStore } from "../persistence/Services/CompositionRunStartStore.ts";
import type {
  CompositionTaskInputStoreShape,
  CompositionTaskRecoveryInput,
} from "../persistence/Services/CompositionTaskInputStore.ts";
import { CompositionTaskStore } from "../persistence/Services/CompositionTaskStore.ts";
import { makeCompositionAgentDriverRegistry } from "./CompositionAgentDriverRegistry.ts";
import { makeCompositionOrchestrator } from "./CompositionOrchestrator.ts";
import { CompositionAgentDriverFailure } from "./CompositionOrchestratorErrors.ts";
import {
  compositionOrchestratorRunStartTestLayer,
  seedFailedRunStart,
} from "./CompositionOrchestratorRunStartTestSupport.ts";
import { seedDispatchingStart } from "./CompositionRetryRunStartDispatchRecoveryTestSupport.ts";
import { makeCompositionRunStartDigests } from "./CompositionRunStartLifecycle.ts";
import { recoverCompositionRunStarts } from "./CompositionRunStartStartupRecovery.ts";

const layer = it.layer(compositionOrchestratorRunStartTestLayer);

const makeInputStore = (
  inputs: ReadonlyMap<string, CompositionTaskRecoveryInput>,
): CompositionTaskInputStoreShape => ({
  save: () => Effect.void,
  get: (taskId) => Effect.succeed(Option.fromNullishOr(inputs.get(taskId))),
  remove: () => Effect.void,
});

const runtimeTaskPolicy = {
  mode: "idempotent-replay" as const,
  capabilityGrantReplay: { mode: "verified" as const },
  requiredReceipt: "runtime-task" as const,
};

layer("Composition Run Start Startup Recovery", (it) => {
  it.effect("单个离线 Driver、IDE 未连接和旧输入损坏不阻断其余 intent 恢复", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const cases = {
        offline: {
          taskId: "task-startup-offline",
          previousRunId: "run-startup-offline-old",
          runId: "run-startup-offline-new",
          agentId: "agent-startup-offline",
          runtimeId: "runtime-startup-offline",
          prompt: "离线 Driver 不得阻断扫描",
          workspaceRoot: "C:/workspace/startup-offline",
        },
        ide: {
          taskId: "task-startup-ide",
          previousRunId: "run-startup-ide-old",
          runId: "run-startup-ide-new",
          agentId: "agent-startup-ide",
          runtimeId: "runtime-startup-ide",
          prompt: "IDE 未连接不得阻断扫描",
          workspaceRoot: "C:/workspace/startup-ide",
        },
        legacy: {
          taskId: "task-startup-legacy-input",
          previousRunId: "run-startup-legacy-input-old",
          runId: "run-startup-legacy-input-new",
          agentId: "agent-startup-legacy-input",
          runtimeId: "runtime-startup-legacy-input",
          prompt: "旧输入缺少 capabilityIds 必须隔离",
          workspaceRoot: "C:/workspace/startup-legacy-input",
        },
        valid: {
          taskId: "task-startup-valid",
          previousRunId: "run-startup-valid-old",
          runId: "run-startup-valid-new",
          agentId: "agent-startup-valid",
          runtimeId: "runtime-startup-valid",
          prompt: "有效 intent 必须继续恢复",
          workspaceRoot: "C:/workspace/startup-valid",
        },
      } as const;

      for (const input of Object.values(cases)) {
        yield* seedDispatchingStart({ store, runStartStore, ...input });
      }

      const capabilityIds = ["t3.workspace.read_file"] as const;
      const inputStore = makeInputStore(
        new Map<string, CompositionTaskRecoveryInput>([
          [cases.offline.taskId, { ...cases.offline, capabilityIds }],
          [cases.ide.taskId, { ...cases.ide, capabilityIds }],
          [
            cases.legacy.taskId,
            {
              taskId: cases.legacy.taskId,
              prompt: cases.legacy.prompt,
              workspaceRoot: cases.legacy.workspaceRoot,
            },
          ],
          [cases.valid.taskId, { ...cases.valid, capabilityIds }],
        ]),
      );
      let validStartCalls = 0;
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId: cases.ide.agentId,
        runtimeId: cases.ide.runtimeId,
        startRecoveryPolicy: runtimeTaskPolicy,
        startTask: () =>
          Effect.fail(
            new CompositionAgentDriverFailure({
              code: "ide_runtime_not_connected",
              detail: "IDE 尚未连接",
            }),
          ),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
      });
      yield* driverRegistry.register({
        agentId: cases.valid.agentId,
        runtimeId: cases.valid.runtimeId,
        startRecoveryPolicy: runtimeTaskPolicy,
        startTask: () =>
          Effect.sync(() => {
            validStartCalls += 1;
            return { runtimeTaskId: "runtime-task-startup-valid" };
          }),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
      });
      const orchestrator = makeCompositionOrchestrator(
        store,
        driverRegistry,
        undefined,
        inputStore,
        runStartStore,
      );

      yield* recoverCompositionRunStarts({
        store,
        runStartStore,
        inputStore,
        orchestrator,
        recoveredAtUnixMs: 5_000,
      });

      assert.equal(validStartCalls, 1);
      assert.equal(
        Option.getOrThrow(yield* runStartStore.getStart(cases.valid.runId)).state,
        "settled",
      );
      assert.equal(Option.getOrThrow(yield* store.getRun(cases.valid.runId)).status, "running");

      const offlineIntent = Option.getOrThrow(
        yield* runStartStore.getStart(cases.offline.runId),
      );
      assert.equal(offlineIntent.state, "indeterminate");
      assert.equal(offlineIntent.outcomeCode, "agent_driver_unavailable");

      const ideIntent = Option.getOrThrow(yield* runStartStore.getStart(cases.ide.runId));
      assert.equal(ideIntent.state, "indeterminate");
      assert.equal(ideIntent.outcomeCode, "driver_start_result_indeterminate");

      const legacyIntent = Option.getOrThrow(
        yield* runStartStore.getStart(cases.legacy.runId),
      );
      assert.equal(legacyIntent.state, "indeterminate");
      assert.equal(legacyIntent.outcomeCode, "run_start_recovery_capability_ids_missing");
    }),
  );

  it.effect("settled RunStart 即使新 Run 仍是 queued 也不得在启动扫描中重派", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const input = {
        taskId: "task-startup-settled-queued",
        previousRunId: "run-startup-settled-queued-old",
        runId: "run-startup-settled-queued-new",
        agentId: "agent-startup-settled-queued",
        runtimeId: "runtime-startup-settled-queued",
        prompt: "settled 记录不得重新派发",
        workspaceRoot: "C:/workspace/startup-settled-queued",
      };
      const seeded = yield* seedDispatchingStart({ store, runStartStore, ...input });
      const claimId = seeded.dispatching.claimId;
      if (claimId === null) return yield* Effect.die("dispatching seed 缺少 claimId");
      const accepted = yield* runStartStore.markAccepted({
        runId: input.runId,
        expectedRevision: seeded.dispatching.revision,
        claimId,
        runtimeTaskId: "runtime-task-startup-settled-queued",
        acceptedAtUnixMs: 12,
      });
      yield* runStartStore.settleStart({
        runId: input.runId,
        expectedRevision: accepted.revision,
        claimId,
        settledAtUnixMs: 13,
      });

      let startCalls = 0;
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId: input.agentId,
        runtimeId: input.runtimeId,
        startRecoveryPolicy: runtimeTaskPolicy,
        startTask: () =>
          Effect.sync(() => {
            startCalls += 1;
            return { runtimeTaskId: "unexpected-runtime-task" };
          }),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
      });
      const inputStore = makeInputStore(
        new Map([
          [
            input.taskId,
            {
              taskId: input.taskId,
              prompt: input.prompt,
              workspaceRoot: input.workspaceRoot,
              capabilityIds: ["t3.workspace.read_file"],
            },
          ],
        ]),
      );
      const orchestrator = makeCompositionOrchestrator(
        store,
        driverRegistry,
        undefined,
        inputStore,
        runStartStore,
      );

      yield* recoverCompositionRunStarts({
        store,
        runStartStore,
        inputStore,
        orchestrator,
        recoveredAtUnixMs: 6_000,
      });

      assert.equal(startCalls, 0);
      assert.equal(Option.getOrThrow(yield* store.getRun(input.runId)).status, "queued");
      assert.equal(
        Option.getOrThrow(yield* runStartStore.getStart(input.runId)).state,
        "settled",
      );
    }),
  );

  for (const withLease of [false, true] as const) {
    it.effect(
      `prepared setup 在${withLease ? "租约已获取" : "租约获取前"}崩溃且输入不兼容时补偿 grant 与 lease`,
      () =>
        Effect.gen(function* () {
          const store = yield* CompositionTaskStore;
          const runStartStore = yield* CompositionRunStartStore;
          const suffix = withLease ? "with-lease" : "before-lease";
          const input = {
            taskId: `task-startup-setup-${suffix}`,
            previousRunId: `run-startup-setup-${suffix}-old`,
            runId: `run-startup-setup-${suffix}-new`,
            agentId: `agent-startup-setup-${suffix}`,
            runtimeId: `runtime-startup-setup-${suffix}`,
            prompt: `验证 ${suffix} 崩溃补偿`,
            workspaceRoot: `C:/workspace/startup-setup-${suffix}`,
          };
          yield* seedFailedRunStart(store, input);
          const digests = makeCompositionRunStartDigests({
            prompt: input.prompt,
            workspaceRoot: input.workspaceRoot,
            capabilityIds: ["t3.workspace.read_file"],
          });
          yield* runStartStore.prepareStart({
            runId: input.runId,
            taskId: input.taskId,
            agentId: input.agentId,
            runtimeId: input.runtimeId,
            attempt: 2,
            payloadDigest: digests.payloadDigest,
            capabilityDigest: digests.capabilityDigest,
            createdAtUnixMs: 10,
          });
          const failedTask = Option.getOrThrow(yield* store.getTask(input.taskId));
          const { finishedAtUnixMs: _finishedAtUnixMs, ...unfinishedTask } = failedTask;
          yield* store.upsertTask({
            ...unfinishedTask,
            status: "queued",
            updatedAtUnixMs: 11,
          });
          const leaseId = `lease-startup-setup-${suffix}`;
          if (withLease) {
            yield* store.upsertLease({
              leaseId,
              runtimeId: input.runtimeId,
              taskId: input.taskId,
              workspaceRootDigest: `sha256:workspace-${suffix}`,
              heartbeatAtUnixMs: 11,
              expiresAtUnixMs: 60_011,
              state: "active",
            });
          }
          yield* store.upsertRun({
            taskId: input.taskId,
            runId: input.runId,
            agentId: input.agentId,
            runtimeId: input.runtimeId,
            status: "queued",
            attempt: 2,
            capabilityGrantIds: [`grant-startup-setup-${suffix}`],
            ...(withLease ? { leaseId } : {}),
          });

          let startCalls = 0;
          const revokedGrantIds: string[] = [];
          const driverRegistry = makeCompositionAgentDriverRegistry();
          yield* driverRegistry.register({
            agentId: input.agentId,
            runtimeId: input.runtimeId,
            startRecoveryPolicy: runtimeTaskPolicy,
            startTask: () =>
              Effect.sync(() => {
                startCalls += 1;
                return { runtimeTaskId: `unexpected-runtime-task-${suffix}` };
              }),
            cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
          });
          const inputStore = makeInputStore(
            new Map([
              [
                input.taskId,
                {
                  taskId: input.taskId,
                  prompt: input.prompt,
                  workspaceRoot: input.workspaceRoot,
                  ...(withLease ? { workspaceRootDigest: `sha256:workspace-${suffix}` } : {}),
                },
              ],
            ]),
          );
          const orchestrator = makeCompositionOrchestrator(
            store,
            driverRegistry,
            {
              issue: () => Effect.die("已有 queued setup 不得重新签发 grant"),
              revoke: ({ grantId }) =>
                Effect.sync(() => {
                  revokedGrantIds.push(grantId);
                }),
            },
            inputStore,
            runStartStore,
          );

          yield* recoverCompositionRunStarts({
            store,
            runStartStore,
            inputStore,
            orchestrator,
            recoveredAtUnixMs: 7_000,
          });

          assert.equal(startCalls, 0);
          assert.deepEqual(revokedGrantIds, [`grant-startup-setup-${suffix}`]);
          if (withLease) {
            assert.equal(Option.getOrThrow(yield* store.getLease(leaseId)).state, "released");
          }
          const intent = Option.getOrThrow(yield* runStartStore.getStart(input.runId));
          assert.equal(intent.state, "indeterminate");
          assert.equal(intent.outcomeCode, "run_start_recovery_capability_ids_missing");
        }),
    );
  }
});
