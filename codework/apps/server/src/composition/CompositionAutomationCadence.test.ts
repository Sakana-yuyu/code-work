import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import {
  calculateNextCompositionAutomationRun,
  type CompositionAutomationCadenceError,
} from "./CompositionAutomationCadence.ts";

const unixMs = (iso: string): number => DateTime.makeUnsafe(iso).epochMilliseconds;

const errorCode = (
  result:
    | { readonly _tag: "Success" }
    | { readonly _tag: "Failure"; readonly failure: CompositionAutomationCadenceError },
): string | undefined => (result._tag === "Failure" ? result.failure.code : undefined);

it.effect("every cadence 从上一个计划点严格递增，并尊重 expiresAt", () =>
  Effect.gen(function* () {
    const next = yield* calculateNextCompositionAutomationRun({
      automationId: "automation-every",
      cadence: { type: "every", intervalMs: 60_000 },
      afterUnixMs: 1_000,
      expiresAtUnixMs: 61_000,
    });
    const expired = yield* calculateNextCompositionAutomationRun({
      automationId: "automation-every",
      cadence: { type: "every", intervalMs: 60_000 },
      afterUnixMs: 61_000,
      expiresAtUnixMs: 120_000,
    });

    assert.equal(next, 61_000);
    assert.equal(expired, null);
  }),
);

it.effect("cron cadence 使用显式 IANA 时区计算工作日计划点", () =>
  Effect.gen(function* () {
    const next = yield* calculateNextCompositionAutomationRun({
      automationId: "automation-shanghai-weekday",
      cadence: {
        type: "cron",
        expression: "0 9 * * 1-5",
        timezone: "Asia/Shanghai",
      },
      afterUnixMs: unixMs("2026-08-28T00:59:59.000Z"),
      expiresAtUnixMs: null,
    });
    const following = yield* calculateNextCompositionAutomationRun({
      automationId: "automation-shanghai-weekday",
      cadence: {
        type: "cron",
        expression: "0 9 * * 1-5",
        timezone: "Asia/Shanghai",
      },
      afterUnixMs: unixMs("2026-08-28T01:00:00.000Z"),
      expiresAtUnixMs: null,
    });

    assert.equal(next, unixMs("2026-08-28T01:00:00.000Z"));
    assert.equal(following, unixMs("2026-08-31T01:00:00.000Z"));
  }),
);

it.effect("cron cadence 跨 DST 后仍保持当地墙上时间", () =>
  Effect.gen(function* () {
    const next = yield* calculateNextCompositionAutomationRun({
      automationId: "automation-london-dst",
      cadence: {
        type: "cron",
        expression: "0 9 * * *",
        timezone: "Europe/London",
      },
      afterUnixMs: unixMs("2026-03-28T09:00:00.000Z"),
      expiresAtUnixMs: null,
    });

    assert.equal(next, unixMs("2026-03-29T08:00:00.000Z"));
  }),
);

it.effect("H 表达式以 automationId 为稳定种子", () =>
  Effect.gen(function* () {
    const input = {
      automationId: "automation-stable-hash",
      cadence: {
        type: "cron" as const,
        expression: "H 9 * * *",
        timezone: "Asia/Shanghai",
      },
      afterUnixMs: unixMs("2026-08-29T00:00:00.000Z"),
      expiresAtUnixMs: null,
    };

    const first = yield* calculateNextCompositionAutomationRun(input);
    const replay = yield* calculateNextCompositionAutomationRun(input);

    assert.equal(replay, first);
    assert.ok(first !== null && first > input.afterUnixMs);
  }),
);

it.effect("拒绝无效时区、cron 表达式和越界时间戳", () =>
  Effect.gen(function* () {
    const invalidTimezone = yield* Effect.result(
      calculateNextCompositionAutomationRun({
        automationId: "automation-invalid-timezone",
        cadence: { type: "cron", expression: "0 9 * * *", timezone: "Mars/Olympus" },
        afterUnixMs: 1_000,
        expiresAtUnixMs: null,
      }),
    );
    const invalidExpression = yield* Effect.result(
      calculateNextCompositionAutomationRun({
        automationId: "automation-invalid-cron",
        cadence: { type: "cron", expression: "not a cron", timezone: "UTC" },
        afterUnixMs: 1_000,
        expiresAtUnixMs: null,
      }),
    );
    const ambiguousExpression = yield* Effect.result(
      calculateNextCompositionAutomationRun({
        automationId: "automation-ambiguous-cron",
        cadence: { type: "cron", expression: "0 9 1 * 1", timezone: "UTC" },
        afterUnixMs: 1_000,
        expiresAtUnixMs: null,
      }),
    );
    const invalidTimestamp = yield* Effect.result(
      calculateNextCompositionAutomationRun({
        automationId: "automation-invalid-time",
        cadence: { type: "every", intervalMs: 1_000 },
        afterUnixMs: Number.MAX_SAFE_INTEGER,
        expiresAtUnixMs: null,
      }),
    );

    assert.equal(errorCode(invalidTimezone), "automation_timezone_invalid");
    assert.equal(errorCode(invalidExpression), "automation_cron_invalid");
    assert.equal(errorCode(ambiguousExpression), "automation_cron_invalid");
    assert.equal(errorCode(invalidTimestamp), "automation_timestamp_out_of_range");
  }),
);
