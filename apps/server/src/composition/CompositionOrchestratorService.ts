import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { CompositionTaskSnapshot } from "@codework/contracts";

import {
  CompositionTaskStore,
  type CompositionTaskStoreError,
  type CompositionTaskStoreShape,
} from "../persistence/Services/CompositionTaskStore.ts";
import { CompositionRunStartStore } from "../persistence/Services/CompositionRunStartStore.ts";
import {
  CompositionTaskInputStore,
  type CompositionTaskInputStoreShape,
} from "../persistence/Services/CompositionTaskInputStore.ts";
import { CompositionAgentDriverRegistryService } from "./CompositionAgentDriverRegistry.ts";
import { CapabilityGrantRegistry } from "./CapabilityGrantRegistry.ts";
import {
  makeCompositionOrchestrator,
  type CompositionOrchestrator,
} from "./CompositionOrchestrator.ts";

export interface CompositionOrchestratorServiceShape {
  readonly dispatchTask: CompositionOrchestrator["dispatchTask"];
  readonly cancelTask: CompositionOrchestrator["cancelTask"];
  readonly resumeTask: CompositionOrchestrator["resumeTask"];
  readonly reviewTask: CompositionOrchestrator["reviewTask"];
  readonly retryTask: CompositionOrchestrator["retryTask"];
  readonly resumeReadyTasks: CompositionOrchestrator["resumeReadyTasks"];
  readonly recoverPersistedRunStart: CompositionOrchestrator["recoverPersistedRunStart"];
  readonly recordPersistedRunStartRecoveryProblem: CompositionOrchestrator["recordPersistedRunStartRecoveryProblem"];
  readonly listTaskSnapshots: (
    projectId?: string,
  ) => Effect.Effect<ReadonlyArray<CompositionTaskSnapshot>, CompositionTaskStoreError>;
  readonly listEvents: CompositionTaskStoreShape["listEvents"];
}

export class CompositionOrchestratorService extends Context.Service<
  CompositionOrchestratorService,
  CompositionOrchestratorServiceShape
>()("codework/composition/CompositionOrchestratorService") {}

/** 列表保留旧任务可读性；仅在执行输入仍可读取时附上真实工作目录。 */
export const listCompositionTaskSnapshots = (
  store: Pick<CompositionTaskStoreShape, "listTasks" | "getLatestRun">,
  inputStore: Pick<CompositionTaskInputStoreShape, "get">,
  projectId?: string,
) =>
  Effect.gen(function* () {
    const tasks = yield* store.listTasks(projectId);
    return yield* Effect.forEach(tasks, (task) =>
      Effect.all({
        latestRun: store.getLatestRun(task.taskId),
        input: inputStore.get(task.taskId).pipe(Effect.orElseSucceed(() => Option.none())),
      }).pipe(
        Effect.map(({ latestRun, input }) => ({
          task,
          ...(Option.isSome(latestRun) ? { latestRun: latestRun.value } : {}),
          ...(Option.isSome(input) ? { workspaceRoot: input.value.workspaceRoot } : {}),
        })),
      ),
    );
  });

const live = Effect.gen(function* () {
  const store = yield* CompositionTaskStore;
  const driverRegistry = yield* CompositionAgentDriverRegistryService;
  const grantRegistry = yield* Effect.serviceOption(CapabilityGrantRegistry);
  const inputStore = yield* CompositionTaskInputStore;
  const runStartStore = yield* CompositionRunStartStore;
  const orchestrator = makeCompositionOrchestrator(
    store,
    driverRegistry,
    grantRegistry._tag === "Some" ? grantRegistry.value : undefined,
    inputStore,
    runStartStore,
  );

  return {
    dispatchTask: orchestrator.dispatchTask,
    cancelTask: orchestrator.cancelTask,
    resumeTask: orchestrator.resumeTask,
    reviewTask: orchestrator.reviewTask,
    retryTask: orchestrator.retryTask,
    resumeReadyTasks: orchestrator.resumeReadyTasks,
    recoverPersistedRunStart: orchestrator.recoverPersistedRunStart,
    recordPersistedRunStartRecoveryProblem: orchestrator.recordPersistedRunStartRecoveryProblem,
    listTaskSnapshots: (projectId) => listCompositionTaskSnapshots(store, inputStore, projectId),
    listEvents: store.listEvents,
  } satisfies CompositionOrchestratorServiceShape;
});

export const layer = Layer.effect(CompositionOrchestratorService, live);
