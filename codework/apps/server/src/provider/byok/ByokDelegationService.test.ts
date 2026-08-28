import { ProviderDriverKind, ProviderInstanceId } from "@codework/contracts";
import { assert, it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import {
  __testables,
  make,
  resolveDelegationModel,
  resolveScheduler,
} from "./ByokDelegationService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { CompositionTaskStore } from "../../persistence/Services/CompositionTaskStore.ts";
import { CompositionTaskStoreLive } from "../../persistence/Layers/CompositionTaskStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";

const { parseExecutorCommand, buildChildEnv, preview } = __testables;

const config = (overrides: Record<string, unknown> = {}) => ({
  enabled: true,
  maxConcurrency: 2,
  queueTimeoutMs: 5_000,
  executionTimeoutMs: 15_000,
  modelGroups: [],
  executorCommand: "",
  executorEnvironmentVariables: [],
  ...overrides,
});

const runToTerminal = (scheduler: ReturnType<typeof resolveScheduler>, input: string) =>
  new Promise<ReturnType<typeof scheduler.get>>((resolve) => {
    const unsubscribe = scheduler.subscribe((event) => {
      if (event.snapshot.status !== "queued" && event.snapshot.status !== "running") {
        unsubscribe();
        resolve(event.snapshot);
      }
    });
    scheduler.submit({ input });
  });

describe("ByokDelegationService helpers", () => {
  it("splits the executor command without a shell", () => {
    expect(parseExecutorCommand("  node   --eval  code  ")).toEqual(["node", "--eval", "code"]);
    expect(parseExecutorCommand("")).toEqual([]);
    // A token containing ; stays one token — no shell parsing happens.
    expect(parseExecutorCommand("echo hi; rm -rf /")).toEqual(["echo", "hi;", "rm", "-rf", "/"]);
  });

  it("resolves only allowlisted environment names from the process env", () => {
    process.env.__BYOK_TEST_ALLOWED = "visible";
    process.env.__BYOK_TEST_HIDDEN = "secret-value";
    const env = buildChildEnv(["__BYOK_TEST_ALLOWED"]);
    expect(env["__BYOK_TEST_ALLOWED"]).toBe("visible");
    expect(Object.keys(env)).not.toContain("__BYOK_TEST_HIDDEN");
    delete process.env.__BYOK_TEST_ALLOWED;
    delete process.env.__BYOK_TEST_HIDDEN;
  });

  it("truncates previews with an ellipsis", () => {
    expect(preview("abcdef", 3)).toBe("abc…");
    expect(preview("abc", 3)).toBe("abc");
  });

  it("routes delegation to the enabled group's model", () => {
    expect(
      resolveDelegationModel(
        config({
          modelGroups: [
            {
              id: "g1",
              name: "Disabled",
              enabled: false,
              modelIds: ["m-a"],
              defaultModelId: "m-a",
            },
            {
              id: "g2",
              name: "Primary",
              enabled: true,
              modelIds: ["m-b", "m-c"],
              defaultModelId: "m-c",
            },
          ],
        }),
      ),
    ).toBe("m-c");
    expect(
      resolveDelegationModel(
        config({
          modelGroups: [{ id: "g1", name: "Fallback", enabled: true, modelIds: ["m-only"] }],
        }),
      ),
    ).toBe("m-only");
    expect(resolveDelegationModel(config())).toBeUndefined();
  });
});

describe("delegation scheduler runtime", () => {
  it("runs a real executor end-to-end and returns its output", async () => {
    const scheduler = resolveScheduler(
      config({
        executorCommand: `"${process.execPath}" -e process.stdout.write("delegated-ok")`,
      }),
      "instance-exec",
    );
    const terminal = await runToTerminal(scheduler, "task");

    expect(terminal?.status).toBe("succeeded");
    expect(terminal?.result).toBe("delegated-ok");
  }, 20_000);

  it("passes the task to the executor via stdin", async () => {
    const scheduler = resolveScheduler(
      config({
        executorCommand: `"${process.execPath}" -e process.stdin.once("data",d=>process.stdout.write(d.toString().trim()))`,
      }),
      "instance-stdin",
    );
    const terminal = await runToTerminal(scheduler, "echo-this-task");

    expect(terminal?.status).toBe("succeeded");
    expect(terminal?.result).toBe("echo-this-task");
  }, 20_000);

  it("surfaces executor failures with exit code and stderr", async () => {
    const scheduler = resolveScheduler(
      config({
        executorCommand: `"${process.execPath}" -e process.stderr.write("boom");process.exit(3)`,
      }),
      "instance-fail",
    );
    const terminal = await runToTerminal(scheduler, "task");

    expect(terminal?.status).toBe("failed");
    expect(terminal?.error?.message).toContain("code 3");
    expect(terminal?.error?.message).toContain("boom");
    // Snapshot carries only the task input — no environment material.
    expect(terminal?.request.input).toBe("task");
  }, 20_000);

  it("kills executors that exceed the execution timeout", async () => {
    const scheduler = resolveScheduler(
      config({
        executionTimeoutMs: 300,
        executorCommand: `"${process.execPath}" -e setTimeout(()=>{},60000)`,
      }),
      "instance-timeout",
    );
    const terminal = await runToTerminal(scheduler, "task");

    expect(terminal?.status).toBe("execution_timed_out");
  }, 20_000);
});

const LEDGER_INSTANCE_ID = "byok-ledger-projection";

const delegationSettingsLayer = ServerSettings.layerTest({
  providerInstances: {
    [ProviderInstanceId.make(LEDGER_INSTANCE_ID)]: {
      driver: ProviderDriverKind.make("byok"),
      config: {
        delegation: {
          enabled: true,
          maxConcurrency: 1,
          queueTimeoutMs: 10_000,
          executionTimeoutMs: 15_000,
          executorCommand: `"${process.execPath}" -e process.stdout.write("delegated-ledger-result")`,
        },
      },
    },
  },
});

const ledgerLayer = effectIt.layer(
  Layer.mergeAll(
    CompositionTaskStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    delegationSettingsLayer,
  ),
);

ledgerLayer("delegation ledger projection (Composition 单一状态源)", (it) => {
  it.effect(
    "submit 把排队/运行/完成迁移以幂等事件行投影进 Composition Task/Run，且原文不落账",
    () =>
      Effect.gen(function* () {
        const service = yield* make;
        const snapshot = yield* service.submit({
          instanceId: LEDGER_INSTANCE_ID,
          task: "ledger-secret-task-body",
        });
        assert.equal(snapshot.status, "succeeded");
        assert.equal(snapshot.resultPreview, "delegated-ledger-result");

        const store = yield* CompositionTaskStore;
        const tasks = yield* store.listTasks("byok-delegation");
        assert.equal(tasks.length, 1);
        const task = tasks[0]!;
        assert.equal(task.status, "completed");
        assert.equal(task.assigneeId, `provider:${LEDGER_INSTANCE_ID}`);
        const run = (yield* store.getLatestRun(task.taskId)).pipe(Option.getOrThrow);
        assert.equal(run.status, "completed");

        const events = yield* store.listEvents(task.taskId, run.runId);
        assert.isTrue(events.some((event) => event.sourceEventId?.endsWith(":queued")));
        assert.isTrue(events.some((event) => event.sourceEventId?.endsWith(":running")));
        assert.isTrue(
          events.some((event) => event.sourceEventId?.endsWith(":terminal:succeeded")),
        );
        // 敏感内容约定：委派 prompt 与执行输出不得进入任务台账。
        // @effect-diagnostics-next-line preferSchemaOverJson:off - 断言台账整体序列化不含敏感原文。
        const serialized = JSON.stringify({ events, task, run });
        assert.isFalse(serialized.includes("ledger-secret-task-body"));
        assert.isFalse(serialized.includes("delegated-ledger-result"));
      }),
    20_000,
  );

  it.effect("执行失败的委派在台账中收敛为 failed 并带错误码", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({
        providerInstances: {
          [ProviderInstanceId.make(LEDGER_INSTANCE_ID)]: {
            driver: ProviderDriverKind.make("byok"),
            config: {
              delegation: {
                enabled: true,
                maxConcurrency: 1,
                queueTimeoutMs: 10_000,
                executionTimeoutMs: 15_000,
                executorCommand: `"${process.execPath}" -e process.exit(3)`,
              },
            },
          },
        },
      });
      const service = yield* make;
      const snapshot = yield* service.submit({
        instanceId: LEDGER_INSTANCE_ID,
        task: "ledger-failing-task",
      });
      assert.equal(snapshot.status, "failed");

      const store = yield* CompositionTaskStore;
      const tasks = yield* store.listTasks("byok-delegation");
      const task = tasks.find((candidate) => candidate.status === "failed");
      assert.isDefined(task);
      const run = (yield* store.getLatestRun(task!.taskId)).pipe(Option.getOrThrow);
      assert.equal(run.status, "failed");
      assert.isDefined(run.failureCode);
      const events = yield* store.listEvents(task!.taskId, run.runId);
      assert.isTrue(events.some((event) => event.sourceEventId?.endsWith(":terminal:failed")));
    }),
    20_000,
  );
});
