import type { CompositionTask, CompositionTaskRun } from "@codework/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { CompositionTaskStoreShape } from "../persistence/Services/CompositionTaskStore.ts";
import {
  guardCompositionRunStartAcceptedManualProjection,
  guardCompositionRunStartAcceptedProjection,
} from "./CompositionRunStartAcceptedProjection.ts";

const makeFixture = (status: CompositionTask["status"] = "queued") => {
  const task: CompositionTask = {
    taskId: "task-accepted-projection",
    projectId: "project-accepted-projection",
    assigneeKind: "agent",
    assigneeId: "agent-accepted-projection",
    mode: "serial",
    status,
    promptDigest: "sha256:accepted-projection",
    dependsOnTaskIds: [],
    createdAtUnixMs: 1,
    updatedAtUnixMs: 1,
  };
  const run: CompositionTaskRun = {
    taskId: task.taskId,
    runId: "run-accepted-projection",
    agentId: task.assigneeId,
    runtimeId: "runtime-accepted-projection",
    status,
    attempt: 1,
    capabilityGrantIds: [],
  };
  return { task, run };
};

const makeStore = (
  task: CompositionTask,
  run: CompositionTaskRun,
  latestRun: CompositionTaskRun = run,
): Pick<CompositionTaskStoreShape, "getTask" | "getRun" | "getLatestRun"> => ({
  getTask: (taskId) => Effect.succeed(taskId === task.taskId ? Option.some(task) : Option.none()),
  getRun: (runId) => Effect.succeed(runId === run.runId ? Option.some(run) : Option.none()),
  getLatestRun: (taskId) =>
    Effect.succeed(taskId === task.taskId ? Option.some(latestRun) : Option.none()),
});

const receipt = {
  runtimeTaskId: "runtime-task-accepted-projection",
  capabilityHandshakeId: null,
};

it.effect("accepted 正常投影拒绝已有取消请求", () =>
  Effect.gen(function* () {
    const fixture = makeFixture();
    const run = { ...fixture.run, cancelRequestedAtUnixMs: 2 };
    const guarded = yield* guardCompositionRunStartAcceptedProjection(
      makeStore(fixture.task, run),
      {
        task: fixture.task,
        run,
        runtimeId: run.runtimeId ?? "",
        receipt,
      },
    );

    assert.equal(guarded._tag, "Rejected");
    if (guarded._tag === "Rejected") {
      assert.equal(guarded.code, "run_start_accepted_projection_cancel_requested");
    }
  }),
);

it.effect("accepted 人工投影允许同一 waiting_input Run 保留 receipt", () =>
  Effect.gen(function* () {
    const fixture = makeFixture("waiting_input");
    const guarded = yield* guardCompositionRunStartAcceptedManualProjection(
      makeStore(fixture.task, fixture.run),
      {
        task: fixture.task,
        run: fixture.run,
        runtimeId: fixture.run.runtimeId ?? "",
        receipt,
      },
    );

    assert.equal(guarded._tag, "Ready");
    if (guarded._tag === "Ready") {
      assert.equal(guarded.task.status, "waiting_input");
      assert.equal(guarded.run.status, "waiting_input");
    }
  }),
);

it.effect("accepted 人工投影拒绝已有取消请求", () =>
  Effect.gen(function* () {
    const fixture = makeFixture();
    const run = { ...fixture.run, cancelRequestedAtUnixMs: 2 };
    const guarded = yield* guardCompositionRunStartAcceptedManualProjection(
      makeStore(fixture.task, run),
      {
        task: fixture.task,
        run,
        runtimeId: run.runtimeId,
        receipt,
      },
    );

    assert.equal(guarded._tag, "Rejected");
    if (guarded._tag === "Rejected") {
      assert.equal(guarded.code, "run_start_accepted_manual_projection_cancel_requested");
    }
  }),
);

it.effect("accepted 人工投影遇到更新 Run 时拒绝覆盖旧投影", () =>
  Effect.gen(function* () {
    const fixture = makeFixture();
    const latestRun: CompositionTaskRun = {
      ...fixture.run,
      runId: `${fixture.run.runId}-newer`,
      attempt: fixture.run.attempt + 1,
    };
    const guarded = yield* guardCompositionRunStartAcceptedManualProjection(
      makeStore(fixture.task, fixture.run, latestRun),
      {
        task: fixture.task,
        run: fixture.run,
        runtimeId: fixture.run.runtimeId ?? "",
        receipt,
      },
    );

    assert.equal(guarded._tag, "Rejected");
    if (guarded._tag === "Rejected") {
      assert.equal(guarded.code, "run_start_accepted_projection_run_replaced");
    }
  }),
);

it.effect("accepted 投影允许当前 Run 已持久化相同的早到 receipt", () =>
  Effect.gen(function* () {
    const fixture = makeFixture();
    const currentRun: CompositionTaskRun = {
      ...fixture.run,
      runtimeTaskId: receipt.runtimeTaskId,
    };
    const guarded = yield* guardCompositionRunStartAcceptedProjection(
      makeStore(fixture.task, currentRun),
      {
        task: fixture.task,
        run: fixture.run,
        runtimeId: fixture.run.runtimeId ?? "",
        receipt,
      },
    );

    assert.equal(guarded._tag, "Ready");
    if (guarded._tag === "Ready") {
      assert.equal(guarded.run.runtimeTaskId, receipt.runtimeTaskId);
    }
  }),
);

it.effect("accepted 投影拒绝当前 Run 已持久化的冲突 receipt", () =>
  Effect.gen(function* () {
    const fixture = makeFixture();
    const currentRun: CompositionTaskRun = {
      ...fixture.run,
      runtimeTaskId: "runtime-task-conflict",
    };
    const guarded = yield* guardCompositionRunStartAcceptedProjection(
      makeStore(fixture.task, currentRun),
      {
        task: fixture.task,
        run: fixture.run,
        runtimeId: fixture.run.runtimeId ?? "",
        receipt,
      },
    );

    assert.equal(guarded._tag, "Rejected");
    if (guarded._tag === "Rejected") {
      assert.equal(guarded.code, "run_start_accepted_projection_receipt_conflict");
    }
  }),
);
