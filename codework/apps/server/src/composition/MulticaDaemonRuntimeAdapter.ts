import { createHash } from "node:crypto";

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
import * as Stream from "effect/Stream";

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

export type MulticaDaemonStreamFramesInput = {
  readonly runtimeId: string;
  readonly daemonRuntimeId: string;
  readonly runtimeTaskId?: string;
};

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
  readonly streamFrames?: (
    input: MulticaDaemonStreamFramesInput,
  ) => Stream.Stream<MulticaWebSocketFrame, MulticaDaemonProtocolFailure>;
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

const mapRuntimeStatus = (
  response: Pick<MulticaHeartbeatResponse, "status" | "runtimeGone">,
): CompositionRuntimeProbeResult["status"] => {
  if (response.runtimeGone) return "offline";
  switch (response.status) {
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
  recordString(payload, "output") ??
  recordString(payload, "error") ??
  fallback;

const eventIdForFrame = (frame: MulticaWebSocketFrame): EventId => {
  const explicit =
    recordString(frame.payload, "event_id") ?? recordString(frame.payload, "eventId");
  if (explicit !== undefined) return EventId.make(explicit);
  const digest = createHash("sha256").update(encodeMulticaWebSocketFrame(frame)).digest("hex");
  return EventId.make(`multica:${digest}`);
};

const createdAtForFrame = (frame: MulticaWebSocketFrame, now: () => number): string =>
  recordString(frame.payload, "created_at") ?? DateTime.formatIso(DateTime.makeUnsafe(now()));

const baseEventFor = (frame: MulticaWebSocketFrame, runtimeId: string, now: () => number) => ({
  eventId: eventIdForFrame(frame),
  provider: ProviderDriverKind.make("multica"),
  threadId: ThreadId.make(runtimeId),
  createdAt: createdAtForFrame(frame, now),
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
      return {
        ...base,
        type: "task.updated",
        payload: { taskId: runtimeTaskId, description: summary },
      } satisfies Extract<ProviderRuntimeEvent, { type: "task.updated" }>;
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
        },
      } satisfies Extract<ProviderRuntimeEvent, { type: "task.progress" }>;
    case "task:completed":
      return {
        ...base,
        type: "task.completed",
        payload: { taskId: runtimeTaskId, status: "completed", summary },
      } satisfies Extract<ProviderRuntimeEvent, { type: "task.completed" }>;
    case "task:failed":
      return {
        ...base,
        type: "task.completed",
        payload: { taskId: runtimeTaskId, status: "failed", summary },
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
  nonEmpty(options.baseUrl, "baseUrl");
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
  const activeTaskIds = new Set<string>();
  const dispatchedTasks = new Map<string, CompositionRuntimeTaskResult>();
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
      Effect.tap((claimed) =>
        Effect.sync(() => {
          if (claimed !== null) {
            activeTaskIds.add(claimed.id);
            claimedTasks.set(claimed.id, claimed);
          }
        }),
      ),
      Effect.mapError((failure) => mapProtocolFailure(runtimeId, failure)),
    );

  const startTask = (runtimeTaskId: string) =>
    Effect.gen(function* () {
      const normalizedRuntimeTaskId = nonEmpty(runtimeTaskId, "runtimeTaskId");
      if (options.taskExecutionBridge !== undefined) {
        const context = yield* executionContextFor(normalizedRuntimeTaskId);
        yield* options.taskExecutionBridge.injectTaskStart(context);
      }
      yield* options.protocol
        .startTask(normalizedRuntimeTaskId)
        .pipe(Effect.mapError((failure) => mapProtocolFailure(runtimeId, failure)));
      activeTaskIds.add(normalizedRuntimeTaskId);
    });

  const reportProgress = (runtimeTaskId: string, input: MulticaTaskProgressInput) =>
    options.protocol
      .reportProgress(nonEmpty(runtimeTaskId, "runtimeTaskId"), input)
      .pipe(Effect.mapError((failure) => mapProtocolFailure(runtimeId, failure)));

  const completeTask = (runtimeTaskId: string, input: MulticaTaskCompleteInput) =>
    options.protocol.completeTask(nonEmpty(runtimeTaskId, "runtimeTaskId"), input).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          activeTaskIds.delete(runtimeTaskId);
          claimedTasks.delete(runtimeTaskId);
          taskExecutionBindings.delete(runtimeTaskId);
        }),
      ),
      Effect.mapError((failure) => mapProtocolFailure(runtimeId, failure)),
    );

  const failTask = (runtimeTaskId: string, input: MulticaTaskFailInput) =>
    options.protocol.failTask(nonEmpty(runtimeTaskId, "runtimeTaskId"), input).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          activeTaskIds.delete(runtimeTaskId);
          claimedTasks.delete(runtimeTaskId);
          taskExecutionBindings.delete(runtimeTaskId);
        }),
      ),
      Effect.mapError((failure) => mapProtocolFailure(runtimeId, failure)),
    );

  const acknowledgeCancellation = (runtimeTaskId: string, input: MulticaTaskCancelAckInput) =>
    options.protocol.acknowledgeCancellation(nonEmpty(runtimeTaskId, "runtimeTaskId"), input).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          activeTaskIds.delete(runtimeTaskId);
          claimedTasks.delete(runtimeTaskId);
          taskExecutionBindings.delete(runtimeTaskId);
        }),
      ),
      Effect.mapError((failure) => mapProtocolFailure(runtimeId, failure)),
    );

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
        return { ...existing, status: "already_running" as const };
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
      const created = yield* options.protocol
        .quickCreateTask({
          workspaceId: route.workspaceId,
          ...(route.multicaAgentId === undefined ? {} : { agentId: route.multicaAgentId }),
          ...(route.multicaSquadId === undefined ? {} : { squadId: route.multicaSquadId }),
          ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
          prompt,
        })
        .pipe(Effect.mapError((failure) => mapProtocolFailure(runtimeId, failure)));
      const result = {
        runtimeTaskId: created.taskId,
        status: "accepted" as const,
      } satisfies CompositionRuntimeTaskResult;
      dispatchedTasks.set(idempotencyKey, result);
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

  const streamEvents: CompositionRuntimeAdapter["streamEvents"] = (filter) => {
    if (options.streamFrames === undefined) {
      return Stream.fail(
        adapterFailure(runtimeId, "stream_unavailable", "未配置 Multica WebSocket transport。"),
      );
    }
    return options.streamFrames({
      runtimeId,
      daemonRuntimeId,
      ...(filter?.runtimeTaskId === undefined ? {} : { runtimeTaskId: filter.runtimeTaskId }),
    }).pipe(
      Stream.mapError((failure) => mapProtocolFailure(runtimeId, failure)),
      Stream.mapEffect((frame) =>
        Effect.try({
          try: () => providerEventFromFrame(frame, runtimeId, now),
          catch: (cause) =>
            adapterFailure(
              runtimeId,
              "protocol_invalid",
              cause instanceof Error ? cause.message : String(cause),
            ),
        }),
      ),
      Stream.filter((event): event is ProviderRuntimeEvent => event !== undefined),
      Stream.filter((event) => matchesEvent(event, filter)),
    );
  };

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
