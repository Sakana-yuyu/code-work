import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  CompositionTaskStore,
  type CompositionTaskStoreShape,
} from "../persistence/Services/CompositionTaskStore.ts";
import { CompositionProviderAgentDriverProjectionService } from "./CompositionProviderAgentDriverRegistry.ts";
import {
  makeCompositionOrchestrator,
  type CompositionOrchestrator,
} from "./CompositionOrchestrator.ts";

export interface CompositionOrchestratorServiceShape {
  readonly dispatchTask: CompositionOrchestrator["dispatchTask"];
  readonly cancelTask: CompositionOrchestrator["cancelTask"];
  readonly listTasks: CompositionTaskStoreShape["listTasks"];
  readonly listEvents: CompositionTaskStoreShape["listEvents"];
}

export class CompositionOrchestratorService extends Context.Service<
  CompositionOrchestratorService,
  CompositionOrchestratorServiceShape
>()("t3/composition/CompositionOrchestratorService") {}

const live = Effect.gen(function* () {
  const store = yield* CompositionTaskStore;
  const projection = yield* CompositionProviderAgentDriverProjectionService;
  const orchestrator = makeCompositionOrchestrator(store, projection.registry);

  return {
    dispatchTask: orchestrator.dispatchTask,
    cancelTask: orchestrator.cancelTask,
    listTasks: store.listTasks,
    listEvents: store.listEvents,
  } satisfies CompositionOrchestratorServiceShape;
});

export const layer = Layer.effect(CompositionOrchestratorService, live);
