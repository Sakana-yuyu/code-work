import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { CompositionTaskSnapshot } from "@codework/contracts";

import {
  CompositionTaskStore,
  type CompositionTaskStoreError,
  type CompositionTaskStoreShape,
} from "../persistence/Services/CompositionTaskStore.ts";
import { CompositionRunStartStore } from "../persistence/Services/CompositionRunStartStore.ts";
import { CompositionAgentDriverRegistryService } from "./CompositionAgentDriverRegistry.ts";
import { CapabilityGrantRegistry } from "./CapabilityGrantRegistry.ts";
import {
  makeCompositionOrchestrator,
  type CompositionOrchestrator,
} from "./CompositionOrchestrator.ts";
import { CompositionTaskInputStore } from "../persistence/Services/CompositionTaskInputStore.ts";

export interface CompositionOrchestratorServiceShape {
  readonly dispatchTask: CompositionOrchestrator["dispatchTask"];
  readonly cancelTask: CompositionOrchestrator["cancelTask"];
  readonly resumeTask: CompositionOrchestrator["resumeTask"];
  readonly reviewTask: CompositionOrchestrator["reviewTask"];
  readonly retryTask: CompositionOrchestrator["retryTask"];
  readonly resumeReadyTasks: CompositionOrchestrator["resumeReadyTasks"];
  readonly listTaskSnapshots: (
    projectId?: string,
  ) => Effect.Effect<ReadonlyArray<CompositionTaskSnapshot>, CompositionTaskStoreError>;
  readonly listEvents: CompositionTaskStoreShape["listEvents"];
}

export class CompositionOrchestratorService extends Context.Service<
  CompositionOrchestratorService,
  CompositionOrchestratorServiceShape
>()("codework/composition/CompositionOrchestratorService") {}

const live = Effect.gen(function* () {
  const store = yield* CompositionTaskStore;
  const driverRegistry = yield* CompositionAgentDriverRegistryService;
  const grantRegistry = yield* Effect.serviceOption(CapabilityGrantRegistry);
  const inputStore = yield* CompositionTaskInputStore;
  const startStore = yield* CompositionRunStartStore;
  const orchestrator = makeCompositionOrchestrator(
    store,
    driverRegistry,
    grantRegistry._tag === "Some" ? grantRegistry.value : undefined,
    inputStore,
    startStore,
  );

  return {
    dispatchTask: orchestrator.dispatchTask,
    cancelTask: orchestrator.cancelTask,
    resumeTask: orchestrator.resumeTask,
    reviewTask: orchestrator.reviewTask,
    retryTask: orchestrator.retryTask,
    resumeReadyTasks: orchestrator.resumeReadyTasks,
    listTaskSnapshots: (projectId) =>
      Effect.gen(function* () {
        const tasks = yield* store.listTasks(projectId);
        return yield* Effect.forEach(tasks, (task) =>
          store.getLatestRun(task.taskId).pipe(
            Effect.map((latestRun) => ({
              task,
              ...(latestRun._tag === "None" ? {} : { latestRun: latestRun.value }),
            })),
          ),
        );
      }),
    listEvents: store.listEvents,
  } satisfies CompositionOrchestratorServiceShape;
});

export const layer = Layer.effect(CompositionOrchestratorService, live);
