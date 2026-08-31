import type { CompositionTaskRun } from "@codework/contracts";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type {
  CompositionRunStartExecutionStoreShape,
  CompositionRunStartIntent,
} from "../persistence/Services/CompositionRunStartStore.ts";
import type { CompositionTaskStoreShape } from "../persistence/Services/CompositionTaskStore.ts";
import type { CompositionRunStartManualRecoveryOptions } from "./CompositionRunStartManualRecovery.ts";
import {
  COMPOSITION_RUN_START_OWNER_HEARTBEAT_MS,
  withCompositionRunStartOwnerLease,
} from "./CompositionRunStartOwnerLease.ts";
import { renewCompositionRuntimeLease } from "./CompositionRuntimeLeaseLifecycle.ts";

class CompositionRunStartManualWorkspaceLeaseLost extends Data.TaggedError(
  "CompositionRunStartManualWorkspaceLeaseLost",
) {}

const nowOf = (options: CompositionRunStartManualRecoveryOptions): Effect.Effect<number> =>
  options.now ?? Effect.clockWith((clock) => clock.currentTimeMillis);

export const renewCompositionRunStartManualWorkspaceLease = (
  options: CompositionRunStartManualRecoveryOptions,
  run: CompositionTaskRun,
) =>
  Effect.gen(function* () {
    if (run.leaseId === undefined) return true;
    const renewed = yield* renewCompositionRuntimeLease(
      options.taskStore as CompositionTaskStoreShape,
      run,
      yield* nowOf(options),
    );
    return Option.isSome(renewed);
  });

const keepWorkspaceLeaseAlive = (
  options: CompositionRunStartManualRecoveryOptions,
  run: CompositionTaskRun,
) =>
  Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep(Duration.millis(COMPOSITION_RUN_START_OWNER_HEARTBEAT_MS));
      if (!(yield* renewCompositionRunStartManualWorkspaceLease(options, run))) {
        return yield* new CompositionRunStartManualWorkspaceLeaseLost();
      }
    }
  });

const withWorkspaceLease = <A, E, R>(
  options: CompositionRunStartManualRecoveryOptions,
  run: CompositionTaskRun,
  effect: Effect.Effect<A, E, R>,
) =>
  run.leaseId === undefined
    ? effect
    : Effect.gen(function* () {
        if (!(yield* renewCompositionRunStartManualWorkspaceLease(options, run))) {
          return yield* new CompositionRunStartManualWorkspaceLeaseLost();
        }
        const result = yield* Effect.raceFirst(
          Effect.result(effect),
          keepWorkspaceLeaseAlive(options, run),
        );
        if (!(yield* renewCompositionRunStartManualWorkspaceLease(options, run))) {
          return yield* new CompositionRunStartManualWorkspaceLeaseLost();
        }
        return result._tag === "Failure" ? yield* Effect.fail(result.failure) : result.success;
      });

export const withCompositionRunStartManualLeases = <A, E, R>(
  options: CompositionRunStartManualRecoveryOptions,
  intent: CompositionRunStartIntent,
  run: CompositionTaskRun,
  effect: Effect.Effect<A, E, R>,
) =>
  withCompositionRunStartOwnerLease(
    options.runStartStore as unknown as CompositionRunStartExecutionStoreShape,
    intent,
    withWorkspaceLease(options, run, effect),
  );
