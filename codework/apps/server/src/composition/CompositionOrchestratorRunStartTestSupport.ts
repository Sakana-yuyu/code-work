import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { CompositionRunStartStoreLive } from "../persistence/Layers/CompositionRunStartStore.ts";
import { CompositionTaskStoreLive } from "../persistence/Layers/CompositionTaskStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import type { CompositionTaskInputStoreShape } from "../persistence/Services/CompositionTaskInputStore.ts";
import type { CompositionTaskStoreShape } from "../persistence/Services/CompositionTaskStore.ts";

export const compositionOrchestratorRunStartTestLayer = Layer.mergeAll(
  CompositionTaskStoreLive,
  CompositionRunStartStoreLive,
).pipe(Layer.provide(SqlitePersistenceMemory));

export const makeRunStartRecoveryInputStore = (
  taskId: string,
  prompt: string,
  workspaceRoot: string,
): CompositionTaskInputStoreShape => ({
  save: () => Effect.void,
  get: (candidateTaskId) =>
    Effect.succeed(
      candidateTaskId === taskId ? Option.some({ taskId, prompt, workspaceRoot }) : Option.none(),
    ),
  remove: () => Effect.void,
});

export const seedFailedRunStart = (
  store: CompositionTaskStoreShape,
  input: {
    readonly taskId: string;
    readonly previousRunId: string;
    readonly agentId: string;
    readonly runtimeId: string;
  },
) =>
  Effect.gen(function* () {
    yield* store.upsertTask({
      taskId: input.taskId,
      projectId: "project-run-start",
      assigneeKind: "agent",
      assigneeId: input.agentId,
      mode: "serial",
      status: "failed",
      promptDigest: `sha256:${input.taskId}`,
      dependsOnTaskIds: [],
      createdAtUnixMs: 1,
      updatedAtUnixMs: 2,
      finishedAtUnixMs: 2,
    });
    yield* store.upsertRun({
      taskId: input.taskId,
      runId: input.previousRunId,
      agentId: input.agentId,
      runtimeId: input.runtimeId,
      status: "failed",
      attempt: 1,
      capabilityGrantIds: [],
      failureCode: "goal_not_converged",
    });
  });

export const makeRunStartRetryRequest = (taskId: string, previousRunId: string, runId: string) => ({
  taskId,
  previousRunId,
  runId,
  reason: "Goal Loop 继续收敛",
  capabilityIds: ["t3.workspace.read_file"],
});
