import type {
  CompositionTask,
  CompositionTaskRun,
  CompositionToolResult,
} from "@codework/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  CompositionTaskInputStore,
  type CompositionTaskInputStoreShape,
} from "../persistence/Services/CompositionTaskInputStore.ts";
import {
  CompositionTaskStore,
  type CompositionTaskStoreShape,
} from "../persistence/Services/CompositionTaskStore.ts";
import * as ToolBroker from "./ToolBroker.ts";

/** 外部 Runtime 请求 Code Work 执行一次 canonical tool 的输入。 */
export type CompositionRuntimeToolInvocation = {
  readonly runtimeId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly capabilityHandshakeId?: string | undefined;
  readonly toolCallId: string;
  readonly canonicalToolName: string;
  readonly arguments: unknown;
  readonly idempotencyKey: string;
  readonly capabilityGrantIds: ReadonlyArray<string>;
  readonly approvalRequestId?: string | undefined;
};

export type CompositionRuntimeToolCancellation = Pick<
  CompositionRuntimeToolInvocation,
  | "runtimeId"
  | "taskId"
  | "runId"
  | "agentId"
  | "capabilityHandshakeId"
  | "toolCallId"
  | "canonicalToolName"
  | "idempotencyKey"
  | "capabilityGrantIds"
>;

export type CompositionRuntimeToolBridgeDependencies = {
  readonly taskStore: Pick<CompositionTaskStoreShape, "getTask" | "getRun">;
  readonly inputStore: Pick<CompositionTaskInputStoreShape, "get">;
  readonly toolBroker: Pick<ToolBroker.ToolBroker["Service"], "invoke" | "cancel">;
};

export type CompositionRuntimeToolBridgeShape = {
  readonly invoke: (
    input: CompositionRuntimeToolInvocation,
  ) => Effect.Effect<ToolBroker.ToolBrokerResult>;
  readonly cancel: (
    input: CompositionRuntimeToolCancellation,
  ) => Effect.Effect<CompositionToolResult>;
};

export class CompositionRuntimeToolBridgeService extends Context.Service<
  CompositionRuntimeToolBridgeService,
  CompositionRuntimeToolBridgeShape
>()("codework/composition/CompositionRuntimeToolBridge/CompositionRuntimeToolBridgeService") {}

type ScopeCheck =
  | {
      readonly ok: true;
      readonly task: CompositionTask;
      readonly run: CompositionTaskRun;
    }
  | {
      readonly ok: false;
      readonly errorCode: string;
    };

type ValidatedScope = Extract<ScopeCheck, { readonly ok: true }>;

const invocationId = (idempotencyKey: string): string => `invocation-${idempotencyKey}`;

const denied = (
  input: Pick<
    CompositionRuntimeToolInvocation,
    "taskId" | "runId" | "toolCallId" | "canonicalToolName" | "idempotencyKey"
  >,
  errorCode: string,
): CompositionToolResult => ({
  invocationId: invocationId(input.idempotencyKey),
  taskId: input.taskId,
  runId: input.runId,
  toolCallId: input.toolCallId,
  canonicalToolName: input.canonicalToolName,
  status: "denied",
  errorCode,
});

const failed = (
  input: Pick<
    CompositionRuntimeToolInvocation,
    "taskId" | "runId" | "toolCallId" | "canonicalToolName" | "idempotencyKey"
  >,
  errorCode: string,
): CompositionToolResult => ({
  invocationId: invocationId(input.idempotencyKey),
  taskId: input.taskId,
  runId: input.runId,
  toolCallId: input.toolCallId,
  canonicalToolName: input.canonicalToolName,
  status: "failed",
  errorCode,
});

const sameStringSet = (left: readonly string[], right: readonly string[]): boolean => {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size && [...leftSet].every((value) => rightSet.has(value));
};

const RecordSchema = Schema.Record(Schema.String, Schema.Unknown);

const trustedToolArguments = (argumentsValue: unknown, workspaceRoot: string): unknown => {
  if (!Schema.is(RecordSchema)(argumentsValue)) return argumentsValue;
  return { ...argumentsValue, cwd: workspaceRoot };
};

type ActiveInvocation = {
  readonly scope: CompositionRuntimeToolCancellation;
  readonly cancellation: Deferred.Deferred<void>;
  readonly terminal: Deferred.Deferred<CompositionToolResult>;
};

type ActiveInvocationClaim =
  | {
      readonly claimed: true;
      readonly activeInvocation: ActiveInvocation;
    }
  | {
      readonly claimed: false;
      readonly result: CompositionToolResult;
    };

const sameInvocationScope = (
  left: CompositionRuntimeToolCancellation,
  right: CompositionRuntimeToolCancellation,
): boolean =>
  left.runtimeId === right.runtimeId &&
  left.taskId === right.taskId &&
  left.runId === right.runId &&
  left.agentId === right.agentId &&
  left.capabilityHandshakeId === right.capabilityHandshakeId &&
  left.toolCallId === right.toolCallId &&
  left.canonicalToolName === right.canonicalToolName &&
  sameStringSet(left.capabilityGrantIds, right.capabilityGrantIds);

const cancelled = (
  input: Pick<
    CompositionRuntimeToolInvocation,
    "taskId" | "runId" | "toolCallId" | "canonicalToolName" | "idempotencyKey"
  >,
): CompositionToolResult => ({
  invocationId: invocationId(input.idempotencyKey),
  taskId: input.taskId,
  runId: input.runId,
  toolCallId: input.toolCallId,
  canonicalToolName: input.canonicalToolName,
  status: "cancelled",
});

export const makeCompositionRuntimeToolBridge = (
  dependencies: CompositionRuntimeToolBridgeDependencies,
): CompositionRuntimeToolBridgeShape => {
  const activeInvocations = new Map<string, ActiveInvocation>();

  const validateScope = (
    input: CompositionRuntimeToolInvocation | CompositionRuntimeToolCancellation,
  ): Effect.Effect<ScopeCheck> =>
    Effect.gen(function* () {
      if (
        input.runtimeId.trim().length === 0 ||
        input.taskId.trim().length === 0 ||
        input.runId.trim().length === 0 ||
        input.agentId.trim().length === 0 ||
        input.idempotencyKey.trim().length === 0
      ) {
        return { ok: false, errorCode: "invalid_input" } as const;
      }

      const taskOption = yield* dependencies.taskStore
        .getTask(input.taskId)
        .pipe(Effect.catch(() => Effect.succeed(Option.none())));
      if (Option.isNone(taskOption)) {
        return { ok: false, errorCode: "task_not_found" } as const;
      }

      const runOption = yield* dependencies.taskStore
        .getRun(input.runId)
        .pipe(Effect.catch(() => Effect.succeed(Option.none())));
      if (Option.isNone(runOption)) {
        return { ok: false, errorCode: "run_not_found" } as const;
      }

      const task = taskOption.value;
      const run = runOption.value;
      if (run.taskId !== input.taskId) {
        return { ok: false, errorCode: "run_scope_mismatch" } as const;
      }
      if (run.runtimeId !== input.runtimeId) {
        return { ok: false, errorCode: "runtime_scope_mismatch" } as const;
      }
      if (run.agentId !== input.agentId) {
        return { ok: false, errorCode: "agent_scope_mismatch" } as const;
      }
      if (task.assigneeKind === "agent" && task.assigneeId !== input.agentId) {
        return { ok: false, errorCode: "agent_scope_mismatch" } as const;
      }
      if (task.status !== "running") {
        return { ok: false, errorCode: "task_not_running" } as const;
      }
      if (run.status !== "running") {
        return { ok: false, errorCode: "run_not_running" } as const;
      }

      const expectedHandshakeId = run.capabilityHandshakeId;
      if (expectedHandshakeId !== input.capabilityHandshakeId) {
        return { ok: false, errorCode: "capability_handshake_mismatch" } as const;
      }
      if (!sameStringSet(run.capabilityGrantIds, input.capabilityGrantIds)) {
        return { ok: false, errorCode: "capability_scope_mismatch" } as const;
      }

      return { ok: true, task, run } as const;
    });

  const invoke: CompositionRuntimeToolBridgeShape["invoke"] = (input) =>
    Effect.gen(function* () {
      const scope = yield* validateScope(input);
      if (!scope.ok) return denied(input, scope.errorCode);

      const cancellationScope: CompositionRuntimeToolCancellation = input;
      return yield* Effect.acquireUseRelease(
        Effect.gen(function* () {
          const cancellation = yield* Deferred.make<void>();
          const terminal = yield* Deferred.make<CompositionToolResult>();
          return yield* Effect.sync((): ActiveInvocationClaim => {
            const existing = activeInvocations.get(input.idempotencyKey);
            if (existing !== undefined) {
              return {
                claimed: false,
                result: sameInvocationScope(existing.scope, cancellationScope)
                  ? failed(input, "tool_invocation_in_progress")
                  : denied(input, "tool_invocation_scope_conflict"),
              };
            }
            const activeInvocation: ActiveInvocation = {
              scope: cancellationScope,
              cancellation,
              terminal,
            };
            activeInvocations.set(input.idempotencyKey, activeInvocation);
            return { claimed: true, activeInvocation };
          });
        }),
        (claim) => {
          if (!claim.claimed) return Effect.succeed(claim.result);
          const activeInvocation = claim.activeInvocation;
          const execute = Effect.gen(function* () {
            const inputOption = yield* dependencies.inputStore
              .get(input.taskId)
              .pipe(Effect.catch(() => Effect.succeed(Option.none())));
            if (Option.isNone(inputOption) || inputOption.value.taskId !== input.taskId) {
              return denied(input, "workspace_input_missing");
            }
            const workspaceRoot = inputOption.value.workspaceRoot.trim();
            if (workspaceRoot.length === 0) {
              return denied(input, "workspace_input_missing");
            }

            return yield* dependencies.toolBroker
              .invoke({
                taskId: input.taskId,
                runId: input.runId,
                agentId: input.agentId,
                toolCallId: input.toolCallId,
                canonicalToolName: input.canonicalToolName,
                arguments: trustedToolArguments(input.arguments, workspaceRoot),
                idempotencyKey: input.idempotencyKey,
                capabilityGrantIds: input.capabilityGrantIds,
                runtimeId: input.runtimeId,
                ...(scope.task.threadId === undefined ? {} : { threadId: scope.task.threadId }),
                ...(input.approvalRequestId === undefined
                  ? {}
                  : { approvalRequestId: input.approvalRequestId }),
                workspaceRoot,
              })
              .pipe(
                Effect.catch(() =>
                  Effect.succeed(
                    denied(input, "tool_broker_failed") as ToolBroker.ToolBrokerResult,
                  ),
                ),
              );
          });

          return Effect.raceFirst(
            Deferred.await(activeInvocation.cancellation).pipe(Effect.as(cancelled(input))),
            execute,
          );
        },
        (claim, exit) => {
          if (!claim.claimed) return Effect.void;
          const activeInvocation = claim.activeInvocation;
          const terminalEffect =
            Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
              ? Effect.succeed(cancelled(input))
              : Exit.isSuccess(exit)
                ? Effect.succeed(exit.value)
                : Effect.failCause(exit.cause);
          return Effect.sync(() => {
            Deferred.doneUnsafe(activeInvocation.terminal, terminalEffect);
            if (activeInvocations.get(input.idempotencyKey) === activeInvocation) {
              activeInvocations.delete(input.idempotencyKey);
            }
          });
        },
      );
    });

  const cancel: CompositionRuntimeToolBridgeShape["cancel"] = (input) =>
    Effect.gen(function* () {
      const scope = yield* validateScope(input);
      if (!scope.ok) return denied(input, scope.errorCode);

      const activeInvocation = activeInvocations.get(input.idempotencyKey);
      if (activeInvocation === undefined) return denied(input, "tool_invocation_not_found");
      if (!sameInvocationScope(activeInvocation.scope, input)) {
        return denied(input, "tool_invocation_scope_mismatch");
      }
      yield* Deferred.succeed(activeInvocation.cancellation, undefined);
      return yield* Deferred.await(activeInvocation.terminal);
    });

  return { invoke, cancel };
};

const live = Effect.gen(function* () {
  const taskStore = yield* CompositionTaskStore;
  const inputStore = yield* CompositionTaskInputStore;
  const toolBroker = yield* ToolBroker.ToolBroker;
  return makeCompositionRuntimeToolBridge({
    taskStore,
    inputStore,
    toolBroker,
  });
});

export const layer = Layer.effect(CompositionRuntimeToolBridgeService, live);
