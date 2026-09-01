import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { PersistenceSqlError } from "../persistence/Errors.ts";
import { CompositionToolInvocationStoreLive } from "../persistence/Layers/CompositionToolInvocationStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  CompositionToolInvocationStore,
  type CompositionToolInvocationStoreShape,
} from "../persistence/Services/CompositionToolInvocationStore.ts";
import {
  CompositionToolInvocationCoordinator,
  makeCompositionToolInvocationCoordinator,
} from "./CompositionToolInvocationCoordinator.ts";

const StoreLayer = CompositionToolInvocationStoreLive.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);
const TestLayer = Layer.mergeAll(
  CompositionToolInvocationCoordinator.layer.pipe(Layer.provide(StoreLayer)),
  StoreLayer,
);
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const makeBeginInput = (idempotencyKey: string) => ({
  idempotencyKey,
  taskId: `task-${idempotencyKey}`,
  runId: `run-${idempotencyKey}`,
  agentId: `agent-${idempotencyKey}`,
  toolCallId: `tool-call-${idempotencyKey}`,
  canonicalToolName: "workspace.write_file",
  operation: "mutate",
  arguments: {
    contents: "apiKey: must-not-be-persisted",
    relativePath: "generated/output.txt",
  },
  workspaceRoot: "E:/private/workspace-root",
  capabilityGrantIds: ["grant-write", "grant-project"],
  runtimeId: "runtime-private",
  threadId: "thread-private",
  providerInstanceId: "provider-private",
  startedAtUnixMs: 100,
});

it.layer(TestLayer, { excludeTestServices: true })("CompositionToolInvocationCoordinator", (it) => {
  it.effect("同一幂等键并发 begin 只有一个执行者，终态可按语义幂等重放", () =>
    Effect.gen(function* () {
      const coordinator = yield* CompositionToolInvocationCoordinator;
      const input = makeBeginInput("coordinator-concurrent");

      const claims = yield* Effect.all(
        [coordinator.begin(input), coordinator.begin({ ...input, startedAtUnixMs: 101 })],
        { concurrency: "unbounded" },
      );
      const claimed = claims.find((claim) => claim.claimed);

      assert.equal(claims.filter((claim) => claim.claimed).length, 1);
      assert.isDefined(claimed);
      assert.isTrue(claims.every((claim) => claim.invocation.status === "executing"));

      const finished = yield* coordinator.finish({
        idempotencyKey: input.idempotencyKey,
        expectedRevision: claimed!.invocation.revision,
        status: "succeeded",
        outcomeCode: null,
        finishedAtUnixMs: 200,
      });
      const replayedFinish = yield* coordinator.finish({
        idempotencyKey: input.idempotencyKey,
        expectedRevision: claimed!.invocation.revision,
        status: "succeeded",
        outcomeCode: null,
        finishedAtUnixMs: 300,
      });
      const replayedBegin = yield* coordinator.begin({ ...input, startedAtUnixMs: 400 });

      assert.equal(finished.status, "succeeded");
      assert.deepEqual(replayedFinish, finished);
      assert.isFalse(replayedBegin.claimed);
      assert.equal(replayedBegin.invocation.status, "succeeded");
    }),
  );

  it.effect("参数键序与授权顺序不改变身份摘要，且持久化记录不包含原始作用域", () =>
    Effect.gen(function* () {
      const coordinator = yield* CompositionToolInvocationCoordinator;
      const store = yield* CompositionToolInvocationStore;
      const input = makeBeginInput("coordinator-digest");

      const first = yield* coordinator.begin(input);
      const replayed = yield* coordinator.begin({
        ...input,
        arguments: {
          relativePath: "generated/output.txt",
          contents: "apiKey: must-not-be-persisted",
        },
        capabilityGrantIds: [...input.capabilityGrantIds.toReversed(), "grant-write"],
        startedAtUnixMs: 101,
      });
      const stored = Option.getOrThrow(yield* store.getInvocation(input.idempotencyKey));
      const serialized = encodeUnknownJson(stored);

      assert.isTrue(first.claimed);
      assert.isFalse(replayed.claimed);
      assert.equal(stored.argumentsDigest.length, "sha256:".length + 64);
      assert.equal(stored.scopeDigest.length, "sha256:".length + 64);
      assert.notInclude(serialized, "must-not-be-persisted");
      assert.notInclude(serialized, input.workspaceRoot);
      assert.notInclude(serialized, input.runtimeId);
      assert.notInclude(serialized, input.threadId);
      assert.notInclude(serialized, input.providerInstanceId);
    }),
  );

  it.effect("构造新的协调器不会把仍在执行的调用误收口为 unknown", () =>
    Effect.gen(function* () {
      const store = yield* CompositionToolInvocationStore;
      const input = makeBeginInput("coordinator-restart");
      yield* store.prepareInvocation({
        idempotencyKey: input.idempotencyKey,
        taskId: input.taskId,
        runId: input.runId,
        agentId: input.agentId,
        toolCallId: input.toolCallId,
        canonicalToolName: input.canonicalToolName,
        operation: input.operation,
        argumentsDigest: "sha256:arguments",
        scopeDigest: "sha256:scope",
        createdAtUnixMs: 100,
      });
      yield* store.claimPrepared({
        idempotencyKey: input.idempotencyKey,
        expectedRevision: 1,
        claimedAtUnixMs: 110,
      });

      yield* makeCompositionToolInvocationCoordinator(store);

      const recovered = Option.getOrThrow(yield* store.getInvocation(input.idempotencyKey));
      assert.equal(recovered.status, "executing");
      assert.equal(recovered.outcomeCode, null);
    }),
  );

  it.effect("终态语义重放不吞掉非法输入、错误 revision 或不同终态", () =>
    Effect.gen(function* () {
      const coordinator = yield* CompositionToolInvocationCoordinator;
      const input = makeBeginInput("coordinator-terminal-validation");
      const claimed = yield* coordinator.begin(input);
      yield* coordinator.finish({
        idempotencyKey: input.idempotencyKey,
        expectedRevision: claimed.invocation.revision,
        status: "succeeded",
        outcomeCode: null,
        finishedAtUnixMs: 200,
      });

      const invalidRevision = yield* coordinator
        .finish({
          idempotencyKey: input.idempotencyKey,
          expectedRevision: 0,
          status: "succeeded",
          outcomeCode: null,
          finishedAtUnixMs: 300,
        })
        .pipe(Effect.flip);
      const invalidTimestamp = yield* coordinator
        .finish({
          idempotencyKey: input.idempotencyKey,
          expectedRevision: claimed.invocation.revision,
          status: "succeeded",
          outcomeCode: null,
          finishedAtUnixMs: -1,
        })
        .pipe(Effect.flip);
      const staleRevision = yield* coordinator
        .finish({
          idempotencyKey: input.idempotencyKey,
          expectedRevision: 1,
          status: "succeeded",
          outcomeCode: null,
          finishedAtUnixMs: 300,
        })
        .pipe(Effect.flip);
      const differentTerminal = yield* coordinator
        .finish({
          idempotencyKey: input.idempotencyKey,
          expectedRevision: claimed.invocation.revision,
          status: "failed",
          outcomeCode: "tool_execution_failed",
          finishedAtUnixMs: 300,
        })
        .pipe(Effect.flip);

      assert.equal(invalidRevision.code, "tool_invocation_input_invalid");
      assert.equal(invalidTimestamp.code, "tool_invocation_input_invalid");
      assert.equal(staleRevision.code, "tool_invocation_terminal_conflict");
      assert.equal(differentTerminal.code, "tool_invocation_terminal_conflict");
    }),
  );

  it.effect("摘要拒绝非 JSON、非有限数与循环参数，避免不同输入碰撞", () =>
    Effect.gen(function* () {
      const coordinator = yield* CompositionToolInvocationCoordinator;
      const circular: Record<string, unknown> = {};
      circular.self = circular;

      const invalidValues: readonly unknown[] = [
        undefined,
        DateTime.toDate(DateTime.makeUnsafe(0)),
        new Map([["key", "value"]]),
        Number.NaN,
        circular,
      ];
      const errors = yield* Effect.forEach(invalidValues, (argumentsValue, index) =>
        coordinator
          .begin({
            ...makeBeginInput(`coordinator-invalid-json-${index}`),
            arguments: argumentsValue,
          })
          .pipe(Effect.flip),
      );

      assert.isTrue(errors.every((error) => error.code === "tool_invocation_input_invalid"));
      assert.isTrue(errors.every((error) => error.phase === "begin"));
    }),
  );
});

it.effect("持久化不可用时 begin 显式失败，不提供进程内降级路径", () =>
  Effect.gen(function* () {
    const unavailable = new PersistenceSqlError({
      operation: "CompositionToolInvocationCoordinator.test",
      detail: "database unavailable",
    });
    const store = {
      prepareInvocation: () => Effect.fail(unavailable),
      claimPrepared: () => Effect.die("unused"),
      saveTerminal: () => Effect.die("unused"),
      getInvocation: () => Effect.succeed(Option.none()),
      listUnknownInvocations: () => Effect.succeed([]),
      recoverExecutingInvocations: () => Effect.die("协调器构造不应执行启动恢复"),
    } satisfies CompositionToolInvocationStoreShape;
    const coordinator = yield* makeCompositionToolInvocationCoordinator(store);
    const error = yield* coordinator
      .begin(makeBeginInput("coordinator-store-down"))
      .pipe(Effect.flip);

    assert.equal(error.code, "tool_invocation_store_unavailable");
    assert.equal(error.phase, "begin");
  }),
);
