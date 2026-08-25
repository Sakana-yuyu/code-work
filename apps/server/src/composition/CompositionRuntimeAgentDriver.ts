import type { ProviderRuntimeEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  CompositionAgentDriverFailure,
  type CompositionAgentDriver,
} from "./CompositionOrchestrator.ts";
import type {
  CompositionRuntimeAdapter,
  CompositionRuntimeTaskInput,
} from "./CompositionRuntimeAdapter.ts";

export interface CompositionRuntimeAgentDriverOptions {
  readonly adapter: CompositionRuntimeAdapter;
  readonly agentId: string;
}

type ActiveRun = {
  readonly taskId: string;
  readonly runId: string;
  readonly runtimeTaskId: string;
};

const errorDetail = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const makeFailure = (code: string, error: unknown) =>
  new CompositionAgentDriverFailure({ code, detail: errorDetail(error) });

const recordString = (value: unknown, key: string): string | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate : undefined;
};

const runtimeTaskIdFromEvent = (event: ProviderRuntimeEvent): string | undefined =>
  recordString(event.payload, "runtimeTaskId") ??
  recordString(event.payload, "taskId") ??
  recordString(event.raw?.payload, "runtimeTaskId") ??
  recordString(event.raw?.payload, "taskId");

export const makeCompositionRuntimeAgentDriver = (
  options: CompositionRuntimeAgentDriverOptions,
): CompositionAgentDriver => {
  const activeRuns = new Map<string, ActiveRun>();

  const startTask: CompositionAgentDriver["startTask"] = (input) => {
    const runtimeInput: CompositionRuntimeTaskInput = {
      taskId: input.task.taskId,
      runId: input.run.runId,
      agentId: options.agentId,
      idempotencyKey: input.run.runId,
      ...(input.workspaceRootDigest === undefined
        ? {}
        : { workspaceRootDigest: input.workspaceRootDigest }),
      ...(input.workspaceRoot === undefined ? {} : { workspaceRoot: input.workspaceRoot }),
      ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
      ...(input.model === undefined ? {} : { model: input.model }),
      promptDigest: input.task.promptDigest,
    };

    return options.adapter.dispatchTask(runtimeInput).pipe(
      Effect.mapError((failure) => makeFailure(failure.code, failure)),
      Effect.tap((result) =>
        Effect.sync(() => {
          activeRuns.set(input.run.runId, {
            taskId: input.task.taskId,
            runId: input.run.runId,
            runtimeTaskId: result.runtimeTaskId,
          });
        }),
      ),
      Effect.map((result) => ({ runtimeTaskId: result.runtimeTaskId })),
    );
  };

  const cancelTask: CompositionAgentDriver["cancelTask"] = (input) =>
    options.adapter
      .cancelTask({
        taskId: input.task.taskId,
        runId: input.run.runId,
        ...(input.run.runtimeTaskId === undefined
          ? {}
          : { runtimeTaskId: input.run.runtimeTaskId }),
      })
      .pipe(
        Effect.mapError((failure) => makeFailure(failure.code, failure)),
        Effect.tap((result) =>
          Effect.sync(() => {
            if (result.status !== "cancel_requested") activeRuns.delete(input.run.runId);
          }),
        ),
        Effect.map((result) => ({ status: result.status })),
      );

  return {
    agentId: options.agentId,
    runtimeId: options.adapter.runtimeId,
    startTask,
    cancelTask,
    resolveRuntimeEvent: (event) => {
      const runtimeTaskId = runtimeTaskIdFromEvent(event);
      if (runtimeTaskId === undefined) return undefined;
      for (const active of activeRuns.values()) {
        if (active.runtimeTaskId !== runtimeTaskId) continue;
        return {
          taskId: active.taskId,
          runId: active.runId,
          runtimeTaskId: active.runtimeTaskId,
        };
      }
      return undefined;
    },
  };
};
