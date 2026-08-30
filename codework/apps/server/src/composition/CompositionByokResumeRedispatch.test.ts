import * as NodeCrypto from "node:crypto";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { makeCompositionAgentDriverRegistry } from "./CompositionAgentDriverRegistry.ts";
import {
  BYOK_RESUME_CONTEXT_BEGIN_MARKER,
  BYOK_RESUME_CONTEXT_END_MARKER,
  byokResumeRedispatchEventPrefix,
  composeByokResumeRedispatchPrompt,
  settleAndRedispatchRecoveredByokRun,
} from "./CompositionByokResumeRedispatch.ts";
import { makeCompositionOrchestrator } from "./CompositionOrchestrator.ts";
import { CompositionRunStartStoreLive } from "../persistence/Layers/CompositionRunStartStore.ts";
import { CompositionTaskStore } from "../persistence/Services/CompositionTaskStore.ts";
import type { CompositionTaskStoreShape } from "../persistence/Services/CompositionTaskStore.ts";
import { CompositionTaskStoreLive } from "../persistence/Layers/CompositionTaskStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  CompositionRunStartStore,
  type CompositionRunStartStoreShape,
} from "../persistence/Services/CompositionRunStartStore.ts";
import type {
  CompositionTaskInputStoreShape,
  CompositionTaskRecoveryInput,
} from "../persistence/Services/CompositionTaskInputStore.ts";

const layer = it.layer(
  Layer.mergeAll(CompositionTaskStoreLive, CompositionRunStartStoreLive).pipe(
    Layer.provide(SqlitePersistenceMemory),
  ),
);

const AGENT_ID = "agent-byok-redispatch";
const RUNTIME_ID = "runtime-byok-redispatch";

const sha256 = (value: string): string =>
  `sha256:${NodeCrypto.createHash("sha256").update(value, "utf8").digest("hex")}`;

const utf8ByteLength = (value: string): number => new TextEncoder().encode(value).byteLength;

const seedTaskAndRun = (input: {
  readonly store: CompositionTaskStoreShape;
  readonly taskId: string;
  readonly runId: string;
  readonly runStatus?: "running" | "completed";
}) =>
  Effect.gen(function* () {
    yield* input.store.upsertTask({
      taskId: input.taskId,
      projectId: "project-byok-redispatch",
      assigneeKind: "agent",
      assigneeId: AGENT_ID,
      mode: "serial",
      status: input.runStatus === "completed" ? "completed" : "running",
      promptDigest: "sha256:byok-redispatch",
      dependsOnTaskIds: [],
      createdAtUnixMs: 1,
      updatedAtUnixMs: 2,
    });
    yield* input.store.upsertRun({
      taskId: input.taskId,
      runId: input.runId,
      agentId: AGENT_ID,
      runtimeId: RUNTIME_ID,
      status: input.runStatus ?? "running",
      attempt: 1,
      capabilityGrantIds: [],
    });
  });

/** 按生产 checkpoint 形状落一段已持久化输出：byok: 前缀、message 行、摘要与累计偏移。 */
const seedCheckpoints = (input: {
  readonly store: CompositionTaskStoreShape;
  readonly taskId: string;
  readonly runId: string;
  readonly deltas: ReadonlyArray<string>;
  readonly corruptDigest?: boolean;
}) =>
  Effect.gen(function* () {
    let offset = 0;
    let chunkIndex = 0;
    for (const delta of input.deltas) {
      offset += utf8ByteLength(delta);
      yield* input.store.appendEventIfNew({
        taskId: input.taskId,
        runId: input.runId,
        agentId: AGENT_ID,
        runtimeId: RUNTIME_ID,
        sourceEventId: `byok:checkpoint-${input.runId}-${chunkIndex}`,
        status: "running",
        sequence: 0,
        eventType: "message",
        summary: "BYOK Agent 已保存部分输出",
        outputDelta: delta,
        outputOffsetBytes: offset,
        outputDigest: input.corruptDigest === true ? sha256(`${delta}-tampered`) : sha256(delta),
      });
      chunkIndex += 1;
    }
  });

const makeMemoryInputStore = () => {
  const records = new Map<string, CompositionTaskRecoveryInput>();
  const store: CompositionTaskInputStoreShape = {
    save: (input) =>
      Effect.sync(() => {
        records.set(input.taskId, input);
      }),
    get: (taskId) => Effect.sync(() => Option.fromNullishOr(records.get(taskId))),
    remove: (taskId) =>
      Effect.sync(() => {
        records.delete(taskId);
      }),
  };
  return { records, store };
};

const makeCapturingOrchestrator = (
  store: CompositionTaskStoreShape,
  inputStore: CompositionTaskInputStoreShape,
  runStartStore: CompositionRunStartStoreShape,
) =>
  Effect.gen(function* () {
    const prompts: string[] = [];
    const driverRegistry = makeCompositionAgentDriverRegistry();
    yield* driverRegistry.register({
      agentId: AGENT_ID,
      runtimeId: RUNTIME_ID,
      startTask: (input) =>
        Effect.sync(() => {
          if (input.prompt !== undefined) prompts.push(input.prompt);
          return { runtimeTaskId: `runtime-task-${input.run.runId}` };
        }),
      cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
    });
    const orchestrator = makeCompositionOrchestrator(
      store,
      driverRegistry,
      undefined,
      inputStore,
      runStartStore,
    );
    return { orchestrator, prompts };
  });

layer("CompositionByokResumeRedispatch", (it) => {
  it.effect("恢复校验通过后结算并经真实 retryTask 创建新 Run，prompt 注入恢复上下文", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const taskId = "task-byok-redispatch";
      const runId = "run-byok-redispatch-stale";
      yield* seedTaskAndRun({ store, taskId, runId });
      yield* seedCheckpoints({
        store,
        taskId,
        runId,
        deltas: ["前段推理输出，", "SECRET-RESUME-PAYLOAD 结尾片段"],
      });
      const memory = makeMemoryInputStore();
      yield* memory.store.save({
        taskId,
        prompt: "原始任务目标：完成迁移报告",
        workspaceRoot: "C:/workspace/byok-redispatch",
      });
      const { orchestrator, prompts } = yield* makeCapturingOrchestrator(
        store,
        memory.store,
        runStartStore,
      );

      const result = yield* settleAndRedispatchRecoveredByokRun({
        taskId,
        runId,
        agentId: AGENT_ID,
        runtimeId: RUNTIME_ID,
        store,
        inputStore: memory.store,
        nowUnixMs: 5_000,
        note: "跨重启恢复后自动续跑",
        redispatch: (args) =>
          Effect.asVoid(
            orchestrator.retryTask({
              taskId,
              previousRunId: args.previousRunId,
              runId: "run-byok-redispatch-next",
              reason: "BYOK 恢复后自动重派",
              capabilityIds: ["t3.workspace.read_file"],
            }),
          ),
      });

      assert.equal(result.recovered.chunkCount, 2);
      assert.equal(result.run.status, "failed");
      assert.equal(result.run.failureCode, "byok_resume_interrupted");

      // 真实 retryTask 创建了新 Run，任务从 failed 回到进行态。
      const nextRun = (yield* store.getRun("run-byok-redispatch-next")).pipe(Option.getOrThrow);
      assert.equal(nextRun.attempt, 2);
      const task = (yield* store.getTask(taskId)).pipe(Option.getOrThrow);
      assert.equal(task.status, "running");

      // 新 Run 的 prompt 含原始目标与恢复出的部分输出上下文。
      assert.equal(prompts.length, 1);
      const prompt = prompts[0]!;
      assert.isTrue(prompt.includes("原始任务目标：完成迁移报告"));
      assert.isTrue(prompt.includes(BYOK_RESUME_CONTEXT_BEGIN_MARKER));
      assert.isTrue(prompt.includes("SECRET-RESUME-PAYLOAD 结尾片段"));
      assert.isTrue(prompt.includes(runId));

      // 结算行幂等落账，摘要只含段数/字节数，恢复正文不进台账。
      const events = yield* store.listEvents(taskId, runId);
      const settleRow = events.find(
        (event) =>
          event.sourceEventId === `${byokResumeRedispatchEventPrefix(taskId, runId)}:settle`,
      );
      assert.isDefined(settleRow);
      assert.equal(settleRow?.status, "blocked");
      assert.isTrue(settleRow?.summary.includes("2 段"));
      assert.isTrue(settleRow?.summary.includes("跨重启恢复后自动续跑"));
      const redispatchRows = events.filter((event) =>
        event.sourceEventId?.startsWith("byok-redispatch:"),
      );
      // @effect-diagnostics-next-line preferSchemaOverJson:off - 断言重派台账行整体序列化不含恢复原文。
      assert.isFalse(JSON.stringify(redispatchRows).includes("SECRET-RESUME-PAYLOAD"));
    }),
  );

  it.effect("重复触发显式拒绝且只重派一次；结算行被抢占时报 already_settled", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const taskId = "task-byok-redispatch-repeat";
      const runId = "run-byok-redispatch-repeat";
      yield* seedTaskAndRun({ store, taskId, runId });
      yield* seedCheckpoints({ store, taskId, runId, deltas: ["部分输出"] });
      const memory = makeMemoryInputStore();
      yield* memory.store.save({
        taskId,
        prompt: "重复触发场景",
        workspaceRoot: "C:/workspace/byok-redispatch",
      });

      let redispatchCount = 0;
      const invoke = () =>
        settleAndRedispatchRecoveredByokRun({
          taskId,
          runId,
          agentId: AGENT_ID,
          store,
          inputStore: memory.store,
          nowUnixMs: 5_000,
          redispatch: () =>
            Effect.sync(() => {
              redispatchCount += 1;
            }),
        });

      yield* invoke();
      const rowsAfterFirst = (yield* store.listEvents(taskId, runId)).length;
      // 已有结算行时重复触发按幂等语义一律 already_settled。
      const repeat = yield* Effect.flip(invoke());
      if (repeat._tag !== "CompositionByokResumeRedispatchError") {
        assert.fail("Expected a CompositionByokResumeRedispatchError");
      }
      assert.equal(repeat.code, "byok_resume_redispatch_already_settled");
      assert.equal(redispatchCount, 1);
      assert.equal((yield* store.listEvents(taskId, runId)).length, rowsAfterFirst);

      // 结算行已存在但 run 未收口（另一投影者中途崩溃）：显式报 already_settled。
      const settledTaskId = "task-byok-redispatch-preclaimed";
      const settledRunId = "run-byok-redispatch-preclaimed";
      yield* seedTaskAndRun({ store, taskId: settledTaskId, runId: settledRunId });
      yield* seedCheckpoints({
        store,
        taskId: settledTaskId,
        runId: settledRunId,
        deltas: ["部分输出"],
      });
      yield* memory.store.save({
        taskId: settledTaskId,
        prompt: "结算行被抢占场景",
        workspaceRoot: "C:/workspace/byok-redispatch",
      });
      yield* store.appendEventIfNew({
        taskId: settledTaskId,
        runId: settledRunId,
        agentId: AGENT_ID,
        runtimeId: RUNTIME_ID,
        sourceEventId: `${byokResumeRedispatchEventPrefix(settledTaskId, settledRunId)}:settle`,
        status: "blocked",
        sequence: 0,
        eventType: "status",
        summary: "既有结算行",
      });
      const preclaimed = yield* Effect.flip(
        settleAndRedispatchRecoveredByokRun({
          taskId: settledTaskId,
          runId: settledRunId,
          agentId: AGENT_ID,
          store,
          inputStore: memory.store,
          nowUnixMs: 5_000,
          redispatch: () =>
            Effect.sync(() => {
              redispatchCount += 1;
            }),
        }),
      );
      if (preclaimed._tag !== "CompositionByokResumeRedispatchError") {
        assert.fail("Expected a CompositionByokResumeRedispatchError");
      }
      assert.equal(preclaimed.code, "byok_resume_redispatch_already_settled");
      assert.equal(redispatchCount, 1);
    }),
  );

  it.effect("已有新 Run（非最新）时显式拒绝且零副作用", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const taskId = "task-byok-redispatch-latest";
      const runId = "run-byok-redispatch-old";
      yield* seedTaskAndRun({ store, taskId, runId });
      yield* store.upsertRun({
        taskId,
        runId: "run-byok-redispatch-newer",
        agentId: AGENT_ID,
        runtimeId: RUNTIME_ID,
        status: "running",
        attempt: 2,
        capabilityGrantIds: [],
      });
      yield* seedCheckpoints({ store, taskId, runId, deltas: ["旧 Run 的部分输出"] });
      const memory = makeMemoryInputStore();
      yield* memory.store.save({
        taskId,
        prompt: "旧 Run 场景",
        workspaceRoot: "C:/workspace/byok-redispatch",
      });

      let invoked = false;
      const error = yield* Effect.flip(
        settleAndRedispatchRecoveredByokRun({
          taskId,
          runId,
          agentId: AGENT_ID,
          store,
          inputStore: memory.store,
          nowUnixMs: 5_000,
          redispatch: () =>
            Effect.sync(() => {
              invoked = true;
            }),
        }),
      );
      if (error._tag !== "CompositionByokResumeRedispatchError") {
        assert.fail("Expected a CompositionByokResumeRedispatchError");
      }
      assert.equal(error.code, "byok_resume_redispatch_not_latest");
      assert.isFalse(invoked);
      const events = yield* store.listEvents(taskId, runId);
      assert.equal(
        events.filter((event) => event.sourceEventId?.startsWith("byok-redispatch:")).length,
        0,
      );
      const staleRun = (yield* store.getRun(runId)).pipe(Option.getOrThrow);
      assert.equal(staleRun.status, "running");
      // 恢复输入存根未被改写。
      assert.equal(memory.records.get(taskId)?.prompt, "旧 Run 场景");
    }),
  );

  it.effect("Run 已终态时显式拒绝且零副作用", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const taskId = "task-byok-redispatch-terminal";
      const runId = "run-byok-redispatch-terminal";
      yield* seedTaskAndRun({ store, taskId, runId, runStatus: "completed" });
      yield* seedCheckpoints({ store, taskId, runId, deltas: ["已完成 Run 的输出"] });
      const memory = makeMemoryInputStore();
      yield* memory.store.save({
        taskId,
        prompt: "终态场景",
        workspaceRoot: "C:/workspace/byok-redispatch",
      });

      let invoked = false;
      const error = yield* Effect.flip(
        settleAndRedispatchRecoveredByokRun({
          taskId,
          runId,
          agentId: AGENT_ID,
          store,
          inputStore: memory.store,
          nowUnixMs: 5_000,
          redispatch: () =>
            Effect.sync(() => {
              invoked = true;
            }),
        }),
      );
      if (error._tag !== "CompositionByokResumeRedispatchError") {
        assert.fail("Expected a CompositionByokResumeRedispatchError");
      }
      assert.equal(error.code, "byok_resume_redispatch_run_terminal");
      assert.isFalse(invoked);
      const events = yield* store.listEvents(taskId, runId);
      assert.equal(
        events.filter((event) => event.sourceEventId?.startsWith("byok-redispatch:")).length,
        0,
      );
    }),
  );

  it.effect("恢复校验失败（摘要被篡改/无 checkpoint）时不结算不重派", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const taskId = "task-byok-redispatch-corrupt";
      const runId = "run-byok-redispatch-corrupt";
      yield* seedTaskAndRun({ store, taskId, runId });
      yield* seedCheckpoints({
        store,
        taskId,
        runId,
        deltas: ["被篡改的输出"],
        corruptDigest: true,
      });
      const memory = makeMemoryInputStore();
      yield* memory.store.save({
        taskId,
        prompt: "校验失败场景",
        workspaceRoot: "C:/workspace/byok-redispatch",
      });

      let invoked = false;
      const invoke = (targetRunId: string) =>
        settleAndRedispatchRecoveredByokRun({
          taskId,
          runId: targetRunId,
          agentId: AGENT_ID,
          store,
          inputStore: memory.store,
          nowUnixMs: 5_000,
          redispatch: () =>
            Effect.sync(() => {
              invoked = true;
            }),
        });

      const corrupt = yield* Effect.flip(invoke(runId));
      if (corrupt._tag !== "ByokCheckpointRecoveryError") {
        assert.fail("Expected a ByokCheckpointRecoveryError");
      }
      assert.equal(corrupt.code, "byok_checkpoint_recovery_digest_mismatch");

      // 没有任何 checkpoint 行的最新 Run 同样显式失败（空集不可恢复）。
      const emptyRunId = "run-byok-redispatch-empty";
      yield* store.upsertRun({
        taskId,
        runId: emptyRunId,
        agentId: AGENT_ID,
        runtimeId: RUNTIME_ID,
        status: "running",
        attempt: 2,
        capabilityGrantIds: [],
      });
      const empty = yield* Effect.flip(invoke(emptyRunId));
      if (empty._tag !== "ByokCheckpointRecoveryError") {
        assert.fail("Expected a ByokCheckpointRecoveryError");
      }
      assert.equal(empty.code, "byok_checkpoint_recovery_empty");

      assert.isFalse(invoked);
      const events = yield* store.listEvents(taskId, runId);
      assert.equal(
        events.filter((event) => event.sourceEventId?.startsWith("byok-redispatch:")).length,
        0,
      );
      const staleRun = (yield* store.getRun(runId)).pipe(Option.getOrThrow);
      assert.equal(staleRun.status, "running");
    }),
  );

  it.effect("prompt 组装：尾部截断防无界增长，重复重派剥离旧上下文块", () =>
    Effect.sync(() => {
      const first = composeByokResumeRedispatchPrompt({
        basePrompt: "基础目标",
        recoveredText: `${"甲".repeat(30)}结尾标记`,
        previousRunId: "run-a",
        maxRecoveredChars: 10,
      });
      // 只保留尾部 10 字符并带截断省略号。
      assert.isTrue(first.includes("…"));
      assert.isTrue(first.includes("结尾标记"));
      assert.isFalse(first.includes("甲".repeat(11)));

      const second = composeByokResumeRedispatchPrompt({
        basePrompt: first,
        recoveredText: "第二次恢复输出",
        previousRunId: "run-b",
        maxRecoveredChars: 100,
      });
      // 旧上下文块被剥离：标记只出现一次，旧恢复正文不叠加。
      assert.equal(second.split(BYOK_RESUME_CONTEXT_BEGIN_MARKER).length, 2);
      assert.equal(second.split(BYOK_RESUME_CONTEXT_END_MARKER).length, 2);
      assert.isFalse(second.includes("结尾标记"));
      assert.isTrue(second.includes("第二次恢复输出"));
      assert.isTrue(second.includes("基础目标"));
    }),
  );
});
