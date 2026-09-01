import type { CompositionTaskRun } from "@codework/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { recoverCompositionRunStartManualPending } from "./CompositionRunStartManualRecovery.ts";
import {
  makeManualRecoveryFixture,
  makeManualRecoveryHarness,
  type ManualRecoveryFixture,
} from "./CompositionRunStartManualRecoveryTestSupport.ts";

for (const scenario of [
  {
    name: "Driver 离线",
    harness: (fixture: ManualRecoveryFixture) =>
      makeManualRecoveryHarness({ fixtures: [fixture], driverAvailable: false }),
    code: "run_start_manual_agent_driver_unavailable",
  },
  {
    name: "Driver runtime 不匹配",
    harness: (fixture: ManualRecoveryFixture) =>
      makeManualRecoveryHarness({
        fixtures: [fixture],
        driverRuntimeId: `${fixture.run.runtimeId}-other`,
      }),
    code: "run_start_manual_agent_driver_unavailable",
  },
  {
    name: "Driver 缺少恢复策略",
    harness: (fixture: ManualRecoveryFixture) =>
      makeManualRecoveryHarness({ fixtures: [fixture], omitPolicy: true }),
    code: "run_start_manual_driver_policy_missing",
  },
  {
    name: "Driver 缺少 receipt 对账",
    harness: (fixture: ManualRecoveryFixture) =>
      makeManualRecoveryHarness({ fixtures: [fixture], omitReconcile: true }),
    code: "run_start_manual_driver_reconciliation_unavailable",
  },
  {
    name: "旧输入缺 capabilityIds",
    harness: (fixture: ManualRecoveryFixture) =>
      makeManualRecoveryHarness({
        fixtures: [fixture],
        recoveryInput: (({ capabilityIds: _capabilityIds, ...legacyInput }) => legacyInput)(
          fixture.recoveryInput,
        ),
      }),
    code: "run_start_legacy_input_capabilities_unknown",
  },
  {
    name: "Driver 只返回 replay",
    harness: (fixture: ManualRecoveryFixture) =>
      makeManualRecoveryHarness({ fixtures: [fixture], decision: { action: "replay" } }),
    code: "run_start_manual_replay_forbidden",
  },
] as const) {
  it.effect(`${scenario.name} 只释放 manual claim 且不启动或撤销资源`, () =>
    Effect.gen(function* () {
      const fixture = makeManualRecoveryFixture(`defer-${scenario.code}`, { lease: true });
      const harness = scenario.harness(fixture);
      const receipt = yield* recoverCompositionRunStartManualPending(harness.options);

      assert.equal(receipt.outcomes[0]?.action, "defer");
      assert.equal(receipt.outcomes[0]?.code, scenario.code);
      assert.equal(harness.calls.release, 1);
      assert.equal(harness.calls.start, 0);
      assert.equal(harness.calls.revoke, 0);
      assert.isAtMost(
        (receipt.nextRecoveryAtUnixMs ?? Infinity) - receipt.recoveredAtUnixMs,
        20_000,
      );
    }),
  );
}

it.effect("accepted decision 只有 receipt 完全一致时才恢复 accepted", () =>
  Effect.gen(function* () {
    const fixture = makeManualRecoveryFixture("receipt-accepted");
    const mismatch = makeManualRecoveryHarness({
      fixtures: [fixture],
      decision: { action: "accepted", runtimeTaskId: "runtime-task-other" },
    });
    const mismatchReceipt = yield* recoverCompositionRunStartManualPending(mismatch.options);
    assert.equal(mismatchReceipt.outcomes[0]?.code, "run_start_manual_reconciled_receipt_mismatch");
    assert.equal(mismatch.calls.resume, 0);
    assert.equal(mismatch.calls.release, 1);

    const matched = makeManualRecoveryHarness({ fixtures: [fixture] });
    const matchedReceipt = yield* recoverCompositionRunStartManualPending(matched.options);
    const resumed = matched.intents.get(fixture.intent.runId);
    assert.equal(matchedReceipt.outcomes[0]?.action, "resume");
    assert.equal(matched.calls.resume, 1);
    assert.equal(resumed?.state, "accepted");
    assert.equal(resumed?.claimId, null);
    assert.equal(resumed?.ownerLeaseExpiresAtUnixMs, null);
    assert.equal(matched.calls.start, 0);
  }),
);

it.effect("同一最新且身份可信的 Task/Run 一致终态才结算 manual receipt", () =>
  Effect.gen(function* () {
    const fixture = makeManualRecoveryFixture("terminal-settle", {
      taskStatus: "completed",
      runStatus: "completed",
      lease: true,
    });
    const harness = makeManualRecoveryHarness({ fixtures: [fixture], driverAvailable: false });
    const receipt = yield* recoverCompositionRunStartManualPending(harness.options);

    assert.equal(receipt.outcomes[0]?.action, "settle");
    assert.equal(harness.calls.settle, 1);
    assert.equal(harness.calls.reconcile, 0);
    assert.equal(harness.intents.get(fixture.intent.runId)?.state, "settled");
  }),
);

it.effect("取消中的 Run 在任何 Driver 核对或外部启动前保持 manual pending", () =>
  Effect.gen(function* () {
    const fixture = makeManualRecoveryFixture("cancel-pending");
    const harness = makeManualRecoveryHarness({
      fixtures: [fixture],
      mutateRun: (run) => ({ ...run, cancelRequestedAtUnixMs: 90 }),
    });
    const receipt = yield* recoverCompositionRunStartManualPending(harness.options);

    assert.equal(receipt.outcomes[0]?.action, "defer");
    assert.equal(receipt.outcomes[0]?.code, "run_start_manual_cancel_pending");
    assert.equal(harness.calls.release, 1);
    assert.equal(harness.calls.driverGet, 0);
    assert.equal(harness.calls.reconcile, 0);
    assert.equal(harness.calls.start, 0);
    assert.equal(harness.calls.revoke, 0);
  }),
);

it.effect("一致可信终态优先结算，即使 Run 已记录取消请求", () =>
  Effect.gen(function* () {
    const fixture = makeManualRecoveryFixture("terminal-cancel-settle", {
      taskStatus: "cancelled",
      runStatus: "cancelled",
    });
    const harness = makeManualRecoveryHarness({
      fixtures: [fixture],
      mutateRun: (run) => ({ ...run, cancelRequestedAtUnixMs: 90 }),
    });
    const receipt = yield* recoverCompositionRunStartManualPending(harness.options);

    assert.equal(receipt.outcomes[0]?.action, "settle");
    assert.equal(receipt.outcomes[0]?.code, "run_start_manual_terminal_settled");
    assert.equal(harness.calls.settle, 1);
    assert.equal(harness.calls.release, 0);
    assert.equal(harness.calls.driverGet, 0);
    assert.equal(harness.calls.reconcile, 0);
    assert.equal(harness.calls.start, 0);
    assert.equal(harness.calls.revoke, 0);
  }),
);

for (const scenario of [
  {
    name: "错误 runId 身份",
    mutateRun: (run: CompositionTaskRun) => ({ ...run, runId: `${run.runId}-other` }),
    code: "run_start_manual_run_replaced",
  },
  {
    name: "错误 agent 身份",
    mutateRun: (run: CompositionTaskRun) => ({ ...run, agentId: `${run.agentId}-other` }),
    code: "run_start_manual_identity_changed",
  },
  {
    name: "错误 runtime 身份",
    mutateRun: (run: CompositionTaskRun) => ({ ...run, runtimeId: `${run.runtimeId}-other` }),
    code: "run_start_manual_identity_changed",
  },
  {
    name: "错误 attempt 身份",
    mutateRun: (run: CompositionTaskRun) => ({ ...run, attempt: run.attempt + 1 }),
    code: "run_start_manual_identity_changed",
  },
  {
    name: "终态 Run 的持久 receipt 漂移",
    mutateRun: (run: CompositionTaskRun) => ({
      ...run,
      runtimeTaskId: `${run.runtimeTaskId}-other`,
    }),
    code: "run_start_manual_persisted_receipt_mismatch",
  },
  {
    name: "Task 已终态但 Run 仍运行",
    mutateRun: (run: CompositionTaskRun) => ({ ...run, status: "running" as const }),
    code: "run_start_manual_status_mismatch",
  },
] as const) {
  it.effect(`${scenario.name} 不得结算 manual receipt`, () =>
    Effect.gen(function* () {
      const fixture = makeManualRecoveryFixture(`unsafe-settle-${scenario.code}`, {
        taskStatus: "completed",
        runStatus: "completed",
      });
      const harness = makeManualRecoveryHarness({
        fixtures: [fixture],
        mutateRun: scenario.mutateRun,
      });
      const receipt = yield* recoverCompositionRunStartManualPending(harness.options);

      assert.equal(receipt.outcomes[0]?.code, scenario.code);
      assert.equal(harness.calls.settle, 0);
      assert.equal(harness.calls.release, 1);
    }),
  );
}

it.effect("Run 已终态但 Task 仍运行不得结算 manual receipt", () =>
  Effect.gen(function* () {
    const fixture = makeManualRecoveryFixture("unsafe-run-terminal", {
      taskStatus: "running",
      runStatus: "completed",
    });
    const harness = makeManualRecoveryHarness({ fixtures: [fixture] });
    const receipt = yield* recoverCompositionRunStartManualPending(harness.options);

    assert.equal(receipt.outcomes[0]?.code, "run_start_manual_status_mismatch");
    assert.equal(harness.calls.settle, 0);
    assert.equal(harness.calls.release, 1);
  }),
);

it.effect("被更新 Run 替换的旧 manual receipt 不得结算", () =>
  Effect.gen(function* () {
    const fixture = makeManualRecoveryFixture("unsafe-latest-run", {
      taskStatus: "completed",
      runStatus: "completed",
    });
    const harness = makeManualRecoveryHarness({
      fixtures: [fixture],
      mutateLatestRun: (run) => ({ ...run, runId: `${run.runId}-new` }),
    });
    const receipt = yield* recoverCompositionRunStartManualPending(harness.options);

    assert.equal(receipt.outcomes[0]?.code, "run_start_manual_run_replaced");
    assert.equal(harness.calls.settle, 0);
  }),
);
