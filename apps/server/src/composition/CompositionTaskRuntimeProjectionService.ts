import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import type { ProviderRuntimeEvent } from "@t3tools/contracts";
import type { PersistenceSqlError } from "../persistence/Errors.ts";
import { CompositionTaskStore } from "../persistence/Services/CompositionTaskStore.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { CompositionProviderAgentDriverProjectionService } from "./CompositionProviderAgentDriverRegistry.ts";
import { projectCompositionRuntimeEvent } from "./CompositionTaskRuntimeProjector.ts";

export interface CompositionTaskRuntimeProjectionServiceShape {
  readonly projectRuntimeEvent: (
    event: ProviderRuntimeEvent,
  ) => Effect.Effect<void, PersistenceSqlError>;
}

export class CompositionTaskRuntimeProjectionService extends Context.Service<
  CompositionTaskRuntimeProjectionService,
  CompositionTaskRuntimeProjectionServiceShape
>()("t3/composition/CompositionTaskRuntimeProjectionService") {}

const live = Effect.gen(function* () {
  const store = yield* CompositionTaskStore;
  const provider = yield* ProviderService;
  const projection = yield* CompositionProviderAgentDriverProjectionService;
  const projectRuntimeEvent = (event: Parameters<typeof projectCompositionRuntimeEvent>[2]) =>
    projectCompositionRuntimeEvent(store, projection.registry, event);

  yield* Stream.runForEach(provider.streamEvents, (event) =>
    projectRuntimeEvent(event).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("Composition Task Runtime 事件投影失败", { cause }),
      ),
    ),
  ).pipe(Effect.forkScoped);

  return { projectRuntimeEvent } satisfies CompositionTaskRuntimeProjectionServiceShape;
});

export const layer = Layer.effect(CompositionTaskRuntimeProjectionService, live);
