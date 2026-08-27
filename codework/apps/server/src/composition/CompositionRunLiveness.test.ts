import { assert, it } from "@effect/vitest";
import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeTaskId,
  ThreadId,
  type CompositionTask,
  type CompositionTaskRun,
} from "@codework/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import { makeCompositionAgentDriverRegistry } from "./CompositionAgentDriverRegistry.ts";
import { makeCompositionOrchestrator } from "./CompositionOrchestrator.ts";
import {
  recoverCompositionRunLiveness,
  superviseCompositionRunLiveness,
  type CompositionRunLivenessOptions,
} from "./CompositionRunLiveness.ts";
import { projectCompositionRuntimeEvent } from "./CompositionTaskRuntimeProjector.ts";
import { CompositionTaskStore } from "../persistence/Services/CompositionTaskStore.ts";
import { CompositionTaskStoreLive } from "../persistence/Layers/CompositionTaskStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";

const layer = it.layer(CompositionTaskStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));

const makeTask = (overrides: Partial<CompositionTask> = {}): CompositionTask => ({
  taskId: "task-liveness",
  projectId: "project-liveness",
  assigneeKind: "agent",
  assigneeId: "agent-liveness",
  mode: "serial",
  status: "running",
  promptDigest: "sha256:liveness",
  dependsOnTaskIds: [],
  createdAtUnixMs: 1,
  updatedAtUnixMs: 1,
  ...overrides,
});

const makeRun = (overrides: Partial<CompositionTaskRun> = {}): CompositionTaskRun => ({
  runId: "run-liveness",
  taskId: "task-liveness",
  agentId: "agent-liveness",
  runtimeId: "runtime-liveness",
  runtimeTaskId: "runtime-task-liveness",
  status: "running",
  attempt: 1,
  capabilityGrantIds: ["grant-liveness"],
  startedAtUnixMs: 1,
  ...overrides,
});

const startWithRunTaskId = (run: CompositionTaskRun) =>
  Effect.succeed(run.runtimeTaskId === undefined ? {} : { runtimeTaskId: run.runtimeTaskId });

layer("CompositionRunLiveness", (it) => {
  it.effect("无活动超过阈值时先请求真实 Driver 取消，不伪造成功或终态", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const task = makeTask({ updatedAtUnixMs: 1 });
      const run = makeRun();
      const registry = makeCompositionAgentDriverRegistry();
      let cancelCalls = 0;
      yield* registry.register({
        agentId: run.agentId,
        runtimeId: run.runtimeId,
        startTask: () => startWithRunTaskId(run),
        cancelTask: () =>
          Effect.sync(() => {
            cancelCalls += 1;
            return { status: "cancel_requested" as const };
          }),
      });
      const orchestrator = makeCompositionOrchestrator(store, registry);
      yield* store.upsertTask(task);
      yield* store.upsertRun(run);

      const actions = yield* recoverCompositionRunLiveness({
        store: { listTasks: () => Effect.succeed([task]), getLatestRun: store.getLatestRun },
        orchestrator,
        nowUnixMs: 10_000,
        inactivityTimeoutMs: 1_000,
        cancelConfirmationTimeoutMs: 500,
        projectRuntimeEvent: (event) => projectCompositionRuntimeEvent(store, registry, event),
      });

      assert.equal(cancelCalls, 1);
      assert.deepEqual(actions, [
        { taskId: task.taskId, runId: run.runId, action: "cancel_requested" },
      ]);
      const storedTask = Option.getOrThrow(yield* store.getTask(task.taskId));
      const storedRun = Option.getOrThrow(yield* store.getRun(run.runId));
      assert.equal(storedTask.status, "running");
      assert.equal(storedRun.status, "running");
      assert.equal(storedRun.cancelRequestedAtUnixMs !== undefined, true);
    }),
  );

  it.effect(
    "取消确认宽限到期后以可信 watchdog 事件收口为 timed_out，并回收 grant 和 handshake",
    () =>
      Effect.gen(function* () {
        const store = yield* CompositionTaskStore;
        const task = makeTask({ taskId: "task-liveness-timeout", updatedAtUnixMs: 1 });
        const run = makeRun({
          taskId: task.taskId,
          runId: "run-liveness-timeout",
          runtimeTaskId: "runtime-task-liveness-timeout",
          capabilityHandshakeId: "handshake-liveness",
          cancelRequestedAtUnixMs: 1,
        });
        const registry = makeCompositionAgentDriverRegistry();
        const revokedHandshakes: string[] = [];
        const revokedGrants: string[] = [];
        yield* registry.register({
          agentId: run.agentId,
          runtimeId: run.runtimeId,
          startTask: () => startWithRunTaskId(run),
          cancelTask: () => Effect.succeed({ status: "cancel_requested" as const }),
          revokeCapabilityHandshake: ({ run: currentRun }) =>
            Effect.sync(() =>
              revokedHandshakes.push(currentRun.capabilityHandshakeId ?? "missing"),
            ),
        });
        const orchestrator = makeCompositionOrchestrator(store, registry);
        yield* store.upsertTask(task);
        yield* store.upsertRun(run);

        const project = (event: Parameters<typeof projectCompositionRuntimeEvent>[2]) =>
          projectCompositionRuntimeEvent(store, registry, event, {
            revoke: ({ grantId }) => Effect.sync(() => revokedGrants.push(grantId)),
          });
        const actions = yield* recoverCompositionRunLiveness({
          store: { listTasks: () => Effect.succeed([task]), getLatestRun: store.getLatestRun },
          orchestrator,
          nowUnixMs: 10_000,
          inactivityTimeoutMs: 1_000,
          cancelConfirmationTimeoutMs: 500,
          projectRuntimeEvent: project,
        });

        assert.deepEqual(actions, [{ taskId: task.taskId, runId: run.runId, action: "timed_out" }]);
        assert.equal(Option.getOrThrow(yield* store.getTask(task.taskId)).status, "timed_out");
        assert.equal(
          Option.getOrThrow(yield* store.getRun(run.runId)).failureCode,
          "runtime_cancel_confirmation_timeout",
        );
        assert.deepEqual(revokedHandshakes, ["handshake-liveness"]);
        assert.deepEqual(revokedGrants, ["grant-liveness"]);
        const events = yield* store.listEvents(task.taskId, run.runId);
        assert.equal(events.length, 1);
        assert.equal(
          events[0]?.sourceEventId,
          "composition-watchdog:run-liveness-timeout:cancel-confirmation-timeout:1",
        );
      }),
  );

  it.effect("取消请求后的确认超时不再依赖首次失活阈值", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const task = makeTask({ taskId: "task-liveness-confirmation-only", updatedAtUnixMs: 9_999 });
      const run = makeRun({
        taskId: task.taskId,
        runId: "run-liveness-confirmation-only",
        cancelRequestedAtUnixMs: 9_000,
      });
      const registry = makeCompositionAgentDriverRegistry();
      yield* registry.register({
        agentId: run.agentId,
        runtimeId: run.runtimeId,
        startTask: () => startWithRunTaskId(run),
        cancelTask: () => Effect.succeed({ status: "cancel_requested" as const }),
      });
      const orchestrator = makeCompositionOrchestrator(store, registry);
      yield* store.upsertTask(task);
      yield* store.upsertRun(run);

      const actions = yield* recoverCompositionRunLiveness({
        store: { listTasks: () => Effect.succeed([task]), getLatestRun: store.getLatestRun },
        orchestrator,
        nowUnixMs: 10_000,
        inactivityTimeoutMs: 60_000,
        cancelConfirmationTimeoutMs: 500,
        projectRuntimeEvent: (event) => projectCompositionRuntimeEvent(store, registry, event),
      });

      assert.deepEqual(actions, [{ taskId: task.taskId, runId: run.runId, action: "timed_out" }]);
      assert.equal(Option.getOrThrow(yield* store.getRun(run.runId)).status, "timed_out");
    }),
  );

  it.effect("重复 sweep 与旧 Run 都不会覆盖最新运行或重复收口", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const task = makeTask({ taskId: "task-liveness-repeat", updatedAtUnixMs: 9_500 });
      const oldRun = makeRun({
        taskId: task.taskId,
        runId: "run-liveness-old",
        runtimeTaskId: "runtime-task-liveness-old",
        attempt: 1,
        cancelRequestedAtUnixMs: 1,
      });
      const latestRun = makeRun({
        taskId: task.taskId,
        runId: "run-liveness-latest",
        runtimeTaskId: "runtime-task-liveness-latest",
        attempt: 2,
      });
      const registry = makeCompositionAgentDriverRegistry();
      yield* registry.register({
        agentId: latestRun.agentId,
        runtimeId: latestRun.runtimeId,
        startTask: () => startWithRunTaskId(latestRun),
        cancelTask: () => Effect.succeed({ status: "cancel_requested" as const }),
      });
      const orchestrator = makeCompositionOrchestrator(store, registry);
      yield* store.upsertTask(task);
      yield* store.upsertRun(oldRun);
      yield* store.upsertRun(latestRun);

      const options: CompositionRunLivenessOptions = {
        store: { listTasks: () => Effect.succeed([task]), getLatestRun: store.getLatestRun },
        orchestrator,
        nowUnixMs: 10_000,
        inactivityTimeoutMs: 1_000,
        cancelConfirmationTimeoutMs: 500,
        projectRuntimeEvent: (event) => projectCompositionRuntimeEvent(store, registry, event),
      };
      const actions = yield* recoverCompositionRunLiveness(options);
      const repeatedActions = yield* recoverCompositionRunLiveness(options);

      assert.deepEqual(actions, []);
      assert.deepEqual(repeatedActions, []);
      assert.equal(Option.getOrThrow(yield* store.getRun(oldRun.runId)).status, "running");
      assert.equal(Option.getOrThrow(yield* store.getRun(latestRun.runId)).status, "running");
    }),
  );

  it.effect("最近的有效 progress 会让 Run 保持运行，不触发取消", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const task = makeTask({ taskId: "task-liveness-progress", updatedAtUnixMs: 9_500 });
      const run = makeRun({ taskId: task.taskId, runId: "run-liveness-progress" });
      const registry = makeCompositionAgentDriverRegistry();
      let cancelCalls = 0;
      yield* registry.register({
        agentId: run.agentId,
        runtimeId: run.runtimeId,
        startTask: () => startWithRunTaskId(run),
        cancelTask: () =>
          Effect.sync(() => {
            cancelCalls += 1;
            return { status: "cancel_requested" as const };
          }),
      });
      const orchestrator = makeCompositionOrchestrator(store, registry);
      yield* store.upsertTask(task);
      yield* store.upsertRun(run);

      const actions = yield* recoverCompositionRunLiveness({
        store: { listTasks: () => Effect.succeed([task]), getLatestRun: store.getLatestRun },
        orchestrator,
        nowUnixMs: 10_000,
        inactivityTimeoutMs: 1_000,
        cancelConfirmationTimeoutMs: 500,
        projectRuntimeEvent: (event) => projectCompositionRuntimeEvent(store, registry, event),
      });

      assert.deepEqual(actions, []);
      assert.equal(cancelCalls, 0);
    }),
  );

  it.effect("任务级更新时间不能掩盖同一 Run 已失活", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const task = makeTask({ taskId: "task-liveness-run-watermark", updatedAtUnixMs: 9_500 });
      // 模拟同一 Task 的非 Runtime 更新：Run 自己最后一次可信活动仍停留在启动时。
      const run = makeRun({
        taskId: task.taskId,
        runId: "run-liveness-run-watermark",
        lastRuntimeEventAtUnixMs: 1,
      });
      const registry = makeCompositionAgentDriverRegistry();
      let cancelCalls = 0;
      yield* registry.register({
        agentId: run.agentId,
        runtimeId: run.runtimeId,
        startTask: () => startWithRunTaskId(run),
        cancelTask: () =>
          Effect.sync(() => {
            cancelCalls += 1;
            return { status: "cancel_requested" as const };
          }),
      });
      const orchestrator = makeCompositionOrchestrator(store, registry);
      yield* store.upsertTask(task);
      yield* store.upsertRun(run);

      const actions = yield* recoverCompositionRunLiveness({
        store: { listTasks: () => Effect.succeed([task]), getLatestRun: store.getLatestRun },
        orchestrator,
        nowUnixMs: 10_000,
        inactivityTimeoutMs: 1_000,
        cancelConfirmationTimeoutMs: 500,
        projectRuntimeEvent: (event) => projectCompositionRuntimeEvent(store, registry, event),
      });

      assert.deepEqual(actions, [
        { taskId: task.taskId, runId: run.runId, action: "cancel_requested" },
      ]);
      assert.equal(cancelCalls, 1);
    }),
  );

  it.effect("supervisor 启动即扫描，并且下一周期不会重复取消已记录请求的 Run", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* CompositionTaskStore;
        const task = makeTask({ taskId: "task-liveness-supervisor", updatedAtUnixMs: 1 });
        const run = makeRun({ taskId: task.taskId, runId: "run-liveness-supervisor" });
        const registry = makeCompositionAgentDriverRegistry();
        let cancelCalls = 0;
        yield* registry.register({
          agentId: run.agentId,
          runtimeId: run.runtimeId,
          startTask: () => startWithRunTaskId(run),
          cancelTask: () =>
            Effect.sync(() => {
              cancelCalls += 1;
              return { status: "cancel_requested" as const };
            }),
        });
        const orchestrator = makeCompositionOrchestrator(store, registry);
        yield* store.upsertTask(task);
        yield* store.upsertRun(run);
        yield* TestClock.setTime(10_000);

        yield* superviseCompositionRunLiveness({
          store,
          orchestrator,
          inactivityTimeoutMs: 1_000,
          cancelConfirmationTimeoutMs: 1_000,
          sweepIntervalMs: 100,
          projectRuntimeEvent: () => Effect.void,
        });
        assert.equal(cancelCalls, 1);
        assert.equal(
          Option.getOrThrow(yield* store.getRun(run.runId)).cancelRequestedAtUnixMs,
          10_000,
        );

        yield* TestClock.adjust("100 millis").pipe(Effect.andThen(Effect.yieldNow));
        assert.equal(cancelCalls, 1);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );
});
