import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type {
  CompositionTask,
  CompositionTaskRun,
  CompositionTaskStatus,
  ProviderRuntimeEvent,
} from "@t3tools/contracts";
import type { PersistenceSqlError } from "../persistence/Errors.ts";
import { CompositionTaskStore } from "../persistence/Services/CompositionTaskStore.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { CompositionAgentDriverRegistryService } from "./CompositionAgentDriverRegistry.ts";
import { CompositionOrchestratorService } from "./CompositionOrchestratorService.ts";
import { projectCompositionRuntimeEvent } from "./CompositionTaskRuntimeProjector.ts";
import { CompositionRuntimeAdapterRegistryService } from "./CompositionRuntimeAdapterRegistry.ts";
import type {
  CompositionAgentDriver,
  CompositionAgentDriverFailure,
} from "./CompositionOrchestrator.ts";
import * as CapabilityGrantRegistry from "./CapabilityGrantRegistry.ts";

export interface CompositionTaskRuntimeProjectionServiceShape {
  readonly projectRuntimeEvent: (
    event: ProviderRuntimeEvent,
  ) => Effect.Effect<
    void,
    | PersistenceSqlError
    | CapabilityGrantRegistry.CapabilityGrantPersistenceError
    | CompositionAgentDriverFailure
  >;
  /** 等待指定 run 的事件投影进入终态或 review 检查点，不轮询数据库。 */
  readonly awaitTaskCompletion: (input: {
    readonly taskId: string;
    readonly runId: string;
  }) => Effect.Effect<CompositionTaskRun, PersistenceSqlError | CompositionTaskRuntimeWaitError>;
}

export class CompositionTaskRuntimeProjectionService extends Context.Service<
  CompositionTaskRuntimeProjectionService,
  CompositionTaskRuntimeProjectionServiceShape
>()("t3/composition/CompositionTaskRuntimeProjectionService") {}

export class CompositionTaskRuntimeWaitError extends Schema.TaggedErrorClass<CompositionTaskRuntimeWaitError>()(
  "CompositionTaskRuntimeWaitError",
  {
    taskId: Schema.String,
    runId: Schema.String,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `等待 Composition Task 完成失败：${this.taskId}/${this.runId}：${this.reason}`;
  }
}

export type CompositionTaskRuntimeUpdate = {
  readonly task: CompositionTask;
  readonly run: CompositionTaskRun;
};

const completionStatuses: ReadonlySet<CompositionTaskStatus> = new Set([
  "in_review",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);

const isComplete = (run: CompositionTaskRun): boolean => completionStatuses.has(run.status);

const awaitCompletionUpdate = (
  subscription: PubSub.Subscription<CompositionTaskRuntimeUpdate>,
  input: { readonly taskId: string; readonly runId: string },
): Effect.Effect<CompositionTaskRun, CompositionTaskRuntimeWaitError> =>
  Effect.suspend(
    (): Effect.Effect<CompositionTaskRun, CompositionTaskRuntimeWaitError> =>
      PubSub.take(subscription).pipe(
        Effect.flatMap((update) =>
          update.task.taskId === input.taskId &&
          update.run.runId === input.runId &&
          isComplete(update.run)
            ? Effect.succeed(update.run)
            : awaitCompletionUpdate(subscription, input),
        ),
      ),
  );

const live = Effect.gen(function* () {
  const store = yield* CompositionTaskStore;
  const provider = yield* ProviderService;
  const driverRegistry = yield* CompositionAgentDriverRegistryService;
  const orchestrator = yield* CompositionOrchestratorService;
  const grantRegistry = yield* CapabilityGrantRegistry.CapabilityGrantRegistry;
  const runtimeAdapters = yield* CompositionRuntimeAdapterRegistryService;
  const updates = yield* PubSub.unbounded<CompositionTaskRuntimeUpdate>();
  const projectRuntimeEvent = (event: Parameters<typeof projectCompositionRuntimeEvent>[2]) =>
    projectCompositionRuntimeEvent(store, driverRegistry, event, grantRegistry, () =>
      orchestrator.resumeReadyTasks().pipe(
        Effect.asVoid,
        Effect.catchCause((cause) => Effect.logError("Composition Task 依赖恢复失败", { cause })),
      ),
    ).pipe(
      Effect.flatMap(() =>
        driverRegistry.resolveRuntimeEvent(event).pipe(
          Effect.flatMap((binding) =>
            binding === undefined
              ? Effect.void
              : store.getTask(binding.taskId).pipe(
                  Effect.flatMap((taskOption) =>
                    Option.match(taskOption, {
                      onNone: () => Effect.void,
                      onSome: (task) =>
                        store.getRun(binding.runId).pipe(
                          Effect.flatMap((runOption) =>
                            Option.match(runOption, {
                              onNone: () => Effect.void,
                              onSome: (run) =>
                                PubSub.publish(updates, { task, run }).pipe(Effect.asVoid),
                            }),
                          ),
                        ),
                    }),
                  ),
                ),
          ),
        ),
      ),
    );

  const awaitTaskCompletion: CompositionTaskRuntimeProjectionServiceShape["awaitTaskCompletion"] = (
    input,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(updates);
        const current = yield* store.getRun(input.runId);
        if (Option.isNone(current)) {
          return yield* new CompositionTaskRuntimeWaitError({
            taskId: input.taskId,
            runId: input.runId,
            reason: "run_not_found",
          });
        }
        if (isComplete(current.value)) return current.value;
        return yield* awaitCompletionUpdate(subscription, input);
      }),
    );

  const projectRuntimeEventWithLogging = (event: ProviderRuntimeEvent) =>
    projectRuntimeEvent(event).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("Composition Task Runtime 事件投影失败", { cause }),
      ),
    );

  yield* Stream.runForEach(provider.streamEvents, projectRuntimeEventWithLogging).pipe(
    Effect.forkScoped,
  );

  const runningDriverStreams = new Map<
    string,
    {
      readonly driver: CompositionAgentDriver;
      readonly fiber: Fiber.Fiber<void, never>;
    }
  >();
  const startDriverStreams = Effect.gen(function* () {
    const drivers = yield* driverRegistry.list;
    const liveAgentIds = new Set(drivers.map((driver) => driver.agentId));
    for (const [agentId, entry] of runningDriverStreams) {
      if (liveAgentIds.has(agentId)) continue;
      yield* Fiber.interrupt(entry.fiber).pipe(Effect.ignore);
      runningDriverStreams.delete(agentId);
    }
    for (const driver of drivers) {
      if (driver.streamEvents === undefined) continue;
      const existing = runningDriverStreams.get(driver.agentId);
      if (existing?.driver === driver) continue;
      if (existing !== undefined) {
        yield* Fiber.interrupt(existing.fiber).pipe(Effect.ignore);
        runningDriverStreams.delete(driver.agentId);
      }
      const fiber = yield* Stream.runForEach(
        driver.streamEvents(),
        projectRuntimeEventWithLogging,
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (runningDriverStreams.get(driver.agentId)?.driver === driver) {
              runningDriverStreams.delete(driver.agentId);
            }
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.logError("Composition Agent Driver 事件流失败", {
            agentId: driver.agentId,
            runtimeId: driver.runtimeId,
            cause,
          }),
        ),
        Effect.forkScoped,
      );
      runningDriverStreams.set(driver.agentId, { driver, fiber });
    }
  });

  const driverSubscription = yield* driverRegistry.subscribeChanges;
  yield* startDriverStreams;
  yield* Effect.forkScoped(
    Effect.forever(
      PubSub.take(driverSubscription).pipe(
        Effect.flatMap(() => startDriverStreams),
        Effect.catchCause((cause) =>
          Effect.logError("Composition Agent Driver 事件流刷新失败", { cause }),
        ),
      ),
    ),
  );

  const runningRuntimeStreams = new Set<string>();
  const startRuntimeStreams = Effect.gen(function* () {
    const adapters = yield* runtimeAdapters.list;
    for (const adapter of adapters) {
      if (runningRuntimeStreams.has(adapter.runtimeId)) continue;
      runningRuntimeStreams.add(adapter.runtimeId);
      yield* Stream.runForEach(adapter.streamEvents(), projectRuntimeEventWithLogging).pipe(
        Effect.ensuring(Effect.sync(() => runningRuntimeStreams.delete(adapter.runtimeId))),
        Effect.catchCause((cause) =>
          Effect.logError("Composition Runtime Adapter 事件流失败", {
            runtimeId: adapter.runtimeId,
            cause,
          }),
        ),
        Effect.forkScoped,
      );
    }
  });

  yield* startRuntimeStreams;
  const runtimeSubscription = yield* runtimeAdapters.subscribeChanges;
  yield* Effect.forkScoped(
    Effect.forever(
      PubSub.take(runtimeSubscription).pipe(
        Effect.flatMap(() => startRuntimeStreams),
        Effect.catchCause((cause) =>
          Effect.logError("Composition Runtime Adapter 事件流刷新失败", { cause }),
        ),
      ),
    ),
  );

  return {
    projectRuntimeEvent,
    awaitTaskCompletion,
  } satisfies CompositionTaskRuntimeProjectionServiceShape;
});

export const layer = Layer.effect(CompositionTaskRuntimeProjectionService, live);
