import * as NodeCrypto from "node:crypto";

import type {
  CompositionRuntimeCapabilityHandshakeRequest,
  CompositionRuntimeCapabilityHandshakeResult,
  CompositionMulticaProbeResult,
  CompositionRuntimeProbeResult,
  ProviderRuntimeEvent,
} from "@codework/contracts";
import { EventId, ProviderDriverKind, RuntimeTaskId, ThreadId } from "@codework/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";

import {
  CompositionRuntimeAdapterFailure,
  type CompositionRuntimeAdapter,
  type CompositionRuntimeAgent,
  type CompositionRuntimeCancelResult,
  type CompositionRuntimeEventFilter,
  type CompositionRuntimeHeartbeat,
  type CompositionRuntimeTaskInput,
  type CompositionRuntimeTaskRef,
  type CompositionRuntimeTaskResult,
} from "./CompositionRuntimeAdapter.ts";
import {
  encodeMulticaWebSocketFrame,
  type MulticaDaemonProtocol,
  type MulticaDaemonProtocolFailure,
  type MulticaHeartbeatResponse,
  type MulticaTask,
  type MulticaTaskCancelAckInput,
  type MulticaTaskCompleteInput,
  type MulticaTaskFailInput,
  type MulticaTaskProgressInput,
  type MulticaWebSocketFrame,
} from "./MulticaDaemonProtocol.ts";
import type { MulticaTaskMcpLease } from "./MulticaTaskMcpLease.ts";
import type { CompositionTaskStoreShape } from "../persistence/Services/CompositionTaskStore.ts";

export type MulticaDaemonStreamFramesInput = {
  readonly runtimeId: string;
  readonly daemonRuntimeId: string;
  readonly runtimeTaskId?: string;
};

export type MulticaDaemonStreamFrames = (
  input: MulticaDaemonStreamFramesInput,
) => Stream.Stream<MulticaWebSocketFrame, MulticaDaemonProtocolFailure>;

export type MulticaDaemonControlFrameHandler = (
  frame: MulticaWebSocketFrame,
) => Effect.Effect<void, CompositionRuntimeAdapterFailure>;

/** Code Work assignee 到 Multica 工作区和远端 Agent/Squad UUID 的显式映射。 */
export type MulticaTaskAssigneeRoute = {
  readonly codeworkAgentId: string;
  readonly codeworkSquadId?: string;
  readonly workspaceId: string;
  readonly multicaAgentId?: string;
  readonly multicaSquadId?: string;
};

export type MulticaDaemonRuntimeAdapterOptions = {
  /** Code Work 侧稳定 Runtime ID，建议使用 multica:<daemonId>:<runtimeId>。 */
  readonly runtimeId: string;
  readonly daemonId: string;
  /** Multica 服务端 agent_runtime 的真实 ID。 */
  readonly daemonRuntimeId: string;
  readonly baseUrl: string;
  readonly protocol: MulticaDaemonProtocol;
  /**
   * quick-create 不提供远端幂等键时的本地发送账本。缺失时必须拒绝派发，不能退回不安全的直接 POST。
   */
  readonly quickCreateIntentStore?: Pick<
    CompositionTaskStoreShape,
    | "createMulticaQuickCreateIntent"
    | "getMulticaQuickCreateIntent"
    | "getMulticaQuickCreateIntentByIdempotencyKey"
    | "claimMulticaQuickCreateIntentForSend"
    | "acceptMulticaQuickCreateIntent"
  >;
  readonly agents: ReadonlyArray<CompositionRuntimeAgent>;
  readonly taskAssigneeRoutes?: ReadonlyArray<MulticaTaskAssigneeRoute>;
  readonly version?: string;
  readonly capabilities?: ReadonlyArray<string>;
  readonly supportedModels?: ReadonlyArray<string>;
  readonly supportsResume?: boolean;
  readonly supportsMcp?: boolean;
  readonly supportsSquad?: boolean | undefined;
  readonly supportsLeader?: boolean | undefined;
  readonly supportsTaskGraph?: boolean | undefined;
  /** F2 每 Run MCP Lease 的读取与 Runtime 回收合同。 */
  readonly taskMcpLeaseBridge?: {
    readonly get: (capabilityHandshakeId: string) => Effect.Effect<MulticaTaskMcpLease | undefined>;
    readonly revokeRuntime: (runtimeId: string) => Effect.Effect<void>;
  };
  /**
   * F2 daemon extension：在 claim 后、向 Multica 标记 running 前注入当前 Run 的能力配置。
   * 该扩展是唯一允许接触 task-local MCP overlay 的执行边界。
   */
  readonly taskExecutionBridge?: MulticaDaemonTaskExecutionBridge;
  /** 官方窄协议之外的 Code Work 扩展；未提供时保持 capability handshake 拒绝。 */
  readonly capabilityBridge?: {
    readonly handshakeCapabilities: (
      input: CompositionRuntimeCapabilityHandshakeRequest,
    ) => Effect.Effect<
      CompositionRuntimeCapabilityHandshakeResult,
      CompositionRuntimeAdapterFailure
    >;
    readonly revokeCapabilityHandshake?: (input: {
      readonly handshakeId: string;
    }) => Effect.Effect<void, CompositionRuntimeAdapterFailure>;
  };
  readonly now?: () => number;
  /** 普通 /ws 任务事件流。 */
  readonly streamFrames?: MulticaDaemonStreamFrames;
  /** 独立 /api/daemon/ws 控制流；不得与普通任务事件混用。 */
  readonly controlFrames?: MulticaDaemonStreamFrames;
  /** 处理 task_available 等可丢失 hint，不得把 hint 当作任务终态。 */
  readonly onControlFrame?: MulticaDaemonControlFrameHandler;
};

export type MulticaDaemonRuntimeAdapter = CompositionRuntimeAdapter & {
  readonly daemonId: string;
  readonly daemonRuntimeId: string;
  readonly claimTask: () => Effect.Effect<MulticaTask | null, CompositionRuntimeAdapterFailure>;
  readonly startTask: (
    runtimeTaskId: string,
  ) => Effect.Effect<void, CompositionRuntimeAdapterFailure>;
  readonly reportProgress: (
    runtimeTaskId: string,
    input: MulticaTaskProgressInput,
  ) => Effect.Effect<void, CompositionRuntimeAdapterFailure>;
  readonly completeTask: (
    runtimeTaskId: string,
    input: MulticaTaskCompleteInput,
  ) => Effect.Effect<void, CompositionRuntimeAdapterFailure>;
  readonly failTask: (
    runtimeTaskId: string,
    input: MulticaTaskFailInput,
  ) => Effect.Effect<void, CompositionRuntimeAdapterFailure>;
  readonly acknowledgeCancellation: (
    runtimeTaskId: string,
    input: MulticaTaskCancelAckInput,
  ) => Effect.Effect<void, CompositionRuntimeAdapterFailure>;
  readonly probeMultica: () => Effect.Effect<
    CompositionMulticaProbeResult,
    CompositionRuntimeAdapterFailure
  >;
  /** claim/start 注入层读取 Lease；原始 token 不进入 Composition 合同。 */
  readonly getTaskMcpLease: (
    capabilityHandshakeId: string,
  ) => Effect.Effect<MulticaTaskMcpLease | undefined>;
  readonly revokeTaskMcpLeases: () => Effect.Effect<void>;
};

export type MulticaTaskExecutionBinding = {
  readonly taskId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly capabilityGrantIds: ReadonlyArray<string>;
  readonly capabilityHandshakeId?: string;
};

export type MulticaDaemonTaskExecutionContext = MulticaTaskExecutionBinding & {
  readonly runtimeId: string;
  readonly daemonId: string;
  readonly daemonRuntimeId: string;
  readonly runtimeTaskId: string;
  readonly task: MulticaTask;
  /** 只在注入回调的进程内存在，不得写入日志、设置或审计正文。 */
  readonly mcpConfig?: MulticaTaskMcpLease["mcpConfig"];
};

export type MulticaDaemonTaskExecutionBridge = {
  /** 外部 claim 的任务没有 Code Work 派发映射时，由扩展显式解析绑定；返回 undefined 必须拒绝 start。 */
  readonly resolveBinding?: (input: {
    readonly runtimeId: string;
    readonly daemonRuntimeId: string;
    readonly task: MulticaTask;
  }) => Effect.Effect<MulticaTaskExecutionBinding | undefined, CompositionRuntimeAdapterFailure>;
  /** 在调用 Multica startTask 前，把已校验的 task-local MCP overlay 注入实际执行器。 */
  readonly injectTaskStart: (
    context: MulticaDaemonTaskExecutionContext,
  ) => Effect.Effect<void, CompositionRuntimeAdapterFailure>;
};

const nonEmpty = (value: string, field: string): string => {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${field} 不能为空。`);
  return trimmed;
};

const adapterFailure = (runtimeId: string, code: string, detail: string) =>
  new CompositionRuntimeAdapterFailure({ runtimeId, code, detail });

const mapProtocolFailure = (
  runtimeId: string,
  failure: MulticaDaemonProtocolFailure,
): CompositionRuntimeAdapterFailure => {
  const code =
    failure.status === 404
      ? "task_not_found"
      : failure.code === "invalid_response"
        ? "protocol_invalid"
        : failure.code;
  return adapterFailure(runtimeId, code, failure.detail);
};

const mapQuickCreatePersistenceFailure = (
  runtimeId: string,
  cause: unknown,
): CompositionRuntimeAdapterFailure =>
  adapterFailure(
    runtimeId,
    "quick_create_persistence_failed",
    cause instanceof Error ? cause.message : "quick-create 本地发送账本操作失败。",
  );

const mapRuntimeStatus = (
  response: Pick<MulticaHeartbeatResponse, "status" | "runtimeGone">,
): CompositionRuntimeProbeResult["status"] => {
  if (response.runtimeGone) return "offline";
  switch (response.status) {
    case "ok":
    case "online":
    case "ready":
    case "running":
      return "online";
    case "degraded":
    case "unstable":
      return "unstable";
    default:
      return "offline";
  }
};

const unique = (values: ReadonlyArray<string>): ReadonlyArray<string> =>
  Array.from(new Set(values.filter((value) => value.trim().length > 0)));

const hasCapability = (
  capabilities: ReadonlyArray<string>,
  aliases: ReadonlyArray<string>,
): boolean => {
  const available = new Set(capabilities.map((capability) => capability.trim().toLowerCase()));
  return aliases.some((alias) => available.has(alias));
};

const sameStringSet = (left: readonly string[], right: readonly string[]): boolean => {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size && [...leftSet].every((value) => rightSet.has(value));
};

const hasDuplicate = (values: readonly string[]): boolean => new Set(values).size !== values.length;

const recordString = (value: unknown, key: string): string | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  if (typeof candidate !== "string") return undefined;
  const trimmed = candidate.trim();
  return trimmed.length === 0 ? undefined : trimmed;
};

const taskIdFromPayload = (payload: unknown): string | undefined =>
  recordString(payload, "task_id") ??
  recordString(payload, "taskId") ??
  recordString(payload, "id");

const summaryFromPayload = (payload: unknown, fallback: string): string =>
  recordString(payload, "summary") ??
  recordString(payload, "description") ??
  recordString(payload, "content") ??
  recordString(payload, "output") ??
  recordString(payload, "error") ??
  recordString(payload, "tool") ??
  recordString(payload, "type") ??
  fallback;

const intFromPayload = (payload: unknown, key: string): number | undefined => {
  if (typeof payload !== "object" || payload === null) return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
};

const unknownFromPayload = (payload: unknown, key: string): unknown => {
  if (typeof payload !== "object" || payload === null) return undefined;
  return (payload as Record<string, unknown>)[key];
};

const eventIdForFrame = (frame: MulticaWebSocketFrame): EventId => {
  // 官方 realtime relay 将 event_id 放在 WebSocket 顶层；payload 里的同名
  // 字段只作为兼容旧 fixture 的降级来源，不能覆盖顶层权威 ID。
  const explicit =
    frame.eventId ??
    recordString(frame.payload, "event_id") ??
    recordString(frame.payload, "eventId");
  if (explicit !== undefined) return EventId.make(explicit);
  const digest = NodeCrypto.createHash("sha256")
    .update(encodeMulticaWebSocketFrame(frame))
    .digest("hex");
  return EventId.make(`multica:${digest}`);
};

const createdAtForFrame = (frame: MulticaWebSocketFrame, now: () => number): string =>
  recordString(frame.payload, "created_at") ?? DateTime.formatIso(DateTime.makeUnsafe(now()));

const baseEventFor = (frame: MulticaWebSocketFrame, runtimeId: string, now: () => number) => ({
  eventId: eventIdForFrame(frame),
  provider: ProviderDriverKind.make("multica"),
  threadId: ThreadId.make(runtimeId),
  createdAt: createdAtForFrame(frame, now),
  raw: {
    source: "multica.task-event" as const,
    messageType: frame.type,
    // 这是 Code Work correlation metadata，用于 Driver 注销后的持久化归属恢复，
    // 不把它伪装成 Multica 官方 payload 字段。
    runtimeId,
    ...(taskIdFromPayload(frame.payload) === undefined
      ? {}
      : { runtimeTaskId: RuntimeTaskId.make(taskIdFromPayload(frame.payload)!) }),
    payload: frame.payload,
  },
});

const providerEventFromFrame = (
  frame: MulticaWebSocketFrame,
  runtimeId: string,
  now: () => number,
): ProviderRuntimeEvent | undefined => {
  const taskId = taskIdFromPayload(frame.payload);
  if (taskId === undefined) return undefined;
  const base = baseEventFor(frame, runtimeId, now);
  const runtimeTaskId = RuntimeTaskId.make(taskId);
  const summary = summaryFromPayload(frame.payload, "Multica 任务状态已更新");

  switch (frame.type) {
    case "daemon:task_available":
      return undefined;
    case "task:dispatch":
    case "task:running":
      return {
        ...base,
        type: "task.started",
        payload: { taskId: runtimeTaskId, description: summary },
      } satisfies Extract<ProviderRuntimeEvent, { type: "task.started" }>;
    case "task:progress":
      return {
        ...base,
        type: "task.progress",
        payload: {
          taskId: runtimeTaskId,
          description: summary,
          summary,
          status: "running",
          ...(intFromPayload(frame.payload, "step") === undefined
            ? {}
            : { step: intFromPayload(frame.payload, "step") }),
          ...(intFromPayload(frame.payload, "total") === undefined
            ? {}
            : { total: intFromPayload(frame.payload, "total") }),
        },
      } satisfies Extract<ProviderRuntimeEvent, { type: "task.progress" }>;
    case "task:message": {
      const messageType = recordString(frame.payload, "type");
      const messageSeq = intFromPayload(frame.payload, "seq");
      const messageTool = recordString(frame.payload, "tool");
      const messageInput = unknownFromPayload(frame.payload, "input");
      const messageOutput = recordString(frame.payload, "output");
      const messageCreatedAt = recordString(frame.payload, "created_at");
      return {
        ...base,
        type: "task.progress",
        payload: {
          taskId: runtimeTaskId,
          description: summary,
          summary,
          status: "running",
          ...(messageType === undefined ? {} : { messageType }),
          ...(messageSeq === undefined ? {} : { messageSeq }),
          ...(messageTool === undefined ? {} : { messageTool }),
          ...(messageInput === undefined ? {} : { messageInput }),
          ...(messageOutput === undefined ? {} : { messageOutput }),
          ...(messageCreatedAt === undefined ? {} : { messageCreatedAt }),
        },
      } satisfies Extract<ProviderRuntimeEvent, { type: "task.progress" }>;
    }
    case "task:completed":
      return {
        ...base,
        type: "task.completed",
        payload: {
          taskId: runtimeTaskId,
          status: "completed",
          summary,
          ...(recordString(frame.payload, "output") === undefined
            ? {}
            : { output: recordString(frame.payload, "output") }),
          ...(recordString(frame.payload, "pr_url") === undefined
            ? {}
            : { prUrl: recordString(frame.payload, "pr_url") }),
        },
      } satisfies Extract<ProviderRuntimeEvent, { type: "task.completed" }>;
    case "task:failed":
      return {
        ...base,
        type: "task.completed",
        payload: {
          taskId: runtimeTaskId,
          status: "failed",
          summary,
          ...(recordString(frame.payload, "error") === undefined
            ? {}
            : { error: recordString(frame.payload, "error") }),
          ...(recordString(frame.payload, "failure_reason") === undefined
            ? {}
            : { failureReason: recordString(frame.payload, "failure_reason") }),
        },
      } satisfies Extract<ProviderRuntimeEvent, { type: "task.completed" }>;
    case "task:cancelled":
      return {
        ...base,
        type: "task.completed",
        payload: { taskId: runtimeTaskId, status: "stopped", summary },
      } satisfies Extract<ProviderRuntimeEvent, { type: "task.completed" }>;
    default:
      return undefined;
  }
};

const matchesEvent = (
  event: ProviderRuntimeEvent,
  filter: CompositionRuntimeEventFilter | undefined,
): boolean => {
  if (filter === undefined) return true;
  if (filter.eventIds !== undefined && !filter.eventIds.includes(event.eventId)) return false;
  if (filter.threadId !== undefined && filter.threadId !== event.threadId) return false;
  if (filter.runtimeTaskId !== undefined) {
    if (!("taskId" in event.payload) || event.payload.taskId !== filter.runtimeTaskId) return false;
  }
  return true;
};

const isTerminalRuntimeStatus = (status: string): boolean =>
  status === "completed" || status === "failed" || status === "cancelled" || status === "stopped";

const isControlHintFrame = (frame: MulticaWebSocketFrame): boolean =>
  frame.type === "daemon:task_available" ||
  frame.type === "daemon:pending_work" ||
  frame.type === "daemon:runtime_profiles_changed" ||
  frame.type === "daemon:workspaces_changed";

const maxClaimDrainTasks = 32;

export const makeMulticaCompositionRuntimeId = (
  daemonId: string,
  daemonRuntimeId: string,
): string =>
  `multica:${nonEmpty(daemonId, "daemonId")}:${nonEmpty(daemonRuntimeId, "daemonRuntimeId")}`;

export const makeMulticaDaemonRuntimeAdapter = (
  options: MulticaDaemonRuntimeAdapterOptions,
): MulticaDaemonRuntimeAdapter => {
  const runtimeId = nonEmpty(options.runtimeId, "runtimeId");
  const daemonId = nonEmpty(options.daemonId, "daemonId");
  const daemonRuntimeId = nonEmpty(options.daemonRuntimeId, "daemonRuntimeId");
  const baseUrl = nonEmpty(options.baseUrl, "baseUrl").replace(/\/+$/, "");
  const now = options.now ?? Date.now;
  const configuredCapabilities = [...(options.capabilities ?? [])];
  const configuredAgents = options.agents.map((agent) => {
    if (agent.runtimeId !== runtimeId) {
      throw new Error(`Agent '${agent.agentId}' 的 runtimeId 必须等于 Adapter runtimeId。`);
    }
    return { ...agent, capabilities: [...agent.capabilities] };
  });
  const taskAssigneeRoutes = new Map<string, MulticaTaskAssigneeRoute>();
  const taskSquadRoutes = new Map<string, MulticaTaskAssigneeRoute>();
  for (const route of options.taskAssigneeRoutes ?? []) {
    const codeworkAgentId = nonEmpty(route.codeworkAgentId, "taskAssigneeRoute.codeworkAgentId");
    const codeworkSquadId =
      route.codeworkSquadId === undefined
        ? undefined
        : nonEmpty(route.codeworkSquadId, "taskAssigneeRoute.codeworkSquadId");
    const workspaceId = nonEmpty(route.workspaceId, "taskAssigneeRoute.workspaceId");
    const multicaAgentId =
      route.multicaAgentId === undefined
        ? undefined
        : nonEmpty(route.multicaAgentId, "taskAssigneeRoute.multicaAgentId");
    const multicaSquadId =
      route.multicaSquadId === undefined
        ? undefined
        : nonEmpty(route.multicaSquadId, "taskAssigneeRoute.multicaSquadId");
    if ((multicaAgentId === undefined) === (multicaSquadId === undefined)) {
      throw new Error(
        `Multica assignee route '${codeworkAgentId}' 必须且只能指定 multicaAgentId 或 multicaSquadId。`,
      );
    }
    const normalizedRoute = {
      codeworkAgentId,
      ...(codeworkSquadId === undefined ? {} : { codeworkSquadId }),
      workspaceId,
      ...(multicaAgentId === undefined ? {} : { multicaAgentId }),
      ...(multicaSquadId === undefined ? {} : { multicaSquadId }),
    } satisfies MulticaTaskAssigneeRoute;
    if (codeworkSquadId !== undefined) {
      if (taskSquadRoutes.has(codeworkSquadId)) {
        throw new Error(`Multica Squad 路由 '${codeworkSquadId}' 重复。`);
      }
      taskSquadRoutes.set(codeworkSquadId, normalizedRoute);
    } else {
      if (taskAssigneeRoutes.has(codeworkAgentId)) {
        throw new Error(`Multica Agent 路由 '${codeworkAgentId}' 重复。`);
      }
      taskAssigneeRoutes.set(codeworkAgentId, normalizedRoute);
    }
  }
  const startConfigDigest = `sha256:${NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: 1,
        runtimeId,
        daemonId,
        daemonRuntimeId,
        baseUrl,
        routes: [...taskAssigneeRoutes.values(), ...taskSquadRoutes.values()].sort((left, right) =>
          `${left.codeworkSquadId ?? ""}\u0000${left.codeworkAgentId}`.localeCompare(
            `${right.codeworkSquadId ?? ""}\u0000${right.codeworkAgentId}`,
          ),
        ),
      }),
      "utf8",
    )
    .digest("hex")}`;
  const getStartIdentity: NonNullable<CompositionRuntimeAdapter["getStartIdentity"]> = (input) => {
    const modelIdentity = input.model?.trim();
    return {
      runtimeKind: "multica",
      providerInstanceId: null,
      adapterId: runtimeId,
      modelIdentity:
        modelIdentity === undefined || modelIdentity.length === 0 ? null : modelIdentity,
      configDigest: startConfigDigest,
      sessionMode: "daemon",
    };
  };
  const activeTaskIds = new Set<string>();
  const startedTaskIds = new Set<string>();
  const dispatchedTasks = new Map<
    string,
    {
      readonly taskId: string;
      readonly runId: string;
      readonly result: CompositionRuntimeTaskResult;
    }
  >();
  const capabilityHandshakes = new Map<
    string,
    {
      readonly taskId: string;
      readonly runId: string;
      readonly agentId: string;
      readonly capabilityGrantIds: ReadonlyArray<string>;
    }
  >();
  const claimedTasks = new Map<string, MulticaTask>();
  const taskExecutionBindings = new Map<string, MulticaTaskExecutionBinding>();
  const startingTaskIds = new Set<string>();
  let claimInFlight = false;
  let claimDrainRequested = false;

  const clearTaskState = (runtimeTaskId: string): void => {
    activeTaskIds.delete(runtimeTaskId);
    startedTaskIds.delete(runtimeTaskId);
    startingTaskIds.delete(runtimeTaskId);
    claimedTasks.delete(runtimeTaskId);
    taskExecutionBindings.delete(runtimeTaskId);
  };

  const normalizeExecutionBinding = (
    input: MulticaTaskExecutionBinding,
  ): MulticaTaskExecutionBinding => {
    const taskId = nonEmpty(input.taskId, "taskId");
    const runId = nonEmpty(input.runId, "runId");
    const agentId = nonEmpty(input.agentId, "agentId");
    const capabilityGrantIds = input.capabilityGrantIds.map((grantId) =>
      nonEmpty(grantId, "capabilityGrantId"),
    );
    if (hasDuplicate(capabilityGrantIds)) {
      throw new Error("capabilityGrantIds 不能包含重复值。");
    }
    const capabilityHandshakeId =
      input.capabilityHandshakeId === undefined
        ? undefined
        : nonEmpty(input.capabilityHandshakeId, "capabilityHandshakeId");
    if (capabilityGrantIds.length > 0 && capabilityHandshakeId === undefined) {
      throw new Error("带 grant 的执行绑定必须包含 capabilityHandshakeId。");
    }
    return {
      taskId,
      runId,
      agentId,
      capabilityGrantIds,
      ...(capabilityHandshakeId === undefined ? {} : { capabilityHandshakeId }),
    };
  };

  const rememberTaskExecutionBinding = (
    runtimeTaskId: string,
    binding: MulticaTaskExecutionBinding,
  ): void => {
    taskExecutionBindings.set(runtimeTaskId, normalizeExecutionBinding(binding));
  };

  const executionContextFor = (
    runtimeTaskId: string,
  ): Effect.Effect<MulticaDaemonTaskExecutionContext, CompositionRuntimeAdapterFailure> =>
    Effect.gen(function* () {
      const task = claimedTasks.get(runtimeTaskId);
      if (task === undefined) {
        return yield* adapterFailure(
          runtimeId,
          "task_execution_context_missing",
          `Multica 任务 '${runtimeTaskId}' 尚未 claim，不能注入执行上下文。`,
        );
      }
      let binding = taskExecutionBindings.get(runtimeTaskId);
      if (binding === undefined && options.taskExecutionBridge?.resolveBinding !== undefined) {
        const resolved = yield* options.taskExecutionBridge.resolveBinding({
          runtimeId,
          daemonRuntimeId,
          task,
        });
        if (resolved !== undefined) {
          try {
            binding = normalizeExecutionBinding(resolved);
          } catch (cause) {
            return yield* adapterFailure(
              runtimeId,
              "task_execution_binding_invalid",
              cause instanceof Error ? cause.message : String(cause),
            );
          }
          taskExecutionBindings.set(runtimeTaskId, binding);
        }
      }
      if (binding === undefined) {
        return yield* adapterFailure(
          runtimeId,
          "task_execution_binding_missing",
          `Multica 任务 '${runtimeTaskId}' 没有可验证的 Code Work Task/Run/Agent 绑定。`,
        );
      }
      let mcpConfig: MulticaTaskMcpLease["mcpConfig"] | undefined;
      if (binding.capabilityHandshakeId !== undefined) {
        if (options.taskMcpLeaseBridge === undefined) {
          return yield* adapterFailure(
            runtimeId,
            "task_mcp_lease_unavailable",
            "当前执行绑定要求 task-local MCP Lease，但 Adapter 没有 Lease bridge。",
          );
        }
        const lease = yield* options.taskMcpLeaseBridge.get(binding.capabilityHandshakeId);
        if (
          lease === undefined ||
          lease.expiresAtUnixMs <= now() ||
          lease.runtimeId !== runtimeId ||
          lease.taskId !== binding.taskId ||
          lease.runId !== binding.runId ||
          lease.agentId !== binding.agentId ||
          !sameStringSet(lease.capabilityGrantIds, binding.capabilityGrantIds)
        ) {
          return yield* adapterFailure(
            runtimeId,
            "task_mcp_lease_mismatch",
            "Task MCP Lease 已过期、撤销或与当前 Task/Run/Agent/Grant 不匹配。",
          );
        }
        mcpConfig = lease.mcpConfig;
      }
      return {
        ...binding,
        runtimeId,
        daemonId,
        daemonRuntimeId,
        runtimeTaskId,
        task,
        ...(mcpConfig === undefined ? {} : { mcpConfig }),
      } satisfies MulticaDaemonTaskExecutionContext;
    });

  const heartbeat = () =>
    options.protocol.heartbeat(daemonRuntimeId).pipe(
      Effect.map(
        (response) =>
          ({
            runtimeId,
            status: mapRuntimeStatus(response),
            heartbeatAtUnixMs: now(),
            activeTaskCount: activeTaskIds.size,
          }) satisfies CompositionRuntimeHeartbeat,
      ),
      Effect.mapError((failure) => mapProtocolFailure(runtimeId, failure)),
    );

  const handshakeCapabilities = (
    input: CompositionRuntimeCapabilityHandshakeRequest,
  ): Effect.Effect<CompositionRuntimeCapabilityHandshakeResult, CompositionRuntimeAdapterFailure> =>
    options.capabilityBridge === undefined
      ? Effect.succeed({
          runtimeId,
          taskId: input.taskId,
          runId: input.runId,
          agentId: input.agentId,
          status: "unsupported",
          acceptedGrantIds: [],
          reasonCode: "multica_capability_handshake_unsupported",
        })
      : options.capabilityBridge.handshakeCapabilities(input).pipe(
          Effect.map((result) => {
            if (
              result.status === "accepted" &&
              result.handshakeId !== undefined &&
              sameStringSet(result.acceptedGrantIds, input.capabilityGrantIds)
            ) {
              capabilityHandshakes.set(result.handshakeId, {
                taskId: input.taskId,
                runId: input.runId,
                agentId: input.agentId,
                capabilityGrantIds: [...input.capabilityGrantIds],
              });
            }
            return {
              ...result,
              runtimeId,
              taskId: input.taskId,
              runId: input.runId,
              agentId: input.agentId,
            };
          }),
        );

  const probe = () =>
    options.protocol.heartbeat(daemonRuntimeId).pipe(
      Effect.map((response) => {
        const status = mapRuntimeStatus(response);
        const capabilities = unique([...configuredCapabilities, ...response.serverCapabilities]);
        return {
          runtimeId,
          driverKind: "multica",
          status,
          ...(options.version === undefined ? {} : { version: options.version }),
          capabilities,
          ...(options.supportedModels === undefined
            ? {}
            : { supportedModels: [...options.supportedModels] }),
          supportsResume: options.supportsResume ?? false,
          supportsMcp: options.supportsMcp ?? false,
          ...(response.runtimeGone ? { reasonCode: "runtime_gone" } : {}),
          ...(status === "unstable" && !response.runtimeGone
            ? { reasonCode: "runtime_unstable" }
            : {}),
        } satisfies CompositionRuntimeProbeResult;
      }),
      Effect.mapError((failure) => mapProtocolFailure(runtimeId, failure)),
    );

  const reconcileStart: NonNullable<CompositionRuntimeAdapter["reconcileStart"]> = (input) =>
    Effect.gen(function* () {
      const runtime = yield* probe();
      if (runtime.status !== "online") {
        return {
          action: "defer" as const,
          code: `run_start_multica_runtime_${runtime.status}`,
          detail:
            runtime.status === "offline"
              ? "Multica Runtime 当前离线，Run Start 恢复已延后。"
              : "Multica Runtime 当前不稳定，Run Start 恢复已延后。",
        };
      }

      const store = options.quickCreateIntentStore;
      if (store === undefined) {
        return {
          action: "manual" as const,
          code: "run_start_multica_quick_create_ledger_unavailable",
          detail: "Multica quick-create 持久账本不可用，不能自动判断外部启动结果。",
        };
      }
      const intent = Option.getOrUndefined(
        yield* store
          .getMulticaQuickCreateIntent(input.run.runId)
          .pipe(Effect.mapError((cause) => mapQuickCreatePersistenceFailure(runtimeId, cause))),
      );
      if (intent === undefined) return { action: "replay" as const };
      if (
        intent.taskId !== input.task.taskId ||
        intent.runtimeId !== runtimeId ||
        intent.idempotencyKey !== input.run.runId
      ) {
        return {
          action: "quarantine" as const,
          code: "run_start_multica_quick_create_intent_conflict",
          detail: "Multica quick-create intent 与当前 Task/Run/Runtime 归属不一致，已阻止恢复。",
        };
      }
      if (intent.state === "prepared") return { action: "replay" as const };
      if (intent.state === "sending") {
        return {
          action: "manual" as const,
          code: "run_start_multica_quick_create_result_unknown",
          detail: "Multica quick-create 可能已被远端接受但本地未取得 task ID，需要人工核对。",
        };
      }
      if (intent.remoteTaskId === undefined || intent.remoteTaskId.trim().length === 0) {
        return {
          action: "manual" as const,
          code: "run_start_multica_quick_create_receipt_missing",
          detail: "Multica quick-create intent 已接受但缺少远端 task ID，需要人工核对。",
        };
      }
      return {
        action: "accepted" as const,
        runtimeTaskId: intent.remoteTaskId,
      };
    });

  const listAgents: CompositionRuntimeAdapter["listAgents"] = () =>
    Effect.succeed(
      configuredAgents.map((agent) => ({ ...agent, capabilities: [...agent.capabilities] })),
    );

  const getTaskMcpLease = (capabilityHandshakeId: string) =>
    options.taskMcpLeaseBridge === undefined
      ? Effect.succeed<MulticaTaskMcpLease | undefined>(undefined)
      : options.taskMcpLeaseBridge.get(capabilityHandshakeId);

  const revokeTaskMcpLeases = () =>
    options.taskMcpLeaseBridge === undefined
      ? Effect.void
      : options.taskMcpLeaseBridge.revokeRuntime(runtimeId);

  const claimTask = () =>
    options.protocol.claimTask(daemonRuntimeId).pipe(
      Effect.map((claimed) => {
        if (claimed === null) return null;
        const normalizedTaskId = nonEmpty(claimed.id, "claimedTaskId");
        const normalizedTask =
          claimed.id === normalizedTaskId ? claimed : { ...claimed, id: normalizedTaskId };
        activeTaskIds.add(normalizedTaskId);
        claimedTasks.set(normalizedTaskId, normalizedTask);
        return normalizedTask;
      }),
      Effect.mapError((failure) => mapProtocolFailure(runtimeId, failure)),
    );

  const startTask = (runtimeTaskId: string) =>
    Effect.gen(function* () {
      const normalizedRuntimeTaskId = nonEmpty(runtimeTaskId, "runtimeTaskId");
      if (
        startedTaskIds.has(normalizedRuntimeTaskId) ||
        startingTaskIds.has(normalizedRuntimeTaskId)
      ) {
        return;
      }
      startingTaskIds.add(normalizedRuntimeTaskId);
      if (options.taskExecutionBridge !== undefined) {
        const context = yield* executionContextFor(normalizedRuntimeTaskId);
        yield* options.taskExecutionBridge.injectTaskStart(context);
      }
      yield* options.protocol
        .startTask(normalizedRuntimeTaskId)
        .pipe(Effect.mapError((failure) => mapProtocolFailure(runtimeId, failure)));
      activeTaskIds.add(normalizedRuntimeTaskId);
      startedTaskIds.add(normalizedRuntimeTaskId);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          const normalizedRuntimeTaskId = runtimeTaskId.trim();
          startingTaskIds.delete(normalizedRuntimeTaskId);
          if (!startedTaskIds.has(normalizedRuntimeTaskId)) {
            clearTaskState(normalizedRuntimeTaskId);
          }
        }),
      ),
    );

  const handleControlFrame: MulticaDaemonControlFrameHandler = (frame) => {
    if (options.onControlFrame !== undefined) {
      return options.onControlFrame(frame);
    }
    if (frame.type !== "daemon:task_available" && frame.type !== "daemon:pending_work") {
      return Effect.void;
    }
    const hintedTaskId = taskIdFromPayload(frame.payload);
    if (
      hintedTaskId !== undefined &&
      (activeTaskIds.has(hintedTaskId) || startingTaskIds.has(hintedTaskId))
    ) {
      return Effect.void;
    }
    claimDrainRequested = true;
    if (claimInFlight) return Effect.void;
    claimInFlight = true;
    return Effect.gen(function* () {
      const seenTaskIds = new Set<string>();
      let drained = 0;
      while (claimDrainRequested && drained < maxClaimDrainTasks) {
        claimDrainRequested = false;
        const claimed = yield* claimTask();
        if (claimed === null) return;
        if (seenTaskIds.has(claimed.id)) return;
        seenTaskIds.add(claimed.id);
        yield* startTask(claimed.id);
        drained += 1;
        if (hintedTaskId !== undefined && claimed.id === hintedTaskId) return;
        // 继续探测同一唤醒期间的其他权威任务；重复任务和 null 会终止 drain。
        claimDrainRequested = true;
      }
      if (drained >= maxClaimDrainTasks) {
        yield* Effect.logWarning("Multica 任务唤醒 drain 达到上限", {
          runtimeId,
          maxClaimDrainTasks,
        });
      }
    }).pipe(
      Effect.catchCause(() =>
        Effect.logWarning("Multica 任务唤醒 claim/start 失败", {
          runtimeId,
          hintType: frame.type,
          ...(hintedTaskId === undefined ? {} : { taskId: hintedTaskId }),
        }).pipe(Effect.asVoid),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          claimInFlight = false;
        }),
      ),
    );
  };

  const reportProgress = (runtimeTaskId: string, input: MulticaTaskProgressInput) =>
    options.protocol
      .reportProgress(nonEmpty(runtimeTaskId, "runtimeTaskId"), input)
      .pipe(Effect.mapError((failure) => mapProtocolFailure(runtimeId, failure)));

  const completeTask = (runtimeTaskId: string, input: MulticaTaskCompleteInput) => {
    const normalizedRuntimeTaskId = nonEmpty(runtimeTaskId, "runtimeTaskId");
    return options.protocol.completeTask(normalizedRuntimeTaskId, input).pipe(
      Effect.tap(() => Effect.sync(() => clearTaskState(normalizedRuntimeTaskId))),
      Effect.mapError((failure) => mapProtocolFailure(runtimeId, failure)),
    );
  };

  const failTask = (runtimeTaskId: string, input: MulticaTaskFailInput) => {
    const normalizedRuntimeTaskId = nonEmpty(runtimeTaskId, "runtimeTaskId");
    return options.protocol.failTask(normalizedRuntimeTaskId, input).pipe(
      Effect.tap(() => Effect.sync(() => clearTaskState(normalizedRuntimeTaskId))),
      Effect.mapError((failure) => mapProtocolFailure(runtimeId, failure)),
    );
  };

  const acknowledgeCancellation = (runtimeTaskId: string, input: MulticaTaskCancelAckInput) => {
    const normalizedRuntimeTaskId = nonEmpty(runtimeTaskId, "runtimeTaskId");
    return options.protocol.acknowledgeCancellation(normalizedRuntimeTaskId, input).pipe(
      Effect.tap(() => Effect.sync(() => clearTaskState(normalizedRuntimeTaskId))),
      Effect.mapError((failure) => mapProtocolFailure(runtimeId, failure)),
    );
  };

  const dispatchTask: CompositionRuntimeAdapter["dispatchTask"] = (
    input: CompositionRuntimeTaskInput,
  ) =>
    Effect.gen(function* () {
      nonEmpty(input.taskId, "taskId");
      nonEmpty(input.runId, "runId");
      const agentId = nonEmpty(input.agentId, "agentId");
      const idempotencyKey = nonEmpty(input.idempotencyKey, "idempotencyKey");
      const capabilityGrantIds = input.capabilityGrantIds ?? [];
      if (capabilityGrantIds.length > 0) {
        if (options.capabilityBridge === undefined) {
          return yield* adapterFailure(
            runtimeId,
            "capability_handshake_unsupported",
            "Multica 官方窄协议尚未提供 Code Work capability handshake，拒绝带 grant 的派发。",
          );
        }
        if (input.capabilityHandshakeId === undefined) {
          return yield* adapterFailure(
            runtimeId,
            "capability_handshake_required",
            "带 grant 的 Multica 派发必须引用已接受的 capability handshake。",
          );
        }
        const handshake = capabilityHandshakes.get(input.capabilityHandshakeId);
        if (
          handshake === undefined ||
          handshake.taskId !== input.taskId ||
          handshake.runId !== input.runId ||
          handshake.agentId !== agentId ||
          !sameStringSet(handshake.capabilityGrantIds, capabilityGrantIds)
        ) {
          return yield* adapterFailure(
            runtimeId,
            "capability_handshake_mismatch",
            "Multica capability handshake 与当前 Task/Run/Agent/Grant 不匹配。",
          );
        }
      }
      const prompt = input.prompt === undefined ? undefined : input.prompt.trim();
      if (prompt === undefined || prompt.length === 0) {
        return yield* adapterFailure(
          runtimeId,
          "prompt_required",
          "Multica quick-create 需要 prompt。",
        );
      }
      let executionBinding: MulticaTaskExecutionBinding | undefined;
      if (options.taskExecutionBridge !== undefined) {
        try {
          executionBinding = normalizeExecutionBinding({
            taskId: input.taskId,
            runId: input.runId,
            agentId,
            capabilityGrantIds,
            ...(input.capabilityHandshakeId === undefined
              ? {}
              : { capabilityHandshakeId: input.capabilityHandshakeId }),
          });
        } catch (cause) {
          return yield* adapterFailure(
            runtimeId,
            "task_execution_binding_invalid",
            cause instanceof Error ? cause.message : String(cause),
          );
        }
      }
      const existing = dispatchedTasks.get(idempotencyKey);
      if (existing !== undefined) {
        if (existing.taskId !== input.taskId || existing.runId !== input.runId) {
          return yield* adapterFailure(
            runtimeId,
            "quick_create_idempotency_conflict",
            "同一 Runtime 下的 quick-create 幂等键已经属于其他 Task/Run。",
          );
        }
        return { ...existing.result, status: "already_running" as const };
      }
      const quickCreateIntentStore = options.quickCreateIntentStore;
      if (quickCreateIntentStore === undefined) {
        return yield* adapterFailure(
          runtimeId,
          "quick_create_persistence_unavailable",
          "Multica quick-create 未配置持久化发送账本，拒绝执行无法跨进程恢复的 POST。",
        );
      }
      let existingIntent = Option.getOrUndefined(
        yield* quickCreateIntentStore
          .getMulticaQuickCreateIntent(input.runId)
          .pipe(Effect.mapError((cause) => mapQuickCreatePersistenceFailure(runtimeId, cause))),
      );
      if (existingIntent === undefined) {
        const existingByIdempotencyKey = Option.getOrUndefined(
          yield* quickCreateIntentStore
            .getMulticaQuickCreateIntentByIdempotencyKey(runtimeId, idempotencyKey)
            .pipe(Effect.mapError((cause) => mapQuickCreatePersistenceFailure(runtimeId, cause))),
        );
        if (existingByIdempotencyKey !== undefined) {
          if (existingByIdempotencyKey.runId !== input.runId) {
            return yield* adapterFailure(
              runtimeId,
              "quick_create_idempotency_conflict",
              "同一 Runtime 下的 quick-create 幂等键已经属于其他 Run，拒绝创建第二个远端任务。",
            );
          }
          existingIntent = existingByIdempotencyKey;
        }
      }
      if (existingIntent !== undefined) {
        if (
          existingIntent.taskId !== input.taskId ||
          existingIntent.runtimeId !== runtimeId ||
          existingIntent.idempotencyKey !== idempotencyKey
        ) {
          return yield* adapterFailure(
            runtimeId,
            "quick_create_intent_conflict",
            "同一 Run 的已持久化 quick-create intent 与当前 Task/Runtime/幂等键不一致。",
          );
        }
        if (existingIntent.state === "accepted") {
          if (existingIntent.remoteTaskId === undefined) {
            return yield* adapterFailure(
              runtimeId,
              "quick_create_recovery_required",
              "quick-create intent 已标记 accepted 但缺少远端 task ID，必须人工核对 Multica。",
            );
          }
          const recovered = {
            runtimeTaskId: existingIntent.remoteTaskId,
            status: "accepted" as const,
          } satisfies CompositionRuntimeTaskResult;
          dispatchedTasks.set(idempotencyKey, {
            taskId: input.taskId,
            runId: input.runId,
            result: recovered,
          });
          if (executionBinding !== undefined) {
            rememberTaskExecutionBinding(existingIntent.remoteTaskId, executionBinding);
          }
          activeTaskIds.add(existingIntent.remoteTaskId);
          return { ...recovered, status: "already_running" as const };
        }
        if (existingIntent.state === "sending") {
          return yield* adapterFailure(
            runtimeId,
            "quick_create_recovery_required",
            "quick-create 请求可能已被 Multica 接收但本地未取得 task ID，拒绝自动重放 POST。",
          );
        }
      }
      const route =
        (input.assigneeKind === "squad" && input.assigneeId === undefined
          ? undefined
          : input.assigneeKind === "squad"
            ? input.assigneeId === undefined
              ? undefined
              : taskSquadRoutes.get(input.assigneeId)
            : undefined) ?? taskAssigneeRoutes.get(agentId);
      if (route === undefined) {
        return yield* adapterFailure(
          runtimeId,
          "assignee_mapping_missing",
          `Code Work assignee '${agentId}' 没有配置 Multica Agent/Squad 映射。`,
        );
      }
      if (existingIntent === undefined) {
        const inserted = yield* quickCreateIntentStore
          .createMulticaQuickCreateIntent({
            runId: input.runId,
            taskId: input.taskId,
            runtimeId,
            idempotencyKey,
            createdAtUnixMs: now(),
            updatedAtUnixMs: now(),
          })
          .pipe(Effect.mapError((cause) => mapQuickCreatePersistenceFailure(runtimeId, cause)));
        if (!inserted) {
          const racedIntent = Option.getOrUndefined(
            yield* quickCreateIntentStore
              .getMulticaQuickCreateIntentByIdempotencyKey(runtimeId, idempotencyKey)
              .pipe(Effect.mapError((cause) => mapQuickCreatePersistenceFailure(runtimeId, cause))),
          );
          if (racedIntent !== undefined && racedIntent.runId !== input.runId) {
            return yield* adapterFailure(
              runtimeId,
              "quick_create_idempotency_conflict",
              "同一 Runtime 下的 quick-create 幂等键已被其他 Run 抢占，拒绝重复派发。",
            );
          }
          return yield* adapterFailure(
            runtimeId,
            "quick_create_intent_race",
            "同一 Run 的 quick-create intent 已被其他执行器创建；请重新读取持久化状态。",
          );
        }
      }
      const sendingIntent = yield* quickCreateIntentStore
        .claimMulticaQuickCreateIntentForSend({
          runId: input.runId,
          runtimeId,
          updatedAtUnixMs: now(),
        })
        .pipe(Effect.mapError((cause) => mapQuickCreatePersistenceFailure(runtimeId, cause)));
      if (Option.isNone(sendingIntent)) {
        return yield* adapterFailure(
          runtimeId,
          "quick_create_recovery_required",
          "quick-create intent 已不再处于可安全发送的 prepared 状态，拒绝自动重放 POST。",
        );
      }
      const created = yield* options.protocol
        .quickCreateTask({
          workspaceId: route.workspaceId,
          ...(route.multicaAgentId === undefined ? {} : { agentId: route.multicaAgentId }),
          ...(route.multicaSquadId === undefined ? {} : { squadId: route.multicaSquadId }),
          ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
          idempotencyKey,
          prompt,
        })
        .pipe(
          Effect.mapError(() =>
            adapterFailure(
              runtimeId,
              "quick_create_recovery_required",
              "quick-create 请求结果未被本地确认；请先核对 Multica，再决定是否恢复。",
            ),
          ),
        );
      const acceptedIntent = yield* quickCreateIntentStore
        .acceptMulticaQuickCreateIntent({
          runId: input.runId,
          runtimeId,
          remoteTaskId: created.taskId,
          updatedAtUnixMs: now(),
        })
        .pipe(Effect.mapError((cause) => mapQuickCreatePersistenceFailure(runtimeId, cause)));
      if (Option.isNone(acceptedIntent)) {
        return yield* adapterFailure(
          runtimeId,
          "quick_create_recovery_required",
          "Multica 已返回 task ID，但本地未能原子绑定发送意图；必须人工核对后恢复。",
        );
      }
      const result = {
        runtimeTaskId: created.taskId,
        status: "accepted" as const,
      } satisfies CompositionRuntimeTaskResult;
      dispatchedTasks.set(idempotencyKey, {
        taskId: input.taskId,
        runId: input.runId,
        result,
      });
      if (executionBinding !== undefined) {
        rememberTaskExecutionBinding(created.taskId, executionBinding);
      }
      activeTaskIds.add(created.taskId);
      return result;
    });

  const cancelTask: CompositionRuntimeAdapter["cancelTask"] = (input: CompositionRuntimeTaskRef) =>
    Effect.gen(function* () {
      const runtimeTaskId = input.runtimeTaskId;
      if (runtimeTaskId === undefined || runtimeTaskId.trim().length === 0) {
        return yield* adapterFailure(runtimeId, "task_not_found", "缺少 runtimeTaskId。");
      }
      const status = yield* options.protocol
        .getTaskStatus(runtimeTaskId)
        .pipe(Effect.mapError((failure) => mapProtocolFailure(runtimeId, failure)));
      if (isTerminalRuntimeStatus(status.status)) {
        activeTaskIds.delete(runtimeTaskId);
        return {
          runtimeTaskId,
          status: "already_terminal" as const,
        } satisfies CompositionRuntimeCancelResult;
      }
      return yield* adapterFailure(
        runtimeId,
        "cancel_not_supported",
        "Multica daemon 窄协议没有由外部 Adapter 发起取消的接口；只能观察服务端状态并回传 cancel-ack。",
      );
    });

  const resumeTask: CompositionRuntimeAdapter["resumeTask"] = () =>
    Effect.fail(
      adapterFailure(
        runtimeId,
        "resume_not_supported",
        "Multica daemon 窄协议没有由外部 Adapter 恢复既有任务的接口。",
      ),
    );

  const streamEvents: CompositionRuntimeAdapter["streamEvents"] = (filter) =>
    Stream.unwrap(
      Effect.try({
        try: () => {
          const streamInput = {
            runtimeId,
            daemonRuntimeId,
            ...(filter?.runtimeTaskId === undefined ? {} : { runtimeTaskId: filter.runtimeTaskId }),
          } satisfies MulticaDaemonStreamFramesInput;
          if (options.streamFrames === undefined && options.controlFrames === undefined) {
            throw adapterFailure(
              runtimeId,
              "stream_unavailable",
              "未配置 Multica WebSocket transport。",
            );
          }
          const taskFrames: Stream.Stream<
            { readonly source: "task"; readonly frame: MulticaWebSocketFrame },
            MulticaDaemonProtocolFailure
          > =
            options.streamFrames === undefined
              ? Stream.empty
              : options
                  .streamFrames(streamInput)
                  .pipe(Stream.map((frame) => ({ source: "task" as const, frame })));
          const controlFrames: Stream.Stream<
            { readonly source: "control"; readonly frame: MulticaWebSocketFrame },
            MulticaDaemonProtocolFailure
          > =
            options.controlFrames === undefined
              ? Stream.empty
              : options
                  .controlFrames(streamInput)
                  .pipe(Stream.map((frame) => ({ source: "control" as const, frame })));
          return Stream.merge(taskFrames, controlFrames);
        },
        catch: (cause) =>
          Schema.is(CompositionRuntimeAdapterFailure)(cause)
            ? cause
            : adapterFailure(
                runtimeId,
                "stream_unavailable",
                cause instanceof Error ? cause.message : String(cause),
              ),
      }),
    ).pipe(
      Stream.mapError((failure) =>
        Schema.is(CompositionRuntimeAdapterFailure)(failure)
          ? failure
          : mapProtocolFailure(runtimeId, failure),
      ),
      Stream.mapEffect(({ source, frame }) => {
        if (source === "control") {
          if (!isControlHintFrame(frame)) {
            return Effect.succeed<ProviderRuntimeEvent | undefined>(undefined);
          }
          return handleControlFrame(frame).pipe(Effect.as(undefined));
        }
        return Effect.try({
          try: () => providerEventFromFrame(frame, runtimeId, now),
          catch: (cause) =>
            adapterFailure(
              runtimeId,
              "protocol_invalid",
              cause instanceof Error ? cause.message : String(cause),
            ),
        });
      }),
      Stream.filter((event): event is ProviderRuntimeEvent => event !== undefined),
      Stream.filter((event) => matchesEvent(event, filter)),
    );

  const probeMultica = () =>
    options.protocol.heartbeat(daemonRuntimeId).pipe(
      Effect.map((response) => {
        const status = mapRuntimeStatus(response);
        const capabilities = unique([...configuredCapabilities, ...response.serverCapabilities]);
        return {
          runtimeId,
          status,
          ...(options.version === undefined ? {} : { version: options.version }),
          capabilities,
          supportsSquad: options.supportsSquad ?? hasCapability(capabilities, ["squad", "squads"]),
          supportsLeader:
            options.supportsLeader ?? hasCapability(capabilities, ["leader", "leader-agent"]),
          supportsTaskGraph:
            options.supportsTaskGraph ??
            hasCapability(capabilities, ["task-graph", "task_graph", "taskgraph"]),
          ...(response.runtimeGone ? { reasonCode: "runtime_gone" } : {}),
        } satisfies CompositionMulticaProbeResult;
      }),
      Effect.mapError((failure) => mapProtocolFailure(runtimeId, failure)),
    );

  return {
    runtimeId,
    driverKind: "multica",
    startRecoveryPolicy: {
      mode: "idempotent-replay",
      requiredReceipt: "runtime-task",
      capabilityGrantReplay: { mode: "verified" },
    },
    getStartIdentity,
    reconcileStart,
    daemonId,
    daemonRuntimeId,
    probe,
    listAgents,
    heartbeat,
    handshakeCapabilities,
    dispatchTask,
    cancelTask,
    resumeTask,
    streamEvents,
    claimTask,
    startTask,
    reportProgress,
    completeTask,
    failTask,
    acknowledgeCancellation,
    probeMultica,
    getTaskMcpLease,
    revokeTaskMcpLeases,
    ...(options.capabilityBridge === undefined
      ? {}
      : {
          revokeCapabilityHandshake: (input: { readonly handshakeId: string }) =>
            Effect.gen(function* () {
              if (options.capabilityBridge!.revokeCapabilityHandshake === undefined) {
                capabilityHandshakes.delete(input.handshakeId);
                return yield* adapterFailure(
                  runtimeId,
                  "capability_handshake_revoke_unsupported",
                  "Multica capability extension 没有提供远端 handshake 撤销接口。",
                );
              }
              yield* options
                .capabilityBridge!.revokeCapabilityHandshake(input)
                .pipe(Effect.mapError((failure) => failure));
              capabilityHandshakes.delete(input.handshakeId);
            }),
        }),
  };
};
