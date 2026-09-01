import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import {
  CompositionRunStartStore,
  type CompositionRunStartIntent,
  type CompositionRunStartStoreError,
  type CompositionRunStartStoreShape,
} from "../persistence/Services/CompositionRunStartStore.ts";
import {
  CompositionTaskInputStore,
  type CompositionTaskInputStoreError,
  type CompositionTaskInputStoreShape,
  type CompositionTaskRecoveryInput,
} from "../persistence/Services/CompositionTaskInputStore.ts";
import {
  CompositionTaskStore,
  type CompositionTaskStoreError,
  type CompositionTaskStoreShape,
} from "../persistence/Services/CompositionTaskStore.ts";
import {
  CompositionAgentDriverRegistryService,
  type CompositionAgentDriverRegistry,
} from "./CompositionAgentDriverRegistry.ts";
import type * as CapabilityGrantRegistry from "./CapabilityGrantRegistry.ts";
import type { CompositionAgentDriverFailure } from "./CompositionOrchestrator.ts";
import { CompositionOrchestratorService } from "./CompositionOrchestratorService.ts";
import {
  planCompositionRunStartRecoveries,
  type CompositionRunStartRecoveryCandidate,
  type CompositionRunStartRecoveryPlan,
  type CompositionRunStartRecoveryReconciliation,
} from "./CompositionRunStartRecoveryPolicy.ts";

export type CompositionRunStartStartupRecoveryOutcome = CompositionRunStartRecoveryPlan;

export type CompositionRunStartStartupRecoveryExecutor = {
  readonly execute: (input: {
    readonly candidate: CompositionRunStartRecoveryCandidate;
    readonly recoveryInput: CompositionTaskRecoveryInput;
    readonly plan: CompositionRunStartRecoveryPlan;
  }) => Effect.Effect<
    CompositionRunStartStartupRecoveryOutcome,
    | CompositionAgentDriverFailure
    | CompositionRunStartStoreError
    | CompositionTaskStoreError
    | CapabilityGrantRegistry.CapabilityGrantPersistenceError
  >;
  readonly recordUnrecoverable: (input: {
    readonly intent: CompositionRunStartIntent;
    readonly code: string;
    readonly detail: string;
  }) => Effect.Effect<
    CompositionRunStartStartupRecoveryOutcome,
    CompositionRunStartStoreError | CompositionTaskStoreError
  >;
};

export interface CompositionRunStartStartupRecoveryOptions {
  readonly runStartStore: Pick<
    CompositionRunStartStoreShape,
    "getRecoverableScanUpperBound" | "listRecoverable"
  >;
  readonly taskStore: Pick<CompositionTaskStoreShape, "getTask" | "getRun">;
  readonly inputStore: Pick<CompositionTaskInputStoreShape, "get">;
  readonly driverRegistry: CompositionAgentDriverRegistry;
  readonly reconciled: ReadonlySet<CompositionRunStartRecoveryReconciliation>;
  readonly executor: CompositionRunStartStartupRecoveryExecutor;
}

export type CompositionRunStartStartupRecoveryReceipt = {
  readonly type: "composition.run_starts.recovered";
  readonly recoveredAtUnixMs: number;
  readonly plans: ReadonlyArray<CompositionRunStartStartupRecoveryOutcome>;
  readonly nextRecoveryAtUnixMs?: number;
};

export interface CompositionRunStartStartupReconciliationShape {
  readonly get: Effect.Effect<ReadonlySet<CompositionRunStartRecoveryReconciliation>>;
  readonly replace: (
    reconciled: ReadonlySet<CompositionRunStartRecoveryReconciliation>,
  ) => Effect.Effect<void>;
}

export class CompositionRunStartStartupReconciliation extends Context.Service<
  CompositionRunStartStartupReconciliation,
  CompositionRunStartStartupReconciliationShape
>()(
  "codework/composition/CompositionRunStartStartupRecovery/CompositionRunStartStartupReconciliation",
) {}

export const CompositionRunStartStartupReconciliationLive = Layer.effect(
  CompositionRunStartStartupReconciliation,
  Effect.gen(function* () {
    const state = yield* Ref.make<ReadonlySet<CompositionRunStartRecoveryReconciliation>>(
      new Set(),
    );
    return {
      get: Ref.get(state),
      replace: (reconciled) => Ref.set(state, new Set(reconciled)),
    } satisfies CompositionRunStartStartupReconciliationShape;
  }),
);

type StartupRecoveryError =
  | CompositionRunStartStoreError
  | CompositionTaskStoreError
  | CompositionTaskInputStoreError
  | CompositionAgentDriverFailure
  | CapabilityGrantRegistry.CapabilityGrantPersistenceError;

export class CompositionRunStartStartupRecovery extends Context.Service<
  CompositionRunStartStartupRecovery,
  {
    readonly awaitRecovered: Effect.Effect<
      CompositionRunStartStartupRecoveryReceipt,
      StartupRecoveryError
    >;
  }
>()("codework/composition/CompositionRunStartStartupRecovery") {
  static readonly layer = Layer.effect(
    CompositionRunStartStartupRecovery,
    Effect.gen(function* () {
      const runStartStore = yield* CompositionRunStartStore;
      const taskStore = yield* CompositionTaskStore;
      const inputStore = yield* CompositionTaskInputStore;
      const driverRegistry = yield* CompositionAgentDriverRegistryService;
      const orchestrator = yield* CompositionOrchestratorService;
      const reconciliation = yield* CompositionRunStartStartupReconciliation;
      const recover = () =>
        reconciliation.get.pipe(
          Effect.flatMap((reconciled) =>
            recoverCompositionRunStarts({
              runStartStore,
              taskStore,
              inputStore,
              driverRegistry,
              reconciled,
              executor: {
                execute: orchestrator.recoverPersistedRunStart,
                recordUnrecoverable: orchestrator.recordPersistedRunStartRecoveryProblem,
              },
            }),
          ),
        );
      return CompositionRunStartStartupRecovery.of({
        awaitRecovered: recover(),
      });
    }),
  );
}

const candidateFailure = (input: {
  readonly intent: CompositionRunStartIntent;
  readonly code: string;
  readonly detail: string;
  readonly executor: CompositionRunStartStartupRecoveryExecutor;
}) => input.executor.recordUnrecoverable(input);

const recoverCandidate = (
  options: CompositionRunStartStartupRecoveryOptions,
  intent: CompositionRunStartIntent,
) =>
  Effect.gen(function* () {
    const taskOption = yield* options.taskStore.getTask(intent.taskId);
    if (Option.isNone(taskOption)) {
      return yield* candidateFailure({
        intent,
        code: "run_start_recovery_task_missing",
        detail: "持久 Run Start 意图对应的 Task 不存在，已停止自动恢复。",
        executor: options.executor,
      });
    }

    const runOption = yield* options.taskStore.getRun(intent.runId);
    if (Option.isNone(runOption)) {
      return yield* candidateFailure({
        intent,
        code: "run_start_recovery_run_missing",
        detail: "持久 Run Start 意图对应的 Run 不存在，已停止自动恢复。",
        executor: options.executor,
      });
    }

    const recoveryInputOption = yield* options.inputStore.get(intent.taskId);
    if (Option.isNone(recoveryInputOption)) {
      return yield* candidateFailure({
        intent,
        code: "run_start_recovery_input_missing",
        detail: "持久 Run Start 意图缺少加密恢复输入，已停止自动恢复。",
        executor: options.executor,
      });
    }
    const recoveryInput = recoveryInputOption.value;
    if (recoveryInput.taskId !== intent.taskId) {
      return yield* candidateFailure({
        intent,
        code: "run_start_recovery_input_identity_mismatch",
        detail: "加密恢复输入与持久 Run Start 意图的 Task 身份不一致，已停止自动恢复。",
        executor: options.executor,
      });
    }

    const candidate: CompositionRunStartRecoveryCandidate = {
      task: taskOption.value,
      run: runOption.value,
      intent,
      capabilityIds:
        recoveryInput.capabilityIds === undefined ? null : [...recoveryInput.capabilityIds],
      workspaceRootDigest: recoveryInput.workspaceRootDigest ?? null,
      model: recoveryInput.model ?? null,
    };
    const [plan] = yield* planCompositionRunStartRecoveries({
      candidates: [candidate],
      driverRegistry: options.driverRegistry,
      reconciled: options.reconciled,
    });
    if (plan === undefined) {
      return yield* candidateFailure({
        intent,
        code: "run_start_recovery_plan_missing",
        detail: "Run Start 恢复候选未生成计划，已停止自动恢复。",
        executor: options.executor,
      });
    }
    return yield* options.executor.execute({ candidate, recoveryInput, plan });
  }).pipe(
    Effect.catchCause((cause) => {
      if (Cause.interruptors(cause).size > 0) return Effect.failCause(cause);
      return candidateFailure({
        intent,
        code: "run_start_recovery_candidate_execution_failed",
        detail: "Run Start 恢复候选处理失败，已隔离当前候选并继续处理其他恢复项。",
        executor: options.executor,
      }).pipe(
        Effect.catchCause((recordCause) =>
          Cause.interruptors(recordCause).size > 0
            ? Effect.failCause(recordCause)
            : Effect.succeed({
                taskId: intent.taskId,
                runId: intent.runId,
                action: "defer" as const,
                code: "run_start_recovery_candidate_record_failed",
                detail: "Run Start 恢复候选失败，且结果无法持久化，等待下一次启动重试。",
              }),
        ),
      );
    }),
  );

export const recoverCompositionRunStarts = (
  options: CompositionRunStartStartupRecoveryOptions,
): Effect.Effect<CompositionRunStartStartupRecoveryReceipt, StartupRecoveryError> =>
  Effect.gen(function* () {
    const plans: CompositionRunStartStartupRecoveryOutcome[] = [];
    const scanUpperBound = yield* options.runStartStore.getRecoverableScanUpperBound;
    if (Option.isNone(scanUpperBound)) {
      return {
        type: "composition.run_starts.recovered" as const,
        recoveredAtUnixMs: yield* Clock.currentTimeMillis,
        plans,
      };
    }
    const throughRunId = scanUpperBound.value;
    const seenRunIds = new Set<string>();
    let after: { readonly runId: string } | undefined;
    while (true) {
      const intents = yield* options.runStartStore.listRecoverable({
        limit: 200,
        throughRunId,
        ...(after === undefined ? {} : { after }),
      });
      if (intents.length === 0) break;
      for (const intent of intents) {
        if (
          intent.state !== "prepared" &&
          intent.state !== "preparing" &&
          intent.state !== "dispatching" &&
          intent.state !== "accepted"
        ) {
          continue;
        }
        if (seenRunIds.has(intent.runId)) continue;
        seenRunIds.add(intent.runId);
        plans.push(yield* recoverCandidate(options, intent));
      }
      const last = intents[intents.length - 1];
      if (last === undefined || intents.length < 200) break;
      if (after !== undefined && last.runId <= after.runId) break;
      after = { runId: last.runId };
    }
    const nextRecoveryAtUnixMs = plans.reduce<number | undefined>((earliest, plan) => {
      if (plan.retryAtUnixMs === undefined) return earliest;
      return earliest === undefined ? plan.retryAtUnixMs : Math.min(earliest, plan.retryAtUnixMs);
    }, undefined);
    return {
      type: "composition.run_starts.recovered" as const,
      recoveredAtUnixMs: yield* Clock.currentTimeMillis,
      plans,
      ...(nextRecoveryAtUnixMs === undefined ? {} : { nextRecoveryAtUnixMs }),
    };
  });
