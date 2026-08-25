import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  CompositionRuntimeLease,
  CompositionSquad,
  CompositionTask,
  CompositionTaskDependency,
  CompositionTaskRun,
} from "./composition.ts";

const decodeTask = Schema.decodeUnknownSync(CompositionTask);
const decodeRun = Schema.decodeUnknownSync(CompositionTaskRun);
const decodeDependency = Schema.decodeUnknownSync(CompositionTaskDependency);
const decodeLease = Schema.decodeUnknownSync(CompositionRuntimeLease);
const decodeSquad = Schema.decodeUnknownSync(CompositionSquad);

describe("composition task contracts", () => {
  it("keeps task identity, assignment, dependencies, and status explicit", () => {
    const task = decodeTask({
      taskId: "task-1",
      projectId: "project-1",
      parentTaskId: "task-parent",
      assigneeKind: "squad",
      assigneeId: "squad-1",
      mode: "parallel",
      status: "queued",
      promptDigest: "sha256:prompt",
      dependsOnTaskIds: ["task-dependency"],
      createdAtUnixMs: 1,
      updatedAtUnixMs: 1,
    });

    expect(task.assigneeKind).toBe("squad");
    expect(task.dependsOnTaskIds).toEqual(["task-dependency"]);
  });

  it("keeps retries as new runs and preserves failure summaries", () => {
    const run = decodeRun({
      runId: "run-2",
      taskId: "task-1",
      agentId: "agent-1",
      runtimeId: "runtime-1",
      status: "failed",
      attempt: 2,
      failureCode: "runtime_offline",
      resultSummary: "运行时不可用",
    });

    expect(run.attempt).toBe(2);
    expect(run.failureCode).toBe("runtime_offline");
  });

  it("does not allow dependency conditions outside the explicit set", () => {
    expect(() =>
      decodeDependency({
        taskId: "task-1",
        dependsOnTaskId: "task-2",
        condition: "anything",
        createdAtUnixMs: 1,
      }),
    ).toThrow();
  });

  it("models a single runtime lease and a leader-first squad", () => {
    const lease = decodeLease({
      leaseId: "lease-1",
      runtimeId: "runtime-1",
      taskId: "task-1",
      workspaceRootDigest: "sha256:workspace",
      heartbeatAtUnixMs: 100,
      expiresAtUnixMs: 200,
      state: "active",
    });
    const squad = decodeSquad({
      squadId: "squad-1",
      name: "主从协同",
      leaderAgentId: "agent-leader",
      memberAgentIds: ["agent-worker"],
      instructions: "先由 Leader 分派任务",
    });

    expect(lease.state).toBe("active");
    expect(squad.leaderAgentId).toBe("agent-leader");
  });
});
