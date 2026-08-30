import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { PersistenceSqlError } from "../persistence/Errors.ts";
import {
  CompositionToolInvocationStore,
  type CompositionToolInvocationPrepareInput,
  type CompositionToolInvocationStoreShape,
} from "../persistence/Services/CompositionToolInvocationStore.ts";
import {
  CompositionToolInvocationStartupRecovery,
  recoverCompositionToolInvocations,
  TOOL_INVOCATION_RESTART_OUTCOME_CODE,
} from "./CompositionToolInvocationStartupRecovery.ts";

const prepareInput: CompositionToolInvocationPrepareInput = {
  idempotencyKey: "startup-recovery-invocation",
  taskId: "startup-recovery-task",
  runId: "startup-recovery-run",
  agentId: "startup-recovery-agent",
  toolCallId: "startup-recovery-tool-call",
  canonicalToolName: "workspace.write_file",
  operation: "mutate",
  argumentsDigest: "sha256:arguments",
  scopeDigest: "sha256:scope",
  createdAtUnixMs: 100,
};

it.effect("启动恢复使用固定受控结果码并返回 Store typed receipt", () =>
  Effect.gen(function* () {
    const inputs: Array<{ readonly recoveredAtUnixMs: number; readonly outcomeCode: string }> = [];
    const store = {
      prepareInvocation: () => Effect.die("unused"),
      claimPrepared: () => Effect.die("unused"),
      saveTerminal: () => Effect.die("unused"),
      getInvocation: () => Effect.succeed(Option.none()),
      listUnknownInvocations: () => Effect.succeed([]),
      recoverExecutingInvocations: (input) => {
        inputs.push(input);
        return Effect.succeed({
          type: "composition.tool_invocations.recovered" as const,
          recoveredAtUnixMs: input.recoveredAtUnixMs,
          outcomeCode: input.outcomeCode,
          recoveredCount: 1,
          invocations: [
            {
              ...prepareInput,
              status: "unknown" as const,
              revision: 3,
              outcomeCode: input.outcomeCode,
              updatedAtUnixMs: input.recoveredAtUnixMs,
              claimedAtUnixMs: 110,
              finishedAtUnixMs: input.recoveredAtUnixMs,
            },
          ],
        });
      },
    } satisfies CompositionToolInvocationStoreShape;

    const receipt = yield* recoverCompositionToolInvocations(store, 120);

    assert.deepEqual(inputs, [
      { recoveredAtUnixMs: 120, outcomeCode: TOOL_INVOCATION_RESTART_OUTCOME_CODE },
    ]);
    assert.equal(receipt.type, "composition.tool_invocations.recovered");
    assert.equal(receipt.recoveredCount, 1);
  }),
);

it.effect("Store 不可用时启动恢复失败并保持 fail-closed", () =>
  Effect.gen(function* () {
    const unavailable = new PersistenceSqlError({
      operation: "CompositionToolInvocationStartupRecovery.test",
      detail: "database unavailable",
    });
    const store = {
      prepareInvocation: () => Effect.die("unused"),
      claimPrepared: () => Effect.die("unused"),
      saveTerminal: () => Effect.die("unused"),
      getInvocation: () => Effect.succeed(Option.none()),
      listUnknownInvocations: () => Effect.succeed([]),
      recoverExecutingInvocations: () => Effect.fail(unavailable),
    } satisfies CompositionToolInvocationStoreShape;

    const error = yield* recoverCompositionToolInvocations(store, 120).pipe(Effect.flip);

    assert.equal(error._tag, "CompositionToolInvocationStartupRecoveryError");
    assert.strictEqual(error.cause, unavailable);
  }),
);

it.effect("恢复屏障只执行一次并向多个消费者重放同一 receipt", () => {
  let recoveryCount = 0;
  const store = {
    prepareInvocation: () => Effect.die("unused"),
    claimPrepared: () => Effect.die("unused"),
    saveTerminal: () => Effect.die("unused"),
    getInvocation: () => Effect.succeed(Option.none()),
    listUnknownInvocations: () => Effect.succeed([]),
    recoverExecutingInvocations: (input) =>
      Effect.sync(() => {
        recoveryCount += 1;
        return {
          type: "composition.tool_invocations.recovered" as const,
          recoveredAtUnixMs: input.recoveredAtUnixMs,
          outcomeCode: input.outcomeCode,
          recoveredCount: 0,
          invocations: [],
        };
      }),
  } satisfies CompositionToolInvocationStoreShape;
  const layer = CompositionToolInvocationStartupRecovery.layer.pipe(
    Layer.provide(
      Layer.succeed(CompositionToolInvocationStore, CompositionToolInvocationStore.of(store)),
    ),
  );

  return Effect.gen(function* () {
    const recovery = yield* CompositionToolInvocationStartupRecovery;
    const first = yield* recovery.awaitRecovered;
    const second = yield* recovery.awaitRecovered;

    assert.strictEqual(first, second);
    assert.equal(recoveryCount, 1);
  }).pipe(Effect.provide(layer));
});

it.effect("恢复失败会被固定并由每个消费者观察到", () => {
  let recoveryCount = 0;
  const unavailable = new PersistenceSqlError({
    operation: "CompositionToolInvocationStartupRecovery.test.replay",
    detail: "database unavailable",
  });
  const store = {
    prepareInvocation: () => Effect.die("unused"),
    claimPrepared: () => Effect.die("unused"),
    saveTerminal: () => Effect.die("unused"),
    getInvocation: () => Effect.succeed(Option.none()),
    listUnknownInvocations: () => Effect.succeed([]),
    recoverExecutingInvocations: () =>
      Effect.sync(() => {
        recoveryCount += 1;
      }).pipe(Effect.andThen(Effect.fail(unavailable))),
  } satisfies CompositionToolInvocationStoreShape;
  const layer = CompositionToolInvocationStartupRecovery.layer.pipe(
    Layer.provide(
      Layer.succeed(CompositionToolInvocationStore, CompositionToolInvocationStore.of(store)),
    ),
  );

  return Effect.gen(function* () {
    const recovery = yield* CompositionToolInvocationStartupRecovery;
    const first = yield* recovery.awaitRecovered.pipe(Effect.flip);
    const second = yield* recovery.awaitRecovered.pipe(Effect.flip);

    assert.strictEqual(first, second);
    assert.strictEqual(first.cause, unavailable);
    assert.equal(recoveryCount, 1);
  }).pipe(Effect.provide(layer));
});
