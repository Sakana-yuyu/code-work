import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  CompositionTaskStore,
  type CompositionTaskStoreShape,
} from "../persistence/Services/CompositionTaskStore.ts";
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
  readonly resumeReadyTasks: CompositionOrchestrator["resumeReadyTasks"];
  readonly listTasks: CompositionTaskStoreShape["listTasks"];
  readonly listEvents: CompositionTaskStoreShape["listEvents"];
}

export class CompositionOrchestratorService extends Context.Service<
  CompositionOrchestratorService,
  CompositionOrchestratorServiceShape
>()("t3/composition/CompositionOrchestratorService") {}

const live = Effect.gen(function* () {
  const store = yield* CompositionTaskStore;
  const driverRegistry = yield* CompositionAgentDriverRegistryService;
  const grantRegistry = yield* Effect.serviceOption(CapabilityGrantRegistry);
  const inputStore = yield* CompositionTaskInputStore;
  const orchestrator = makeCompositionOrchestrator(
    store,
    driverRegistry,
    grantRegistry._tag === "Some" ? grantRegistry.value : undefined,
    inputStore,
  );

  return {
    dispatchTask: orchestrator.dispatchTask,
    cancelTask: orchestrator.cancelTask,
    resumeReadyTasks: orchestrator.resumeReadyTasks,
    listTasks: store.listTasks,
    listEvents: store.listEvents,
  } satisfies CompositionOrchestratorServiceShape;
});

export const layer = Layer.effect(CompositionOrchestratorService, live);
