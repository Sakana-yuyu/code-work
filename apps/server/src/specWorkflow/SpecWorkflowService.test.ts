import {
  ProjectId,
  ThreadId,
  type CompositionTask,
  type CompositionTaskDispatchResult,
  type CompositionTaskSnapshot,
  type CompositionTaskRun,
  type SpecWorkflowCapability,
  type SpecWorkflowEvent,
  type SpecWorkflowStateEvent,
} from "@codework/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import type { CompositionOrchestratorServiceShape } from "../composition/CompositionOrchestratorService.ts";
import { CompositionOrchestratorService } from "../composition/CompositionOrchestratorService.ts";
import {
  CompositionGoalLoopAutomationRunner,
  type CompositionGoalLoopAutomationRunnerShape,
} from "../composition/CompositionGoalLoopAutomationRunner.ts";
import {
  CompositionTaskRuntimeProjectionService,
  CompositionTaskRuntimeWaitError,
  type CompositionTaskRuntimeProjectionServiceShape,
} from "../composition/CompositionTaskRuntimeProjectionService.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { CompositionTaskInputStore } from "../persistence/Services/CompositionTaskInputStore.ts";
import type {
  CompositionTaskInputStoreShape,
  CompositionTaskRecoveryInput,
} from "../persistence/Services/CompositionTaskInputStore.ts";
import { SpecWorkflowCapabilityStore } from "../persistence/Services/SpecWorkflowCapabilityStore.ts";
import { SpecWorkflowStateStore } from "../persistence/Services/SpecWorkflowStateStore.ts";
import type { SpecWorkflowStateStoreShape } from "../persistence/Services/SpecWorkflowStateStore.ts";
import { SpecWorkflowStateStoreLive } from "../persistence/Layers/SpecWorkflowStateStore.ts";
import { SpecWorkflowArtifactStore } from "./SpecWorkflowArtifactStore.ts";
import type { SpecWorkflowArtifactStoreShape } from "./SpecWorkflowArtifactStore.ts";
import { transitionSpecWorkflowState } from "./SpecWorkflowDecider.ts";
import { layer as SpecWorkflowServiceLayer, SpecWorkflowService } from "./SpecWorkflowService.ts";
import { startSpecWorkflow } from "./SpecWorkflowDecider.ts";

const projectId = ProjectId.make("project-service");
const threadId = ThreadId.make("thread-service");
const enabledCapability = {
  threadId,
  enabled: true,
  revision: 1,
  updatedAt: 1,
};

const makeCompositionResult = (input: {
  readonly taskId: string;
  readonly runId: string;
  readonly projectId: string;
  readonly threadId?: string;
  readonly assigneeId: string;
  readonly promptDigest: string;
}): CompositionTaskDispatchResult => ({
  task: {
    taskId: input.taskId,
    projectId: ProjectId.make(input.projectId),
    ...(input.threadId === undefined ? {} : { threadId: ThreadId.make(input.threadId) }),
    assigneeKind: "agent",
    assigneeId: input.assigneeId,
    mode: "serial",
    status: "running",
    promptDigest: input.promptDigest,
    dependsOnTaskIds: [],
    createdAtUnixMs: 10,
    updatedAtUnixMs: 10,
  },
  run: {
    runId: input.runId,
    taskId: input.taskId,
    agentId: input.assigneeId,
    runtimeId: "runtime-service",
    status: "running",
    attempt: 0,
    capabilityGrantIds: [],
  },
});

const makeLayer = (
  onDispatch: (input: Parameters<CompositionOrchestratorServiceShape["dispatchTask"]>[0]) => void,
  awaitTaskCompletion: CompositionTaskRuntimeProjectionServiceShape["awaitTaskCompletion"] = ({
    taskId,
    runId,
  }) =>
    Effect.fail(
      new CompositionTaskRuntimeWaitError({
        taskId,
        runId,
        reason: "service unit test does not run Composition Runtime",
      }),
    ),
  stateStore?: SpecWorkflowStateStoreShape,
  listTaskSnapshots: CompositionOrchestratorServiceShape["listTaskSnapshots"] = () =>
    Effect.succeed([]),
  capability: SpecWorkflowCapability = enabledCapability,
  optionalServices?: {
    readonly loopRunner?: CompositionGoalLoopAutomationRunnerShape;
    readonly taskInputs?: CompositionTaskInputStoreShape;
    readonly artifacts?: SpecWorkflowArtifactStoreShape;
    readonly capabilityChanges?: Stream.Stream<SpecWorkflowEvent>;
  },
) => {
  const capabilityStore = {
    get: () => Effect.succeed(capability),
    subscribe: () => Effect.succeed(optionalServices?.capabilityChanges ?? Stream.empty),
  } as unknown as typeof SpecWorkflowCapabilityStore.Service;
  let dispatchCount = 0;
  const composition = {
    dispatchTask: (input: Parameters<CompositionOrchestratorServiceShape["dispatchTask"]>[0]) => {
      dispatchCount += 1;
      onDispatch(input);
      return Effect.succeed(
        makeCompositionResult({
          taskId: input.taskId,
          runId: input.runId,
          projectId: input.projectId,
          ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
          assigneeId: input.assigneeId,
          promptDigest: input.promptDigest,
        }),
      );
    },
    listTaskSnapshots,
  } as unknown as CompositionOrchestratorServiceShape;
  const runtime = {
    projectRuntimeEvent: () => Effect.void,
    awaitTaskCompletion,
  } satisfies CompositionTaskRuntimeProjectionServiceShape;
  const stateStoreLayer =
    stateStore === undefined
      ? SpecWorkflowStateStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory))
      : Layer.succeed(SpecWorkflowStateStore, stateStore);
  const loopRunnerLayer =
    optionalServices?.loopRunner === undefined
      ? Layer.empty
      : Layer.succeed(CompositionGoalLoopAutomationRunner, optionalServices.loopRunner);
  const taskInputLayer =
    optionalServices?.taskInputs === undefined
      ? Layer.empty
      : Layer.succeed(CompositionTaskInputStore, optionalServices.taskInputs);
  const artifactLayer =
    optionalServices?.artifacts === undefined
      ? Layer.empty
      : Layer.succeed(SpecWorkflowArtifactStore, optionalServices.artifacts);
  const layer = SpecWorkflowServiceLayer.pipe(
    Layer.provide(Layer.succeed(CompositionOrchestratorService, composition)),
    Layer.provide(Layer.succeed(CompositionTaskRuntimeProjectionService, runtime)),
    Layer.provide(Layer.succeed(SpecWorkflowCapabilityStore, capabilityStore)),
    Layer.provideMerge(stateStoreLayer),
    Layer.provideMerge(Layer.mergeAll(loopRunnerLayer, taskInputLayer, artifactLayer)),
  );
  return { layer, getDispatchCount: () => dispatchCount };
};

const makeCompletionRuntime = () =>
  Effect.gen(function* () {
    const completionRequests = yield* PubSub.unbounded<string>();
    const waiters = new Map<string, Deferred.Deferred<CompositionTaskRun>>();
    const awaitTaskCompletion: CompositionTaskRuntimeProjectionServiceShape["awaitTaskCompletion"] =
      ({ runId }) =>
        Effect.gen(function* () {
          const waiter = yield* Deferred.make<CompositionTaskRun>();
          waiters.set(runId, waiter);
          yield* PubSub.publish(completionRequests, runId);
          return yield* Deferred.await(waiter);
        });
    return { completionRequests, waiters, awaitTaskCompletion };
  });

const makeFixArtifactStore = (contents: string): SpecWorkflowArtifactStoreShape => ({
  read: (input) => Effect.succeed({ ...input, contents }),
  write: (input) => Effect.succeed(input),
  list: () => Effect.succeed(["fix.md"]),
});

it.effect("单独编写方案可直接进入人工确认，其他节点不产生任务", () => {
  const runtime = makeLayer(
    () => {
      throw new Error("文档节点不派发实施任务");
    },
    undefined,
    undefined,
    undefined,
    { ...enabledCapability, selectedIntent: "propose" },
  );
  return Effect.gen(function* () {
    const service = yield* SpecWorkflowService;
    const input = {
      workflowId: "single-proposal",
      projectId,
      threadId,
      changeName: "single-proposal",
      mode: "full" as const,
      workspaceRoot: "C:/workspace/single-proposal",
      assigneeId: "writer",
      prompt: "只编写方案",
      promptDigest: "sha256:single-proposal",
    };
    yield* service.start({ ...input, updatedAt: 0 });
    const result = yield* service.dispatch({ ...input, intent: "propose" });
    assert.equal(result.state.stage, "awaitingApproval");
    assert.equal(result.state.proposalStatus, "pending");
    const denied = yield* service.dispatch({ ...input, intent: "apply" }).pipe(Effect.result);
    assert.equal(denied._tag, "Failure");
    assert.equal(runtime.getDispatchCount(), 0);
  }).pipe(Effect.provide(runtime.layer));
});

const makeObservedStateStore = () =>
  Effect.gen(function* () {
    const rows = new Map<
      string,
      { state: ReturnType<typeof startSpecWorkflow>["state"]; events: SpecWorkflowStateEvent[] }
    >();
    const changes = yield* PubSub.unbounded<{
      readonly threadId: string;
      readonly event: SpecWorkflowStateEvent;
    }>();
    const store = {
      listStates: () => Effect.sync(() => [...rows.values()].map((row) => row.state)),
      get: (threadId: string) =>
        Effect.sync(() => {
          const row = rows.get(threadId);
          return row === undefined ? Option.none() : Option.some(row.state);
        }),
      append: (input: Parameters<SpecWorkflowStateStoreShape["append"]>[0]) =>
        Effect.gen(function* () {
          const previous = rows.get(input.threadId);
          if (
            input.event.state.threadId !== input.threadId ||
            input.expectedRevision !== (previous?.state.revision ?? 0) ||
            input.event.state.revision !== input.expectedRevision + 1
          ) {
            throw new Error("test state store revision conflict");
          }
          const next = {
            state: input.event.state,
            events: [...(previous?.events ?? []), input.event],
          };
          rows.set(input.threadId, next);
          yield* PubSub.publish(changes, { threadId: input.threadId, event: input.event });
          return next.state;
        }),
      listEvents: (threadId: string) => Effect.sync(() => rows.get(threadId)?.events ?? []),
      subscribe: (threadId: string) =>
        Effect.succeed(
          Stream.fromPubSub(changes).pipe(
            Stream.filter((change) => change.threadId === threadId),
            Stream.map((change) => change.event),
          ),
        ),
    } as unknown as SpecWorkflowStateStoreShape;
    return { store, changes };
  });

const seedActiveWorkflow = (input: {
  readonly store: SpecWorkflowStateStoreShape;
  readonly workflowId: string;
  readonly task: CompositionTask;
}) =>
  Effect.gen(function* () {
    const started = startSpecWorkflow({
      workflowId: input.workflowId,
      projectId,
      threadId,
      changeName: `${input.workflowId}-change`,
      mode: "full",
      updatedAt: 1,
    });
    let state = yield* input.store.append({
      threadId,
      event: started,
      expectedRevision: 0,
    });
    for (const to of ["design", "propose", "awaitingApproval"] as const) {
      state = yield* input.store.append({
        threadId,
        event: transitionSpecWorkflowState(
          state,
          { type: "advance", to, expectedRevision: state.revision },
          state.revision + 1,
        ),
        expectedRevision: state.revision,
      });
    }
    state = yield* input.store.append({
      threadId,
      event: transitionSpecWorkflowState(
        state,
        { type: "approve-proposal", expectedRevision: state.revision },
        state.revision + 1,
      ),
      expectedRevision: state.revision,
    });
    return yield* input.store.append({
      threadId,
      event: transitionSpecWorkflowState(
        state,
        {
          type: "advance",
          to: "apply",
          activeTaskId: input.task.taskId,
          expectedRevision: state.revision,
        },
        state.revision + 1,
      ),
      expectedRevision: state.revision,
    });
  });

for (const stop of ["pause", "disable", "switch"] as const) {
  it.effect(`Loop 使用持久化输入和预算启动，并在 ${stop} 后以取消终态回写`, () =>
    Effect.gen(function* () {
      const runStarted = yield* Deferred.make<void>();
      const release = yield* Deferred.make<"completed" | "cancelled">();
      const capabilityChange = yield* Deferred.make<SpecWorkflowEvent>();
      const changeConsumed = yield* Deferred.make<void>();
      const capabilityChanges = Stream.fromEffect(Deferred.await(capabilityChange)).pipe(
        Stream.concat(
          Stream.fromEffect(Deferred.succeed(changeConsumed, undefined)).pipe(Stream.drain),
        ),
      );
      let loopInput: Parameters<CompositionGoalLoopAutomationRunnerShape["run"]>[0] | undefined;
      const runner: CompositionGoalLoopAutomationRunnerShape = {
        run: (input) =>
          Effect.gen(function* () {
            loopInput = input;
            yield* Deferred.succeed(runStarted, undefined);
            const status = yield* Deferred.await(release);
            return {
              goalStatus: status === "completed" ? "completed" : "cancelled",
              automationStatus: status === "completed" ? "succeeded" : "cancelled",
              summary: status === "completed" ? "Loop 完成。" : "Loop 已取消。",
            };
          }),
      };
      const savedInputs = new Map<string, CompositionTaskRecoveryInput>();
      const taskInputs: CompositionTaskInputStoreShape = {
        save: (input) => Effect.sync(() => void savedInputs.set(input.taskId, input)),
        get: (taskId) => {
          const input = savedInputs.get(taskId);
          return Effect.succeed(input === undefined ? Option.none() : Option.some(input));
        },
        remove: (taskId) => Effect.sync(() => void savedInputs.delete(taskId)),
      };
      const observedState = yield* makeObservedStateStore();
      const runtime = makeLayer(
        () => {},
        undefined,
        observedState.store,
        undefined,
        enabledCapability,
        { loopRunner: runner, taskInputs, capabilityChanges },
      );

      return yield* Effect.gen(function* () {
        const service = yield* SpecWorkflowService;
        const states = yield* SpecWorkflowStateStore;
        const baseInput = {
          workflowId: "workflow-service-loop",
          projectId,
          threadId,
          changeName: "service-loop-change",
          mode: "loop" as const,
          intent: "workflow" as const,
          workspaceRoot: "C:/workspace/service-loop",
          assigneeId: "implementer",
          prompt: "持续执行并按预算检查目标。",
          promptDigest: "sha256:service-loop",
        };
        let state = (yield* service.dispatch(baseInput).pipe(Effect.orDie)).state;
        for (const to of ["design", "propose", "awaitingApproval"] as const) {
          state = yield* states.append({
            threadId,
            event: transitionSpecWorkflowState(
              state,
              { type: "advance", to, expectedRevision: state.revision },
              state.revision + 1,
            ),
            expectedRevision: state.revision,
          });
        }
        state = yield* service.reviewProposal({
          threadId,
          decision: "approve",
          expectedRevision: state.revision,
        });
        const stateChanges = yield* PubSub.subscribe(observedState.changes);

        const applied = yield* service.dispatch({
          ...baseInput,
          intent: "loop",
          loopConfig: { maxAttempts: 2, reviewerAgentId: "reviewer" },
          independentVerifierId: "reviewer",
        });
        const dispatchEvent = yield* PubSub.take(stateChanges);
        assert.equal(dispatchEvent.event.type, "state-changed");
        assert.equal(applied.state.stage, "apply");
        assert.equal(applied.state.activeTaskId, "spec-workflow:workflow-service-loop:loop:6");
        assert.equal(loopInput, undefined);
        yield* Deferred.await(runStarted);
        assert.equal(loopInput?.maxAttempts, 2);
        assert.equal(loopInput?.reviewerAgentId, "reviewer");
        assert.equal(savedInputs.has(applied.state.activeTaskId!), true);

        assert.equal(loopInput?.isCancelled?.(), false);
        if (stop === "pause") {
          yield* service.pause({ threadId, expectedRevision: applied.state.revision });
          const pauseEvent = yield* PubSub.take(stateChanges);
          assert.equal(pauseEvent.event.state.status, "paused");
        } else {
          yield* Deferred.succeed(capabilityChange, {
            type: "updated",
            capability: {
              ...enabledCapability,
              enabled: stop !== "disable",
              selectedIntent: stop === "switch" ? "chat" : "loop",
              revision: 2,
            },
          });
          yield* Deferred.await(changeConsumed);
        }
        assert.equal(loopInput?.isCancelled?.(), true);
        yield* Deferred.succeed(release, "cancelled");
        const cancelledEvent = yield* PubSub.take(stateChanges);
        assert.equal(cancelledEvent.event.state.status, stop === "pause" ? "paused" : "active");
        assert.isNull(cancelledEvent.event.state.activeTaskId);
        assert.equal(cancelledEvent.event.state.lastError, "Loop 已取消。");

        if (stop === "pause") {
          const resumed = yield* service.resume({
            threadId,
            expectedRevision: cancelledEvent.event.state.revision,
          });
          assert.equal(resumed.status, "active");
        }
      }).pipe(Effect.provide(runtime.layer));
    }),
  );
}

it.effect("Loop 在父 Task 尚未落库时可按加密输入重启恢复", () =>
  Effect.gen(function* () {
    const observedState = yield* makeObservedStateStore();
    const taskId = "spec-workflow:workflow-recovery-loop:loop:6";
    let recoveredInput: Parameters<CompositionGoalLoopAutomationRunnerShape["run"]>[0] | undefined;
    const runner: CompositionGoalLoopAutomationRunnerShape = {
      run: (input) =>
        Effect.sync(() => {
          recoveredInput = input;
          return {
            goalStatus: "completed" as const,
            automationStatus: "succeeded" as const,
            summary: "Loop 重启恢复完成。",
          };
        }),
    };
    const inputs = new Map<string, CompositionTaskRecoveryInput>([
      [
        taskId,
        {
          taskId,
          agentId: "implementer",
          prompt: "恢复未落库的 Loop。",
          workspaceRoot: "C:/workspace/recovery-loop",
          capabilityIds: [],
        },
      ],
    ]);
    const taskInputs: CompositionTaskInputStoreShape = {
      save: (input) => Effect.sync(() => void inputs.set(input.taskId, input)),
      get: (id) => {
        const input = inputs.get(id);
        return Effect.succeed(input === undefined ? Option.none() : Option.some(input));
      },
      remove: (id) => Effect.sync(() => void inputs.delete(id)),
    };
    const runtime = makeLayer(
      () => {},
      undefined,
      observedState.store,
      () => Effect.succeed([]),
      enabledCapability,
      { loopRunner: runner, taskInputs },
    );

    return yield* Effect.gen(function* () {
      const service = yield* SpecWorkflowService;
      const states = yield* SpecWorkflowStateStore;
      let state = yield* states.append({
        threadId,
        event: startSpecWorkflow({
          workflowId: "workflow-recovery-loop",
          projectId,
          threadId,
          changeName: "workflow-recovery-loop-change",
          mode: "loop",
          updatedAt: 1,
        }),
        expectedRevision: 0,
      });
      for (const to of ["design", "propose", "awaitingApproval"] as const) {
        state = yield* states.append({
          threadId,
          event: transitionSpecWorkflowState(
            state,
            { type: "advance", to, expectedRevision: state.revision },
            state.revision + 1,
          ),
          expectedRevision: state.revision,
        });
      }
      state = yield* states.append({
        threadId,
        event: transitionSpecWorkflowState(
          state,
          { type: "approve-proposal", expectedRevision: state.revision },
          state.revision + 1,
        ),
        expectedRevision: state.revision,
      });
      state = yield* states.append({
        threadId,
        event: transitionSpecWorkflowState(
          state,
          {
            type: "advance",
            to: "apply",
            activeTaskId: taskId,
            loopConfig: { maxAttempts: 1 },
            expectedRevision: state.revision,
          },
          state.revision + 1,
        ),
        expectedRevision: state.revision,
      });
      const stateChanges = yield* PubSub.subscribe(observedState.changes);

      const receipt = yield* service.recover();
      assert.deepEqual(receipt, { scanned: 1, rebound: 1, settled: 0, skipped: 0 });
      const completion = yield* PubSub.take(stateChanges);
      assert.equal(completion.event.state.implementationCompleted, true);
      assert.isNull(completion.event.state.activeTaskId);
      assert.equal(recoveredInput?.taskId, taskId);
      assert.equal(recoveredInput?.runId, `${taskId}:run`);
      assert.equal(recoveredInput?.agentId, "implementer");
    }).pipe(Effect.provide(runtime.layer));
  }),
);

it.effect("Server service 持久化状态、调用 Composition，并阻止重复派发", () => {
  let lastDispatch: Parameters<CompositionOrchestratorServiceShape["dispatchTask"]>[0] | undefined;
  const runtime = makeLayer((input) => {
    lastDispatch = input;
  });

  return Effect.gen(function* () {
    const service = yield* SpecWorkflowService;
    const states = yield* SpecWorkflowStateStore;
    const baseInput = {
      workflowId: "workflow-service",
      projectId,
      threadId,
      changeName: "service-change",
      mode: "full" as const,
      intent: "workflow" as const,
      workspaceRoot: "C:/workspace/service",
      assigneeId: "implementer",
      prompt: "执行批准后的方案。",
      promptDigest: "sha256:service",
    };
    const initial = yield* service.dispatch(baseInput);
    assert.equal(initial.route.action, "start");
    let state = initial.state;
    const startEvent = startSpecWorkflow({
      workflowId: state.workflowId,
      projectId: state.projectId,
      threadId: state.threadId,
      changeName: state.changeName,
      mode: state.mode,
      updatedAt: state.updatedAt,
    });
    assert.deepEqual(startEvent.state, state);

    for (const to of ["design", "propose", "awaitingApproval"] as const) {
      const event = transitionSpecWorkflowState(
        state,
        { type: "advance", to, expectedRevision: state.revision },
        state.revision + 1,
      );
      state = yield* states.append({
        threadId,
        event,
        expectedRevision: state.revision,
      });
    }
    state = yield* service.reviewProposal({
      threadId,
      decision: "approve",
      expectedRevision: state.revision,
    });
    assert.equal(state.proposalStatus, "approved");

    const applied = yield* service.dispatch({ ...baseInput, intent: "apply" });
    assert.equal(applied.state.stage, "apply");
    assert.isNotNull(applied.task);
    assert.equal(runtime.getDispatchCount(), 1);
    assert.equal(lastDispatch?.taskId, "spec-workflow:workflow-service:apply:6");

    const repeated = yield* service.dispatch({ ...baseInput, intent: "apply" });
    assert.equal(repeated.route.reason, "already-at-target");
    assert.isNull(repeated.task);
    assert.equal(runtime.getDispatchCount(), 1);

    const paused = yield* service.pause({ threadId, expectedRevision: applied.state.revision });
    assert.equal(paused.status, "paused");
    const resumed = yield* service.resume({ threadId, expectedRevision: paused.revision });
    assert.equal(resumed.status, "active");
    assert.deepEqual(yield* service.getState(threadId), Option.some(resumed));
  }).pipe(Effect.provide(runtime.layer));
});

it.effect("Server service 支持拒绝方案并沿用 revision 门禁", () => {
  const runtime = makeLayer(() => {});

  return Effect.gen(function* () {
    const service = yield* SpecWorkflowService;
    const states = yield* SpecWorkflowStateStore;
    const state = (yield* service.dispatch({
      workflowId: "workflow-service-reject",
      projectId,
      threadId,
      changeName: "service-reject-change",
      mode: "full",
      intent: "workflow",
      workspaceRoot: "C:/workspace/service-reject",
      assigneeId: "implementer",
      prompt: "执行需要拒绝方案的流程。",
      promptDigest: "sha256:service-reject",
    })).state;
    let awaitingApproval = state;
    for (const to of ["design", "propose", "awaitingApproval"] as const) {
      awaitingApproval = yield* states.append({
        threadId,
        event: transitionSpecWorkflowState(
          awaitingApproval,
          { type: "advance", to, expectedRevision: awaitingApproval.revision },
          awaitingApproval.revision + 1,
        ),
        expectedRevision: awaitingApproval.revision,
      });
    }

    const rejected = yield* service.reviewProposal({
      threadId,
      decision: "reject",
      expectedRevision: awaitingApproval.revision,
    });
    assert.equal(rejected.stage, "awaitingApproval");
    assert.equal(rejected.proposalStatus, "rejected");
    assert.equal(rejected.revision, awaitingApproval.revision + 1);
  }).pipe(Effect.provide(runtime.layer));
});

it.effect("Server service 不允许 ship 绕过 acceptance，并在验收后归档", () => {
  const runtime = makeLayer(() => {});

  return Effect.gen(function* () {
    const service = yield* SpecWorkflowService;
    const states = yield* SpecWorkflowStateStore;
    const baseInput = {
      workflowId: "workflow-service-ship",
      projectId,
      threadId,
      changeName: "service-ship-change",
      mode: "full" as const,
      intent: "workflow" as const,
      workspaceRoot: "C:/workspace/service-ship",
      assigneeId: "implementer",
      prompt: "执行并完成最终验收。",
      promptDigest: "sha256:service-ship",
    };
    let state = (yield* service.dispatch(baseInput).pipe(Effect.orDie)).state;
    for (const to of ["design", "propose", "awaitingApproval"] as const) {
      state = yield* states.append({
        threadId,
        event: transitionSpecWorkflowState(
          state,
          { type: "advance", to, expectedRevision: state.revision },
          state.revision + 1,
        ),
        expectedRevision: state.revision,
      });
    }
    state = yield* service.reviewProposal({
      threadId,
      decision: "approve",
      expectedRevision: state.revision,
    });
    state = yield* states.append({
      threadId,
      event: transitionSpecWorkflowState(
        state,
        { type: "advance", to: "apply", expectedRevision: state.revision },
        state.revision + 1,
      ),
      expectedRevision: state.revision,
    });
    state = yield* states.append({
      threadId,
      event: transitionSpecWorkflowState(
        state,
        { type: "mark-implementation-complete", expectedRevision: state.revision },
        state.revision + 1,
      ),
      expectedRevision: state.revision,
    });
    state = yield* states.append({
      threadId,
      event: transitionSpecWorkflowState(
        state,
        { type: "advance", to: "verify", expectedRevision: state.revision },
        state.revision + 1,
      ),
      expectedRevision: state.revision,
    });
    state = yield* states.append({
      threadId,
      event: transitionSpecWorkflowState(
        state,
        { type: "record-verification", passed: true, expectedRevision: state.revision },
        state.revision + 1,
      ),
      expectedRevision: state.revision,
    });
    state = yield* states.append({
      threadId,
      event: transitionSpecWorkflowState(
        state,
        { type: "advance", to: "acceptance", expectedRevision: state.revision },
        state.revision + 1,
      ),
      expectedRevision: state.revision,
    });
    const accepted = yield* service.completeAcceptance({
      threadId,
      expectedRevision: state.revision,
    });
    assert.equal(accepted.acceptanceStatus, "passed");

    const archived = yield* service.dispatch({ ...baseInput, intent: "ship" });
    assert.equal(archived.route.targetStage, "archive");
    assert.equal(archived.state.stage, "archive");
    assert.equal(archived.state.status, "completed");
  }).pipe(Effect.provide(runtime.layer));
});

it.effect("fix 模式从首个修复开始，允许累积并由 ship 只派发一次独立验证", () => {
  const runtime = makeLayer(() => {}, undefined, undefined, undefined, enabledCapability, {
    artifacts: makeFixArtifactStore("# 修复批次\n\n## F-1\n- 修复并记录验证结果。\n"),
  });

  return Effect.gen(function* () {
    const service = yield* SpecWorkflowService;
    const states = yield* SpecWorkflowStateStore;
    const baseInput = {
      workflowId: "workflow-service-fix",
      projectId,
      threadId,
      changeName: "fixes",
      mode: "fix" as const,
      intent: "fix" as const,
      workspaceRoot: "C:/workspace/service-fix",
      assigneeId: "implementer",
      prompt: "修复一个小问题并把记录追加到 fix.md。",
      promptDigest: "sha256:service-fix",
      implementationAssigneeId: "implementer",
      independentVerifierId: "verifier",
    };

    const first = yield* service.dispatch(baseInput);
    assert.equal(first.state.stage, "apply");
    assert.isNotNull(first.task);

    let state = yield* states.append({
      threadId,
      event: transitionSpecWorkflowState(
        first.state,
        {
          type: "record-task-result",
          taskId: first.task!.task.taskId,
          status: "completed",
          expectedRevision: first.state.revision,
        },
        first.state.revision + 1,
      ),
      expectedRevision: first.state.revision,
    });
    const second = yield* service.dispatch({ ...baseInput, promptDigest: "sha256:service-fix-2" });
    assert.equal(second.state.stage, "apply");
    assert.isNotNull(second.task);
    assert.isTrue(second.route.corrected === false);

    state = yield* states.append({
      threadId,
      event: transitionSpecWorkflowState(
        second.state,
        {
          type: "record-task-result",
          taskId: second.task!.task.taskId,
          status: "completed",
          expectedRevision: second.state.revision,
        },
        second.state.revision + 1,
      ),
      expectedRevision: second.state.revision,
    });
    const shipped = yield* service.dispatch({
      ...baseInput,
      intent: "ship",
      promptDigest: "sha256:service-fix-ship",
    });
    assert.equal(shipped.route.targetStage, "verify");
    assert.isNotNull(shipped.task);
    assert.equal(shipped.task!.run.agentId, "verifier");
    assert.equal(shipped.state.activeTaskId, shipped.task!.task.taskId);
    assert.equal(state.implementationCompleted, true);
  }).pipe(Effect.provide(runtime.layer));
});

it.effect("fix/ship 在批次产物为空时由 Server 拒绝，不调用独立验证", () => {
  let dispatchCount = 0;
  const runtime = makeLayer(
    () => {
      dispatchCount += 1;
    },
    undefined,
    undefined,
    undefined,
    enabledCapability,
    { artifacts: makeFixArtifactStore("\n") },
  );

  return Effect.gen(function* () {
    const service = yield* SpecWorkflowService;
    const states = yield* SpecWorkflowStateStore;
    const baseInput = {
      workflowId: "workflow-service-empty-fix",
      projectId,
      threadId,
      changeName: "empty-fixes",
      mode: "fix" as const,
      intent: "fix" as const,
      workspaceRoot: "C:/workspace/empty-fix",
      assigneeId: "implementer",
      prompt: "修复并记录。",
      promptDigest: "sha256:empty-fix",
      implementationAssigneeId: "implementer",
      independentVerifierId: "verifier",
    };
    const started = yield* service.dispatch(baseInput);
    const completed = transitionSpecWorkflowState(
      started.state,
      {
        type: "record-task-result",
        taskId: started.task!.task.taskId,
        status: "completed",
        expectedRevision: started.state.revision,
      },
      started.state.revision + 1,
    );
    yield* states.append({
      threadId,
      event: completed,
      expectedRevision: started.state.revision,
    });

    const rejected = yield* service
      .dispatch({ ...baseInput, intent: "ship", promptDigest: "sha256:empty-ship" })
      .pipe(Effect.flip);
    assert.equal(rejected._tag, "SpecWorkflowCompositionBridgeError");
    assert.equal(dispatchCount, 1);
  }).pipe(Effect.provide(runtime.layer));
});

it.effect("Composition Task 终态单向回写 workflow，并收口失败与取消", () =>
  Effect.gen(function* () {
    const completionRuntime = yield* makeCompletionRuntime();
    const observedState = yield* makeObservedStateStore();
    const runtime = makeLayer(() => {}, completionRuntime.awaitTaskCompletion, observedState.store);

    return yield* Effect.gen(function* () {
      const service = yield* SpecWorkflowService;
      const states = yield* SpecWorkflowStateStore;
      const completionRequests = yield* PubSub.subscribe(completionRuntime.completionRequests);
      const baseInput = {
        workflowId: "workflow-runtime-service",
        projectId,
        threadId,
        changeName: "runtime-service-change",
        mode: "full" as const,
        intent: "workflow" as const,
        workspaceRoot: "C:/workspace/runtime-service",
        assigneeId: "implementer",
        prompt: "执行批准后的方案。",
        promptDigest: "sha256:runtime-service",
      };
      let state = (yield* service.dispatch(baseInput).pipe(Effect.orDie)).state;
      for (const to of ["design", "propose", "awaitingApproval"] as const) {
        state = yield* states.append({
          threadId,
          event: transitionSpecWorkflowState(
            state,
            { type: "advance", to, expectedRevision: state.revision },
            state.revision + 1,
          ),
          expectedRevision: state.revision,
        });
      }
      state = yield* states.append({
        threadId,
        event: transitionSpecWorkflowState(
          state,
          { type: "approve-proposal", expectedRevision: state.revision },
          state.revision + 1,
        ),
        expectedRevision: state.revision,
      });
      const stateChanges = yield* PubSub.subscribe(observedState.changes);

      const applied = yield* service.dispatch({ ...baseInput, intent: "apply" }).pipe(Effect.orDie);
      assert.isNotNull(applied.task);
      assert.equal(applied.state.activeTaskId, applied.task!.task.taskId);
      assert.equal((yield* PubSub.take(stateChanges)).event.type, "state-changed");
      const applyRunId = yield* PubSub.take(completionRequests);
      const applyWaiter = completionRuntime.waiters.get(applyRunId);
      assert.isTrue(applyWaiter !== undefined);
      const completedApplyRun: CompositionTaskRun = {
        ...applied.task!.run,
        status: "completed",
      };
      yield* Deferred.succeed(applyWaiter!, completedApplyRun);
      state = (yield* PubSub.take(stateChanges)).event.state;
      assert.equal(state.implementationCompleted, true);
      assert.isNull(state.activeTaskId);
      assert.isNull(state.lastError);

      const verified = yield* service.dispatch({
        ...baseInput,
        intent: "verify",
        assigneeId: "verifier",
        implementationAssigneeId: "implementer",
        independentVerifierId: "verifier",
      });
      assert.isNotNull(verified.task);
      assert.equal((yield* PubSub.take(stateChanges)).event.type, "state-changed");
      const verifyRunId = yield* PubSub.take(completionRequests);
      const verifyWaiter = completionRuntime.waiters.get(verifyRunId);
      assert.isTrue(verifyWaiter !== undefined);
      const failedVerifyRun: CompositionTaskRun = {
        ...verified.task!.run,
        status: "failed",
        failureCode: "verification_failed",
      };
      yield* Deferred.succeed(verifyWaiter!, failedVerifyRun);
      state = (yield* PubSub.take(stateChanges)).event.state;
      assert.equal(state.verificationStatus, "failed");
      assert.isNull(state.activeTaskId);
      assert.equal(state.lastError, "Composition Task 执行失败：verification_failed");

      const retry = yield* service.dispatch({ ...baseInput, intent: "apply" });
      assert.isNotNull(retry.task);
      assert.equal((yield* PubSub.take(stateChanges)).event.type, "state-changed");
      const retryRunId = yield* PubSub.take(completionRequests);
      const retryWaiter = completionRuntime.waiters.get(retryRunId);
      assert.isTrue(retryWaiter !== undefined);
      const cancelledRetryRun: CompositionTaskRun = {
        ...retry.task!.run,
        status: "cancelled",
      };
      yield* Deferred.succeed(retryWaiter!, cancelledRetryRun);
      state = (yield* PubSub.take(stateChanges)).event.state;
      assert.equal(state.stage, "apply");
      assert.equal(state.implementationCompleted, false);
      assert.isNull(state.activeTaskId);
      assert.equal(state.lastError, "Composition Task 已取消。");
    }).pipe(Effect.provide(runtime.layer));
  }),
);

it.effect("任务终态 Reactor 自动唤醒 verify，并把成功验证推进到人工 acceptance", () =>
  Effect.gen(function* () {
    const completionRuntime = yield* makeCompletionRuntime();
    const observedState = yield* makeObservedStateStore();
    const runtime = makeLayer(() => {}, completionRuntime.awaitTaskCompletion, observedState.store);

    return yield* Effect.gen(function* () {
      const service = yield* SpecWorkflowService;
      const states = yield* SpecWorkflowStateStore;
      const completionRequests = yield* PubSub.subscribe(completionRuntime.completionRequests);
      const baseInput = {
        workflowId: "workflow-reactor-service",
        projectId,
        threadId,
        changeName: "reactor-service-change",
        mode: "full" as const,
        intent: "workflow" as const,
        workspaceRoot: "C:/workspace/reactor-service",
        assigneeId: "implementer",
        prompt: "执行并自动唤醒独立验证。",
        promptDigest: "sha256:reactor-service",
        implementationAssigneeId: "implementer",
        independentVerifierId: "verifier",
      };
      let state = (yield* service.dispatch(baseInput).pipe(Effect.orDie)).state;
      for (const to of ["design", "propose", "awaitingApproval"] as const) {
        state = yield* states.append({
          threadId,
          event: transitionSpecWorkflowState(
            state,
            { type: "advance", to, expectedRevision: state.revision },
            state.revision + 1,
          ),
          expectedRevision: state.revision,
        });
      }
      state = yield* service.reviewProposal({
        threadId,
        decision: "approve",
        expectedRevision: state.revision,
      });

      const stateChanges = yield* PubSub.subscribe(observedState.changes);
      const applied = yield* service.dispatch({ ...baseInput, intent: "apply" });
      assert.isNotNull(applied.task);
      yield* PubSub.take(stateChanges);
      const applyRunId = yield* PubSub.take(completionRequests);
      const applyWaiter = completionRuntime.waiters.get(applyRunId);
      assert.isTrue(applyWaiter !== undefined);
      const completedApplyRun: CompositionTaskRun = {
        ...applied.task!.run,
        status: "completed",
      };
      yield* Deferred.succeed(applyWaiter!, completedApplyRun);

      const applySettled = (yield* PubSub.take(stateChanges)).event.state;
      assert.equal(applySettled.stage, "apply");
      assert.equal(applySettled.implementationCompleted, true);
      const verifyDispatched = (yield* PubSub.take(stateChanges)).event.state;
      assert.equal(verifyDispatched.stage, "verify");
      assert.equal(
        verifyDispatched.activeTaskId,
        "spec-workflow:workflow-reactor-service:verify:8",
      );
      const verifyRunId = yield* PubSub.take(completionRequests);
      const verifyWaiter = completionRuntime.waiters.get(verifyRunId);
      assert.isTrue(verifyWaiter !== undefined);
      const verifyTaskId = verifyDispatched.activeTaskId;
      assert.isTrue(verifyTaskId !== null);
      yield* Deferred.succeed(verifyWaiter!, {
        runId: verifyRunId,
        taskId: verifyTaskId!,
        agentId: "verifier",
        runtimeId: "runtime-service",
        status: "completed",
        attempt: 0,
        capabilityGrantIds: [],
      });

      const verificationSettled = (yield* PubSub.take(stateChanges)).event.state;
      assert.equal(verificationSettled.stage, "verify");
      assert.equal(verificationSettled.verificationStatus, "passed");
      const acceptance = (yield* PubSub.take(stateChanges)).event.state;
      assert.equal(acceptance.stage, "acceptance");
      assert.equal(acceptance.acceptanceStatus, "pending");
      assert.isNull(acceptance.activeTaskId);
    }).pipe(Effect.provide(runtime.layer));
  }),
);

it.effect("服务重启扫描持久化 active Task，终态回写幂等且不重复落账", () =>
  Effect.gen(function* () {
    const observedState = yield* makeObservedStateStore();
    const task: CompositionTask = {
      taskId: "spec-workflow:workflow-recovery-terminal:apply:6",
      projectId,
      threadId,
      assigneeKind: "agent",
      assigneeId: "implementer",
      mode: "serial",
      status: "completed",
      promptDigest: "sha256:recovery-terminal",
      dependsOnTaskIds: [],
      createdAtUnixMs: 10,
      updatedAtUnixMs: 20,
      finishedAtUnixMs: 20,
    };
    const run: CompositionTaskRun = {
      taskId: task.taskId,
      runId: "run-spec-workflow-recovery-terminal",
      agentId: task.assigneeId,
      runtimeId: "runtime-service",
      status: "completed",
      attempt: 0,
      capabilityGrantIds: [],
    };
    const runtime = makeLayer(
      () => {},
      () => Effect.succeed(run),
      observedState.store,
      () =>
        Effect.succeed([{ task, latestRun: run }] satisfies ReadonlyArray<CompositionTaskSnapshot>),
    );

    return yield* Effect.gen(function* () {
      yield* seedActiveWorkflow({
        store: observedState.store,
        workflowId: "workflow-recovery-terminal",
        task,
      });
      const service = yield* SpecWorkflowService;
      const first = yield* service.recover();
      const afterFirst = yield* observedState.store.get(threadId);
      const eventCount = (yield* observedState.store.listEvents(threadId)).length;

      assert.deepEqual(first, { scanned: 1, rebound: 0, settled: 1, skipped: 0 });
      assert.equal(Option.isSome(afterFirst) ? afterFirst.value.activeTaskId : "missing", null);
      assert.equal(
        Option.isSome(afterFirst) ? afterFirst.value.implementationCompleted : false,
        true,
      );

      const second = yield* service.recover();
      assert.deepEqual(second, { scanned: 0, rebound: 0, settled: 0, skipped: 0 });
      assert.equal((yield* observedState.store.listEvents(threadId)).length, eventCount);
    }).pipe(Effect.provide(runtime.layer));
  }),
);

it.effect("服务重启扫描运行中的 active Task，并重新挂回终态等待器", () =>
  Effect.gen(function* () {
    const completionRuntime = yield* makeCompletionRuntime();
    const observedState = yield* makeObservedStateStore();
    const task: CompositionTask = {
      taskId: "spec-workflow:workflow-recovery-running:apply:6",
      projectId,
      threadId,
      assigneeKind: "agent",
      assigneeId: "implementer",
      mode: "serial",
      status: "running",
      promptDigest: "sha256:recovery-running",
      dependsOnTaskIds: [],
      createdAtUnixMs: 10,
      updatedAtUnixMs: 20,
    };
    const run: CompositionTaskRun = {
      taskId: task.taskId,
      runId: "run-spec-workflow-recovery-running",
      agentId: task.assigneeId,
      runtimeId: "runtime-service",
      status: "running",
      attempt: 0,
      capabilityGrantIds: [],
    };
    const runtime = makeLayer(
      () => {},
      completionRuntime.awaitTaskCompletion,
      observedState.store,
      () =>
        Effect.succeed([{ task, latestRun: run }] satisfies ReadonlyArray<CompositionTaskSnapshot>),
    );

    return yield* Effect.gen(function* () {
      yield* seedActiveWorkflow({
        store: observedState.store,
        workflowId: "workflow-recovery-running",
        task,
      });
      const service = yield* SpecWorkflowService;
      const stateChanges = yield* PubSub.subscribe(observedState.changes);
      const completionRequests = yield* PubSub.subscribe(completionRuntime.completionRequests);
      const receipt = yield* service.recover();
      const runId = yield* PubSub.take(completionRequests);
      const waiter = completionRuntime.waiters.get(runId);

      assert.deepEqual(receipt, { scanned: 1, rebound: 1, settled: 0, skipped: 0 });
      assert.equal(runId, run.runId);
      assert.isTrue(waiter !== undefined);
      const completedRun: CompositionTaskRun = { ...run, status: "completed" };
      yield* Deferred.succeed(waiter!, completedRun);
      const event = (yield* PubSub.take(stateChanges)).event;
      assert.equal(event.state.activeTaskId, null);
      assert.equal(event.state.implementationCompleted, true);
    }).pipe(Effect.provide(runtime.layer));
  }),
);

it.effect("能力关闭后启动恢复不重新绑定 active Task", () =>
  Effect.gen(function* () {
    const observedState = yield* makeObservedStateStore();
    const task: CompositionTask = {
      taskId: "spec-workflow:workflow-recovery-disabled:apply:6",
      projectId,
      threadId,
      assigneeKind: "agent",
      assigneeId: "implementer",
      mode: "serial",
      status: "running",
      promptDigest: "sha256:recovery-disabled",
      dependsOnTaskIds: [],
      createdAtUnixMs: 10,
      updatedAtUnixMs: 20,
    };
    const runtime = makeLayer(
      () => {},
      () => Effect.die("disabled recovery must not wait for a runtime task"),
      observedState.store,
      () => Effect.die("disabled recovery must not read Composition snapshots"),
      { ...enabledCapability, enabled: false },
    );

    return yield* Effect.gen(function* () {
      yield* seedActiveWorkflow({
        store: observedState.store,
        workflowId: "workflow-recovery-disabled",
        task,
      });
      const service = yield* SpecWorkflowService;
      const receipt = yield* service.recover();
      const state = yield* observedState.store.get(threadId);

      assert.deepEqual(receipt, { scanned: 1, rebound: 0, settled: 0, skipped: 1 });
      assert.equal(Option.isSome(state) ? state.value.activeTaskId : "missing", task.taskId);
    }).pipe(Effect.provide(runtime.layer));
  }),
);
