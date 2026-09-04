import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ByokDelegationConfig,
  type OrchestrationCommand,
} from "@codework/contracts";
import { assert, it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/unstable/http";
import { describe, expect, it } from "vite-plus/test";

import {
  __testables,
  clampDelegationRuntimeConfig,
  delegationOriginActivities,
  delegationSubmitErrorCode,
  globalDelegationPressure,
  make,
  resolveDelegationModel,
  resolveScheduler,
} from "./ByokDelegationService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { CompositionTaskStore } from "../../persistence/Services/CompositionTaskStore.ts";
import { CompositionTaskStoreLive } from "../../persistence/Layers/CompositionTaskStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../orchestration/Services/OrchestrationEngine.ts";
import {
  DelegationQueueFullError,
  type DelegationStatus,
} from "../../orchestration/byokDelegation/DelegationScheduler.ts";
import {
  makeByokDelegationProjectionScope,
  projectByokDelegationTransition,
} from "../../composition/CompositionByokDelegationProjection.ts";

const { parseExecutorCommand, buildChildEnv, preview, registerLiveProjectedDelegation } =
  __testables;

const config = (overrides: Record<string, unknown> = {}) => ({
  enabled: true,
  maxConcurrency: 2,
  queueTimeoutMs: 5_000,
  executionTimeoutMs: 15_000,
  modelGroups: [],
  executorCommand: "",
  executorEnvironmentVariables: [],
  executors: [],
  executorFailoverLimit: 3,
  visionDelegation: { enabled: false, visionModelId: "", mode: "auto" as const },
  supervision: {
    enabled: false,
    supervisorModelId: "",
    reviewerModelId: "",
    maxCorrections: 2,
    maxRetries: 1,
    maxRounds: 8,
    allowReassign: true,
    allowEscalate: true,
    strictUnavailable: false,
  },
  subagentProfiles: [],
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

describe("delegation runtime hard caps (服务端硬上限)", () => {
  it("clamps persisted runtime numbers to the hard caps with trunc semantics", () => {
    const clamped = clampDelegationRuntimeConfig(
      config({
        maxConcurrency: 10_000,
        queueTimeoutMs: 5,
        executionTimeoutMs: 500,
        supervision: {
          enabled: false,
          supervisorModelId: "",
          reviewerModelId: "",
          maxCorrections: 999,
          maxRetries: 500,
          maxRounds: 1e6,
          allowReassign: true,
          allowEscalate: true,
          strictUnavailable: false,
        },
      }),
    );

    expect(clamped.maxConcurrency).toBe(16);
    expect(clamped.queueTimeoutMs).toBe(1_000);
    expect(clamped.executionTimeoutMs).toBe(1_000);
    expect(clamped.supervision.maxCorrections).toBe(20);
    expect(clamped.supervision.maxRetries).toBe(20);
    expect(clamped.supervision.maxRounds).toBe(50);
  });

  it("truncates fractional concurrency toward zero before clamping", () => {
    expect(clampDelegationRuntimeConfig(config({ maxConcurrency: 0.9 })).maxConcurrency).toBe(1);
    expect(clampDelegationRuntimeConfig(config({ maxConcurrency: 7.9 })).maxConcurrency).toBe(7);
  });

  it("keeps in-bounds values untouched and falls back to defaults for unusable ones", () => {
    const inBounds = clampDelegationRuntimeConfig(config());
    expect(inBounds.maxConcurrency).toBe(2);
    expect(inBounds.queueTimeoutMs).toBe(5_000);
    expect(inBounds.supervision.maxRounds).toBe(8);

    const unusable = clampDelegationRuntimeConfig({
      ...config(),
      maxConcurrency: Number.NaN,
      queueTimeoutMs: undefined,
    } as unknown as ByokDelegationConfig);
    expect(unusable.maxConcurrency).toBe(4);
    expect(unusable.queueTimeoutMs).toBe(30_000);
  });

  it("sums running and in-flight delegations across scheduler snapshots", () => {
    const source = (statuses: DelegationStatus[]) => ({
      list: () => statuses.map((status) => ({ status })),
    });

    expect(globalDelegationPressure([])).toEqual({ running: 0, inFlight: 0 });
    expect(
      globalDelegationPressure([
        source(["running", "queued", "succeeded"]),
        source(["queued", "cancelled", "execution_timed_out"]),
      ]),
    ).toEqual({ running: 1, inFlight: 3 });
  });

  it("maps queue-full backpressure onto a distinct submit error code", () => {
    expect(delegationSubmitErrorCode({ code: new DelegationQueueFullError(4).code })).toBe(
      "DELEGATION_QUEUE_FULL",
    );
    expect(delegationSubmitErrorCode({})).toBe("DELEGATION_SUBMIT_FAILED");
    expect(delegationSubmitErrorCode({ code: "other" })).toBe("DELEGATION_SUBMIT_FAILED");
  });
});

describe("delegationOriginActivities (origin 线程名册行)", () => {
  const rosterTaskId = "byok-delegation-key-1";

  it("started row stamps agentKind agent, default role and timelineBypass", () => {
    const rows = delegationOriginActivities({
      origin: { threadId: "thread-42" },
      rosterTaskId,
      taskText: "Fix the flaky test\nsecond line never reaches the title",
      phase: "started",
    });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.kind).toBe("task.started");
    expect(row.id).toBe("task-started:thread-42:byok-delegation-key-1");
    expect(row.tone).toBe("info");
    expect(row.turnId).toBeNull();
    expect(row.summary).toBe("Delegation started: Fix the flaky test");
    expect(row.payload).toEqual({
      taskId: rosterTaskId,
      agentKind: "agent",
      title: "Fix the flaky test",
      role: "delegation",
      timelineBypass: true,
    });
    expect(Number.isNaN(Date.parse(row.createdAt))).toBe(false);
  });

  it("carries subagentType as the roster role and brands turnId when present", () => {
    const [row] = delegationOriginActivities({
      origin: { threadId: "thread-42", turnId: "turn-7" },
      rosterTaskId,
      taskText: "Explore the repo",
      subagentType: "explore",
      phase: "started",
    });
    expect(row!.turnId).toBe("turn-7");
    expect(row!.payload).toMatchObject({ role: "explore", agentKind: "agent" });
  });

  it("running row uses a stable upsert id and explicit running status", () => {
    const [row] = delegationOriginActivities({
      origin: { threadId: "thread-42" },
      rosterTaskId,
      taskText: "task body",
      phase: "running",
    });
    expect(row!.kind).toBe("task.progress");
    expect(row!.id).toBe("task-progress:thread-42:byok-delegation-key-1");
    expect(row!.summary).toBe("Delegation running");
    expect(row!.payload).toEqual({
      taskId: rosterTaskId,
      status: "running",
      summary: "Delegation running",
      timelineBypass: true,
    });
  });

  it("maps terminal statuses onto the roster fold vocabulary", () => {
    const terminal = (status: string, errorMessage?: string) =>
      delegationOriginActivities({
        origin: { threadId: "thread-42" },
        rosterTaskId,
        taskText: "task body",
        phase: "terminal",
        status,
        ...(errorMessage === undefined ? {} : { errorMessage }),
      })[0]!;

    const succeeded = terminal("succeeded");
    expect(succeeded.kind).toBe("task.updated");
    expect(succeeded.summary).toBe("Delegation completed");
    expect(succeeded.payload).toEqual({
      taskId: rosterTaskId,
      status: "completed",
      endedAt: succeeded.createdAt,
      timelineBypass: true,
    });

    expect(terminal("failed", 'Executor "rescue" exited with code 3.').payload).toMatchObject({
      status: "failed",
      error: 'Executor "rescue" exited with code 3.',
    });

    const cancelled = terminal("cancelled");
    expect(cancelled.payload).toMatchObject({ status: "cancelled" });
    expect((cancelled.payload as Record<string, unknown>)["error"]).toBeUndefined();

    expect(terminal("execution_timed_out").payload).toMatchObject({
      status: "failed",
      detail: "execution_timed_out",
    });
    expect(terminal("martian_state").payload).toMatchObject({
      status: "failed",
      detail: "martian_state",
    });
  });

  it("gives terminal rows a unique id suffix so retries never collide", () => {
    const build = () =>
      delegationOriginActivities({
        origin: { threadId: "thread-42" },
        rosterTaskId,
        taskText: "task body",
        phase: "terminal",
        status: "failed",
      })[0]!;
    const first = build();
    const second = build();
    expect(first.id).toMatch(
      /^task-updated:thread-42:byok-delegation-key-1:failed:[0-9a-f-]{36}$/u,
    );
    expect(first.id).not.toBe(second.id);
  });

  it("bounds the title to one line of at most 80 chars and errors to 200", () => {
    const [started] = delegationOriginActivities({
      origin: { threadId: "thread-42" },
      rosterTaskId,
      taskText: `${"x".repeat(300)}\nsecond line`,
      phase: "started",
    });
    const title = (started!.payload as Record<string, unknown>)["title"] as string;
    expect(title).toHaveLength(80);
    expect(title.endsWith("…")).toBe(true);

    const [failed] = delegationOriginActivities({
      origin: { threadId: "thread-42" },
      rosterTaskId,
      taskText: "task body",
      phase: "terminal",
      status: "failed",
      errorMessage: "e".repeat(500),
    });
    expect((failed!.payload as Record<string, unknown>)["error"]).toHaveLength(200);
  });

  it("returns no rows for unusable inputs", () => {
    const base = {
      origin: { threadId: "thread-42" },
      rosterTaskId,
      taskText: "task body",
      phase: "terminal",
      status: "failed",
    } as const;
    expect(delegationOriginActivities({ ...base, origin: { threadId: "   " } })).toEqual([]);
    expect(delegationOriginActivities({ ...base, rosterTaskId: "" })).toEqual([]);
    expect(
      delegationOriginActivities({
        origin: { threadId: "thread-42" },
        rosterTaskId,
        taskText: "task body",
        phase: "terminal",
      }),
    ).toEqual([]);
    expect(
      delegationOriginActivities({
        origin: { threadId: "thread-42" },
        rosterTaskId,
        taskText: "task body",
        phase: "started",
      }),
    ).toHaveLength(1);
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
    FetchHttpClient.layer,
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
        assert.isTrue(events.some((event) => event.sourceEventId?.endsWith(":terminal:succeeded")));
        // 敏感内容约定：委派 prompt 与执行输出不得进入任务台账。
        // @effect-diagnostics-next-line preferSchemaOverJson:off - 断言台账整体序列化不含敏感原文。
        const serialized = JSON.stringify({ events, task, run });
        assert.isFalse(serialized.includes("ledger-secret-task-body"));
        assert.isFalse(serialized.includes("delegated-ledger-result"));
      }),
    20_000,
  );

  it.effect(
    "执行失败的委派在台账中收敛为 failed 并带错误码",
    () =>
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

const CANCEL_INSTANCE_ID = "byok-ledger-cancel";
const cancellationConfig: ByokDelegationConfig = {
  enabled: true,
  maxConcurrency: 1,
  queueTimeoutMs: 10_000,
  executionTimeoutMs: 60_000,
  modelGroups: [],
  executorCommand: `"${process.execPath}" -e setTimeout(()=>{},60000)`,
  executorEnvironmentVariables: [],
  executors: [],
  executorFailoverLimit: 3,
  visionDelegation: { enabled: false, visionModelId: "", mode: "auto" },
  supervision: {
    enabled: false,
    supervisorModelId: "",
    reviewerModelId: "",
    maxCorrections: 2,
    maxRetries: 1,
    maxRounds: 8,
    allowReassign: true,
    allowEscalate: true,
    strictUnavailable: false,
  },
  subagentProfiles: [],
};
const cancellationLayer = effectIt.layer(
  Layer.mergeAll(
    CompositionTaskStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    ServerSettings.layerTest({
      providerInstances: {
        [ProviderInstanceId.make(CANCEL_INSTANCE_ID)]: {
          driver: ProviderDriverKind.make("byok"),
          config: { delegation: cancellationConfig },
        },
      },
    }),
    FetchHttpClient.layer,
  ),
);

cancellationLayer("delegation composition cancel bridge", (it) => {
  it.effect(
    "composition cancel 命中真实调度器并把委派台账落为 cancelled",
    () =>
      Effect.gen(function* () {
        const scheduler = resolveScheduler(cancellationConfig, CANCEL_INSTANCE_ID);
        const blocker = scheduler.submit({ input: "blocker" });
        const queued = scheduler.submit({ input: "cancel-secret-prompt" });
        assert.equal(queued.status, "queued");

        const scope = makeByokDelegationProjectionScope({
          instanceId: CANCEL_INSTANCE_ID,
          delegationId: queued.id,
          uniqueKey: "service-cancel",
          taskText: "cancel-secret-prompt",
        });
        const unregisterLive = registerLiveProjectedDelegation(scope, scheduler);
        const store = yield* CompositionTaskStore;
        yield* projectByokDelegationTransition({
          store,
          scope,
          transition: { status: "queued" },
          nowUnixMs: 1_000,
        });

        const service = yield* make;
        const result = yield* service.cancelCompositionTask({
          taskId: scope.taskId,
          runId: scope.runId,
          reason: "控制中心取消",
        });

        assert.equal(result?.status, "cancelled");
        assert.equal(scheduler.get(queued.id)?.status, "cancelled");
        assert.equal(result?.task.status, "cancelled");
        assert.equal(result?.run.status, "cancelled");
        const events = yield* store.listEvents(scope.taskId, scope.runId);
        assert.isTrue(events.some((event) => event.sourceEventId?.endsWith(":terminal:cancelled")));
        // @effect-diagnostics-next-line preferSchemaOverJson:off - 整体序列化用于验证敏感正文不进入台账/返回值。
        assert.isFalse(JSON.stringify({ events, result }).includes("cancel-secret-prompt"));

        unregisterLive();
        scheduler.cancel(blocker.id);
      }),
    20_000,
  );

  it.effect(
    "service.cancel 按 instanceId+delegationId 取消委派并返回快照，未知 id 返回 null",
    () =>
      Effect.gen(function* () {
        const scheduler = resolveScheduler(cancellationConfig, CANCEL_INSTANCE_ID);
        const blocker = scheduler.submit({ input: "blocker" });
        const queued = scheduler.submit({ input: "cancel-target-task" });

        const service = yield* make;
        const cancelled = yield* service.cancel({
          instanceId: CANCEL_INSTANCE_ID,
          delegationId: queued.id,
        });
        assert.equal(cancelled?.status, "cancelled");
        assert.equal(scheduler.get(queued.id)?.status, "cancelled");

        const unknown = yield* service.cancel({
          instanceId: CANCEL_INSTANCE_ID,
          delegationId: "delegation-unknown",
        });
        assert.equal(unknown, null);

        scheduler.cancel(blocker.id);
      }),
    20_000,
  );
});

const FAILOVER_INSTANCE_ID = "byok-failover";
const rescueExecutor = {
  id: "rescue",
  name: "",
  enabled: true,
  priority: 100,
  command: `"${process.execPath}" -e process.stdout.write("rescued-ok")`,
  environmentVariables: [],
  probeArguments: "",
};

const failoverSettingsLayer = ServerSettings.layerTest({
  providerInstances: {
    [ProviderInstanceId.make(FAILOVER_INSTANCE_ID)]: {
      driver: ProviderDriverKind.make("byok"),
      config: {
        delegation: {
          enabled: true,
          maxConcurrency: 1,
          queueTimeoutMs: 10_000,
          executionTimeoutMs: 20_000,
          executorCommand: `"${process.execPath}" -e process.stderr.write("primary_down");process.exit(3)`,
          executors: [rescueExecutor],
        },
      },
    },
  },
});

const failoverLayer = effectIt.layer(Layer.mergeAll(failoverSettingsLayer, FetchHttpClient.layer));

failoverLayer("delegation executor failover (original registry parity)", (it) => {
  it.effect(
    "switchable failure fails over to the next candidate and records the attempt chain",
    () =>
      Effect.gen(function* () {
        const service = yield* make;
        const snapshot = yield* service.submit({
          instanceId: FAILOVER_INSTANCE_ID,
          task: "failover-task",
        });
        assert.equal(snapshot.status, "succeeded");
        assert.equal(snapshot.resultPreview, "rescued-ok");
        assert.deepEqual(
          snapshot.executorAttempts?.map((row) => [row.executorId, row.status]),
          [
            ["default", "failed"],
            ["rescue", "completed"],
          ],
        );
        assert.include(snapshot.executorAttempts?.[0]?.diagnosticPreview ?? "", "primary_down");
      }),
    20_000,
  );

  it.effect(
    "not-installed candidates are probed away without consuming the budget",
    () =>
      Effect.gen(function* () {
        const settings = yield* ServerSettings.ServerSettingsService;
        yield* settings.updateSettings({
          providerInstances: {
            [ProviderInstanceId.make(FAILOVER_INSTANCE_ID)]: {
              driver: ProviderDriverKind.make("byok"),
              config: {
                delegation: {
                  enabled: true,
                  maxConcurrency: 1,
                  queueTimeoutMs: 10_000,
                  executionTimeoutMs: 20_000,
                  executorCommand: "definitely-not-installed-executor-xyz --run",
                  executors: [rescueExecutor],
                },
              },
            },
          },
        });
        const service = yield* make;
        const snapshot = yield* service.submit({
          instanceId: FAILOVER_INSTANCE_ID,
          task: "probe-skip-task",
        });
        assert.equal(snapshot.status, "succeeded");
        assert.equal(snapshot.resultPreview, "rescued-ok");
        assert.deepEqual(
          snapshot.executorAttempts?.map((row) => [row.executorId, row.status]),
          [
            ["default", "skipped"],
            ["rescue", "completed"],
          ],
        );
        assert.equal(snapshot.executorAttempts?.[0]?.diagnosticPreview, "not_installed");
      }),
    20_000,
  );
});

const ORIGIN_ACTIVITY_INSTANCE_ID = "byok-origin-activity";
const dispatchedCommands: OrchestrationCommand[] = [];

const fakeOrchestrationEngineLayer = Layer.succeed(OrchestrationEngineService, {
  dispatch: (command) =>
    Effect.sync(() => {
      dispatchedCommands.push(command);
      return { sequence: dispatchedCommands.length };
    }),
  readEvents: () => Stream.empty,
  streamDomainEvents: Stream.empty,
  latestSequence: Effect.succeed(0),
} satisfies OrchestrationEngineShape);

const originActivitySettingsLayer = ServerSettings.layerTest({
  providerInstances: {
    [ProviderInstanceId.make(ORIGIN_ACTIVITY_INSTANCE_ID)]: {
      driver: ProviderDriverKind.make("byok"),
      config: {
        delegation: {
          enabled: true,
          maxConcurrency: 1,
          queueTimeoutMs: 10_000,
          executionTimeoutMs: 15_000,
          executorCommand: `"${process.execPath}" -e process.stdout.write("origin-activity-result")`,
        },
      },
    },
  },
});

const originActivityLayer = effectIt.layer(
  Layer.mergeAll(originActivitySettingsLayer, FetchHttpClient.layer, fakeOrchestrationEngineLayer),
);

originActivityLayer("delegation origin thread activities (Agents 面板名册)", (it) => {
  it.effect(
    "submit 带 origin 时向 origin 线程按序追加 started/running/terminal 活动行",
    () =>
      Effect.gen(function* () {
        dispatchedCommands.length = 0;
        const service = yield* make;
        const snapshot = yield* service.submit({
          instanceId: ORIGIN_ACTIVITY_INSTANCE_ID,
          task: "origin-thread-task-body",
          origin: { threadId: "thread-origin-1", turnId: "turn-origin-9" },
        });
        assert.equal(snapshot.status, "succeeded");

        const appends = dispatchedCommands.flatMap((command) =>
          command.type === "thread.activity.append" ? [command] : [],
        );
        assert.equal(appends.length, 3);
        assert.deepEqual(
          appends.map((command) => command.activity.kind),
          ["task.started", "task.progress", "task.updated"],
        );
        for (const command of appends) {
          assert.equal(command.threadId, "thread-origin-1");
          assert.equal(command.activity.turnId, "turn-origin-9");
        }
        // 三行共用台账 scope.taskId 身份（ledger 与 Agents 面板同 id）。
        const rosterTaskIds = new Set(
          appends.map((command) => (command.activity.payload as Record<string, unknown>)["taskId"]),
        );
        assert.equal(rosterTaskIds.size, 1);
        assert.isTrue(String([...rosterTaskIds][0]).startsWith("byok-delegation-"));

        const startedPayload = appends[0]!.activity.payload as Record<string, unknown>;
        assert.equal(startedPayload["agentKind"], "agent");
        assert.equal(startedPayload["timelineBypass"], true);
        assert.equal(startedPayload["role"], "delegation");
        assert.equal(startedPayload["title"], "origin-thread-task-body");

        const terminalPayload = appends[2]!.activity.payload as Record<string, unknown>;
        assert.equal(terminalPayload["status"], "completed");
        assert.equal(typeof terminalPayload["endedAt"], "string");
      }),
    20_000,
  );

  it.effect(
    "submit 无 origin 时不派发任何线程活动命令",
    () =>
      Effect.gen(function* () {
        dispatchedCommands.length = 0;
        const service = yield* make;
        const snapshot = yield* service.submit({
          instanceId: ORIGIN_ACTIVITY_INSTANCE_ID,
          task: "no-origin-task-body",
        });
        assert.equal(snapshot.status, "succeeded");
        assert.equal(dispatchedCommands.length, 0);
      }),
    20_000,
  );
});

const QUEUE_FULL_INSTANCE_ID = "byok-queue-full";
// maxConcurrency 1 → queueLimit 4：1 个 running + 4 个 queued 即占满本地队列。
const queueFullConfig: ByokDelegationConfig = {
  enabled: true,
  maxConcurrency: 1,
  queueTimeoutMs: 10_000,
  executionTimeoutMs: 60_000,
  modelGroups: [],
  executorCommand: `"${process.execPath}" -e setTimeout(()=>{},60000)`,
  executorEnvironmentVariables: [],
  executors: [],
  executorFailoverLimit: 3,
  visionDelegation: { enabled: false, visionModelId: "", mode: "auto" },
  supervision: {
    enabled: false,
    supervisorModelId: "",
    reviewerModelId: "",
    maxCorrections: 2,
    maxRetries: 1,
    maxRounds: 8,
    allowReassign: true,
    allowEscalate: true,
    strictUnavailable: false,
  },
  subagentProfiles: [],
};

const queueFullLayer = effectIt.layer(
  Layer.mergeAll(
    ServerSettings.layerTest({
      providerInstances: {
        [ProviderInstanceId.make(QUEUE_FULL_INSTANCE_ID)]: {
          driver: ProviderDriverKind.make("byok"),
          config: { delegation: queueFullConfig },
        },
      },
    }),
    FetchHttpClient.layer,
  ),
);

queueFullLayer("delegation submit backpressure (队列满错误码)", (it) => {
  it.effect(
    "队列满时 submit 以 DELEGATION_QUEUE_FULL 失败快照拒绝，而非通用提交失败",
    () =>
      Effect.gen(function* () {
        const scheduler = resolveScheduler(queueFullConfig, QUEUE_FULL_INSTANCE_ID);
        const inFlight = [
          // 第 1 个立即 running（maxConcurrency 1），其余 4 个占满队列。
          scheduler.submit({ input: "blocker" }),
          ...Array.from({ length: 4 }, (_, index) =>
            scheduler.submit({ input: `queued-${index}` }),
          ),
        ];
        assert.equal(inFlight.filter((snapshot) => snapshot.status === "running").length, 1);
        assert.equal(inFlight.filter((snapshot) => snapshot.status === "queued").length, 4);

        const service = yield* make;
        const snapshot = yield* service.submit({
          instanceId: QUEUE_FULL_INSTANCE_ID,
          task: "overflow-task",
        });

        assert.equal(snapshot.status, "failed");
        assert.equal(snapshot.errorCode, "DELEGATION_QUEUE_FULL");
        assert.include(snapshot.errorMessage ?? "", "queue is full");
        // 背压与通用提交失败可区分：模型据此停止盲目重试。
        assert.notEqual(snapshot.errorCode, "DELEGATION_SUBMIT_FAILED");

        for (const record of inFlight) scheduler.cancel(record.id);
      }),
    20_000,
  );
});

const RETIRE_INSTANCE_ID = "byok-retire-check";

describe("delegation scheduler retirement (指纹变更退役)", () => {
  it("配置指纹变更时：排队任务立即取消，运行中保留并计入全局压力，排空后自动移除", () => {
    const configA: ByokDelegationConfig = config({
      maxConcurrency: 1,
      executorCommand: `"${process.execPath}" -e setTimeout(()=>{},60000)`,
    });
    const configB: ByokDelegationConfig = config({
      maxConcurrency: 1,
      executorCommand: `"${process.execPath}" -e setTimeout(()=>{},59000)`,
    });
    const schedulerA = resolveScheduler(configA, RETIRE_INSTANCE_ID);
    const running = schedulerA.submit({ input: "retire-running" });
    const queued = schedulerA.submit({ input: "retire-queued" });
    assert.equal(running.status, "running");
    assert.equal(queued.status, "queued");

    const schedulerB = resolveScheduler(configB, RETIRE_INSTANCE_ID);
    assert.notEqual(schedulerA, schedulerB);
    // 排队任务立即以 cancelled 结算——不会在旧配置下隐形执行。
    assert.equal(schedulerA.get(queued.id)?.status, "cancelled");
    // 运行中的任务继续执行，但进入退役追踪并计入全局压力。
    assert.equal(schedulerA.get(running.id)?.status, "running");
    assert.equal(__testables.retiredSchedulers.length, 1);
    const pressure = globalDelegationPressure([
      ...[...__testables.schedulers.values()].map((entry) => entry.scheduler),
      ...__testables.retiredSchedulers,
    ]);
    assert.equal(pressure.running, 1);
    assert.equal(pressure.inFlight, 1);
    assert.equal(__testables.schedulers.get(RETIRE_INSTANCE_ID)?.scheduler, schedulerB);

    // 运行任务终态后退役条目自动移除，退役表不滞留。
    schedulerA.cancel(running.id);
    assert.equal(__testables.retiredSchedulers.length, 0);
  });
});

const PRUNE_INSTANCE_ID = "byok-prune-check";
const pruneExecutorCommand = `"${process.execPath}" -e process.stdout.write("prune-ok")`;

const pruneLayer = effectIt.layer(
  Layer.mergeAll(
    ServerSettings.layerTest({
      providerInstances: {
        [ProviderInstanceId.make(PRUNE_INSTANCE_ID)]: {
          driver: ProviderDriverKind.make("byok"),
          config: {
            delegation: {
              enabled: true,
              maxConcurrency: 1,
              queueTimeoutMs: 10_000,
              executionTimeoutMs: 15_000,
              executorCommand: pruneExecutorCommand,
            },
          },
        },
      },
    }),
    FetchHttpClient.layer,
  ),
);

pruneLayer("delegation scheduler state pruning (实例删除清理)", (it) => {
  it.effect(
    "实例从设置移除后，调度器条目与探测注册表在下一次设置读取时被清理",
    () =>
      Effect.gen(function* () {
        const configPrune: ByokDelegationConfig = config({
          executorCommand: pruneExecutorCommand,
        });
        resolveScheduler(configPrune, PRUNE_INSTANCE_ID);
        assert.ok(__testables.schedulers.has(PRUNE_INSTANCE_ID));
        const retiredBefore = __testables.retiredSchedulers.length;

        const settings = yield* ServerSettings.ServerSettingsService;
        // providerInstances 是整体替换语义：空映射即删除全部实例。
        yield* settings.updateSettings({ providerInstances: {} });

        const service = yield* make;
        const listed = yield* service.list(PRUNE_INSTANCE_ID);
        assert.deepEqual(listed, []);
        assert.equal(__testables.schedulers.has(PRUNE_INSTANCE_ID), false);
        assert.equal(__testables.probeRegistries.has(PRUNE_INSTANCE_ID), false);
        // 无在途工作的退役即时完成：清理动作本身不向退役表新增条目
        // （长度与清理前持平；表内既有条目属于其他用例的残留）。
        assert.equal(__testables.retiredSchedulers.length, retiredBefore);
      }),
    20_000,
  );
});
