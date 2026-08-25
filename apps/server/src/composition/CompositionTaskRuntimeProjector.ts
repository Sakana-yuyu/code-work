import type {
  CompositionTask,
  CompositionTaskEvent,
  CompositionTaskRun,
  CompositionTaskStatus,
  ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { PersistenceSqlError } from "../persistence/Errors.ts";
import type { CompositionTaskStoreShape } from "../persistence/Services/CompositionTaskStore.ts";
import type { CompositionAgentDriverRegistry } from "./CompositionAgentDriverRegistry.ts";
import type { CompositionAgentDriverFailure } from "./CompositionOrchestrator.ts";
import type * as CapabilityGrantRegistry from "./CapabilityGrantRegistry.ts";

const terminalStatuses: ReadonlySet<CompositionTaskStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
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

type RuntimeProjection = {
  readonly status: CompositionTaskStatus;
  readonly eventType: CompositionTaskEvent["eventType"];
  readonly summary: string;
  readonly blockerCode?: string;
  readonly failureCode?: string;
};

const projectEvent = (
  event: ProviderRuntimeEvent,
  currentStatus: CompositionTaskStatus,
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
      const status = runtimeStatusToCompositionStatus(event.payload.state) ?? "failed";
      return {
        status,
        eventType: "status",
        summary: summaryOf(
          event.payload.errorMessage,
          status === "completed" ? "Provider Runtime 已完成任务" : "Provider Runtime 执行结束",
        ),
        ...(status === "failed" ? { failureCode: "provider_turn_failed" } : {}),
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
      const status =
        event.payload.status === "completed"
          ? "completed"
          : event.payload.status === "stopped"
            ? "cancelled"
            : "failed";
      return {
        status,
        eventType: "status",
        summary: summaryOf(
          event.payload.summary,
          status === "completed" ? "子任务已完成" : "子任务已结束",
        ),
        ...(status === "failed" ? { failureCode: "provider_task_failed" } : {}),
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
    case "runtime.warning":
      return { status: currentStatus, eventType: "message", summary: event.payload.message };
    case "runtime.error":
      return {
        status: "failed",
        eventType: "status",
        summary: event.payload.message,
        failureCode: "provider_runtime_error",
      };
    default:
      return undefined;
  }
};

export const projectCompositionRuntimeEvent = (
  store: CompositionTaskStoreShape,
  driverRegistry: CompositionAgentDriverRegistry,
  event: ProviderRuntimeEvent,
  grantRegistry?: Pick<CapabilityGrantRegistry.CapabilityGrantRegistryShape, "revoke">,
): Effect.Effect<
  void,
  | PersistenceSqlError
  | CapabilityGrantRegistry.CapabilityGrantPersistenceError
  | CompositionAgentDriverFailure
> =>
  Effect.gen(function* () {
    const binding = yield* driverRegistry.resolveRuntimeEvent(event);
    if (binding === undefined) return;

    const taskOption = yield* store.getTask(binding.taskId);
    const runOption = yield* store.getRun(binding.runId);
    if (Option.isNone(taskOption) || Option.isNone(runOption)) return;

    const task = taskOption.value;
    const run = runOption.value;
    const projection = projectEvent(event, task.status);
    if (projection === undefined) return;
    if (terminalStatuses.has(task.status) && projection.status !== task.status) return;

    const now = yield* Clock.currentTimeMillis;
    const isTerminal = terminalStatuses.has(projection.status);
    const becameTerminal = !terminalStatuses.has(task.status) && isTerminal;
    const bindingDriver = yield* driverRegistry.get(run.agentId);
    if (
      becameTerminal &&
      run.capabilityHandshakeId !== undefined &&
      bindingDriver?.revokeCapabilityHandshake !== undefined
    ) {
      yield* bindingDriver.revokeCapabilityHandshake({ task, run });
    }
    if (becameTerminal && grantRegistry !== undefined) {
      yield* Effect.forEach(run.capabilityGrantIds ?? [], (grantId) =>
        grantRegistry
          .revoke({ grantId })
          .pipe(Effect.catchTag("CapabilityGrantNotFoundError", () => Effect.void)),
      );
    }
    const nextTask: CompositionTask = {
      ...task,
      status: projection.status,
      updatedAtUnixMs: now,
      ...(isTerminal ? { finishedAtUnixMs: now } : {}),
    };
    const nextRun: CompositionTaskRun = {
      ...run,
      ...(binding.runtimeTaskId === undefined ? {} : { runtimeTaskId: binding.runtimeTaskId }),
      status: projection.status,
      ...(isTerminal ? { finishedAtUnixMs: now } : {}),
      ...(projection.failureCode === undefined ? {} : { failureCode: projection.failureCode }),
      ...(isTerminal ? { resultSummary: projection.summary } : {}),
      ...(projection.status === "running" && run.startedAtUnixMs === undefined
        ? { startedAtUnixMs: now }
        : {}),
    };
    const priorEvents = yield* store.listEvents(binding.taskId, binding.runId);
    yield* store.upsertTask(nextTask);
    yield* store.upsertRun(nextRun);
    yield* store.appendEvent({
      taskId: nextTask.taskId,
      runId: nextRun.runId,
      ...(nextTask.parentTaskId === undefined ? {} : { parentTaskId: nextTask.parentTaskId }),
      sourceEventId: String(event.eventId),
      agentId: nextRun.agentId,
      runtimeId: nextRun.runtimeId,
      status: projection.status,
      sequence: priorEvents.length,
      eventType: projection.eventType,
      summary: projection.summary,
      ...(projection.blockerCode === undefined ? {} : { blockerCode: projection.blockerCode }),
    });
  });
