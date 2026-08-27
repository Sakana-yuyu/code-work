import type { CompositionAgentDriverProfile, ProviderRuntimeEvent } from "@codework/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import {
  CompositionAgentDriverFailure,
  type CompositionAgentDriver,
} from "./CompositionOrchestrator.ts";
import type {
  CompositionIdeAdapter,
  CompositionIdeRequestedProfile,
  CompositionIdeSessionRegistry,
  CompositionIdeCapabilityHandshakeResult,
} from "./CompositionIdeSessionRegistry.ts";

export const IDE_TASK_START_OPERATION = "task.start";
export const IDE_TASK_CANCEL_OPERATION = "task.cancel";
export const IDE_TASK_EVENTS_OPERATION = "task.events";

const IDE_EVENT_BINDING_WAIT = "20 seconds";
const MAX_PENDING_EVENT_BINDINGS = 256;

export const compositionIdeAgentId = (sessionId: string): string => `ide:${sessionId}`;

export interface CompositionIdeAgentDriverOptions {
  readonly registry: Pick<
    CompositionIdeSessionRegistry,
    "get" | "resolve" | "handshake" | "invoke" | "revokeHandshake"
  >;
  readonly sessionId: string;
  readonly profile: CompositionIdeRequestedProfile;
  readonly agentId?: string;
  readonly eventStream?: CompositionIdeAdapter["streamEvents"];
}

type IdeRunBinding = {
  readonly taskId: string;
  readonly runId: string;
  readonly runtimeTaskId: string;
  readonly handshakeId: string;
};

const errorDetail = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const failure = (code: string, detail: string): CompositionAgentDriverFailure =>
  new CompositionAgentDriverFailure({ code, detail });

const recordFrom = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const stringFrom = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const runtimeTaskIdFromEvent = (event: ProviderRuntimeEvent): string | undefined => {
  const payload = recordFrom(event.payload);
  const rawPayload = recordFrom(event.raw?.payload);
  return (
    stringFrom(payload?.runtimeTaskId) ??
    stringFrom(payload?.taskId) ??
    stringFrom(rawPayload?.runtimeTaskId) ??
    stringFrom(rawPayload?.taskId)
  );
};

const resultStatus = (
  value: unknown,
): "accepted" | "already_running" | "already_terminal" | undefined => {
  const status = stringFrom(recordFrom(value)?.status);
  return status === "accepted" || status === "already_running" || status === "already_terminal"
    ? status
    : undefined;
};

const cancelStatus = (
  value: unknown,
): "cancelled" | "cancel_requested" | "already_terminal" | undefined => {
  const status = stringFrom(recordFrom(value)?.status);
  return status === "cancelled" || status === "cancel_requested" || status === "already_terminal"
    ? status
    : undefined;
};

const acceptedHandshake = (
  result: CompositionIdeCapabilityHandshakeResult,
): result is CompositionIdeCapabilityHandshakeResult & {
  readonly status: "accepted";
  readonly handshakeId: string;
} => result.status === "accepted" && result.handshakeId !== undefined;

export const makeCompositionIdeAgentDriver = (
  options: CompositionIdeAgentDriverOptions,
): CompositionAgentDriver => {
  const sessionId = options.sessionId.trim();
  const agentId = options.agentId ?? compositionIdeAgentId(sessionId);
  const runtimeId = compositionIdeAgentId(sessionId);
  const activeRuns = new Map<string, IdeRunBinding>();
  const historicalRuns = new Map<string, IdeRunBinding | null>();
  const pendingEventBindings = new Map<string, Deferred.Deferred<void>>();
  let pendingTaskStarts = 0;

  const remember = (binding: IdeRunBinding): boolean => {
    const previous = historicalRuns.get(binding.runtimeTaskId);
    if (
      previous !== undefined &&
      (previous === null || previous.taskId !== binding.taskId || previous.runId !== binding.runId)
    ) {
      historicalRuns.set(binding.runtimeTaskId, null);
      return false;
    }
    historicalRuns.set(binding.runtimeTaskId, binding);
    while (historicalRuns.size > 4096) {
      const oldest = historicalRuns.keys().next().value;
      if (oldest === undefined) break;
      historicalRuns.delete(oldest);
    }
    return true;
  };

  const releasePendingEventBinding = (runtimeTaskId: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      const pending = pendingEventBindings.get(runtimeTaskId);
      if (pending === undefined) return;
      pendingEventBindings.delete(runtimeTaskId);
      yield* Deferred.succeed(pending, undefined);
    });

  const awaitRuntimeEventBinding = (
    event: ProviderRuntimeEvent,
  ): Effect.Effect<ProviderRuntimeEvent> =>
    Effect.gen(function* () {
      const runtimeTaskId = runtimeTaskIdFromEvent(event);
      if (
        runtimeTaskId === undefined ||
        historicalRuns.get(runtimeTaskId) !== undefined ||
        pendingTaskStarts === 0
      ) {
        return event;
      }
      let pending = pendingEventBindings.get(runtimeTaskId);
      if (pending === undefined) {
        pending = yield* Deferred.make<void>();
        pendingEventBindings.set(runtimeTaskId, pending);
        while (pendingEventBindings.size > MAX_PENDING_EVENT_BINDINGS) {
          const oldest = pendingEventBindings.keys().next().value;
          if (oldest === undefined) break;
          pendingEventBindings.delete(oldest);
        }
      }
      const resolved = yield* Deferred.await(pending).pipe(
        Effect.timeoutOption(IDE_EVENT_BINDING_WAIT),
      );
      if (Option.isNone(resolved)) {
        if (pendingEventBindings.get(runtimeTaskId) === pending) {
          pendingEventBindings.delete(runtimeTaskId);
        }
        yield* Effect.logWarning("IDE task event 等待 runtime 关联超时", {
          sessionId,
          runtimeId,
          runtimeTaskId,
        });
      }
      return event;
    });

  const getProfile: NonNullable<CompositionAgentDriver["getProfile"]> = () =>
    Effect.gen(function* () {
      const resolved = yield* options.registry.resolve({
        sessionId,
        requestedProfile: options.profile,
      });
      const operations = new Set(resolved.verifiedOperations);
      const taskBridgeReady =
        resolved.status === "ready" &&
        operations.has(IDE_TASK_START_OPERATION) &&
        operations.has(IDE_TASK_CANCEL_OPERATION) &&
        operations.has(IDE_TASK_EVENTS_OPERATION) &&
        options.eventStream !== undefined;
      const status: CompositionAgentDriverProfile["status"] =
        resolved.status === "unavailable"
          ? "unavailable"
          : taskBridgeReady
            ? "available"
            : "degraded";
      return {
        schemaVersion: 1,
        agentId,
        runtimeId,
        driverKind: "ide" as const,
        status,
        capabilities: [
          "ide",
          ...resolved.verifiedOperations,
          ...(taskBridgeReady ? ["task.dispatch", "task.cancel"] : []),
        ],
        supportsToolBroker: false,
        supportsCapabilityHandshake: resolved.status === "ready",
        supportsWorkspace: false,
        supportsTerminal: false,
        supportsGit: false,
        supportsMcp: false,
        supportsBrowser: resolved.profile === "browser_mcp" && resolved.status === "ready",
        supportsIde: resolved.status === "ready",
        supportsProviderApi: false,
        supportsResume: false,
        supportsSquad: false,
        supportsLeader: false,
        supportsTaskGraph: false,
        ...(status === "available"
          ? {}
          : {
              reasonCode:
                resolved.status === "unavailable"
                  ? (resolved.reasonCode ?? "ide_unavailable")
                  : "ide_task_bridge_unsupported",
            }),
      } satisfies CompositionAgentDriverProfile;
    });

  const startTask: CompositionAgentDriver["startTask"] = (input) =>
    Effect.gen(function* () {
      const handshake = yield* options.registry.handshake({
        sessionId,
        requestedProfile: options.profile,
        taskId: input.task.taskId,
        runId: input.run.runId,
        agentId,
        capabilityGrantIds: [...(input.run.capabilityGrantIds ?? [])],
        requestedOperations: [
          IDE_TASK_START_OPERATION,
          IDE_TASK_CANCEL_OPERATION,
          IDE_TASK_EVENTS_OPERATION,
        ],
      });
      if (!acceptedHandshake(handshake)) {
        return yield* Effect.fail(
          failure(
            handshake.reasonCode ?? "ide_task_handshake_rejected",
            "IDE session 未接受任务 bridge capability。",
          ),
        );
      }

      pendingTaskStarts += 1;
      return yield* Effect.gen(function* () {
        const invocation = yield* options.registry
          .invoke({
            sessionId,
            handshakeId: handshake.handshakeId,
            taskId: input.task.taskId,
            runId: input.run.runId,
            agentId,
            operation: IDE_TASK_START_OPERATION,
            arguments: {
              taskId: input.task.taskId,
              runId: input.run.runId,
              agentId,
              runtimeId,
              projectId: input.task.projectId,
              parentTaskId: input.task.parentTaskId,
              dependsOnTaskIds: [...input.task.dependsOnTaskIds],
              mode: input.task.mode,
              assigneeKind: input.task.assigneeKind,
              assigneeId: input.task.assigneeId,
              prompt: input.prompt,
              workspaceRoot: input.workspaceRoot,
              workspaceRootDigest: input.workspaceRootDigest,
              model: input.model,
              capabilityGrantIds: [...(input.run.capabilityGrantIds ?? [])],
            },
          })
          .pipe(Effect.mapError((cause) => failure("ide_task_start_failed", errorDetail(cause))));
        const runtimeTaskId = stringFrom(recordFrom(invocation)?.runtimeTaskId);
        const status = resultStatus(invocation);
        if (runtimeTaskId === undefined || status === undefined) {
          return yield* Effect.fail(
            failure("ide_task_start_result_invalid", "IDE task.start 返回值格式无效。"),
          );
        }
        if (status === "already_terminal") {
          return yield* Effect.fail(
            failure("ide_task_already_terminal", "IDE task.start 返回任务已经处于终态。"),
          );
        }
        const binding = {
          taskId: input.task.taskId,
          runId: input.run.runId,
          runtimeTaskId,
          handshakeId: handshake.handshakeId,
        };
        activeRuns.set(input.run.runId, binding);
        if (remember(binding)) yield* releasePendingEventBinding(runtimeTaskId);
        return { runtimeTaskId, capabilityHandshakeId: handshake.handshakeId };
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            pendingTaskStarts -= 1;
          }),
        ),
      );
    });

  const cancelTask: CompositionAgentDriver["cancelTask"] = (input) =>
    Effect.gen(function* () {
      const binding = activeRuns.get(input.run.runId);
      const runtimeTaskId = input.run.runtimeTaskId ?? binding?.runtimeTaskId;
      const handshakeId = input.run.capabilityHandshakeId ?? binding?.handshakeId;
      if (runtimeTaskId === undefined || handshakeId === undefined) {
        return yield* Effect.fail(
          failure("ide_task_binding_missing", "IDE task 缺少 runtimeTaskId 或 handshakeId。"),
        );
      }
      const invocation = yield* options.registry
        .invoke({
          sessionId,
          handshakeId,
          taskId: input.task.taskId,
          runId: input.run.runId,
          agentId,
          operation: IDE_TASK_CANCEL_OPERATION,
          arguments: { runtimeTaskId, reason: input.reason },
        })
        .pipe(Effect.mapError((cause) => failure("ide_task_cancel_failed", errorDetail(cause))));
      const status = cancelStatus(invocation);
      if (status === undefined) {
        return yield* Effect.fail(
          failure("ide_task_cancel_result_invalid", "IDE task.cancel 返回值格式无效。"),
        );
      }
      if (status !== "cancel_requested") activeRuns.delete(input.run.runId);
      return { status };
    });

  const revokeCapabilityHandshake: NonNullable<
    CompositionAgentDriver["revokeCapabilityHandshake"]
  > = ({ run }) =>
    options.registry
      .revokeHandshake(run.capabilityHandshakeId ?? activeRuns.get(run.runId)?.handshakeId ?? "")
      .pipe(
        Effect.tap(() => Effect.sync(() => activeRuns.delete(run.runId))),
        Effect.asVoid,
        Effect.mapError((cause) => failure("ide_handshake_revoke_failed", errorDetail(cause))),
      );

  const streamEvents =
    options.eventStream === undefined
      ? undefined
      : () =>
          options.eventStream!().pipe(
            Stream.filter(
              (event) => event.raw?.source === "ide.jsonrpc" && event.raw.runtimeId === runtimeId,
            ),
            Stream.mapEffect(awaitRuntimeEventBinding),
            Stream.catchCause((cause) =>
              Stream.fromEffect(
                Effect.logError("IDE Agent Driver 任务事件流失败", {
                  sessionId,
                  runtimeId,
                  cause,
                }),
              ).pipe(Stream.drain),
            ),
          );

  return {
    agentId,
    runtimeId,
    getProfile,
    ...(streamEvents === undefined ? {} : { streamEvents }),
    startTask,
    cancelTask,
    revokeCapabilityHandshake,
    resolveRuntimeEvent: (event) => {
      if (event.raw?.source !== "ide.jsonrpc" || event.raw.runtimeId !== runtimeId) {
        return undefined;
      }
      const runtimeTaskId = runtimeTaskIdFromEvent(event);
      if (runtimeTaskId === undefined) return undefined;
      const binding = historicalRuns.get(runtimeTaskId);
      return binding === undefined || binding === null
        ? undefined
        : { taskId: binding.taskId, runId: binding.runId, runtimeTaskId };
    },
  };
};
