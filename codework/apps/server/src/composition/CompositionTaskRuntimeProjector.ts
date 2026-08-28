import {
  ProviderDriverKind,
  ProviderInstanceId,
  type CompositionTask,
  type CompositionTaskEvent,
  type CompositionTaskRun,
  type CompositionTaskStatus,
  type ProviderRuntimeEvent,
} from "@codework/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { PersistenceSqlError } from "../persistence/Errors.ts";
import type { CompositionTaskStoreShape } from "../persistence/Services/CompositionTaskStore.ts";
import type { CompositionAgentDriverRegistry } from "./CompositionAgentDriverRegistry.ts";
import type {
  CompositionAgentDriver,
  CompositionAgentDriverFailure,
} from "./CompositionOrchestrator.ts";
import type * as CapabilityGrantRegistry from "./CapabilityGrantRegistry.ts";
import {
  releaseCompositionRuntimeLease,
  renewCompositionRuntimeLease,
} from "./CompositionRuntimeLeaseLifecycle.ts";
import { isCompositionSquadLeaderPlanTaskId } from "./CompositionSquadPlan.ts";

type ResumeReadyTasks = () => Effect.Effect<void>;

const terminalStatuses: ReadonlySet<CompositionTaskStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);

const runtimeLockedStatuses: ReadonlySet<CompositionTaskStatus> = new Set([
  ...terminalStatuses,
  "in_review",
]);

const runtimeStatusToCompositionStatus = (
  status: string | undefined,
): CompositionTaskStatus | undefined => {
  switch (status) {
    case "pending":
      return "queued";
    case "running":
      return "running";
    case "waiting":
      return "waiting_input";
    case "idle":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
    case "interrupted":
      return "cancelled";
    default:
      return undefined;
  }
};

const nonEmpty = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
};

const summaryOf = (value: unknown, fallback: string): string => nonEmpty(value) ?? fallback;

const runtimeFailureCode = (
  payload: Extract<ProviderRuntimeEvent, { readonly type: "runtime.error" }>["payload"],
): string => {
  const detail =
    typeof payload.detail === "object" && payload.detail !== null && !Array.isArray(payload.detail)
      ? (payload.detail as Record<string, unknown>)
      : undefined;
  const structuredCode = nonEmpty(detail?.failureCode);
  if (structuredCode !== undefined) return structuredCode;
  return payload.class === undefined ||
    payload.class === "unknown" ||
    payload.class === "provider_error"
    ? "provider_runtime_error"
    : payload.class;
};

type CompositionRuntimeEventBinding = {
  readonly driver?: CompositionAgentDriver;
  readonly taskId: string;
  readonly runId: string;
  readonly runtimeTaskId?: string;
  readonly source: "driver" | "persistence" | "watchdog";
};

type WatchdogRuntimeEventCorrelation = {
  readonly taskId: string;
  readonly runId: string;
  readonly runtimeId: string;
  readonly runtimeTaskId?: string;
};

const watchdogRuntimeEventCorrelation = (
  event: ProviderRuntimeEvent,
): WatchdogRuntimeEventCorrelation | undefined => {
  if (event.raw?.source !== "composition.watchdog") return undefined;
  if (
    event.provider !== ProviderDriverKind.make("composition") ||
    event.providerInstanceId !== ProviderInstanceId.make("composition")
  ) {
    return undefined;
  }
  const taskId = event.raw.taskId;
  const runId = event.raw.runId;
  const runtimeId = event.raw.runtimeId;
  if (taskId === undefined || runId === undefined || runtimeId === undefined) return undefined;
  return {
    taskId,
    runId,
    runtimeId,
    ...(event.raw.runtimeTaskId === undefined ? {} : { runtimeTaskId: event.raw.runtimeTaskId }),
  };
};

const multicaRuntimeEventCorrelation = (
  event: ProviderRuntimeEvent,
): { readonly runtimeId: string; readonly runtimeTaskId: string } | undefined => {
  // 只有 Multica Adapter 写入的明确 correlation metadata 允许触发持久化 fallback；
  // 不使用 task_id 单独猜测，也不把外部 payload 字段误当成本地 runtime ID。
  if (event.raw?.source !== "multica.task-event") return undefined;
  const runtimeTaskId = event.raw.runtimeTaskId;
  const runtimeId = event.raw.runtimeId;
  return runtimeTaskId === undefined || runtimeId === undefined
    ? undefined
    : { runtimeId, runtimeTaskId };
};

/** Driver 失联后只用明确的 runtime 复合键恢复审计归属，禁止凭 taskId 猜测。 */
export const resolveCompositionRuntimeEventBinding = (
  store: CompositionTaskStoreShape,
  driverRegistry: CompositionAgentDriverRegistry,
  event: ProviderRuntimeEvent,
): Effect.Effect<CompositionRuntimeEventBinding | undefined, PersistenceSqlError> =>
  Effect.gen(function* () {
    const liveBinding = yield* driverRegistry.resolveRuntimeEvent(event);
    if (liveBinding !== undefined) {
      return { ...liveBinding, source: "driver" as const };
    }

    const watchdog = watchdogRuntimeEventCorrelation(event);
    if (watchdog !== undefined) {
      const run = yield* store.getRun(watchdog.runId);
      if (
        Option.isNone(run) ||
        run.value.taskId !== watchdog.taskId ||
        run.value.runtimeId !== watchdog.runtimeId ||
        (watchdog.runtimeTaskId !== undefined && run.value.runtimeTaskId !== watchdog.runtimeTaskId)
      ) {
        yield* Effect.logWarning("Composition Watchdog 事件绑定失败", {
          reasonCode: "watchdog_binding_invalid",
          taskId: watchdog.taskId,
          runId: watchdog.runId,
          runtimeId: watchdog.runtimeId,
        });
        return undefined;
      }
      const driver = yield* driverRegistry.get(run.value.agentId);
      return {
        taskId: watchdog.taskId,
        runId: watchdog.runId,
        ...(watchdog.runtimeTaskId === undefined ? {} : { runtimeTaskId: watchdog.runtimeTaskId }),
        ...(driver === undefined ? {} : { driver }),
        source: "watchdog" as const,
      };
    }

    const correlation =
      (yield* driverRegistry.resolvePersistedRuntimeEvent(event)) ??
      multicaRuntimeEventCorrelation(event);
    if (correlation === undefined) return undefined;

    const candidates = yield* store.listRunsByRuntimeTask(
      correlation.runtimeId,
      correlation.runtimeTaskId,
    );
    if (candidates.length === 1) {
      const [run] = candidates;
      if (run === undefined) return undefined;
      return {
        taskId: run.taskId,
        runId: run.runId,
        runtimeTaskId: run.runtimeTaskId ?? correlation.runtimeTaskId,
        source: "persistence" as const,
      };
    }

    yield* Effect.logWarning("Composition Runtime 事件绑定失败", {
      reasonCode: candidates.length === 0 ? "unknown_binding" : "ambiguous_binding",
      runtimeId: correlation.runtimeId,
      runtimeTaskId: correlation.runtimeTaskId,
      candidateCount: candidates.length,
    });
    return undefined;
  });

type RuntimeProjection = {
  readonly status: CompositionTaskStatus;
  readonly eventType: CompositionTaskEvent["eventType"];
  readonly summary: string;
  readonly blockerCode?: string;
  readonly failureCode?: string;
  readonly runtimeTerminal?: boolean;
  readonly outputDelta?: string;
  readonly outputOffsetBytes?: number;
  readonly outputDigest?: string;
};

const projectEvent = (
  event: ProviderRuntimeEvent,
  currentStatus: CompositionTaskStatus,
  requiresReview: boolean,
  captureAssistantOutput: boolean,
): RuntimeProjection | undefined => {
  switch (event.type) {
    case "session.started":
    case "session.configured":
    case "thread.started":
    case "thread.state.changed":
      return undefined;
    case "turn.started":
      return {
        status: "running",
        eventType: "status",
        summary: "Provider Runtime 已开始执行任务",
      };
    case "turn.completed": {
      const runtimeStatus = runtimeStatusToCompositionStatus(event.payload.state) ?? "failed";
      const status = requiresReview && runtimeStatus === "completed" ? "in_review" : runtimeStatus;
      return {
        status,
        eventType: status === "in_review" ? "review_requested" : "status",
        summary: summaryOf(
          event.payload.errorMessage,
          status === "in_review"
            ? "Provider Runtime 已完成，等待 Reviewer 审核"
            : status === "completed"
              ? "Provider Runtime 已完成任务"
              : "Provider Runtime 执行结束",
        ),
        ...(status === "failed" ? { failureCode: "provider_turn_failed" } : {}),
        runtimeTerminal: true,
      };
    }
    case "turn.aborted":
      return {
        status: "cancelled",
        eventType: "status",
        summary: summaryOf(event.payload.reason, "Provider Runtime 已中断任务"),
      };
    case "task.started":
      return {
        status: "running",
        eventType: "status",
        summary: summaryOf(event.payload.description, "子任务已启动"),
      };
    case "task.progress":
      if (event.raw?.source === "multica.task-event" && event.raw.messageType === "task:message") {
        return {
          status: currentStatus,
          eventType: "message",
          summary: summaryOf(event.payload.summary ?? event.payload.description, "Runtime 消息"),
        };
      }
      return {
        status: runtimeStatusToCompositionStatus(event.payload.status) ?? "running",
        eventType: "progress",
        summary: summaryOf(event.payload.summary ?? event.payload.description, "子任务正在执行"),
      };
    case "task.updated": {
      const status = runtimeStatusToCompositionStatus(event.payload.status) ?? currentStatus;
      return {
        status,
        eventType: "progress",
        summary: summaryOf(event.payload.error ?? event.payload.description, "子任务状态已更新"),
        ...(event.payload.error === undefined ? {} : { failureCode: "provider_task_error" }),
      };
    }
    case "task.completed": {
      const runtimeStatus =
        event.payload.status === "completed"
          ? "completed"
          : event.payload.status === "stopped"
            ? "cancelled"
            : event.payload.status === "timed_out"
              ? "timed_out"
              : "failed";
      const status = requiresReview && runtimeStatus === "completed" ? "in_review" : runtimeStatus;
      return {
        status,
        eventType: status === "in_review" ? "review_requested" : "status",
        summary: summaryOf(
          event.payload.summary,
          status === "in_review"
            ? "子任务已完成，等待 Reviewer 审核"
            : status === "completed"
              ? "子任务已完成"
              : "子任务已结束",
        ),
        ...(status === "failed"
          ? { failureCode: "provider_task_failed" }
          : status === "timed_out"
            ? {
                failureCode:
                  event.raw?.source === "composition.watchdog" &&
                  event.raw.method === "cancel_confirmation_timeout"
                    ? "runtime_cancel_confirmation_timeout"
                    : "runtime_liveness_timeout",
              }
            : {}),
        runtimeTerminal: true,
      };
    }
    case "request.opened":
      return {
        status: "waiting_approval",
        eventType: "blocker",
        summary: summaryOf(event.payload.detail, "等待工具审批"),
        blockerCode: "approval_required",
      };
    case "request.resolved":
      return { status: "running", eventType: "status", summary: "工具审批已处理" };
    case "user-input.requested":
      return {
        status: "waiting_input",
        eventType: "blocker",
        summary: `等待用户输入（${event.payload.questions.length} 个问题）`,
        blockerCode: "user_input_required",
      };
    case "user-input.resolved":
      return { status: "running", eventType: "status", summary: "用户输入已提交" };
    case "tool.progress":
      return {
        status: currentStatus === "waiting_approval" ? "waiting_approval" : "running",
        eventType: "tool",
        summary: summaryOf(event.payload.summary ?? event.payload.toolName, "工具正在执行"),
      };
    case "tool.summary":
      return { status: currentStatus, eventType: "tool", summary: event.payload.summary };
    case "content.delta":
      if (event.payload.streamKind !== "assistant_text" || event.payload.delta.length === 0) {
        return undefined;
      }
      const isByokCheckpoint =
        event.raw?.source === "composition.byok.agent-loop" &&
        event.payload.checkpointOffsetBytes !== undefined &&
        event.payload.checkpointDigest !== undefined;
      if (!isByokCheckpoint && !captureAssistantOutput) return undefined;
      return {
        status: currentStatus,
        eventType: "message",
        summary:
          event.raw?.source === "composition.byok.agent-loop"
            ? "BYOK Agent 已保存部分输出"
            : "Agent 已保存部分输出",
        outputDelta: event.payload.delta,
        ...(event.payload.checkpointOffsetBytes === undefined
          ? {}
          : { outputOffsetBytes: event.payload.checkpointOffsetBytes }),
        ...(event.payload.checkpointDigest === undefined
          ? {}
          : { outputDigest: event.payload.checkpointDigest }),
      };
    case "runtime.warning":
      return { status: currentStatus, eventType: "message", summary: event.payload.message };
    case "runtime.error":
      return {
        status: "failed",
        eventType: "status",
        summary: event.payload.message,
        failureCode: runtimeFailureCode(event.payload),
        runtimeTerminal: true,
      };
    default:
      return undefined;
  }
};

/**
 * 事件流可能在重连或多路回放后乱序到达。启动/进度类事件不能清除当前
 * blocker，也不能把已经派发或运行中的任务退回 queued；终态事件仍由上层
 * 的 runtime lock 和终态规则处理。
 */
const preserveStatusForStaleRuntimeEvent = (
  event: ProviderRuntimeEvent,
  currentStatus: CompositionTaskStatus,
  projection: RuntimeProjection,
): RuntimeProjection => {
  const isProgressLike =
    event.type === "turn.started" ||
    event.type === "task.started" ||
    event.type === "task.progress" ||
    event.type === "task.updated";
  if (
    !isProgressLike ||
    terminalStatuses.has(projection.status) ||
    projection.status === "in_review"
  ) {
    return projection;
  }

  const preserveBlocker =
    (currentStatus === "waiting_approval" ||
      currentStatus === "waiting_input" ||
      currentStatus === "blocked") &&
    projection.status !== currentStatus;
  const preventQueueRegression =
    (currentStatus === "dispatched" || currentStatus === "running") &&
    projection.status === "queued";
  if (!preserveBlocker && !preventQueueRegression) {
    return projection;
  }
  return { ...projection, status: currentStatus };
};

export const projectCompositionRuntimeEvent = (
  store: CompositionTaskStoreShape,
  driverRegistry: CompositionAgentDriverRegistry,
  event: ProviderRuntimeEvent,
  grantRegistry?: Pick<CapabilityGrantRegistry.CapabilityGrantRegistryShape, "revoke">,
  resumeReadyTasks?: ResumeReadyTasks,
): Effect.Effect<
  void,
  | PersistenceSqlError
  | CapabilityGrantRegistry.CapabilityGrantPersistenceError
  | CompositionAgentDriverFailure
> =>
  Effect.gen(function* () {
    const binding = yield* resolveCompositionRuntimeEventBinding(store, driverRegistry, event);
    if (binding === undefined) return;

    const taskOption = yield* store.getTask(binding.taskId);
    const runOption = yield* store.getRun(binding.runId);
    if (Option.isNone(taskOption) || Option.isNone(runOption)) return;

    const task = taskOption.value;
    const run = runOption.value;
    const projected = projectEvent(
      event,
      task.status,
      task.mode === "review",
      isCompositionSquadLeaderPlanTaskId(task.taskId),
    );
    if (projected === undefined) return;
    const projection = preserveStatusForStaleRuntimeEvent(event, task.status, projected);

    const eventRecord = {
      taskId: binding.taskId,
      runId: binding.runId,
      ...(task.parentTaskId === undefined ? {} : { parentTaskId: task.parentTaskId }),
      sourceEventId: String(event.eventId),
      agentId: run.agentId,
      runtimeId: run.runtimeId,
      status: projection.status,
      sequence: 0,
      eventType: projection.eventType,
      summary: projection.summary,
      ...(projection.blockerCode === undefined ? {} : { blockerCode: projection.blockerCode }),
      ...(projection.outputDelta === undefined ? {} : { outputDelta: projection.outputDelta }),
      ...(projection.outputOffsetBytes === undefined
        ? {}
        : { outputOffsetBytes: projection.outputOffsetBytes }),
      ...(projection.outputDigest === undefined ? {} : { outputDigest: projection.outputDigest }),
    } as const;

    const appendAuditOnly = () =>
      store.withTransaction(store.appendEventIfNew(eventRecord).pipe(Effect.asVoid));

    // 重试会复用 taskId 但创建新的 runId；旧 Run 的迟到事件只保留在其审计流中，
    // 不能再次改写当前 Task 或最新 Run 投影。
    const latestRunOption = yield* store.getLatestRun(binding.taskId);
    if (Option.isSome(latestRunOption) && latestRunOption.value.runId !== binding.runId) {
      yield* appendAuditOnly();
      return;
    }

    // 终态和 in_review 都是运行时锁定状态。任何迟到事件（包括映射到同一状态的事件）
    // 只能保留审计，不能刷新投影时间、覆盖结果或再次触发终态副作用。
    if (runtimeLockedStatuses.has(task.status)) {
      yield* appendAuditOnly();
      return;
    }

    const now = yield* Clock.currentTimeMillis;
    const isTaskTerminal = terminalStatuses.has(projection.status);
    const runtimeTerminal = projection.runtimeTerminal ?? isTaskTerminal;
    const becameRuntimeTerminal = runtimeTerminal && run.finishedAtUnixMs === undefined;
    const becameTaskTerminal = !terminalStatuses.has(task.status) && isTaskTerminal;
    const nextTask: CompositionTask = {
      ...task,
      status: projection.status,
      updatedAtUnixMs: now,
      ...(isTaskTerminal ? { finishedAtUnixMs: now } : {}),
    };
    const nextRun: CompositionTaskRun = {
      ...run,
      ...(binding.runtimeTaskId === undefined ? {} : { runtimeTaskId: binding.runtimeTaskId }),
      status: projection.status,
      ...(runtimeTerminal ? { finishedAtUnixMs: now } : {}),
      ...(projection.failureCode === undefined ? {} : { failureCode: projection.failureCode }),
      ...(runtimeTerminal ? { resultSummary: projection.summary } : {}),
      ...(projection.status === "running" && run.startedAtUnixMs === undefined
        ? { startedAtUnixMs: now }
        : {}),
      lastRuntimeEventAtUnixMs: now,
    };
    const accepted = yield* store.withTransaction(
      Effect.gen(function* () {
        const inserted = yield* store.appendEventIfNew(eventRecord);
        if (!inserted) return false;
        yield* store.upsertTask(nextTask);
        yield* store.upsertRun(nextRun);
        return true;
      }),
    );
    if (!accepted) return;
    if (run.leaseId !== undefined) {
      const leaseResult = becameRuntimeTerminal
        ? yield* releaseCompositionRuntimeLease(store, run, now)
        : yield* renewCompositionRuntimeLease(store, run, now);
      if (Option.isNone(leaseResult)) {
        yield* Effect.logWarning("Composition Runtime 租约更新被拒绝", {
          reasonCode: becameRuntimeTerminal ? "lease_release_rejected" : "lease_renew_rejected",
          taskId: task.taskId,
          runId: run.runId,
          runtimeId: run.runtimeId,
          leaseId: run.leaseId,
        });
      }
    }
    // 持久化 fallback 只恢复归属和审计；已注销或新注册的 Driver 都不能借此触发
    // handshake revoke 等一次性副作用。
    const bindingDriver = binding.source === "persistence" ? undefined : binding.driver;
    if (
      becameRuntimeTerminal &&
      run.capabilityHandshakeId !== undefined &&
      bindingDriver?.revokeCapabilityHandshake !== undefined
    ) {
      yield* bindingDriver.revokeCapabilityHandshake({ task, run });
    }
    if (becameRuntimeTerminal && grantRegistry !== undefined) {
      yield* Effect.forEach(run.capabilityGrantIds ?? [], (grantId) =>
        grantRegistry
          .revoke({ grantId })
          .pipe(Effect.catchTag("CapabilityGrantNotFoundError", () => Effect.void)),
      );
    }
    if (becameTaskTerminal && resumeReadyTasks !== undefined) {
      yield* resumeReadyTasks();
    }
  });
