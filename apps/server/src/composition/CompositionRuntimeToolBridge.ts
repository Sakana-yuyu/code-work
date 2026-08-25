import type {
  CompositionTask,
  CompositionTaskRun,
  CompositionToolResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
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

/** 外部 Runtime 请求 T3 执行一次 canonical tool 的输入。 */
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
>()("t3/composition/CompositionRuntimeToolBridge/CompositionRuntimeToolBridgeService") {}

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

export const makeCompositionRuntimeToolBridge = (
  dependencies: CompositionRuntimeToolBridgeDependencies,
): CompositionRuntimeToolBridgeShape => {
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
          ...(input.approvalRequestId === undefined
            ? {}
            : { approvalRequestId: input.approvalRequestId }),
          workspaceRoot,
        })
        .pipe(
          Effect.catch(() =>
            Effect.succeed(denied(input, "tool_broker_failed") as ToolBroker.ToolBrokerResult),
          ),
        );
    });

  const cancel: CompositionRuntimeToolBridgeShape["cancel"] = (input) =>
    Effect.gen(function* () {
      const scope = yield* validateScope(input);
      if (!scope.ok) return denied(input, scope.errorCode);

      yield* dependencies.toolBroker
        .cancel({ idempotencyKey: input.idempotencyKey })
        .pipe(Effect.catch(() => Effect.void));
      return {
        invocationId: invocationId(input.idempotencyKey),
        taskId: input.taskId,
        runId: input.runId,
        toolCallId: input.toolCallId,
        canonicalToolName: input.canonicalToolName,
        status: "cancelled" as const,
      };
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
