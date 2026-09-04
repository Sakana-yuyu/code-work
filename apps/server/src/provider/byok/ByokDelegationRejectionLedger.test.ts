import {
  BYOK_DELEGATION_PROJECT_ID,
  ProviderDriverKind,
  ProviderInstanceId,
  type ByokDelegationConfig,
} from "@codework/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { FetchHttpClient } from "effect/unstable/http";

import { make, resolveScheduler } from "./ByokDelegationService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { CompositionTaskStore } from "../../persistence/Services/CompositionTaskStore.ts";
import { CompositionTaskStoreLive } from "../../persistence/Layers/CompositionTaskStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";

const DISABLED_INSTANCE_ID = "byok-rejection-disabled";
const UNCONFIGURED_INSTANCE_ID = "byok-rejection-unconfigured";
const QUEUE_FULL_INSTANCE_ID = "byok-rejection-queue-full";

const baseDelegationConfig = {
  maxConcurrency: 1,
  queueTimeoutMs: 5_000,
  executionTimeoutMs: 15_000,
  modelGroups: [],
  executorEnvironmentVariables: [],
};

const queueFullConfig = {
  ...baseDelegationConfig,
  enabled: true,
  executorCommand: `"${process.execPath}" -e setTimeout(()=>{},60000)`,
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
} as ByokDelegationConfig;

const layer = it.layer(
  Layer.mergeAll(
    CompositionTaskStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    ServerSettings.layerTest({
      providerInstances: {
        [ProviderInstanceId.make(DISABLED_INSTANCE_ID)]: {
          driver: ProviderDriverKind.make("byok"),
          config: {
            delegation: {
              ...baseDelegationConfig,
              enabled: false,
              executorCommand: `"${process.execPath}" -e process.exit(0)`,
            },
          },
        },
        [ProviderInstanceId.make(UNCONFIGURED_INSTANCE_ID)]: {
          driver: ProviderDriverKind.make("byok"),
          config: {
            delegation: {
              ...baseDelegationConfig,
              enabled: true,
              executorCommand: "",
            },
          },
        },
        [ProviderInstanceId.make(QUEUE_FULL_INSTANCE_ID)]: {
          driver: ProviderDriverKind.make("byok"),
          config: { delegation: queueFullConfig },
        },
      },
    }),
    FetchHttpClient.layer,
  ),
);

layer("BYOK 委派入队前拒绝台账", (it) => {
  it.effect("disabled 与未配置请求各自落唯一失败 Run，且 prompt 原文不落账", () =>
    Effect.gen(function* () {
      const service = yield* make;
      const disabled = yield* service.submit({
        instanceId: DISABLED_INSTANCE_ID,
        task: "disabled-secret-prompt",
      });
      const unconfigured = yield* service.submit({
        instanceId: UNCONFIGURED_INSTANCE_ID,
        task: "unconfigured-secret-prompt",
      });

      assert.equal(disabled.status, "failed");
      assert.equal(disabled.errorCode, "DELEGATION_DISABLED");
      assert.match(disabled.id, /^delegation-rejected-/);
      assert.equal(unconfigured.status, "failed");
      assert.equal(unconfigured.errorCode, "DELEGATION_NOT_CONFIGURED");
      assert.match(unconfigured.id, /^delegation-rejected-/);
      assert.notEqual(disabled.id, unconfigured.id);

      const store = yield* CompositionTaskStore;
      const tasks = yield* store.listTasks(BYOK_DELEGATION_PROJECT_ID);
      assert.equal(tasks.length, 2);

      const failureCodes = new Set<string>();
      const ledgerRows: unknown[] = [];
      for (const task of tasks) {
        const run = (yield* store.getLatestRun(task.taskId)).pipe(Option.getOrThrow);
        const events = yield* store.listEvents(task.taskId, run.runId);
        assert.equal(task.status, "failed");
        assert.equal(run.status, "failed");
        assert.equal(events.length, 1);
        assert.isTrue(events[0]?.sourceEventId?.endsWith(":terminal:failed") ?? false);
        if (run.failureCode !== undefined) failureCodes.add(run.failureCode);
        ledgerRows.push({ task, run, events });
      }
      assert.deepEqual(
        [...failureCodes].sort(),
        ["DELEGATION_DISABLED", "DELEGATION_NOT_CONFIGURED"].sort(),
      );

      // @effect-diagnostics-next-line preferSchemaOverJson:off - 整体序列化验证敏感正文未进入台账。
      const serialized = JSON.stringify(ledgerRows);
      assert.isFalse(serialized.includes("disabled-secret-prompt"));
      assert.isFalse(serialized.includes("unconfigured-secret-prompt"));
    }),
  );

  it.effect(
    "调度器拒绝入队时创建失败台账，且不会覆盖既有拒绝",
    () =>
      Effect.gen(function* () {
        const scheduler = resolveScheduler(queueFullConfig, QUEUE_FULL_INSTANCE_ID);
        const occupied = [
          scheduler.submit({ input: "running-blocker" }),
          ...Array.from({ length: scheduler.queueLimit }, (_, index) =>
            scheduler.submit({ input: `queued-${String(index)}` }),
          ),
        ];

        yield* Effect.gen(function* () {
          const service = yield* make;
          const rejected = yield* service.submit({
            instanceId: QUEUE_FULL_INSTANCE_ID,
            task: "queue-full-secret-prompt",
          });
          assert.equal(rejected.status, "failed");
          assert.equal(rejected.errorCode, "DELEGATION_QUEUE_FULL");
          assert.match(rejected.id, /^delegation-rejected-/);

          const store = yield* CompositionTaskStore;
          const tasks = yield* store.listTasks(BYOK_DELEGATION_PROJECT_ID);
          const task = tasks.find(
            (candidate) => candidate.assigneeId === `provider:${QUEUE_FULL_INSTANCE_ID}`,
          );
          assert.isDefined(task);
          const run = (yield* store.getLatestRun(task!.taskId)).pipe(Option.getOrThrow);
          const events = yield* store.listEvents(task!.taskId, run.runId);
          assert.equal(task!.status, "failed");
          assert.equal(run.status, "failed");
          assert.equal(run.failureCode, "DELEGATION_QUEUE_FULL");
          assert.equal(events.length, 1);
          assert.isFalse(
            // @effect-diagnostics-next-line preferSchemaOverJson:off - 整体序列化验证敏感正文未进入台账。
            JSON.stringify({ task, run, events }).includes("queue-full-secret-prompt"),
          );
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              for (const snapshot of occupied) scheduler.cancel(snapshot.id);
            }),
          ),
        );
      }),
    20_000,
  );
});
