import { EnvironmentId } from "@codework/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Layer from "effect/Layer";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createWorkspaceScriptEnvironmentAtoms,
  workspaceScriptStartCommandKey,
  workspaceScriptStopCommandKey,
} from "./server.ts";

describe("Workspace Script environment atoms", () => {
  it("暴露列表、单条查询、启动和停止原子，并隔离查询缓存", () => {
    const runtime = Atom.runtime(Layer.empty) as unknown as Atom.AtomRuntime<
      EnvironmentRegistry,
      never
    >;
    const atoms = createWorkspaceScriptEnvironmentAtoms(runtime);
    const environmentId = EnvironmentId.make("environment-1");

    expect(Object.keys(atoms)).toEqual([
      "workspaceScriptRuns",
      "workspaceScriptRun",
      "startWorkspaceScript",
      "stopWorkspaceScript",
    ]);
    expect(atoms.workspaceScriptRuns({ environmentId, input: {} })).toBe(
      atoms.workspaceScriptRuns({ environmentId, input: {} }),
    );
    expect(atoms.workspaceScriptRuns({ environmentId, input: {} })).not.toBe(
      atoms.workspaceScriptRuns({ environmentId, input: { projectId: "project-1" } }),
    );
    expect(
      atoms.workspaceScriptRun({
        environmentId,
        input: { workspaceScriptRunId: "workspace-script-run:operation-1" },
      }),
    ).not.toBe(
      atoms.workspaceScriptRun({
        environmentId,
        input: { workspaceScriptRunId: "workspace-script-run:operation-2" },
      }),
    );
  });

  it("启动键包含完整不可变身份，避免把冲突请求错误合并", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const input = {
      operationId: "operation-1",
      projectId: "project-1",
      threadId: "thread-1",
      scriptId: "serve",
      worktreePath: "C:/repo/worktree",
      compositionTaskId: "task-1",
      compositionRunId: "run-1",
    };

    expect(workspaceScriptStartCommandKey({ environmentId, input })).toBe(
      workspaceScriptStartCommandKey({ environmentId, input }),
    );
    expect(workspaceScriptStartCommandKey({ environmentId, input })).not.toBe(
      workspaceScriptStartCommandKey({
        environmentId,
        input: { ...input, scriptId: "preview" },
      }),
    );
  });

  it("停止键区分运行、操作和预期 revision", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const input = {
      workspaceScriptRunId: "workspace-script-run:operation-1",
      operationId: "stop-1",
      expectedRevision: 2,
    };

    expect(workspaceScriptStopCommandKey({ environmentId, input })).not.toBe(
      workspaceScriptStopCommandKey({
        environmentId,
        input: { ...input, expectedRevision: 3 },
      }),
    );
    expect(workspaceScriptStopCommandKey({ environmentId, input })).not.toBe(
      workspaceScriptStopCommandKey({
        environmentId,
        input: { ...input, operationId: "stop-2" },
      }),
    );
  });
});
