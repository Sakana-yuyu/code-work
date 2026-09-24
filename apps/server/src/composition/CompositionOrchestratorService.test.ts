import type { CompositionTask } from "@codework/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { CompositionTaskInputStoreError } from "../persistence/Services/CompositionTaskInputStore.ts";
import { listCompositionTaskSnapshots } from "./CompositionOrchestratorService.ts";

const task = (taskId: string): CompositionTask => ({
  taskId,
  projectId: "project-1",
  assigneeKind: "agent",
  assigneeId: "agent-1",
  mode: "serial",
  status: "completed",
  promptDigest: "sha256:test",
  dependsOnTaskIds: [],
  createdAtUnixMs: 1,
  updatedAtUnixMs: 2,
});

describe("任务列表的工作目录关联", () => {
  it.effect("从持久化执行输入取目录，不将读取失败误报为任务列表失败", () =>
    Effect.gen(function* () {
      const projects: Array<string | undefined> = [];
      const snapshots = yield* listCompositionTaskSnapshots(
        {
          listTasks: (projectId) => {
            projects.push(projectId);
            return Effect.succeed([task("available"), task("unreadable")]);
          },
          getLatestRun: () => Effect.succeed(Option.none()),
        },
        {
          get: (taskId) =>
            taskId === "available"
              ? Effect.succeed(
                  Option.some({
                    taskId,
                    prompt: "不应出现在列表响应中",
                    workspaceRoot: "C:/work/project-1",
                  }),
                )
              : Effect.fail(
                  new CompositionTaskInputStoreError({ operation: "get", detail: "unreadable" }),
                ),
        },
        "project-1",
      );

      expect(projects).toEqual(["project-1"]);
      expect(snapshots[0]?.workspaceRoot).toBe("C:/work/project-1");
      expect(snapshots[1]?.workspaceRoot).toBeUndefined();
      expect(snapshots[0]).not.toHaveProperty("prompt");
    }),
  );
});
