import * as NodeCrypto from "node:crypto";

import { describe, expect } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import type { CompositionTaskEvent, ProviderRuntimeEvent } from "@codework/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { recoverPersistedCheckpointText } from "./CompositionByokCheckpointRecovery.ts";
import { makeCompositionByokAgentDriver } from "./CompositionByokAgentDriver.ts";
import {
  CompositionAgentServiceError,
  type CompositionAgentServiceInput,
  type CompositionAgentServiceShape,
} from "./CompositionAgentService.ts";
import type { CompositionTaskStoreShape } from "../persistence/Services/CompositionTaskStore.ts";

const runtimeId = "byok:inst-1";

const sha256 = (value: string): string =>
  `sha256:${NodeCrypto.createHash("sha256").update(value, "utf8").digest("hex")}`;

const utf8ByteLength = (value: string): number => new TextEncoder().encode(value).byteLength;

const task = {
  taskId: "task-byok",
  projectId: "project-1",
  threadId: "thread-byok",
  assigneeKind: "agent" as const,
  assigneeId: "provider:byok",
  mode: "serial" as const,
  status: "queued" as const,
  promptDigest: "sha256:prompt",
  dependsOnTaskIds: [],
  createdAtUnixMs: 1,
  updatedAtUnixMs: 1,
};

const run = {
  runId: "run-byok",
  taskId: task.taskId,
  agentId: "provider:byok",
  runtimeId,
  status: "queued" as const,
  attempt: 1,
  capabilityGrantIds: ["grant-read"],
};

const checkpointEvent = (
  chunkIndex: number,
  delta: string,
  endOffsetBytes: number,
): CompositionTaskEvent => ({
  taskId: task.taskId,
  runId: run.runId,
  sourceEventId: `byok:${chunkIndex}`,
  agentId: run.agentId,
  runtimeId,
  status: "running",
  sequence: chunkIndex,
  eventType: "message",
  summary: "BYOK Agent 已保存部分输出",
  outputDelta: delta,
  outputOffsetBytes: endOffsetBytes,
  outputDigest: sha256(delta),
});

const makeLedger = () => {
  const events = new Map<string, CompositionTaskEvent>();
  const store = {
    appendEventIfNew: (event: CompositionTaskEvent & { readonly sourceEventId: string }) =>
      Effect.sync(() => {
        const key = `${event.taskId}:${event.runId}:${event.sourceEventId}`;
        if (events.has(key)) return false;
        events.set(key, event);
        return true;
      }),
    listEvents: (taskId: string, runId: string) =>
      Effect.succeed(
        [...events.values()].filter((event) => event.taskId === taskId && event.runId === runId),
      ),
  } satisfies Pick<CompositionTaskStoreShape, "appendEventIfNew" | "listEvents">;
  return { events, store };
};

const okService = (): CompositionAgentServiceShape => ({
  run: () => Effect.succeed({ text: "", messages: [], rounds: 1 }),
});

const makeDriver = (
  service: CompositionAgentServiceShape,
  extra: Partial<Parameters<typeof makeCompositionByokAgentDriver>[0]> = {},
) =>
  makeCompositionByokAgentDriver({
    agentId: "provider:byok",
    runtimeId,
    providerInstanceId: "inst-1",
    providerKind: "byok",
    defaultModel: "openai/gpt-test",
    agentService: service,
    checkpointStore: {
      appendEventIfNew: () => Effect.sync(() => true),
    },
    listTools: () => Effect.succeed([]),
    ...extra,
  });

describe("BYOK 部分输出跨重启恢复", () => {
  effectIt.live("提供 checkpointHistory 时 profile 才承诺 supportsResume 并带恢复能力", () =>
    Effect.gen(function* () {
      const plain = yield* makeDriver(okService()).getProfile!();
      expect(plain.supportsResume).toBe(false);
      expect(plain.capabilities).not.toContain("byok.checkpoint_recovery");

      const recovered = yield* makeDriver(okService(), {
        checkpointHistory: makeLedger().store,
      }).getProfile!();
      expect(recovered.supportsResume).toBe(true);
      expect(recovered.capabilities).toContain("byok.checkpoint_recovery");
    }),
  );

  effectIt.effect("未注入恢复路径时 resume 显式拒绝，而不是静默成功", () =>
    Effect.gen(function* () {
      const driver = makeDriver(okService());
      const failure = yield* driver.resumeTask!({ task, run, reason: "process restart" }).pipe(
        Effect.flip,
      );
      expect(failure.code).toBe("byok_resume_not_supported");
    }),
  );

  effectIt.live("进程重启后：新 Driver 实例可校验并恢复已持久化的部分输出链", () =>
    Effect.gen(function* () {
      const deltas = ["第一段输出。", "第二段包含 emoji 🚀 与换行\n"];
      let consumed = 0;
      // 模拟截断：Loop 写完两个 checkpoint 后进程直接崩溃。
      const truncatedService: CompositionAgentServiceShape = {
        run: (input) =>
          Effect.gen(function* () {
            for (const delta of deltas) {
              consumed += 1;
              yield* input.onTextCheckpoint!({
                turn: 1,
                chunkIndex: consumed - 1,
                delta,
                cumulativeUtf8Bytes: deltas
                  .slice(0, consumed)
                  .reduce((sum, part) => sum + utf8ByteLength(part), 0),
              } satisfies Parameters<
                NonNullable<CompositionAgentServiceInput["onTextCheckpoint"]>
              >[0]).pipe(
                Effect.mapError(
                  (error): CompositionAgentServiceError =>
                    new CompositionAgentServiceError({
                      code: error.code,
                      detail: error.detail,
                    }),
                ),
              );
            }
            return yield* new CompositionAgentServiceError({
              code: "byok_agent_loop_failed",
              detail: "模拟进程崩溃后的截断终态。",
            });
          }),
      };
      const ledger = makeLedger();
      const firstProcessDriver = makeDriver(truncatedService, {
        checkpointStore: ledger.store,
        checkpointHistory: ledger.store,
      });
      yield* firstProcessDriver.startTask({
        task,
        run,
        prompt: "检查工作区",
        workspaceRoot: "C:/workspace",
      });
      // 等待后台 Loop 完成全部 checkpoint 落盘。
      while ((yield* ledger.store.listEvents(task.taskId, run.runId)).length < deltas.length) {
        yield* Effect.sleep("5 millis");
      }
      yield* Effect.sleep("20 millis");

      // 新的进程：全新 Driver 实例读取同一持久化 store，只能依赖持久化行恢复。
      const restartedDriver = makeDriver(okService(), {
        checkpointStore: ledger.store,
        checkpointHistory: ledger.store,
      });
      const persisted = yield* ledger.store.listEvents(task.taskId, run.runId);
      expect(persisted.length).toBeGreaterThanOrEqual(deltas.length);
      const recovered = yield* recoverPersistedCheckpointText(persisted);
      expect(recovered.text).toBe(deltas.join(""));
      expect(recovered.utf8Bytes).toBe(utf8ByteLength(deltas.join("")));
      expect(recovered.chunkCount).toBe(deltas.length);

      const projection = yield* Effect.scoped(
        Effect.gen(function* () {
          const captured = { warning: undefined as ProviderRuntimeEvent | undefined };
          yield* Effect.forkScoped(
            Stream.runForEach(
              Stream.filter(
                restartedDriver.streamEvents!(),
                (event) => event.type === "runtime.warning",
              ),
              (event) =>
                Effect.sync(() => {
                  captured.warning = event;
                }),
            ),
          );
          // 等待订阅挂载完成，避免首个恢复事件在无订阅者时被丢弃。
          yield* Effect.sleep("100 millis");
          const resumeResult = yield* restartedDriver.resumeTask!({
            task,
            run,
            reason: "process restart",
          });
          expect(resumeResult.status).toBe("accepted");
          while (captured.warning === undefined) {
            yield* Effect.sleep("5 millis");
          }
          const restored = captured.warning;
          const rowsWithRestore = () =>
            Effect.map(ledger.store.listEvents(task.taskId, run.runId), (rows) =>
              rows.filter((row) => row.sourceEventId?.startsWith("byok-restore:") === true),
            );
          const firstRestoreRows = yield* rowsWithRestore();
          // 同一实例内重复 resume 不得重复刷恢复投影。
          const repeatResult = yield* restartedDriver.resumeTask!({
            task,
            run,
            reason: "duplicate resume request",
          });
          const repeatedRestoreRows = yield* rowsWithRestore();
          return { restored, firstRestoreRows, repeatResult, repeatedRestoreRows };
        }),
      );

      expect(projection.restored?.payload).toMatchObject({
        message: "BYOK 已恢复持久化部分输出（2 段）",
        detail: { restoredChunks: 2, restoredUtf8Bytes: utf8ByteLength(deltas.join("")) },
      });
      expect(projection.firstRestoreRows.length).toBe(1);
      expect(projection.firstRestoreRows[0]?.summary).toContain(
        `2 段 / ${utf8ByteLength(deltas.join(""))} 字节`,
      );
      expect(projection.repeatResult.status).toBe("accepted");
      expect(projection.repeatedRestoreRows.length).toBe(1);
    }),
  );

  effectIt.effect("运行中的 Run 上请求 resume 返回 already_running，不打断本地 Loop", () =>
    Effect.gen(function* () {
      const loopGate = yield* Deferred.make<void>();
      const blockingService: CompositionAgentServiceShape = {
        run: () =>
          Effect.map(Deferred.await(loopGate), () => ({ text: "", messages: [], rounds: 1 })),
      };
      const driver = makeDriver(blockingService, { checkpointHistory: makeLedger().store });
      const liveRun = { ...run, runId: "run-byok-live" };
      yield* driver.startTask({
        task,
        run: liveRun,
        prompt: "检查工作区",
        workspaceRoot: "C:/workspace",
      });
      const resumeResult = yield* driver.resumeTask!({
        task,
        run: liveRun,
        reason: "duplicate request",
      });
      expect(resumeResult.status).toBe("already_running");
      yield* Deferred.succeed(loopGate, void 0);
    }),
  );

  effectIt.effect("持久化内容被篡改或存在缺口时显式失败，不返回伪造正文", () =>
    Effect.gen(function* () {
      const tampered = [
        checkpointEvent(0, "第一段", utf8ByteLength("第一段")),
        {
          ...checkpointEvent(1, "第二段", utf8ByteLength("第一段") + utf8ByteLength("第二段")),
          outputDigest: sha256("与原内容不同的字节"),
        },
      ];
      const gapped = [
        checkpointEvent(0, "第一段", utf8ByteLength("第一段")),
        checkpointEvent(
          1,
          "第三段",
          utf8ByteLength("第一段") + utf8ByteLength("缺失段") + utf8ByteLength("第三段"),
        ),
      ];
      const digestFailure = yield* recoverPersistedCheckpointText(tampered).pipe(Effect.flip);
      const gapFailure = yield* recoverPersistedCheckpointText(gapped).pipe(Effect.flip);
      const emptyFailure = yield* recoverPersistedCheckpointText([]).pipe(Effect.flip);
      expect(digestFailure.code).toBe("byok_checkpoint_recovery_digest_mismatch");
      expect(gapFailure.code).toBe("byok_checkpoint_recovery_offset_gap");
      expect(emptyFailure.code).toBe("byok_checkpoint_recovery_empty");
    }),
  );
});
