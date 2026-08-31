import type {
  CompositionRuntimeCapabilityHandshakeRequest,
  CompositionRuntimeCapabilityHandshakeResult,
  CompositionRuntimeDriverKind,
  CompositionRuntimeProbeResult,
  ProviderRuntimeEvent,
  ThreadId,
} from "@codework/contracts";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type {
  CompositionRunStartExternalTargetIdentity,
  CompositionRunStartReconcileDecision,
  CompositionRunStartReconcileInput,
  CompositionRunStartRecoveryPolicy,
} from "./CompositionRunStartLifecycle.ts";

export class CompositionRuntimeAdapterFailure extends Schema.TaggedErrorClass<CompositionRuntimeAdapterFailure>()(
  "CompositionRuntimeAdapterFailure",
  {
    runtimeId: Schema.String,
    code: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Runtime Adapter 操作失败（${this.runtimeId}）：${this.code}: ${this.detail}`;
  }
}

export type CompositionRuntimeAgent = {
  readonly agentId: string;
  readonly runtimeId: string;
  readonly displayName?: string;
  readonly version?: string;
  readonly status: "online" | "offline" | "unstable";
  readonly capabilities: ReadonlyArray<string>;
};

export type CompositionRuntimeHeartbeat = {
  readonly runtimeId: string;
  readonly status: "online" | "offline" | "unstable";
  readonly heartbeatAtUnixMs: number;
  readonly activeTaskCount: number;
};

export type CompositionRuntimeTaskInput = {
  readonly taskId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly projectId?: string;
  readonly parentTaskId?: string;
  readonly dependsOnTaskIds?: ReadonlyArray<string>;
  readonly mode?: "serial" | "parallel" | "review";
  readonly assigneeKind?: "agent" | "squad";
  readonly assigneeId?: string;
  readonly workspaceRootDigest?: string;
  readonly workspaceRoot?: string;
  readonly prompt?: string;
  readonly promptDigest?: string;
  readonly model?: string;
  readonly capabilityGrantIds?: ReadonlyArray<string>;
  /** 带 grant 的 dispatch 必须引用同一次 accepted handshake。 */
  readonly capabilityHandshakeId?: string;
  /** 同一 run 的重试必须复用这个幂等键。 */
  readonly idempotencyKey: string;
};

export type CompositionRuntimeTaskRef = {
  readonly taskId: string;
  readonly runId: string;
  readonly runtimeTaskId?: string;
};

export type CompositionRuntimeTaskResult = {
  readonly runtimeTaskId: string;
  readonly status: "accepted" | "already_running" | "already_terminal";
};

export type CompositionRuntimeCancelResult = {
  readonly runtimeTaskId?: string;
  readonly status: "cancelled" | "cancel_requested" | "already_terminal";
};

export type CompositionRuntimeEventFilter = {
  readonly eventIds?: ReadonlyArray<string>;
  readonly threadId?: ThreadId;
  readonly runtimeTaskId?: string;
};

export interface CompositionRuntimeAdapter {
  readonly runtimeId: string;
  readonly driverKind: CompositionRuntimeDriverKind;
  readonly startRecoveryPolicy?: CompositionRunStartRecoveryPolicy;
  /** 只有 Adapter 能给出稳定外部目标身份时，通用 Driver 才允许自动跨进程恢复。 */
  readonly getStartIdentity?: (input: {
    readonly model?: string;
  }) => CompositionRunStartExternalTargetIdentity;
  readonly reconcileStart?: (
    input: CompositionRunStartReconcileInput,
  ) => Effect.Effect<CompositionRunStartReconcileDecision, CompositionRuntimeAdapterFailure>;
  readonly probe: () => Effect.Effect<
    CompositionRuntimeProbeResult,
    CompositionRuntimeAdapterFailure
  >;
  readonly listAgents: () => Effect.Effect<
    ReadonlyArray<CompositionRuntimeAgent>,
    CompositionRuntimeAdapterFailure
  >;
  readonly heartbeat: () => Effect.Effect<
    CompositionRuntimeHeartbeat,
    CompositionRuntimeAdapterFailure
  >;
  readonly handshakeCapabilities?: (
    input: CompositionRuntimeCapabilityHandshakeRequest,
  ) => Effect.Effect<CompositionRuntimeCapabilityHandshakeResult, CompositionRuntimeAdapterFailure>;
  readonly revokeCapabilityHandshake?: (input: {
    readonly handshakeId: string;
  }) => Effect.Effect<void, CompositionRuntimeAdapterFailure>;
  readonly dispatchTask: (
    input: CompositionRuntimeTaskInput,
  ) => Effect.Effect<CompositionRuntimeTaskResult, CompositionRuntimeAdapterFailure>;
  readonly cancelTask: (
    input: CompositionRuntimeTaskRef,
  ) => Effect.Effect<CompositionRuntimeCancelResult, CompositionRuntimeAdapterFailure>;
  readonly resumeTask: (
    input: CompositionRuntimeTaskRef,
  ) => Effect.Effect<CompositionRuntimeTaskResult, CompositionRuntimeAdapterFailure>;
  readonly streamEvents: (
    input?: CompositionRuntimeEventFilter,
  ) => Stream.Stream<ProviderRuntimeEvent, CompositionRuntimeAdapterFailure>;
}

const nonEmpty = (value: string | undefined): value is string =>
  value !== undefined && value.trim().length > 0;

const error = (runtimeId: string, code: string, detail: string) =>
  new CompositionRuntimeAdapterFailure({ runtimeId, code, detail });

const taskKey = (taskId: string, runId: string): string => `${taskId}\u0000${runId}`;

const isTerminalTaskStatus = (
  status: InMemoryRuntimeTask["status"],
): status is "completed" | "failed" | "cancelled" =>
  status === "completed" || status === "failed" || status === "cancelled";

type InMemoryRuntimeTask = {
  readonly input: CompositionRuntimeTaskInput;
  readonly runtimeTaskId: string;
  status: "running" | "completed" | "failed" | "cancelled";
};

type InMemoryCompositionRuntimeAdapterOptions = {
  readonly runtimeId: string;
  readonly driverKind?: CompositionRuntimeDriverKind;
  readonly version?: string;
  readonly capabilities?: ReadonlyArray<string>;
  readonly supportedModels?: ReadonlyArray<string>;
  readonly supportsResume?: boolean;
  readonly supportsMcp?: boolean;
  readonly agents?: ReadonlyArray<CompositionRuntimeAgent>;
  readonly now?: () => number;
};

export type InMemoryCompositionRuntimeAdapter = CompositionRuntimeAdapter & {
  readonly emitEvent: (
    event: ProviderRuntimeEvent,
  ) => Effect.Effect<void, CompositionRuntimeAdapterFailure>;
  readonly setProbeStatus: (status: CompositionRuntimeProbeResult["status"]) => Effect.Effect<void>;
  readonly setTaskStatus: (
    input: CompositionRuntimeTaskRef & {
      readonly status: InMemoryRuntimeTask["status"];
    },
  ) => Effect.Effect<void, CompositionRuntimeAdapterFailure>;
};

const getRecordString = (value: unknown, key: string): string | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : undefined;
};

const matchesEvent = (
  event: ProviderRuntimeEvent,
  filter: CompositionRuntimeEventFilter | undefined,
): boolean => {
  if (filter === undefined) return true;
  if (filter.eventIds !== undefined && !filter.eventIds.includes(event.eventId)) return false;
  if (filter.threadId !== undefined && filter.threadId !== event.threadId) return false;
  if (
    filter.runtimeTaskId !== undefined &&
    filter.runtimeTaskId !== getRecordString(event.payload, "taskId") &&
    filter.runtimeTaskId !== getRecordString(event.payload, "runtimeTaskId")
  ) {
    return false;
  }
  return true;
};

export const makeInMemoryCompositionRuntimeAdapter = (
  options: InMemoryCompositionRuntimeAdapterOptions,
): InMemoryCompositionRuntimeAdapter => {
  const runtimeId = options.runtimeId.trim();
  if (!nonEmpty(runtimeId)) {
    throw new Error("runtimeId 不能为空。");
  }

  const driverKind = options.driverKind ?? "multica";
  const version = options.version;
  const capabilities = [...(options.capabilities ?? [])];
  const supportedModels =
    options.supportedModels === undefined ? undefined : [...options.supportedModels];
  const supportsResume = options.supportsResume ?? false;
  const supportsMcp = options.supportsMcp ?? false;
  const now = options.now ?? Date.now;
  const events = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
  const tasks = new Map<string, InMemoryRuntimeTask>();
  const capabilityHandshakes = new Map<string, CompositionRuntimeCapabilityHandshakeRequest>();
  let probeStatus: CompositionRuntimeProbeResult["status"] = "online";
  const agents = [
    ...(options.agents ?? [
      {
        agentId: `${runtimeId}:agent`,
        runtimeId,
        status: "online" as const,
        capabilities,
        ...(version === undefined ? {} : { version }),
      },
    ]),
  ];

  const requireId = (value: string | undefined, name: string) =>
    nonEmpty(value)
      ? Effect.succeed(value.trim())
      : Effect.fail(error(runtimeId, "invalid_input", `${name} 不能为空。`));

  const probe: CompositionRuntimeAdapter["probe"] = () =>
    Effect.succeed({
      runtimeId,
      driverKind,
      status: probeStatus,
      ...(version === undefined ? {} : { version }),
      capabilities: [...capabilities],
      ...(supportedModels === undefined ? {} : { supportedModels: [...supportedModels] }),
      supportsResume,
      supportsMcp,
      ...(probeStatus === "online" ? {} : { reasonCode: `runtime_${probeStatus}` }),
    });

  const listAgents: CompositionRuntimeAdapter["listAgents"] = () =>
    Effect.succeed(agents.map((agent) => ({ ...agent, capabilities: [...agent.capabilities] })));

  const heartbeat: CompositionRuntimeAdapter["heartbeat"] = () =>
    Effect.succeed({
      runtimeId,
      status: probeStatus,
      heartbeatAtUnixMs: now(),
      activeTaskCount: [...tasks.values()].filter((task) => task.status === "running").length,
    });

  const handshakeCapabilities: NonNullable<CompositionRuntimeAdapter["handshakeCapabilities"]> = (
    input,
  ) =>
    Effect.gen(function* () {
      const taskId = yield* requireId(input.taskId, "taskId");
      const runId = yield* requireId(input.runId, "runId");
      const agentId = yield* requireId(input.agentId, "agentId");
      const grantIds = [
        ...new Set(input.capabilityGrantIds.map((grantId) => grantId.trim())),
      ].filter(Boolean);
      if (grantIds.length === 0) {
        return yield* error(runtimeId, "invalid_input", "capabilityGrantIds 不能为空。");
      }
      const handshakeId = `handshake:${runtimeId}:${taskId}:${runId}:${grantIds.join(",")}`;
      const request = {
        runtimeId,
        taskId,
        runId,
        agentId,
        capabilityGrantIds: grantIds,
      } satisfies CompositionRuntimeCapabilityHandshakeRequest;
      capabilityHandshakes.set(handshakeId, request);
      return {
        ...request,
        status: "accepted" as const,
        handshakeId,
        acceptedGrantIds: grantIds,
      } satisfies CompositionRuntimeCapabilityHandshakeResult;
    });

  const verifyCapabilityHandshake = (input: CompositionRuntimeTaskInput) => {
    const grantIds = [
      ...new Set((input.capabilityGrantIds ?? []).map((grantId) => grantId.trim())),
    ].filter(Boolean);
    if (grantIds.length === 0) return Effect.void;
    if (input.capabilityHandshakeId === undefined) {
      return Effect.fail(
        error(
          runtimeId,
          "capability_handshake_required",
          "带 capability grant 的派发必须先完成握手。",
        ),
      );
    }
    const handshake = capabilityHandshakes.get(input.capabilityHandshakeId);
    if (
      handshake === undefined ||
      handshake.taskId !== input.taskId ||
      handshake.runId !== input.runId ||
      handshake.agentId !== input.agentId ||
      handshake.capabilityGrantIds.join("\u0000") !== grantIds.join("\u0000")
    ) {
      return Effect.fail(
        error(
          runtimeId,
          "capability_handshake_mismatch",
          "派发引用的 capability handshake 与 task/run 不匹配。",
        ),
      );
    }
    return Effect.void;
  };

  const revokeCapabilityHandshake: NonNullable<
    CompositionRuntimeAdapter["revokeCapabilityHandshake"]
  > = (input) =>
    Effect.gen(function* () {
      const handshakeId = yield* requireId(input.handshakeId, "handshakeId");
      capabilityHandshakes.delete(handshakeId);
    });

  const dispatchTask: CompositionRuntimeAdapter["dispatchTask"] = (input) =>
    Effect.gen(function* () {
      const taskId = yield* requireId(input.taskId, "taskId");
      const runId = yield* requireId(input.runId, "runId");
      yield* requireId(input.agentId, "agentId");
      yield* requireId(input.idempotencyKey, "idempotencyKey");
      yield* verifyCapabilityHandshake(input);
      if (probeStatus === "offline") {
        return yield* error(runtimeId, "runtime_offline", "Runtime 当前离线。");
      }
      const key = taskKey(taskId, runId);
      const existing = tasks.get(key);
      if (existing !== undefined) {
        return {
          runtimeTaskId: existing.runtimeTaskId,
          status: isTerminalTaskStatus(existing.status) ? "already_terminal" : "already_running",
        };
      }
      const runtimeTaskId = `${runtimeId}:task:${taskId}:${runId}`;
      tasks.set(key, { input: { ...input, taskId, runId }, runtimeTaskId, status: "running" });
      return { runtimeTaskId, status: "accepted" as const };
    });

  const findTask = (input: CompositionRuntimeTaskRef): InMemoryRuntimeTask | undefined =>
    tasks.get(taskKey(input.taskId, input.runId));

  const cancelTask: CompositionRuntimeAdapter["cancelTask"] = (input) =>
    Effect.gen(function* () {
      yield* requireId(input.taskId, "taskId");
      yield* requireId(input.runId, "runId");
      const task = findTask(input);
      if (task === undefined) {
        return yield* error(runtimeId, "task_not_found", "Runtime Task 不存在。");
      }
      if (isTerminalTaskStatus(task.status)) {
        return { runtimeTaskId: task.runtimeTaskId, status: "already_terminal" as const };
      }
      task.status = "cancelled";
      return { runtimeTaskId: task.runtimeTaskId, status: "cancelled" as const };
    });

  const resumeTask: CompositionRuntimeAdapter["resumeTask"] = (input) =>
    Effect.gen(function* () {
      yield* requireId(input.taskId, "taskId");
      yield* requireId(input.runId, "runId");
      if (!supportsResume) {
        return yield* error(runtimeId, "resume_not_supported", "Runtime 不支持恢复任务。");
      }
      const task = findTask(input);
      if (task === undefined) {
        return yield* error(runtimeId, "task_not_found", "Runtime Task 不存在。");
      }
      if (isTerminalTaskStatus(task.status)) {
        return { runtimeTaskId: task.runtimeTaskId, status: "already_terminal" as const };
      }
      task.status = "running";
      return { runtimeTaskId: task.runtimeTaskId, status: "accepted" as const };
    });

  const streamEvents: CompositionRuntimeAdapter["streamEvents"] = (filter) =>
    Stream.fromPubSub(events).pipe(Stream.filter((event) => matchesEvent(event, filter)));

  const emitEvent: InMemoryCompositionRuntimeAdapter["emitEvent"] = (event) =>
    PubSub.publish(events, event).pipe(
      Effect.mapError((cause) => error(runtimeId, "event_publish_failed", String(cause))),
      Effect.asVoid,
    );

  const setProbeStatus: InMemoryCompositionRuntimeAdapter["setProbeStatus"] = (status) =>
    Effect.sync(() => {
      probeStatus = status;
    });

  const setTaskStatus: InMemoryCompositionRuntimeAdapter["setTaskStatus"] = (input) =>
    Effect.gen(function* () {
      const task = findTask(input);
      if (task === undefined) {
        return yield* error(runtimeId, "task_not_found", "Runtime Task 不存在。");
      }
      task.status = input.status;
    });

  return {
    runtimeId,
    driverKind,
    startRecoveryPolicy: {
      mode: "manual",
      requiredReceipt: "runtime-task",
      capabilityGrantReplay: { mode: "verified" },
    },
    probe,
    listAgents,
    heartbeat,
    handshakeCapabilities,
    revokeCapabilityHandshake,
    dispatchTask,
    cancelTask,
    resumeTask,
    streamEvents,
    emitEvent,
    setProbeStatus,
    setTaskStatus,
  };
};
