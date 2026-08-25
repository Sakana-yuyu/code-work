import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { CompositionCapabilityGrant } from "@t3tools/contracts";

import { makeCompositionAgentDriverRegistry } from "./CompositionAgentDriverRegistry.ts";
import {
  CompositionAgentDriverFailure,
  makeCompositionOrchestrator,
} from "./CompositionOrchestrator.ts";
import { CompositionTaskStore } from "../persistence/Services/CompositionTaskStore.ts";
import { CompositionTaskStoreLive } from "../persistence/Layers/CompositionTaskStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";

const layer = it.layer(CompositionTaskStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));

layer("CompositionOrchestrator", (it) => {
  it.effect("dispatches a task through its AgentDriver and persists the run lifecycle", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const started: string[] = [];
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId: "agent-1",
        runtimeId: "runtime-1",
        startTask: (input) =>
          Effect.sync(() => {
            started.push(input.task.taskId);
            return { runtimeTaskId: "runtime-task-1" };
          }),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
      });
      const orchestrator = makeCompositionOrchestrator(store, driverRegistry);

      const result = yield* orchestrator.dispatchTask({
        taskId: "task-1",
        runId: "run-1",
        projectId: "project-1",
        assigneeKind: "agent",
        assigneeId: "agent-1",
        mode: "serial",
        promptDigest: "sha256:prompt",
        capabilityIds: [],
        dependsOnTaskIds: [],
      });

      assert.deepEqual(started, ["task-1"]);
      assert.equal(result.task.status, "running");
      assert.equal(result.run.runtimeTaskId, "runtime-task-1");
      const events = yield* store.listEvents("task-1", "run-1");
      assert.deepEqual(
        events.map((event) => event.status),
        ["queued", "running"],
      );
    }),
  );

  it.effect("按 Squad 的 Leader Agent Driver 执行，并保留 Squad 任务归属", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const startedBy: string[] = [];
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* store.upsertSquad({
        squadId: "squad-1",
        name: "代码协同组",
        leaderAgentId: "agent-leader",
        memberAgentIds: ["agent-leader", "agent-worker"],
      });
      yield* driverRegistry.register({
        agentId: "agent-leader",
        runtimeId: "runtime-leader",
        startTask: (input) =>
          Effect.sync(() => {
            startedBy.push(input.run.agentId);
            return { runtimeTaskId: "runtime-task-squad" };
          }),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
      });
      const orchestrator = makeCompositionOrchestrator(store, driverRegistry);

      const result = yield* orchestrator.dispatchTask({
        taskId: "task-squad",
        runId: "run-squad",
        projectId: "project-1",
        assigneeKind: "squad",
        assigneeId: "squad-1",
        mode: "parallel",
        promptDigest: "sha256:squad",
        dependsOnTaskIds: [],
      });

      assert.deepEqual(startedBy, ["agent-leader"]);
      assert.equal(result.task.assigneeId, "squad-1");
      assert.equal(result.run.agentId, "agent-leader");
      assert.equal(result.run.runtimeId, "runtime-leader");
    }),
  );

  it.effect("为普通 Composition Task 签发 grant，并把 grant ID 持久化和传给 Driver", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const captured: string[][] = [];
      const revoked: string[] = [];
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId: "agent-grant",
        runtimeId: "runtime-grant",
        startTask: (input) =>
          Effect.sync(() => {
            captured.push([...(input.capabilityGrantIds ?? [])]);
            return {
              runtimeTaskId: "runtime-task-grant",
              capabilityHandshakeId: "handshake-grant",
            };
          }),
        revokeCapabilityHandshake: ({ run }) =>
          Effect.sync(() => revoked.push(`handshake:${run.capabilityHandshakeId}`)),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
      });
      const grants: CompositionCapabilityGrant[] = [
        {
          grantId: "grant-1",
          taskId: "task-grant",
          agentId: "agent-grant",
          capabilityId: "workspace.read",
          issuedAtUnixMs: 1,
          expiresAtUnixMs: 900_001,
        },
      ];
      const orchestrator = makeCompositionOrchestrator(store, driverRegistry, {
        issue: () => Effect.succeed(grants),
        revoke: ({ grantId }) => Effect.sync(() => revoked.push(grantId)),
      });

      const result = yield* orchestrator.dispatchTask({
        taskId: "task-grant",
        runId: "run-grant",
        projectId: "project-1",
        assigneeKind: "agent",
        assigneeId: "agent-grant",
        mode: "serial",
        promptDigest: "sha256:grant",
        capabilityIds: ["workspace.read"],
        dependsOnTaskIds: [],
      });

      assert.deepEqual(result.run.capabilityGrantIds, ["grant-1"]);
      assert.equal(result.run.capabilityHandshakeId, "handshake-grant");
      assert.deepEqual(captured, [["grant-1"]]);
      const savedRun = yield* store.getRun("run-grant");
      assert.isTrue(Option.isSome(savedRun));
      if (Option.isSome(savedRun)) assert.deepEqual(savedRun.value.capabilityGrantIds, ["grant-1"]);
      const cancelled = yield* orchestrator.cancelTask({
        taskId: "task-grant",
        runId: "run-grant",
        reason: "用户取消",
      });
      assert.equal(cancelled.status, "cancelled");
      assert.deepEqual(revoked, ["handshake:handshake-grant", "grant-1"]);
    }),
  );

  it.effect("blocks a dependent task until the dependency reaches a valid terminal state", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      yield* store.upsertTask({
        taskId: "dependency-1",
        projectId: "project-1",
        assigneeKind: "agent",
        assigneeId: "agent-1",
        mode: "serial",
        status: "running",
        promptDigest: "sha256:dependency",
        dependsOnTaskIds: [],
        createdAtUnixMs: 1,
        updatedAtUnixMs: 1,
      });
      const started: string[] = [];
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId: "agent-1",
        runtimeId: "runtime-1",
        startTask: (input) =>
          Effect.sync(() => {
            started.push(input.task.taskId);
            return {};
          }),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
      });
      const orchestrator = makeCompositionOrchestrator(store, driverRegistry);

      const result = yield* orchestrator.dispatchTask({
        taskId: "task-blocked",
        runId: "run-blocked",
        projectId: "project-1",
        assigneeKind: "agent",
        assigneeId: "agent-1",
        mode: "serial",
        promptDigest: "sha256:prompt",
        capabilityIds: [],
        dependsOnTaskIds: ["dependency-1"],
      });

      assert.equal(result.task.status, "blocked");
      assert.equal(result.run.status, "blocked");
      assert.deepEqual(started, []);
      assert.equal(
        (yield* store.listEvents("task-blocked", "run-blocked"))[0]?.eventType,
        "blocker",
      );
    }),
  );

  it.effect("persists a failed run when its AgentDriver is unavailable", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const orchestrator = makeCompositionOrchestrator(store, makeCompositionAgentDriverRegistry());

      const result = yield* orchestrator.dispatchTask({
        taskId: "task-no-driver",
        runId: "run-no-driver",
        projectId: "project-1",
        assigneeKind: "agent",
        assigneeId: "missing-agent",
        mode: "serial",
        promptDigest: "sha256:prompt",
        capabilityIds: [],
        dependsOnTaskIds: [],
      });

      assert.equal(result.task.status, "failed");
      assert.equal(result.run.failureCode, "agent_driver_unavailable");
      assert.equal(
        (yield* store.listEvents("task-no-driver", "run-no-driver")).at(-1)?.status,
        "failed",
      );
    }),
  );

  it.effect("外部只接受取消请求时保留运行状态并追加等待事件", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const driverRegistry = makeCompositionAgentDriverRegistry();
      const revoked: string[] = [];
      const grants: CompositionCapabilityGrant[] = [
        {
          grantId: "grant-cancel-requested",
          taskId: "task-cancel-requested",
          agentId: "agent-cancel-requested",
          capabilityId: "workspace.read",
          issuedAtUnixMs: 1,
          expiresAtUnixMs: 900_001,
        },
      ];
      yield* driverRegistry.register({
        agentId: "agent-cancel-requested",
        runtimeId: "runtime-cancel-requested",
        startTask: () => Effect.succeed({ runtimeTaskId: "runtime-task-cancel-requested" }),
        cancelTask: () => Effect.succeed({ status: "cancel_requested" as const }),
      });
      const orchestrator = makeCompositionOrchestrator(store, driverRegistry);
      const orchestratorWithGrants = makeCompositionOrchestrator(store, driverRegistry, {
        issue: () => Effect.succeed(grants),
        revoke: ({ grantId }) => Effect.sync(() => revoked.push(grantId)),
      });

      yield* orchestratorWithGrants.dispatchTask({
        taskId: "task-cancel-requested",
        runId: "run-cancel-requested",
        projectId: "project-1",
        assigneeKind: "agent",
        assigneeId: "agent-cancel-requested",
        mode: "serial",
        promptDigest: "sha256:cancel-requested",
        capabilityIds: ["workspace.read"],
        dependsOnTaskIds: [],
      });

      const result = yield* orchestratorWithGrants.cancelTask({
        taskId: "task-cancel-requested",
        runId: "run-cancel-requested",
        reason: "用户取消",
      });
      assert.equal(result.status, "cancel_requested");
      assert.equal(result.task.status, "running");
      assert.equal(result.run.status, "running");
      assert.deepEqual(revoked, []);
      assert.equal(
        (yield* store.listEvents("task-cancel-requested", "run-cancel-requested")).at(-1)
          ?.eventType,
        "message",
      );
    }),
  );

  it.effect("外部取消能力失败时不提前修改 T3 任务终态", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId: "agent-cancel-failed",
        runtimeId: "runtime-cancel-failed",
        startTask: () => Effect.succeed({ runtimeTaskId: "runtime-task-cancel-failed" }),
        cancelTask: () =>
          Effect.fail(
            new CompositionAgentDriverFailure({
              code: "cancel_not_supported",
              detail: "外部 Runtime 未提供取消接口。",
            }),
          ),
      });
      const orchestrator = makeCompositionOrchestrator(store, driverRegistry);

      yield* orchestrator.dispatchTask({
        taskId: "task-cancel-failed",
        runId: "run-cancel-failed",
        projectId: "project-1",
        assigneeKind: "agent",
        assigneeId: "agent-cancel-failed",
        mode: "serial",
        promptDigest: "sha256:cancel-failed",
        capabilityIds: [],
        dependsOnTaskIds: [],
      });

      yield* Effect.flip(
        orchestrator.cancelTask({
          taskId: "task-cancel-failed",
          runId: "run-cancel-failed",
          reason: "用户取消",
        }),
      );
      const savedTask = yield* store.getTask("task-cancel-failed");
      assert.isTrue(Option.isSome(savedTask));
      if (Option.isSome(savedTask)) assert.equal(savedTask.value.status, "running");
    }),
  );

  it.effect("持久化可恢复的派发输入而不改变任务摘要投影", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const persisted: Array<{
        readonly taskId: string;
        readonly prompt: string;
        readonly workspaceRoot: string;
        readonly workspaceRootDigest?: string;
        readonly model?: string;
      }> = [];
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId: "agent-recovery",
        runtimeId: "runtime-recovery",
        startTask: () => Effect.succeed({ runtimeTaskId: "runtime-task-recovery" }),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
      });
      const orchestrator = makeCompositionOrchestrator(store, driverRegistry, undefined, {
        save: (input) => Effect.sync(() => void persisted.push(input)),
        get: () => Effect.succeed(Option.none()),
        remove: () => Effect.void,
      });

      const result = yield* orchestrator.dispatchTask({
        taskId: "task-recovery",
        runId: "run-recovery",
        projectId: "project-1",
        assigneeKind: "agent",
        assigneeId: "agent-recovery",
        mode: "serial",
        promptDigest: "sha256:recovery",
        dependsOnTaskIds: [],
        prompt: "恢复这次任务并继续执行",
        workspaceRoot: "C:/workspace/recovery",
        workspaceRootDigest: "sha256:workspace-recovery",
        model: "provider/model",
      });

      assert.equal(result.task.promptDigest, "sha256:recovery");
      assert.deepEqual(persisted, [
        {
          taskId: "task-recovery",
          prompt: "恢复这次任务并继续执行",
          workspaceRoot: "C:/workspace/recovery",
          workspaceRootDigest: "sha256:workspace-recovery",
          model: "provider/model",
        },
      ]);
    }),
  );

  it.effect("依赖完成后恢复有持久化输入的 blocked task", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const started: Array<{ readonly taskId: string; readonly prompt?: string }> = [];
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId: "agent-resume",
        runtimeId: "runtime-resume",
        startTask: (input) =>
          Effect.sync(() => {
            started.push({
              taskId: input.task.taskId,
              ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
            });
            return { runtimeTaskId: "runtime-task-resumed" };
          }),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
      });
      yield* store.upsertTask({
        taskId: "dependency-resume",
        projectId: "project-resume",
        assigneeKind: "agent",
        assigneeId: "agent-resume",
        mode: "serial",
        status: "completed",
        promptDigest: "sha256:dependency-resume",
        dependsOnTaskIds: [],
        createdAtUnixMs: 1,
        updatedAtUnixMs: 2,
        finishedAtUnixMs: 2,
      });
      yield* store.upsertTask({
        taskId: "task-resume",
        projectId: "project-resume",
        assigneeKind: "agent",
        assigneeId: "agent-resume",
        mode: "serial",
        status: "blocked",
        promptDigest: "sha256:task-resume",
        dependsOnTaskIds: ["dependency-resume"],
        createdAtUnixMs: 1,
        updatedAtUnixMs: 1,
      });
      yield* store.upsertRun({
        taskId: "task-resume",
        runId: "run-resume",
        agentId: "agent-resume",
        runtimeId: "runtime-resume",
        status: "blocked",
        attempt: 1,
        capabilityGrantIds: [],
      });

      const orchestrator = makeCompositionOrchestrator(store, driverRegistry, undefined, {
        save: () => Effect.void,
        get: (taskId) =>
          Effect.succeed(
            taskId === "task-resume"
              ? Option.some({
                  taskId,
                  prompt: "继续执行恢复任务",
                  workspaceRoot: "C:/workspace/resume",
                })
              : Option.none(),
          ),
        remove: () => Effect.void,
      });

      const resumed = yield* orchestrator.resumeReadyTasks();

      assert.deepEqual(started, [{ taskId: "task-resume", prompt: "继续执行恢复任务" }]);
      assert.deepEqual(
        resumed.map((item) => item.task.taskId),
        ["task-resume"],
      );
      assert.equal(resumed[0]?.task.status, "running");
      assert.equal((yield* store.getTask("task-resume")).pipe(Option.getOrThrow).status, "running");
    }),
  );
});
