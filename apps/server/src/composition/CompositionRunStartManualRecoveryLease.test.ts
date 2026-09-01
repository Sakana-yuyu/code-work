import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { recoverCompositionRunStartManualPending } from "./CompositionRunStartManualRecovery.ts";
import {
  acceptedManualRecoveryDecision,
  makeManualRecoveryFixture,
  makeManualRecoveryHarness,
} from "./CompositionRunStartManualRecoveryTestSupport.ts";

it.effect("小于 60 秒的 defer 扫描持续续期 workspace lease", () =>
  Effect.gen(function* () {
    const fixture = makeManualRecoveryFixture("workspace-over-sixty", { lease: true });
    let now = 0;
    const harness = makeManualRecoveryHarness({
      fixtures: [fixture],
      driverAvailable: false,
      now: () => now,
    });
    for (const nextNow of [0, 20_000, 40_000, 61_000]) {
      now = nextNow;
      yield* recoverCompositionRunStartManualPending(harness.options);
    }

    const lease = harness.leases.get(fixture.run.leaseId!);
    assert.isDefined(lease);
    assert.equal(harness.calls.workspaceRenew, 4);
    assert.equal(lease?.heartbeatAtUnixMs, 61_000);
    assert.equal(lease?.expiresAtUnixMs, 121_000);
    assert.equal(harness.calls.start, 0);
  }),
);

it.effect("长时间 receipt 对账同时维持 owner 与 workspace lease", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = makeManualRecoveryFixture("long-reconcile", { lease: true });
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const harness = makeManualRecoveryHarness({
        fixtures: [fixture],
        now: () => 0,
        reconcile: () =>
          Effect.gen(function* () {
            harness.calls.reconcile += 1;
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            return acceptedManualRecoveryDecision(fixture.intent);
          }),
      });
      const fiber = yield* recoverCompositionRunStartManualPending(harness.options).pipe(
        Effect.forkScoped,
      );
      yield* Deferred.await(entered);
      yield* TestClock.adjust("65 seconds");
      yield* Effect.yieldNow;
      yield* Deferred.succeed(release, undefined);
      const receipt = yield* Fiber.join(fiber);

      assert.equal(receipt.outcomes[0]?.action, "resume");
      assert.isAtLeast(harness.calls.ownerRenew, 3);
      assert.isAtLeast(harness.calls.workspaceRenew, 5);
    }),
  ),
);

it.effect("旧 owner epoch 在对账期间失去所有权后 fail-closed", () =>
  Effect.gen(function* () {
    const fixture = makeManualRecoveryFixture("stale-epoch");
    const harness = makeManualRecoveryHarness({
      fixtures: [fixture],
      reconcile: () =>
        Effect.sync(() => {
          harness.calls.reconcile += 1;
          const current = harness.intents.get(fixture.intent.runId)!;
          harness.intents.set(fixture.intent.runId, {
            ...current,
            revision: current.revision + 1,
            claimId: "manual-worker:new-owner",
            ownerEpoch: current.ownerEpoch + 1,
            ownerLeaseExpiresAtUnixMs: 120_000,
          });
          return acceptedManualRecoveryDecision(fixture.intent);
        }),
    });
    const receipt = yield* recoverCompositionRunStartManualPending(harness.options);

    assert.equal(receipt.outcomes[0]?.action, "defer");
    assert.equal(harness.calls.resume, 0);
    assert.equal(harness.calls.settle, 0);
    assert.equal(harness.calls.start, 0);
    assert.equal(harness.intents.get(fixture.intent.runId)?.claimId, "manual-worker:new-owner");
  }),
);
