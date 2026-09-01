import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";

import type { CompositionRunStartStartupRecoveryReceipt } from "./CompositionRunStartStartupRecovery.ts";

const DEFAULT_FAILURE_RETRY_MS = 30_000;
const DEFAULT_IDLE_SWEEP_MS = 30_000;

export interface CompositionRunStartRecoverySchedulerOptions<E, R> {
  readonly initialReceipt?: CompositionRunStartStartupRecoveryReceipt;
  readonly changes: Queue.Dequeue<void>;
  readonly recover: Effect.Effect<CompositionRunStartStartupRecoveryReceipt, E, R>;
  readonly failureRetryMs?: number;
}

const awaitRecoveryTrigger = (
  changes: Queue.Dequeue<void>,
  nextRecoveryAtUnixMs: number | undefined,
) =>
  Effect.gen(function* () {
    const nowUnixMs = yield* Clock.currentTimeMillis;
    const wakeAtUnixMs = nextRecoveryAtUnixMs ?? nowUnixMs + DEFAULT_IDLE_SWEEP_MS;
    if (wakeAtUnixMs <= nowUnixMs) return;
    yield* Effect.raceFirst(
      Queue.take(changes),
      Effect.sleep(Duration.millis(wakeAtUnixMs - nowUnixMs)),
    );
  });

export const runCompositionRunStartRecoveryScheduler = <E, R>(
  options: CompositionRunStartRecoverySchedulerOptions<E, R>,
): Effect.Effect<never, never, R> =>
  Effect.gen(function* () {
    let nextRecoveryAtUnixMs = options.initialReceipt?.nextRecoveryAtUnixMs;
    const failureRetryMs = options.failureRetryMs ?? DEFAULT_FAILURE_RETRY_MS;
    while (true) {
      yield* awaitRecoveryTrigger(options.changes, nextRecoveryAtUnixMs);
      const recoveryExit = yield* Effect.exit(options.recover);
      if (Exit.isFailure(recoveryExit)) {
        if (Cause.hasInterruptsOnly(recoveryExit.cause)) {
          return yield* Effect.interrupt;
        }
        yield* Effect.logWarning("Run Start 后台恢复扫描失败，将按受控间隔重试", {
          cause: recoveryExit.cause,
        });
        nextRecoveryAtUnixMs = (yield* Clock.currentTimeMillis) + failureRetryMs;
        continue;
      }
      nextRecoveryAtUnixMs = recoveryExit.value.nextRecoveryAtUnixMs;
    }
  });
