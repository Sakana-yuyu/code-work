import type { CompositionTaskStatus } from "@codework/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { CompositionRunStartStore } from "../persistence/Services/CompositionRunStartStore.ts";
import { CompositionTaskStore } from "../persistence/Services/CompositionTaskStore.ts";
import {
  makeRunStartRetryRequest,
  seedFailedRunStart,
} from "./CompositionOrchestratorRunStartTestSupport.ts";
import { makeCompositionRunStartDigests } from "./CompositionRunStartLifecycle.ts";

export const seedDispatchingStart = (input: {
  readonly store: typeof CompositionTaskStore.Service;
  readonly runStartStore: typeof CompositionRunStartStore.Service;
  readonly taskId: string;
  readonly previousRunId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly runtimeId: string;
  readonly prompt: string;
  readonly workspaceRoot: string;
  readonly status?: CompositionTaskStatus;
  readonly runtimeTaskId?: string;
  readonly capabilityHandshakeId?: string;
  readonly capabilityGrantIds?: ReadonlyArray<string>;
  readonly includeRun?: boolean;
}) =>
  Effect.gen(function* () {
    yield* seedFailedRunStart(input.store, input);
    const request = makeRunStartRetryRequest(input.taskId, input.previousRunId, input.runId);
    const digests = makeCompositionRunStartDigests({
      prompt: input.prompt,
      workspaceRoot: input.workspaceRoot,
      capabilityIds: request.capabilityIds,
    });
    const prepared = yield* input.runStartStore.prepareStart({
      runId: input.runId,
      taskId: input.taskId,
      agentId: input.agentId,
      runtimeId: input.runtimeId,
      attempt: 2,
      payloadDigest: digests.payloadDigest,
      capabilityDigest: digests.capabilityDigest,
      createdAtUnixMs: 10,
    });
    const dispatching = yield* input.runStartStore.claimStart({
      runId: input.runId,
      expectedRevision: prepared.revision,
      claimId: `claim:${input.runId}`,
      claimedAtUnixMs: 11,
    });

    if (input.includeRun !== false) {
      const status = input.status ?? "queued";
      const previousTask = Option.getOrThrow(yield* input.store.getTask(input.taskId));
      const { finishedAtUnixMs: _finishedAtUnixMs, ...unfinishedTask } = previousTask;
      yield* input.store.upsertTask({
        ...unfinishedTask,
        status,
        updatedAtUnixMs: 12,
        ...(status === "completed" ? { finishedAtUnixMs: 12 } : {}),
      });
      yield* input.store.upsertRun({
        runId: input.runId,
        taskId: input.taskId,
        agentId: input.agentId,
        runtimeId: input.runtimeId,
        ...(input.runtimeTaskId === undefined ? {} : { runtimeTaskId: input.runtimeTaskId }),
        ...(input.capabilityHandshakeId === undefined
          ? {}
          : { capabilityHandshakeId: input.capabilityHandshakeId }),
        status,
        attempt: 2,
        capabilityGrantIds: [...(input.capabilityGrantIds ?? [])],
        ...(status === "running" ? { startedAtUnixMs: 12 } : {}),
        ...(status === "completed" ? { startedAtUnixMs: 12, finishedAtUnixMs: 13 } : {}),
      });
    }

    return { request, dispatching: dispatching.intent };
  });
