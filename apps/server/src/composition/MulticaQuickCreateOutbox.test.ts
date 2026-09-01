import { describe, expect } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  auditMulticaQuickCreateIntents,
  settleStaleSendingIntent,
} from "./MulticaQuickCreateOutbox.ts";
import type { CompositionMulticaQuickCreateIntent } from "../persistence/Services/CompositionTaskStore.ts";

const makeIntent = (
  overrides: Partial<CompositionMulticaQuickCreateIntent> = {},
): CompositionMulticaQuickCreateIntent => ({
  runId: "run-1",
  taskId: "task-1",
  runtimeId: "multica:d1:r1",
  idempotencyKey: "run-1",
  state: "prepared",
  createdAtUnixMs: 1_000,
  updatedAtUnixMs: 1_000,
  ...overrides,
});

const makeStore = (intents: Map<string, CompositionMulticaQuickCreateIntent>) => ({
  listPendingMulticaQuickCreateIntents: (
    runtimeId?: string,
  ): Effect.Effect<ReadonlyArray<CompositionMulticaQuickCreateIntent>> =>
    Effect.succeed(
      [...intents.values()].filter(
        (intent) => runtimeId === undefined || intent.runtimeId === runtimeId,
      ),
    ),
  acceptMulticaQuickCreateIntent: (input: {
    readonly runId: string;
    readonly runtimeId: string;
    readonly remoteTaskId: string;
    readonly updatedAtUnixMs: number;
  }) =>
    Effect.sync(() => {
      const existing = intents.get(input.runId);
      if (
        existing === undefined ||
        existing.runtimeId !== input.runtimeId ||
        existing.state !== "sending"
      ) {
        return Option.none();
      }
      const accepted = {
        ...existing,
        state: "accepted" as const,
        remoteTaskId: input.remoteTaskId,
        updatedAtUnixMs: input.updatedAtUnixMs,
      };
      intents.set(input.runId, accepted);
      return Option.some(accepted);
    }),
});

describe("Multica quick-create outbox 审计", () => {
  effectIt.effect("prepared 可安全重派；超窗 sending 进入 stale，未超窗保持观察", () =>
    Effect.gen(function* () {
      const intents = new Map<string, CompositionMulticaQuickCreateIntent>([
        ["run-prepared", makeIntent({ runId: "run-prepared", taskId: "task-a" })],
        ["run-stale", makeIntent({ runId: "run-stale", state: "sending", updatedAtUnixMs: 900 })],
        ["run-fresh", makeIntent({ runId: "run-fresh", state: "sending", updatedAtUnixMs: 1_100 })],
      ]);
      const audit = yield* auditMulticaQuickCreateIntents(makeStore(intents), {
        staleBeforeUnixMs: 1_000,
      });
      expect(audit.readyToDispatch.map((intent) => intent.runId)).toEqual(["run-prepared"]);
      expect(audit.staleSending.map((intent) => intent.runId)).toEqual(["run-stale"]);
      expect(audit.freshSending.map((intent) => intent.runId)).toEqual(["run-fresh"]);
    }),
  );

  effectIt.effect("runtimeId 过滤只看本 Runtime 的账本", () =>
    Effect.gen(function* () {
      const intents = new Map<string, CompositionMulticaQuickCreateIntent>([
        ["run-own", makeIntent({ runId: "run-own" })],
        [
          "run-other",
          makeIntent({ runId: "run-other", runtimeId: "multica:d2:r2", idempotencyKey: "k2" }),
        ],
      ]);
      const audit = yield* auditMulticaQuickCreateIntents(makeStore(intents), {
        runtimeId: "multica:d1:r1",
        staleBeforeUnixMs: 2_000,
      });
      expect(audit.readyToDispatch.map((intent) => intent.runId)).toEqual(["run-own"]);
    }),
  );

  effectIt.effect("settle 仅在 sending 态绑定远端 task ID，随后审计不再出现该意图", () =>
    Effect.gen(function* () {
      const intents = new Map<string, CompositionMulticaQuickCreateIntent>([
        ["run-hang", makeIntent({ runId: "run-hang", state: "sending", updatedAtUnixMs: 500 })],
      ]);
      const store = makeStore(intents);
      const settled = yield* settleStaleSendingIntent(store, {
        runId: "run-hang",
        runtimeId: "multica:d1:r1",
        remoteTaskId: "remote-issue-9",
        updatedAtUnixMs: 2_000,
      });
      expect(settled.state).toBe("accepted");
      if (settled.state === "accepted") {
        expect(settled.remoteTaskId).toBe("remote-issue-9");
      }
      // 再 setle 一次应显式失败，防止覆盖已确认的远端绑定。
      const failure = yield* settleStaleSendingIntent(store, {
        runId: "run-hang",
        runtimeId: "multica:d1:r1",
        remoteTaskId: "remote-issue-other",
        updatedAtUnixMs: 3_000,
      }).pipe(Effect.flip);
      expect((failure as { code?: string }).code).toBe("quick_create_outbox_not_accepted");

      const audit = yield* auditMulticaQuickCreateIntents(store, {
        staleBeforeUnixMs: 1_000,
      });
      expect(audit.readyToDispatch).toEqual([]);
      expect(audit.staleSending).toEqual([]);
    }),
  );

  effectIt.effect("prepared 意图不能被 settle：必须先走真实发送路径", () =>
    Effect.gen(function* () {
      const intents = new Map<string, CompositionMulticaQuickCreateIntent>([
        ["run-ready", makeIntent({ runId: "run-ready" })],
      ]);
      const failure = yield* settleStaleSendingIntent(makeStore(intents), {
        runId: "run-ready",
        runtimeId: "multica:d1:r1",
        remoteTaskId: "remote-issue-x",
        updatedAtUnixMs: 2_000,
      }).pipe(Effect.flip);
      expect((failure as { code?: string }).code).toBe("quick_create_outbox_not_accepted");
    }),
  );
});
