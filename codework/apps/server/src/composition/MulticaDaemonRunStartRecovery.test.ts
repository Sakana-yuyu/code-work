import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { CompositionTask, CompositionTaskRun } from "@codework/contracts";

import type { CompositionRunStartIntent } from "../persistence/Services/CompositionRunStartStore.ts";
import {
  makeMulticaDaemonRuntimeAdapter,
  type MulticaDaemonRuntimeAdapterOptions,
} from "./MulticaDaemonRuntimeAdapter.ts";
import type { MulticaDaemonProtocol } from "./MulticaDaemonProtocol.ts";
import type { CompositionRunStartReconcileInput } from "./CompositionRunStartLifecycle.ts";

const runtimeId = "multica:daemon-recovery:runtime-recovery";
const daemonRuntimeId = "runtime-recovery";

type Intent = {
  readonly runId: string;
  readonly taskId: string;
  readonly runtimeId: string;
  readonly idempotencyKey: string;
  readonly state: "prepared" | "sending" | "accepted";
  readonly remoteTaskId?: string;
  readonly createdAtUnixMs: number;
  readonly updatedAtUnixMs: number;
};

const makeLedger = () => {
  const intents = new Map<string, Intent>();
  return {
    seed: (intent: Intent) => intents.set(intent.runId, intent),
    createMulticaQuickCreateIntent: (intent: Omit<Intent, "state">) =>
      Effect.sync(() => {
        if (intents.has(intent.runId)) return false;
        intents.set(intent.runId, { ...intent, state: "prepared" });
        return true;
      }),
    getMulticaQuickCreateIntent: (runId: string) =>
      Effect.sync(() => {
        const intent = intents.get(runId);
        return intent === undefined ? Option.none<Intent>() : Option.some(intent);
      }),
    getMulticaQuickCreateIntentByIdempotencyKey: (scopeRuntimeId: string, key: string) =>
      Effect.sync(() => {
        const intent = [...intents.values()].find(
          (candidate) => candidate.runtimeId === scopeRuntimeId && candidate.idempotencyKey === key,
        );
        return intent === undefined ? Option.none<Intent>() : Option.some(intent);
      }),
    claimMulticaQuickCreateIntentForSend: (input: {
      readonly runId: string;
      readonly runtimeId: string;
      readonly updatedAtUnixMs: number;
    }) =>
      Effect.sync(() => {
        const intent = intents.get(input.runId);
        if (intent === undefined || intent.state !== "prepared") return Option.none<Intent>();
        const sending = { ...intent, state: "sending" as const };
        intents.set(input.runId, sending);
        return Option.some(sending);
      }),
    acceptMulticaQuickCreateIntent: (input: {
      readonly runId: string;
      readonly runtimeId: string;
      readonly remoteTaskId: string;
      readonly updatedAtUnixMs: number;
    }) =>
      Effect.sync(() => {
        const intent = intents.get(input.runId);
        if (intent === undefined || intent.state !== "sending") return Option.none<Intent>();
        const accepted = {
          ...intent,
          state: "accepted" as const,
          remoteTaskId: input.remoteTaskId,
        };
        intents.set(input.runId, accepted);
        return Option.some(accepted);
      }),
  };
};

const makeProtocol = (
  status: "online" | "offline" = "online",
  onQuickCreate?: () => void,
): MulticaDaemonProtocol => ({
  register: () => Effect.die("恢复核对不应注册 daemon"),
  heartbeat: () =>
    Effect.succeed({
      runtimeId: daemonRuntimeId,
      status,
      serverCapabilities: ["rpc-v1"],
      runtimeGone: status === "offline",
    }),
  claimTask: () => Effect.die("恢复核对不应领取任务"),
  startTask: () => Effect.die("恢复核对不应启动任务"),
  reportProgress: () => Effect.die("恢复核对不应写进度"),
  completeTask: () => Effect.die("恢复核对不应完成任务"),
  failTask: () => Effect.die("恢复核对不应失败任务"),
  acknowledgeCancellation: () => Effect.die("恢复核对不应确认取消"),
  getTaskStatus: () => Effect.die("恢复核对不应猜测远端任务"),
  quickCreateTask: () => {
    onQuickCreate?.();
    return Effect.die("恢复核对不应发送 quick-create POST");
  },
});

const makeOptions = (
  ledger: ReturnType<typeof makeLedger>,
  protocol: MulticaDaemonProtocol,
): MulticaDaemonRuntimeAdapterOptions => ({
  runtimeId,
  daemonId: "daemon-recovery",
  daemonRuntimeId,
  baseUrl: "https://multica.example.invalid",
  protocol,
  quickCreateIntentStore: ledger,
  taskAssigneeRoutes: [
    {
      codeworkAgentId: "multica-agent-recovery",
      workspaceId: "workspace-recovery",
      multicaAgentId: "remote-agent-recovery",
    },
  ],
  agents: [
    {
      agentId: "multica-agent-recovery",
      runtimeId,
      status: "online",
      capabilities: ["rpc-v1"],
    },
  ],
});

const makeInput = (suffix: string): CompositionRunStartReconcileInput => {
  const task: CompositionTask = {
    taskId: `task-${suffix}`,
    projectId: "project-multica-recovery",
    assigneeKind: "agent" as const,
    assigneeId: "multica-agent-recovery",
    mode: "serial" as const,
    status: "queued" as const,
    promptDigest: `sha256:prompt-${suffix}`,
    dependsOnTaskIds: [],
    createdAtUnixMs: 1,
    updatedAtUnixMs: 1,
  };
  const run: CompositionTaskRun = {
    runId: `run-${suffix}`,
    taskId: task.taskId,
    agentId: task.assigneeId,
    runtimeId,
    status: "queued" as const,
    attempt: 1,
    capabilityGrantIds: [],
  };
  const intent: CompositionRunStartIntent = {
    taskId: task.taskId,
    runId: run.runId,
    previousRunId: null,
    agentId: run.agentId,
    runtimeId,
    attempt: run.attempt,
    payloadDigest: `sha256:payload-${suffix}`,
    capabilityDigest: `sha256:capability-${suffix}`,
    state: "dispatching",
    revision: 2,
    claimId: `claim-${suffix}`,
    ownerEpoch: 1,
    ownerLeaseExpiresAtUnixMs: 60_000,
    runtimeTaskId: null,
    capabilityHandshakeId: null,
    outcomeCode: null,
    outcomeDetail: null,
    createdAtUnixMs: 1,
    updatedAtUnixMs: 2,
  };
  return {
    task,
    run,
    intent,
    capabilityIds: [],
  };
};

const seed = (
  ledger: ReturnType<typeof makeLedger>,
  input: ReturnType<typeof makeInput>,
  state: Intent["state"],
  remoteTaskId?: string,
) =>
  ledger.seed({
    runId: input.run.runId,
    taskId: input.task.taskId,
    runtimeId,
    idempotencyKey: input.run.runId,
    state,
    ...(remoteTaskId === undefined ? {} : { remoteTaskId }),
    createdAtUnixMs: 1,
    updatedAtUnixMs: 2,
  });

it.effect("Multica 按 quick-create 持久账本规划 replay、manual 与 accepted，且不发送 POST", () =>
  Effect.gen(function* () {
    const ledger = makeLedger();
    let quickCreateCalls = 0;
    const adapter = makeMulticaDaemonRuntimeAdapter(
      makeOptions(
        ledger,
        makeProtocol("online", () => {
          quickCreateCalls += 1;
        }),
      ),
    );
    expect(adapter.startRecoveryPolicy).toEqual({
      mode: "idempotent-replay",
      requiredReceipt: "runtime-task",
      capabilityGrantReplay: { mode: "verified" },
    });
    if (adapter.reconcileStart === undefined) {
      return yield* Effect.die("Multica Adapter 必须提供 reconcileStart。");
    }

    const missing = makeInput("missing");
    const prepared = makeInput("prepared");
    const sending = makeInput("sending");
    const accepted = makeInput("accepted");
    seed(ledger, prepared, "prepared");
    seed(ledger, sending, "sending");
    seed(ledger, accepted, "accepted", "multica-remote-accepted");

    expect(yield* adapter.reconcileStart(missing)).toEqual({ action: "replay" });
    expect(yield* adapter.reconcileStart(prepared)).toEqual({ action: "replay" });
    expect(yield* adapter.reconcileStart(sending)).toMatchObject({
      action: "manual",
      code: "run_start_multica_quick_create_result_unknown",
    });
    expect(yield* adapter.reconcileStart(accepted)).toEqual({
      action: "accepted",
      runtimeTaskId: "multica-remote-accepted",
    });
    expect(quickCreateCalls).toBe(0);
  }),
);

it.effect("Multica Runtime 离线时延后恢复，不读取为可重放结论", () =>
  Effect.gen(function* () {
    const adapter = makeMulticaDaemonRuntimeAdapter(
      makeOptions(makeLedger(), makeProtocol("offline")),
    );
    if (adapter.reconcileStart === undefined) {
      return yield* Effect.die("Multica Adapter 必须提供 reconcileStart。");
    }

    expect(yield* adapter.reconcileStart(makeInput("offline"))).toEqual({
      action: "defer",
      code: "run_start_multica_runtime_offline",
      detail: "Multica Runtime 当前离线，Run Start 恢复已延后。",
    });
  }),
);

it.effect("Multica quick-create 账本归属冲突时 quarantine，且不发送 POST", () =>
  Effect.gen(function* () {
    const ledger = makeLedger();
    const input = makeInput("conflict");
    ledger.seed({
      runId: input.run.runId,
      taskId: "task-owned-by-another-run",
      runtimeId,
      idempotencyKey: input.run.runId,
      state: "prepared",
      createdAtUnixMs: 1,
      updatedAtUnixMs: 2,
    });
    let quickCreateCalls = 0;
    const adapter = makeMulticaDaemonRuntimeAdapter(
      makeOptions(
        ledger,
        makeProtocol("online", () => {
          quickCreateCalls += 1;
        }),
      ),
    );
    if (adapter.reconcileStart === undefined) {
      return yield* Effect.die("Multica Adapter 必须提供 reconcileStart。");
    }

    expect(yield* adapter.reconcileStart(input)).toEqual({
      action: "quarantine",
      code: "run_start_multica_quick_create_intent_conflict",
      detail: "Multica quick-create intent 与当前 Task/Run/Runtime 归属不一致，已阻止恢复。",
    });
    expect(quickCreateCalls).toBe(0);
  }),
);
