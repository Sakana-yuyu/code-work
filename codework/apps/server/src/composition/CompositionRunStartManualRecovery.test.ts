import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { recoverCompositionRunStartManualPending } from "./CompositionRunStartManualRecovery.ts";
import {
  acceptedManualRecoveryDecision,
  makeManualRecoveryFixture,
  makeManualRecoveryHarness,
} from "./CompositionRunStartManualRecoveryTestSupport.ts";

it.effect("manual_pending 使用独立 upper-bound/keyset 扫描且不会重复候选", () =>
  Effect.gen(function* () {
    const fixtures = [
      makeManualRecoveryFixture("scan-a"),
      makeManualRecoveryFixture("scan-b"),
      makeManualRecoveryFixture("scan-c"),
    ];
    const harness = makeManualRecoveryHarness({
      fixtures,
      driverAvailable: false,
      pageSize: 2,
    });
    const receipt = yield* recoverCompositionRunStartManualPending(harness.options);

    assert.equal(harness.calls.upperBound, 1);
    assert.deepEqual(harness.calls.pages, [
      { throughRunId: fixtures[2]!.intent.runId },
      { after: fixtures[1]!.intent.runId, throughRunId: fixtures[2]!.intent.runId },
    ]);
    assert.equal(receipt.outcomes.length, 3);
    assert.equal(new Set(receipt.outcomes.map((outcome) => outcome.runId)).size, 3);
  }),
);

it.effect("两个 worker 竞争同一 manual claim 时只有赢家执行 receipt 对账", () =>
  Effect.gen(function* () {
    const fixture = makeManualRecoveryFixture("double-worker");
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const harness = makeManualRecoveryHarness({
      fixtures: [fixture],
      reconcile: () =>
        Effect.gen(function* () {
          harness.calls.reconcile += 1;
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
          return acceptedManualRecoveryDecision(fixture.intent);
        }),
    });
    const first = yield* Effect.forkChild(recoverCompositionRunStartManualPending(harness.options));
    yield* Deferred.await(entered);
    const second = yield* recoverCompositionRunStartManualPending(harness.options);
    yield* Deferred.succeed(release, undefined);
    const firstReceipt = yield* Fiber.join(first);

    assert.equal(harness.calls.reconcile, 1);
    assert.equal(firstReceipt.outcomes[0]?.action, "resume");
    assert.equal(second.outcomes[0]?.code, "run_start_manual_claim_unavailable");
  }),
);
