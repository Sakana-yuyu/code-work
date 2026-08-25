import { createHash } from "node:crypto";

import type {
  CompositionMulticaProbeResult,
  CompositionRuntimeProbeResult,
  ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { EventId, ProviderDriverKind, RuntimeTaskId, ThreadId } from "@t3tools/contracts";
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

export type MulticaDaemonStreamFramesInput = {
  readonly runtimeId: string;
  readonly daemonRuntimeId: string;
};

/** T3 assignee 到 Multica 工作区和远端 Agent/Squad UUID 的显式映射。 */
export type MulticaTaskAssigneeRoute = {
  readonly t3AgentId: string;
  readonly workspaceId: string;
  readonly multicaAgentId?: string;
  readonly multicaSquadId?: string;
};

export type MulticaDaemonRuntimeAdapterOptions = {
  /** T3 侧稳定 Runtime ID，建议使用 multica:<daemonId>:<runtimeId>。 */
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
  readonly supportsSquad?: boolean;
  readonly supportsLeader?: boolean;
  readonly supportsTaskGraph?: boolean;
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
  for (const route of options.taskAssigneeRoutes ?? []) {
    const t3AgentId = nonEmpty(route.t3AgentId, "taskAssigneeRoute.t3AgentId");
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
        `Multica assignee route '${t3AgentId}' 必须且只能指定 multicaAgentId 或 multicaSquadId。`,
      );
    }
    if (taskAssigneeRoutes.has(t3AgentId)) {
      throw new Error(`Multica assignee route '${t3AgentId}' 重复。`);
    }
    taskAssigneeRoutes.set(t3AgentId, {
      t3AgentId,
      workspaceId,
      ...(multicaAgentId === undefined ? {} : { multicaAgentId }),
      ...(multicaSquadId === undefined ? {} : { multicaSquadId }),
    });
  }
  const activeTaskIds = new Set<string>();
  const dispatchedTasks = new Map<string, CompositionRuntimeTaskResult>();

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

  const probe = () =>
    options.protocol.heartbeat(daemonRuntimeId).pipe(
      Effect.map((response) => {
        const status = mapRuntimeStatus(response);
        return {
          runtimeId,
          driverKind: "multica",
          status,
          ...(options.version === undefined ? {} : { version: options.version }),
          capabilities: unique([...configuredCapabilities, ...response.serverCapabilities]),
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

  const claimTask = () =>
    options.protocol.claimTask(daemonRuntimeId).pipe(
      Effect.tap((claimed) =>
        Effect.sync(() => {
          if (claimed !== null) activeTaskIds.add(claimed.id);
        }),
      ),
      Effect.mapError((failure) => mapProtocolFailure(runtimeId, failure)),
    );

  const startTask = (runtimeTaskId: string) =>
    options.protocol.startTask(nonEmpty(runtimeTaskId, "runtimeTaskId")).pipe(
      Effect.tap(() => Effect.sync(() => activeTaskIds.add(runtimeTaskId))),
      Effect.mapError((failure) => mapProtocolFailure(runtimeId, failure)),
    );

  const reportProgress = (runtimeTaskId: string, input: MulticaTaskProgressInput) =>
    options.protocol
      .reportProgress(nonEmpty(runtimeTaskId, "runtimeTaskId"), input)
      .pipe(Effect.mapError((failure) => mapProtocolFailure(runtimeId, failure)));

  const completeTask = (runtimeTaskId: string, input: MulticaTaskCompleteInput) =>
    options.protocol.completeTask(nonEmpty(runtimeTaskId, "runtimeTaskId"), input).pipe(
      Effect.tap(() => Effect.sync(() => activeTaskIds.delete(runtimeTaskId))),
      Effect.mapError((failure) => mapProtocolFailure(runtimeId, failure)),
    );

  const failTask = (runtimeTaskId: string, input: MulticaTaskFailInput) =>
    options.protocol.failTask(nonEmpty(runtimeTaskId, "runtimeTaskId"), input).pipe(
      Effect.tap(() => Effect.sync(() => activeTaskIds.delete(runtimeTaskId))),
      Effect.mapError((failure) => mapProtocolFailure(runtimeId, failure)),
    );

  const acknowledgeCancellation = (runtimeTaskId: string, input: MulticaTaskCancelAckInput) =>
    options.protocol.acknowledgeCancellation(nonEmpty(runtimeTaskId, "runtimeTaskId"), input).pipe(
      Effect.tap(() => Effect.sync(() => activeTaskIds.delete(runtimeTaskId))),
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
      const prompt = input.prompt === undefined ? undefined : input.prompt.trim();
      if (prompt === undefined || prompt.length === 0) {
        return yield* adapterFailure(
          runtimeId,
          "prompt_required",
          "Multica quick-create 需要 prompt。",
        );
      }
      const existing = dispatchedTasks.get(idempotencyKey);
      if (existing !== undefined) {
        return { ...existing, status: "already_running" as const };
      }
      const route = taskAssigneeRoutes.get(agentId);
      if (route === undefined) {
        return yield* adapterFailure(
          runtimeId,
          "assignee_mapping_missing",
          `T3 assignee '${agentId}' 没有配置 Multica Agent/Squad 映射。`,
        );
      }
      const created = yield* options.protocol
        .quickCreateTask({
          workspaceId: route.workspaceId,
          ...(route.multicaAgentId === undefined ? {} : { agentId: route.multicaAgentId }),
          ...(route.multicaSquadId === undefined ? {} : { squadId: route.multicaSquadId }),
          prompt,
        })
        .pipe(Effect.mapError((failure) => mapProtocolFailure(runtimeId, failure)));
      const result = {
        runtimeTaskId: created.taskId,
        status: "accepted" as const,
      } satisfies CompositionRuntimeTaskResult;
      dispatchedTasks.set(idempotencyKey, result);
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
    return options.streamFrames({ runtimeId, daemonRuntimeId }).pipe(
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
        return {
          runtimeId,
          status,
          ...(options.version === undefined ? {} : { version: options.version }),
          capabilities: unique([...configuredCapabilities, ...response.serverCapabilities]),
          supportsSquad: options.supportsSquad ?? configuredCapabilities.includes("squad"),
          supportsLeader: options.supportsLeader ?? configuredCapabilities.includes("leader"),
          supportsTaskGraph:
            options.supportsTaskGraph ?? configuredCapabilities.includes("task-graph"),
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
  };
};
