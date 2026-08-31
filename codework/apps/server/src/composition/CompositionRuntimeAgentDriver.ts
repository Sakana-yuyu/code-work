import type {
  CompositionAgentDriverProfile,
  CompositionRuntimeCapabilityHandshakeRequest,
  ProviderRuntimeEvent,
} from "@codework/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import {
  CompositionAgentDriverFailure,
  type CompositionAgentDriver,
} from "./CompositionOrchestrator.ts";
import type {
  CompositionRuntimeAdapter,
  CompositionRuntimeTaskInput,
} from "./CompositionRuntimeAdapter.ts";

export interface CompositionRuntimeAgentDriverOptions {
  readonly adapter: CompositionRuntimeAdapter;
  readonly agentId: string;
  readonly heartbeatFreshnessMs?: number;
}

export const defaultCompositionRuntimeHeartbeatFreshnessMs = 30_000;

type ActiveRun = {
  readonly taskId: string;
  readonly runId: string;
  readonly runtimeTaskId: string;
  readonly capabilityHandshakeId?: string;
  readonly lastDelegatedSourceMessageId?: number;
};

const maxHistoricalRuntimeBindings = 4096;

const errorDetail = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const makeFailure = (code: string, error: unknown) =>
  new CompositionAgentDriverFailure({ code, detail: errorDetail(error) });

const recordString = (value: unknown, key: string): string | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate : undefined;
};

const runtimeTaskIdFromEvent = (event: ProviderRuntimeEvent): string | undefined =>
  recordString(event.payload, "runtimeTaskId") ??
  recordString(event.payload, "taskId") ??
  recordString(event.raw?.payload, "runtimeTaskId") ??
  recordString(event.raw?.payload, "taskId");

export const makeCompositionRuntimeAgentDriver = (
  options: CompositionRuntimeAgentDriverOptions,
): CompositionAgentDriver => {
  const heartbeatFreshnessMs =
    options.heartbeatFreshnessMs ?? defaultCompositionRuntimeHeartbeatFreshnessMs;
  const activeRuns = new Map<string, ActiveRun>();
  // 活动表只负责当前生命周期；历史表用于终态后迟到事件的只读归属解析。
  // 设上限避免长期运行的 Runtime 因事件审计绑定无限增长。
  const historicalRuns = new Map<string, ActiveRun | null>();
  const startRecoveryPolicy = options.adapter.startRecoveryPolicy ?? {
    mode: "manual" as const,
    requiredReceipt: "runtime-task" as const,
    capabilityGrantReplay: { mode: "verified" as const },
  };
  const reconcileStart =
    options.adapter.reconcileStart === undefined
      ? undefined
      : (((input) =>
          options.adapter.reconcileStart!(input).pipe(
            Effect.mapError((failure) =>
              makeFailure("runtime_start_reconciliation_failed", failure),
            ),
          )) satisfies NonNullable<CompositionAgentDriver["reconcileStart"]>);
  const getStartIdentity =
    options.adapter.getStartIdentity === undefined
      ? undefined
      : (((input) => options.adapter.getStartIdentity!(input)) satisfies NonNullable<
          CompositionAgentDriver["getStartIdentity"]
        >);

  const hasHistoricalBindingConflict = (run: ActiveRun): boolean => {
    const existing = historicalRuns.get(run.runtimeTaskId);
    return (
      existing !== undefined &&
      (existing === null || existing.taskId !== run.taskId || existing.runId !== run.runId)
    );
  };

  const rememberRun = (run: ActiveRun): void => {
    historicalRuns.delete(run.runtimeTaskId);
    historicalRuns.set(run.runtimeTaskId, run);
    while (historicalRuns.size > maxHistoricalRuntimeBindings) {
      const oldest = historicalRuns.keys().next().value;
      if (oldest === undefined) break;
      historicalRuns.delete(oldest);
    }
  };

  const getProfile: NonNullable<CompositionAgentDriver["getProfile"]> = () =>
    Effect.gen(function* () {
      const probe = yield* options.adapter.probe();
      const agents = yield* options.adapter.listAgents();
      const agent = agents.find((candidate) => candidate.agentId === options.agentId);
      const agentScopeMismatch =
        agent !== undefined && agent.runtimeId !== options.adapter.runtimeId;
      const status =
        agent === undefined || agentScopeMismatch
          ? "offline"
          : probe.status === "online"
            ? agent.status
            : probe.status;
      const capabilities = [
        ...new Set([...(probe.capabilities ?? []), ...(agent?.capabilities ?? [])]),
      ];
      const supportsCapabilityHandshake =
        options.adapter.handshakeCapabilities !== undefined &&
        capabilities.includes("t3.capability_handshake");
      const supportsToolBroker =
        capabilities.includes("t3.toolbroker") && supportsCapabilityHandshake;
      const profileStatus =
        status === "online"
          ? supportsToolBroker
            ? "available"
            : "degraded"
          : status === "unstable"
            ? "degraded"
            : "unavailable";
      const profileReasonCode =
        agent === undefined
          ? "runtime_agent_unavailable"
          : agentScopeMismatch
            ? "runtime_agent_scope_mismatch"
            : profileStatus === "available"
              ? undefined
              : probe.status !== "online"
                ? (probe.reasonCode ?? `runtime_${probe.status}`)
                : agent.status !== "online"
                  ? `runtime_agent_${agent.status}`
                  : !supportsCapabilityHandshake
                    ? "runtime_capability_handshake_unsupported"
                    : "runtime_toolbroker_unsupported";
      return {
        schemaVersion: 1,
        agentId: options.agentId,
        runtimeId: options.adapter.runtimeId,
        driverKind: options.adapter.driverKind,
        ...(agent?.displayName === undefined ? {} : { displayName: agent.displayName }),
        status: profileStatus,
        capabilities,
        supportsToolBroker,
        supportsCapabilityHandshake,
        supportsWorkspace: supportsToolBroker && capabilities.includes("t3.workspace"),
        supportsTerminal: supportsToolBroker && capabilities.includes("t3.terminal"),
        supportsGit: supportsToolBroker && capabilities.includes("t3.git"),
        supportsMcp: supportsToolBroker && probe.supportsMcp,
        supportsBrowser: supportsToolBroker && capabilities.includes("t3.browser"),
        supportsIde: supportsToolBroker && capabilities.includes("t3.ide"),
        supportsProviderApi: supportsToolBroker && capabilities.includes("t3.provider_api"),
        supportsResume: probe.supportsResume,
        supportsSquad: capabilities.includes("squad"),
        supportsLeader: capabilities.includes("leader"),
        supportsTaskGraph: capabilities.includes("task-graph"),
        ...(profileReasonCode === undefined ? {} : { reasonCode: profileReasonCode }),
      } satisfies CompositionAgentDriverProfile;
    }).pipe(
      Effect.orElseSucceed(
        () =>
          ({
            schemaVersion: 1,
            agentId: options.agentId,
            runtimeId: options.adapter.runtimeId,
            driverKind: options.adapter.driverKind,
            status: "unavailable" as const,
            capabilities: [],
            supportsToolBroker: false,
            supportsCapabilityHandshake: false,
            supportsWorkspace: false,
            supportsTerminal: false,
            supportsGit: false,
            supportsMcp: false,
            supportsBrowser: false,
            supportsIde: false,
            supportsProviderApi: false,
            supportsResume: false,
            supportsSquad: false,
            supportsLeader: false,
            supportsTaskGraph: false,
            reasonCode: "runtime_profile_failed",
          }) satisfies CompositionAgentDriverProfile,
      ),
    );

  const startTask: CompositionAgentDriver["startTask"] = (input) => {
    const capabilityGrantIds = [...(input.run.capabilityGrantIds ?? [])];

    return Effect.gen(function* () {
      const probe = yield* options.adapter
        .probe()
        .pipe(Effect.mapError((failure) => makeFailure("runtime_probe_failed", failure)));
      if (probe.status !== "online") {
        return yield* new CompositionAgentDriverFailure({
          code: probe.reasonCode ?? `runtime_${probe.status}`,
          detail: `Runtime '${options.adapter.runtimeId}' 当前状态为 ${probe.status}，拒绝派发。`,
        });
      }

      const heartbeat = yield* options.adapter
        .heartbeat()
        .pipe(Effect.mapError((failure) => makeFailure("runtime_heartbeat_failed", failure)));
      if (heartbeat.runtimeId !== options.adapter.runtimeId) {
        return yield* new CompositionAgentDriverFailure({
          code: "runtime_heartbeat_scope_mismatch",
          detail: `Runtime 心跳属于 '${heartbeat.runtimeId}'，不能用于 '${options.adapter.runtimeId}' 派发。`,
        });
      }
      if (heartbeat.status !== "online") {
        return yield* new CompositionAgentDriverFailure({
          code: `runtime_${heartbeat.status}`,
          detail: `Runtime '${options.adapter.runtimeId}' 心跳状态为 ${heartbeat.status}，拒绝派发。`,
        });
      }
      const nowUnixMs = yield* Clock.currentTimeMillis;
      if (!Number.isSafeInteger(heartbeat.heartbeatAtUnixMs) || heartbeat.heartbeatAtUnixMs < 0) {
        return yield* new CompositionAgentDriverFailure({
          code: "runtime_heartbeat_invalid",
          detail: `Runtime '${options.adapter.runtimeId}' 返回了非法心跳时间。`,
        });
      }
      if (heartbeat.heartbeatAtUnixMs < nowUnixMs - heartbeatFreshnessMs) {
        return yield* new CompositionAgentDriverFailure({
          code: "runtime_heartbeat_stale",
          detail: `Runtime '${options.adapter.runtimeId}' 心跳已超过 ${heartbeatFreshnessMs}ms 新鲜度窗口。`,
        });
      }

      const agents = yield* options.adapter
        .listAgents()
        .pipe(Effect.mapError((failure) => makeFailure("runtime_agent_list_failed", failure)));
      const agent = agents.find((candidate) => candidate.agentId === options.agentId);
      if (agent === undefined) {
        return yield* new CompositionAgentDriverFailure({
          code: "runtime_agent_unavailable",
          detail: `Runtime '${options.adapter.runtimeId}' 未声明目标 Agent '${options.agentId}'。`,
        });
      }
      if (agent.runtimeId !== options.adapter.runtimeId) {
        return yield* new CompositionAgentDriverFailure({
          code: "runtime_agent_scope_mismatch",
          detail: `Agent '${options.agentId}' 属于 Runtime '${agent.runtimeId}'，不能由 '${options.adapter.runtimeId}' 派发。`,
        });
      }
      if (agent.status !== "online") {
        return yield* new CompositionAgentDriverFailure({
          code: `runtime_agent_${agent.status}`,
          detail: `Agent '${options.agentId}' 当前状态为 ${agent.status}，拒绝派发。`,
        });
      }

      let capabilityHandshakeId: string | undefined;
      if (capabilityGrantIds.length > 0) {
        const handshake = options.adapter.handshakeCapabilities;
        if (handshake === undefined) {
          return yield* new CompositionAgentDriverFailure({
            code: "runtime_capability_handshake_unsupported",
            detail: "Runtime 没有提供 capability handshake，拒绝派发带 grant 的任务。",
          });
        }
        const request: CompositionRuntimeCapabilityHandshakeRequest = {
          runtimeId: options.adapter.runtimeId,
          taskId: input.task.taskId,
          runId: input.run.runId,
          agentId: options.agentId,
          capabilityGrantIds,
        };
        const result = yield* handshake(request).pipe(
          Effect.mapError((failure) => makeFailure("runtime_capability_handshake_failed", failure)),
        );
        const missingGrantIds = capabilityGrantIds.filter(
          (grantId) => !result.acceptedGrantIds.includes(grantId),
        );
        if (
          result.status !== "accepted" ||
          result.handshakeId === undefined ||
          missingGrantIds.length > 0
        ) {
          return yield* new CompositionAgentDriverFailure({
            code: result.reasonCode ?? "runtime_capability_handshake_rejected",
            detail: `Runtime 未接受全部 capability grant${
              missingGrantIds.length === 0 ? "。" : `：${missingGrantIds.join(",")}`
            }`,
          });
        }
        capabilityHandshakeId = result.handshakeId;
      }

      const runtimeInput: CompositionRuntimeTaskInput = {
        taskId: input.task.taskId,
        runId: input.run.runId,
        agentId: options.agentId,
        projectId: input.task.projectId,
        ...(input.task.parentTaskId === undefined ? {} : { parentTaskId: input.task.parentTaskId }),
        dependsOnTaskIds: [...input.task.dependsOnTaskIds],
        mode: input.task.mode,
        assigneeKind: input.task.assigneeKind,
        assigneeId: input.task.assigneeId,
        idempotencyKey: input.run.runId,
        ...(input.workspaceRootDigest === undefined
          ? {}
          : { workspaceRootDigest: input.workspaceRootDigest }),
        ...(input.workspaceRoot === undefined ? {} : { workspaceRoot: input.workspaceRoot }),
        ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
        ...(input.model === undefined ? {} : { model: input.model }),
        capabilityGrantIds,
        ...(capabilityHandshakeId === undefined ? {} : { capabilityHandshakeId }),
        promptDigest: input.task.promptDigest,
      };

      return yield* options.adapter.dispatchTask(runtimeInput).pipe(
        Effect.mapError((failure) => makeFailure(failure.code, failure)),
        Effect.tapError(() =>
          capabilityHandshakeId === undefined ||
          options.adapter.revokeCapabilityHandshake === undefined
            ? Effect.void
            : options.adapter
                .revokeCapabilityHandshake({ handshakeId: capabilityHandshakeId })
                .pipe(Effect.ignore),
        ),
        Effect.flatMap((result) => {
          const binding = {
            taskId: input.task.taskId,
            runId: input.run.runId,
            runtimeTaskId: result.runtimeTaskId,
            ...(capabilityHandshakeId === undefined ? {} : { capabilityHandshakeId }),
          } satisfies ActiveRun;
          if (hasHistoricalBindingConflict(binding)) {
            const revoke =
              capabilityHandshakeId === undefined ||
              options.adapter.revokeCapabilityHandshake === undefined
                ? Effect.void
                : options.adapter
                    .revokeCapabilityHandshake({ handshakeId: capabilityHandshakeId })
                    .pipe(Effect.ignore);
            return revoke.pipe(
              Effect.andThen(
                Effect.fail(
                  new CompositionAgentDriverFailure({
                    code: "runtime_task_binding_conflict",
                    detail: "Runtime 返回的 runtimeTaskId 已绑定到其他 Task/Run，拒绝覆盖。",
                  }),
                ),
              ),
            );
          }
          return Effect.sync(() => {
            activeRuns.set(input.run.runId, binding);
            rememberRun(binding);
            return {
              runtimeTaskId: result.runtimeTaskId,
              ...(capabilityHandshakeId === undefined ? {} : { capabilityHandshakeId }),
            };
          });
        }),
      );
    });
  };

  const revokeCapabilityHandshake: CompositionAgentDriver["revokeCapabilityHandshake"] = ({
    run,
  }) => {
    const removeActiveRun = Effect.sync(() => activeRuns.delete(run.runId));
    if (run.capabilityHandshakeId === undefined) return removeActiveRun;
    if (options.adapter.revokeCapabilityHandshake === undefined) {
      return Effect.fail(
        new CompositionAgentDriverFailure({
          code: "runtime_capability_handshake_revoke_unsupported",
          detail: "Runtime 没有提供 capability handshake 撤销接口。",
        }),
      ).pipe(Effect.ensuring(removeActiveRun));
    }
    return options.adapter
      .revokeCapabilityHandshake({
        handshakeId: run.capabilityHandshakeId,
      })
      .pipe(
        Effect.mapError((failure) => makeFailure(failure.code, failure)),
        Effect.ensuring(removeActiveRun),
      );
  };

  const cancelTask: CompositionAgentDriver["cancelTask"] = (input) =>
    options.adapter
      .cancelTask({
        taskId: input.task.taskId,
        runId: input.run.runId,
        ...(input.run.runtimeTaskId === undefined
          ? {}
          : { runtimeTaskId: input.run.runtimeTaskId }),
      })
      .pipe(
        Effect.mapError((failure) => makeFailure(failure.code, failure)),
        Effect.tap((result) =>
          Effect.sync(() => {
            if (result.status !== "cancel_requested") activeRuns.delete(input.run.runId);
          }),
        ),
        Effect.map((result) => ({ status: result.status })),
      );

  const resumeTask: NonNullable<CompositionAgentDriver["resumeTask"]> = (input) =>
    options.adapter
      .resumeTask({
        taskId: input.task.taskId,
        runId: input.run.runId,
        ...(input.run.runtimeTaskId === undefined
          ? {}
          : { runtimeTaskId: input.run.runtimeTaskId }),
      })
      .pipe(
        Effect.mapError((failure) => makeFailure(failure.code, failure)),
        Effect.flatMap((result) =>
          input.run.runtimeTaskId !== undefined && result.runtimeTaskId !== input.run.runtimeTaskId
            ? Effect.fail(
                new CompositionAgentDriverFailure({
                  code: "runtime_task_binding_conflict",
                  detail: "Runtime 恢复返回的 runtimeTaskId 与当前 Run 不一致。",
                }),
              )
            : Effect.succeed({ status: result.status }),
        ),
      );

  return {
    agentId: options.agentId,
    runtimeId: options.adapter.runtimeId,
    startRecoveryPolicy,
    ...(getStartIdentity === undefined ? {} : { getStartIdentity }),
    ...(reconcileStart === undefined ? {} : { reconcileStart }),
    getProfile,
    startTask,
    revokeCapabilityHandshake,
    cancelTask,
    resumeTask,
    resolveRuntimeEvent: (event) => {
      if (event.raw?.runtimeId !== undefined && event.raw.runtimeId !== options.adapter.runtimeId) {
        return undefined;
      }
      const delegatedExecution = event.raw?.delegatedExecution;
      if (delegatedExecution !== undefined) {
        const raw = event.raw;
        const runtimeTaskId = raw?.runtimeTaskId;
        if (
          raw?.runtimeId === undefined ||
          runtimeTaskId === undefined ||
          delegatedExecution.executionId !== runtimeTaskId
        ) {
          return undefined;
        }
        const binding = historicalRuns.get(runtimeTaskId);
        if (
          binding === undefined ||
          binding === null ||
          binding.runtimeTaskId !== delegatedExecution.executionId
        ) {
          return undefined;
        }
        const sourceMessageId = delegatedExecution.sourceMessageId;
        if (sourceMessageId !== undefined) {
          const previousSourceMessageId = binding.lastDelegatedSourceMessageId;
          if (previousSourceMessageId !== undefined && sourceMessageId < previousSourceMessageId) {
            return undefined;
          }
          if (previousSourceMessageId === undefined || sourceMessageId > previousSourceMessageId) {
            historicalRuns.set(runtimeTaskId, {
              ...binding,
              lastDelegatedSourceMessageId: sourceMessageId,
            });
          }
        }
        return {
          taskId: binding.taskId,
          runId: binding.runId,
          runtimeTaskId: binding.runtimeTaskId,
        };
      }
      const runtimeTaskId = runtimeTaskIdFromEvent(event);
      if (runtimeTaskId === undefined) return undefined;
      const binding = historicalRuns.get(runtimeTaskId);
      return binding === undefined || binding === null
        ? undefined
        : {
            taskId: binding.taskId,
            runId: binding.runId,
            runtimeTaskId: binding.runtimeTaskId,
          };
    },
  };
};
