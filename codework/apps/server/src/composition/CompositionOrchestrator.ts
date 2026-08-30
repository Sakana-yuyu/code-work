import type {
  CompositionAgentDriverProfile,
  CompositionCapabilityGrant,
  CompositionTask,
  CompositionTaskRetryRequest,
  CompositionTaskRetryResult,
  CompositionTaskResumeRequest,
  CompositionTaskResumeResult,
  CompositionTaskReviewRequest,
  CompositionTaskReviewResult,
  CompositionTaskRun,
  CompositionTaskStatus,
  ProviderRuntimeEvent,
} from "@codework/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";

import {
  type CompositionTaskStoreError,
  type CompositionTaskStoreShape,
} from "../persistence/Services/CompositionTaskStore.ts";
import type {
  CompositionRunStartExecutionStoreShape,
  CompositionRunStartIntent,
  CompositionRunStartStoreError,
} from "../persistence/Services/CompositionRunStartStore.ts";
import {
  CompositionTaskInputStoreError,
  type CompositionTaskInputStoreShape,
} from "../persistence/Services/CompositionTaskInputStore.ts";
import type { CompositionAgentDriverRegistry } from "./CompositionAgentDriverRegistry.ts";
import type * as CapabilityGrantRegistry from "./CapabilityGrantRegistry.ts";
import * as CapabilityRegistry from "./CapabilityRegistry.ts";
import {
  claimCompositionRuntimeLease,
  recoverCompositionRuntimeLease,
  releaseCompositionRuntimeLease,
} from "./CompositionRuntimeLeaseLifecycle.ts";
import {
  claimCompositionRunStartSetup,
  compositionRunStartWinnerFailure,
  quarantineCompositionRunStartUnknownCapabilities,
  releaseCompositionRunStartPreparation,
  runCompositionWithPersistedStart,
  type CompositionRunStartDriverResult,
} from "./CompositionRunStartCoordinator.ts";
import type {
  CompositionRunStartReconcileDecision,
  CompositionRunStartReconcileInput,
  CompositionRunStartRecoveryPolicy,
} from "./CompositionRunStartLifecycle.ts";

export class CompositionTaskDependencyMissingError extends Schema.TaggedErrorClass<CompositionTaskDependencyMissingError>()(
  "CompositionTaskDependencyMissingError",
  {
    taskId: Schema.String,
    dependsOnTaskId: Schema.String,
  },
) {
  override get message(): string {
    return `任务 ${this.taskId} 依赖的任务 ${this.dependsOnTaskId} 不存在。`;
  }
}

export class CompositionTaskDependencyCycleError extends Schema.TaggedErrorClass<CompositionTaskDependencyCycleError>()(
  "CompositionTaskDependencyCycleError",
  {
    taskId: Schema.String,
    dependsOnTaskId: Schema.String,
  },
) {
  override get message(): string {
    return `任务 ${this.taskId} 与依赖 ${this.dependsOnTaskId} 形成循环。`;
  }
}

export class CompositionTaskAlreadyExistsError extends Schema.TaggedErrorClass<CompositionTaskAlreadyExistsError>()(
  "CompositionTaskAlreadyExistsError",
  {
    taskId: Schema.String,
  },
) {
  override get message(): string {
    return `任务 ${this.taskId} 已存在，拒绝重复派发。`;
  }
}

export class CompositionSquadNotFoundError extends Schema.TaggedErrorClass<CompositionSquadNotFoundError>()(
  "CompositionSquadNotFoundError",
  {
    squadId: Schema.String,
  },
) {
  override get message(): string {
    return `协同组 ${this.squadId} 不存在。`;
  }
}

export class CompositionTaskNotFoundError extends Schema.TaggedErrorClass<CompositionTaskNotFoundError>()(
  "CompositionTaskNotFoundError",
  {
    taskId: Schema.String,
    runId: Schema.String,
  },
) {
  override get message(): string {
    return `任务 ${this.taskId} 或运行 ${this.runId} 不存在。`;
  }
}

export class CompositionTaskNotInReviewError extends Schema.TaggedErrorClass<CompositionTaskNotInReviewError>()(
  "CompositionTaskNotInReviewError",
  {
    taskId: Schema.String,
    runId: Schema.String,
    status: Schema.String,
  },
) {
  override get message(): string {
    return `任务 ${this.taskId}/${this.runId} 当前状态为 ${this.status}，不是待审核状态。`;
  }
}

export class CompositionTaskRetryInvalidError extends Schema.TaggedErrorClass<CompositionTaskRetryInvalidError>()(
  "CompositionTaskRetryInvalidError",
  {
    taskId: Schema.String,
    previousRunId: Schema.String,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `任务 ${this.taskId}/${this.previousRunId} 不允许重试：${this.reason}`;
  }
}

export class CompositionTaskResumeInvalidError extends Schema.TaggedErrorClass<CompositionTaskResumeInvalidError>()(
  "CompositionTaskResumeInvalidError",
  {
    taskId: Schema.String,
    runId: Schema.String,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `任务 ${this.taskId}/${this.runId} 不允许恢复：${this.reason}`;
  }
}

export class CompositionAgentDriverFailure extends Schema.TaggedErrorClass<CompositionAgentDriverFailure>()(
  "CompositionAgentDriverFailure",
  {
    code: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Agent Driver 启动失败：${this.code}: ${this.detail}`;
  }
}

export interface CompositionAgentDriver {
  readonly agentId: string;
  readonly runtimeId: string;
  /** 跨进程恢复只依据 Driver 明确声明的重放策略，不从 runtimeId 或实现名称猜测。 */
  readonly startRecoveryPolicy?: CompositionRunStartRecoveryPolicy;
  /** 只核对外部启动事实；不得在此方法中创建新的外部任务。 */
  readonly reconcileStart?: (
    input: CompositionRunStartReconcileInput,
  ) => Effect.Effect<CompositionRunStartReconcileDecision, CompositionAgentDriverFailure>;
  /** 返回当前 Driver 已经验证过的能力，不包含本次 Task 的授权结果。 */
  readonly getProfile?: () => Effect.Effect<CompositionAgentDriverProfile>;
  /** Driver 自己产生的运行时事件；用于不依赖 Provider Session 的本地 Agent Loop。 */
  readonly streamEvents?: () => Stream.Stream<ProviderRuntimeEvent>;
  readonly startTask: (input: {
    readonly task: CompositionTask;
    readonly run: CompositionTaskRun;
    readonly workspaceRootDigest?: string;
    /** 只在运行时传递，不写入 CompositionTask 持久化表。 */
    readonly workspaceRoot?: string;
    /** 只在运行时传递，不写入 CompositionTask 持久化表。 */
    readonly prompt?: string;
    readonly model?: string;
    readonly capabilityGrantIds?: ReadonlyArray<string>;
  }) => Effect.Effect<
    {
      readonly runtimeTaskId?: string;
      readonly capabilityHandshakeId?: string;
    },
    CompositionAgentDriverFailure
  >;
  /** 终态或取消后撤销 Runtime 已接受的 capability handshake。 */
  readonly revokeCapabilityHandshake?: (input: {
    readonly task: CompositionTask;
    readonly run: CompositionTaskRun;
  }) => Effect.Effect<void, CompositionAgentDriverFailure>;
  readonly cancelTask: (input: {
    readonly task: CompositionTask;
    readonly run: CompositionTaskRun;
    readonly reason: string;
  }) => Effect.Effect<
    { readonly status: "cancelled" | "cancel_requested" | "already_terminal" },
    CompositionAgentDriverFailure
  >;
  /** 对同一外部 Runtime Run 请求恢复，不会创建新的 Run 或授权。 */
  readonly resumeTask?: (input: {
    readonly task: CompositionTask;
    readonly run: CompositionTaskRun;
    readonly reason: string;
  }) => Effect.Effect<
    { readonly status: "accepted" | "already_running" | "already_terminal" },
    CompositionAgentDriverFailure
  >;
  readonly reviewTask?: (
    input: CompositionTaskReviewRequest,
  ) => Effect.Effect<
    CompositionTaskReviewResult,
    CompositionTaskStoreError | CompositionTaskNotFoundError | CompositionTaskNotInReviewError
  >;
  /** 将外部 runtime 事件归属到本驱动已启动的 Composition run。 */
  readonly resolveRuntimeEvent?: (event: ProviderRuntimeEvent) =>
    | {
        readonly taskId: string;
        readonly runId: string;
        readonly runtimeTaskId?: string;
      }
    | undefined;
  /** Driver 重建后，用受信任的 Runtime 复合键恢复事件归属；不得返回 Task/Run 猜测。 */
  readonly resolvePersistedRuntimeEvent?: (event: ProviderRuntimeEvent) =>
    | {
        readonly runtimeId: string;
        readonly runtimeTaskId: string;
      }
    | undefined;
}

export type CompositionDispatchInput = {
  readonly taskId: string;
  readonly runId: string;
  readonly projectId: string;
  readonly threadId?: string;
  readonly parentTaskId?: string;
  readonly assigneeKind: "agent" | "squad";
  readonly assigneeId: string;
  readonly mode: "serial" | "parallel" | "review";
  readonly promptDigest: string;
  readonly dependsOnTaskIds: ReadonlyArray<string>;
  readonly workspaceRootDigest?: string;
  /** 完整 prompt 只用于本次派发，不进入任务持久化投影。 */
  readonly workspaceRoot?: string;
  readonly prompt?: string;
  readonly model?: string;
  /** 用户请求的 capability ID；由 Orchestrator 转换为短期 grant。 */
  readonly capabilityIds?: ReadonlyArray<string>;
};

export type CompositionDispatchResult = {
  readonly task: CompositionTask;
  readonly run: CompositionTaskRun;
};

export type CompositionCancelResult = {
  readonly task: CompositionTask;
  readonly run: CompositionTaskRun;
  readonly status: "cancelled" | "cancel_requested" | "already_terminal";
};

export type CompositionResumeResult = CompositionTaskResumeResult;

export type CompositionRecoveryResult = ReadonlyArray<CompositionDispatchResult>;

const terminalStatuses: ReadonlySet<CompositionTaskStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);

const dependencySatisfied = (status: CompositionTaskStatus): boolean => status === "completed";

const makeEvent = (input: {
  readonly task: CompositionTask;
  readonly run: CompositionTaskRun;
  readonly sequence: number;
  readonly status: CompositionTaskStatus;
  readonly eventType: "blocker" | "status";
  readonly summary: string;
  readonly blockerCode?: string;
}) => ({
  taskId: input.task.taskId,
  runId: input.run.runId,
  agentId: input.run.agentId,
  status: input.status,
  sequence: input.sequence,
  eventType: input.eventType,
  summary: input.summary,
  ...(input.blockerCode === undefined ? {} : { blockerCode: input.blockerCode }),
});

export interface CompositionOrchestrator {
  readonly dispatchTask: (
    input: CompositionDispatchInput,
  ) => Effect.Effect<
    CompositionDispatchResult,
    | CompositionTaskStoreError
    | CompositionTaskDependencyMissingError
    | CompositionTaskDependencyCycleError
    | CompositionTaskAlreadyExistsError
    | CompositionSquadNotFoundError
    | CompositionAgentDriverFailure
    | CompositionTaskInputStoreError
    | CompositionRunStartStoreError
    | CapabilityGrantRegistry.CapabilityGrantInvalidError
    | CapabilityGrantRegistry.CapabilityGrantPersistenceError
    | CapabilityRegistry.CapabilityScopeNotFoundError
    | CapabilityRegistry.CapabilityRegistryUnavailableError
  >;
  readonly cancelTask: (input: {
    readonly taskId: string;
    readonly runId: string;
    readonly reason: string;
  }) => Effect.Effect<
    CompositionCancelResult,
    | CompositionTaskStoreError
    | CompositionTaskNotFoundError
    | CompositionAgentDriverFailure
    | CapabilityGrantRegistry.CapabilityGrantPersistenceError
  >;
  readonly reviewTask: (
    input: CompositionTaskReviewRequest,
  ) => Effect.Effect<
    CompositionTaskReviewResult,
    CompositionTaskStoreError | CompositionTaskNotFoundError | CompositionTaskNotInReviewError
  >;
  readonly retryTask: (
    input: CompositionTaskRetryRequest,
  ) => Effect.Effect<
    CompositionTaskRetryResult,
    | CompositionTaskStoreError
    | CompositionTaskNotFoundError
    | CompositionTaskRetryInvalidError
    | CompositionAgentDriverFailure
    | CompositionTaskInputStoreError
    | CompositionRunStartStoreError
    | CapabilityGrantRegistry.CapabilityGrantInvalidError
    | CapabilityGrantRegistry.CapabilityGrantPersistenceError
    | CapabilityRegistry.CapabilityScopeNotFoundError
    | CapabilityRegistry.CapabilityRegistryUnavailableError
  >;
  readonly resumeTask: (
    input: CompositionTaskResumeRequest,
  ) => Effect.Effect<
    CompositionResumeResult,
    | CompositionTaskStoreError
    | CompositionTaskNotFoundError
    | CompositionTaskResumeInvalidError
    | CompositionAgentDriverFailure
  >;
  readonly resumeReadyTasks: () => Effect.Effect<
    CompositionRecoveryResult,
    | CompositionTaskStoreError
    | CompositionAgentDriverFailure
    | CompositionTaskInputStoreError
    | CompositionRunStartStoreError
    | CapabilityGrantRegistry.CapabilityGrantPersistenceError
  >;
}

const makeOrchestrator = (
  store: CompositionTaskStoreShape,
  driverRegistry: CompositionAgentDriverRegistry,
  grantRegistry?: Pick<CapabilityGrantRegistry.CapabilityGrantRegistryShape, "issue"> &
    Partial<Pick<CapabilityGrantRegistry.CapabilityGrantRegistryShape, "revoke">>,
  inputStore?: CompositionTaskInputStoreShape,
  runStartStore?: CompositionRunStartExecutionStoreShape,
): CompositionOrchestrator => {
  const resumingTaskIds = new Set<string>();
  const resumingRunIds = new Set<string>();

  const prepareRunLease = (
    task: CompositionTask,
    run: CompositionTaskRun,
    workspaceRootDigest: string | undefined,
  ) =>
    Effect.gen(function* () {
      if (workspaceRootDigest === undefined) return Option.some(run);
      const now = yield* Clock.currentTimeMillis;
      return yield* claimCompositionRuntimeLease(store, {
        task,
        run,
        workspaceRootDigest,
        nowUnixMs: now,
      });
    });

  const releaseRunLease = (run: CompositionTaskRun) =>
    Effect.gen(function* () {
      if (run.leaseId === undefined) return;
      const now = yield* Clock.currentTimeMillis;
      yield* releaseCompositionRuntimeLease(store, run, now);
    });

  const revokeCapabilityGrantIds = (grantIds: ReadonlyArray<string>) =>
    grantRegistry?.revoke === undefined || grantIds.length === 0
      ? Effect.void
      : Effect.forEach(grantIds, (grantId) =>
          grantRegistry.revoke!({ grantId }).pipe(
            Effect.catchTag("CapabilityGrantNotFoundError", () => Effect.void),
          ),
        ).pipe(Effect.asVoid);

  const revokeRunCapabilities = (
    driver: CompositionAgentDriver | undefined,
    task: CompositionTask,
    run: CompositionTaskRun,
  ) =>
    Effect.gen(function* () {
      if (
        run.capabilityHandshakeId !== undefined &&
        driver?.revokeCapabilityHandshake !== undefined
      ) {
        yield* driver.revokeCapabilityHandshake({ task, run });
      }
      const grantIds = [...(run.capabilityGrantIds ?? [])];
      yield* revokeCapabilityGrantIds(grantIds);
      if (grantIds.length > 0) {
        yield* persistCapabilityGrantProjection({
          task,
          run,
          sourceEventId: `capgrant:${task.taskId}:${run.runId}:revoked`,
          summary: `能力授权已撤销（${grantIds.length} 项）`,
        });
      }
    });

  /** 把 grant 下发/撤销状态以幂等事件行投影到任务历史，供用户与多端查看。 */
  const persistCapabilityGrantProjection = (input: {
    readonly task: CompositionTask;
    readonly run: CompositionTaskRun;
    readonly sourceEventId: string;
    readonly summary: string;
  }): Effect.Effect<void, CompositionTaskStoreError> =>
    Effect.asVoid(
      store.appendEventIfNew({
        taskId: input.task.taskId,
        runId: input.run.runId,
        ...(input.task.parentTaskId === undefined ? {} : { parentTaskId: input.task.parentTaskId }),
        agentId: input.run.agentId,
        ...(input.run.runtimeId === undefined ? {} : { runtimeId: input.run.runtimeId }),
        sourceEventId: input.sourceEventId,
        status: input.run.status,
        sequence: 0,
        eventType: "status",
        summary: input.summary,
      }),
    );

  const describeIssuedGrants = (grants: ReadonlyArray<CompositionCapabilityGrant>): string =>
    `能力授权已下发（${grants.length} 项）：${[...grants]
      .sort((a, b) => a.grantId.localeCompare(b.grantId))
      .map((grant) => `${grant.capabilityId}@${grant.grantId.slice(0, 12)}`)
      .join(", ")}`;

  /**
   * Provider 可能在 startTask 返回前推送运行时事件。只有 Task/Run 仍处于本次
   * 启动前的原始状态时才写入 running，避免早到终态被后续启动确认复活。
   */
  const persistStartedRun = (input: {
    readonly task: CompositionTask;
    readonly run: CompositionTaskRun;
    readonly driver: CompositionAgentDriver;
    readonly startResult: CompositionRunStartDriverResult;
    readonly summary: string;
  }): Effect.Effect<CompositionDispatchResult, CompositionTaskStoreError> =>
    store.withTransaction(
      Effect.gen(function* () {
        const currentTaskOption = yield* store.getTask(input.task.taskId);
        const currentRunOption = yield* store.getRun(input.run.runId);
        if (Option.isNone(currentTaskOption) || Option.isNone(currentRunOption)) {
          return { task: input.task, run: input.run };
        }
        const currentTask = currentTaskOption.value;
        const currentRun = currentRunOption.value;
        if (currentTask.status !== input.task.status || currentRun.status !== input.run.status) {
          if (
            terminalStatuses.has(currentTask.status) ||
            terminalStatuses.has(currentRun.status) ||
            currentTask.status === "in_review" ||
            currentRun.status === "in_review"
          ) {
            return { task: currentTask, run: currentRun };
          }
          const startedAt = currentRun.startedAtUnixMs ?? (yield* Clock.currentTimeMillis);
          const synchronizedRun: CompositionTaskRun = {
            ...currentRun,
            runtimeId: input.driver.runtimeId,
            ...(currentRun.runtimeTaskId === undefined &&
            input.startResult.runtimeTaskId !== undefined
              ? { runtimeTaskId: input.startResult.runtimeTaskId }
              : {}),
            ...(currentRun.capabilityHandshakeId === undefined &&
            input.startResult.capabilityHandshakeId !== undefined
              ? { capabilityHandshakeId: input.startResult.capabilityHandshakeId }
              : {}),
            ...(currentRun.startedAtUnixMs === undefined ? { startedAtUnixMs: startedAt } : {}),
          };
          yield* store.upsertRun(synchronizedRun);
          return { task: currentTask, run: synchronizedRun };
        }

        const startedAt = yield* Clock.currentTimeMillis;
        const runningTask: CompositionTask = {
          ...currentTask,
          status: "running",
          updatedAtUnixMs: startedAt,
        };
        const runningRun: CompositionTaskRun = {
          ...currentRun,
          runtimeId: input.driver.runtimeId,
          runtimeTaskId: input.startResult.runtimeTaskId,
          ...(input.startResult.capabilityHandshakeId === undefined
            ? {}
            : { capabilityHandshakeId: input.startResult.capabilityHandshakeId }),
          status: "running",
          startedAtUnixMs: startedAt,
        };
        yield* store.upsertTask(runningTask);
        yield* store.upsertRun(runningRun);
        const events = yield* store.listEvents(runningTask.taskId, runningRun.runId);
        yield* store.appendEvent(
          makeEvent({
            task: runningTask,
            run: runningRun,
            sequence: events.length,
            status: "running",
            eventType: "status",
            summary: input.summary,
          }),
        );
        return { task: runningTask, run: runningRun };
      }),
    );

  const persistFailedStart = (input: {
    readonly task: CompositionTask;
    readonly run: CompositionTaskRun;
    readonly driver: CompositionAgentDriver;
    readonly failure: CompositionAgentDriverFailure;
    readonly summary: string;
    readonly finishTask: boolean;
  }) =>
    Effect.gen(function* () {
      const persisted = yield* store.withTransaction(
        Effect.gen(function* () {
          const currentTaskOption = yield* store.getTask(input.task.taskId);
          const currentRunOption = yield* store.getRun(input.run.runId);
          if (Option.isNone(currentTaskOption) || Option.isNone(currentRunOption)) {
            return { task: input.task, run: input.run, failurePersisted: false };
          }
          const currentTask = currentTaskOption.value;
          const currentRun = currentRunOption.value;
          if (
            terminalStatuses.has(currentTask.status) ||
            terminalStatuses.has(currentRun.status) ||
            currentTask.status === "in_review" ||
            currentRun.status === "in_review"
          ) {
            return { task: currentTask, run: currentRun, failurePersisted: false };
          }
          const failedAt = yield* Clock.currentTimeMillis;
          const failedTask: CompositionTask = {
            ...currentTask,
            status: "failed",
            updatedAtUnixMs: failedAt,
            ...(input.finishTask ? { finishedAtUnixMs: failedAt } : {}),
          };
          const failedRun: CompositionTaskRun = {
            ...currentRun,
            runtimeId: input.driver.runtimeId,
            status: "failed",
            finishedAtUnixMs: failedAt,
            failureCode: input.failure.code,
            resultSummary: input.failure.detail,
          };
          yield* store.upsertTask(failedTask);
          yield* store.upsertRun(failedRun);
          const events = yield* store.listEvents(failedTask.taskId, failedRun.runId);
          yield* store.appendEvent(
            makeEvent({
              task: failedTask,
              run: failedRun,
              sequence: events.length,
              status: "failed",
              eventType: "status",
              summary: input.summary,
            }),
          );
          return { task: failedTask, run: failedRun, failurePersisted: true };
        }),
      );
      if (persisted.failurePersisted) {
        yield* revokeRunCapabilities(input.driver, persisted.task, persisted.run);
      }
      return { task: persisted.task, run: persisted.run };
    });

  const makeRunStartSetup = (input: {
    readonly task: CompositionTask;
    readonly run: CompositionTaskRun;
    readonly previousRunId: string | null;
    readonly driver: CompositionAgentDriver;
    readonly workspaceRootDigest?: string;
    readonly model?: string;
    readonly capabilityIds: ReadonlyArray<string> | null;
  }) => ({
    taskId: input.task.taskId,
    projectId: input.task.projectId,
    ...(input.task.threadId === undefined ? {} : { threadId: input.task.threadId }),
    ...(input.task.parentTaskId === undefined ? {} : { parentTaskId: input.task.parentTaskId }),
    runId: input.run.runId,
    previousRunId: input.previousRunId,
    assigneeKind: input.task.assigneeKind,
    assigneeId: input.task.assigneeId,
    mode: input.task.mode,
    dependsOnTaskIds: input.task.dependsOnTaskIds,
    agentId: input.run.agentId,
    runtimeId: input.driver.runtimeId,
    attempt: input.run.attempt,
    promptDigest: input.task.promptDigest,
    ...(input.workspaceRootDigest === undefined
      ? {}
      : { workspaceRootDigest: input.workspaceRootDigest }),
    ...(input.model === undefined ? {} : { model: input.model }),
    capabilityIds: input.capabilityIds,
  });

  const claimPersistedRunStart = (input: Parameters<typeof makeRunStartSetup>[0]) =>
    runStartStore === undefined
      ? Effect.fail(
          new CompositionAgentDriverFailure({
            code: "run_start_store_unavailable",
            detail: "当前 Runtime 未提供持久 Run Start store。",
          }),
        )
      : claimCompositionRunStartSetup(runStartStore, makeRunStartSetup(input));

  const releasePersistedRunStartPreparation = (intent: CompositionRunStartIntent) =>
    runStartStore === undefined
      ? Effect.void
      : releaseCompositionRunStartPreparation(runStartStore, intent);

  const persistedRunStartWinnerFailure = (
    winner: CompositionRunStartIntent,
    inProgressDetail: string,
  ) =>
    new CompositionAgentDriverFailure(compositionRunStartWinnerFailure(winner, inProgressDetail));

  const quarantineUnknownRecoveryCapabilities = (input: {
    readonly task: CompositionTask;
    readonly run: CompositionTaskRun;
    readonly driver: CompositionAgentDriver;
    readonly workspaceRootDigest?: string;
    readonly model?: string;
  }) =>
    runStartStore === undefined
      ? Effect.void
      : quarantineCompositionRunStartUnknownCapabilities(
          runStartStore,
          makeRunStartSetup({ ...input, previousRunId: null, capabilityIds: null }),
        );

  const startPersistedRun = (input: {
    readonly task: CompositionTask;
    readonly run: CompositionTaskRun;
    readonly previousRunId: string | null;
    readonly driver: CompositionAgentDriver;
    readonly workspaceRootDigest?: string;
    readonly model?: string;
    readonly capabilityIds: ReadonlyArray<string>;
    readonly intent?: CompositionRunStartIntent;
    readonly start: Effect.Effect<CompositionRunStartDriverResult, CompositionAgentDriverFailure>;
    readonly startedSummary: string;
    readonly failedSummary: string;
    readonly finishTaskOnFailure: boolean;
  }) => {
    const persistRejected = (failure: CompositionAgentDriverFailure) =>
      Effect.gen(function* () {
        const failed = yield* persistFailedStart({
          task: input.task,
          run: input.run,
          driver: input.driver,
          failure,
          summary: input.failedSummary,
          finishTask: input.finishTaskOnFailure,
        });
        yield* releaseRunLease(failed.run);
        return failed;
      });
    const persistAccepted = (startResult: CompositionRunStartDriverResult) =>
      persistStartedRun({
        task: input.task,
        run: input.run,
        driver: input.driver,
        startResult,
        summary: input.startedSummary,
      });
    return runCompositionWithPersistedStart({
      ...(runStartStore === undefined ? {} : { store: runStartStore }),
      setup: makeRunStartSetup(input),
      ...(input.intent === undefined ? {} : { intent: input.intent }),
      ...(input.driver.startRecoveryPolicy === undefined
        ? {}
        : { policy: input.driver.startRecoveryPolicy }),
      capabilityGrantIds: input.run.capabilityGrantIds ?? [],
      start: input.start,
      onAccepted: persistAccepted,
      onRejected: persistRejected,
      makeFailure: (failure) => new CompositionAgentDriverFailure(failure),
    });
  };

  const validateDependencies = (
    taskId: string,
    dependencyIds: ReadonlyArray<string>,
  ): Effect.Effect<
    void,
    | CompositionTaskStoreError
    | CompositionTaskDependencyMissingError
    | CompositionTaskDependencyCycleError
  > => {
    const visiting = new Set<string>();
    const visited = new Set<string>();

    function visit(
      currentTaskId: string,
    ): Effect.Effect<
      void,
      | CompositionTaskStoreError
      | CompositionTaskDependencyMissingError
      | CompositionTaskDependencyCycleError
    > {
      return Effect.gen(function* () {
        if (visiting.has(currentTaskId)) {
          return yield* new CompositionTaskDependencyCycleError({
            taskId,
            dependsOnTaskId: currentTaskId,
          });
        }
        if (visited.has(currentTaskId)) {
          return;
        }
        visiting.add(currentTaskId);
        const dependency = yield* store.getTask(currentTaskId);
        if (Option.isNone(dependency)) {
          return yield* new CompositionTaskDependencyMissingError({
            taskId,
            dependsOnTaskId: currentTaskId,
          });
        }
        for (const nestedDependencyId of dependency.value.dependsOnTaskIds) {
          yield* visit(nestedDependencyId);
        }
        visiting.delete(currentTaskId);
        visited.add(currentTaskId);
      });
    }

    return Effect.gen(function* () {
      for (const dependencyId of dependencyIds) {
        if (dependencyId === taskId) {
          return yield* new CompositionTaskDependencyCycleError({
            taskId,
            dependsOnTaskId: dependencyId,
          });
        }
        yield* visit(dependencyId);
      }
    });
  };

  const dispatchTask: CompositionOrchestrator["dispatchTask"] = (input) =>
    Effect.gen(function* () {
      const existing = yield* store.getTask(input.taskId);
      if (Option.isSome(existing)) {
        return yield* new CompositionTaskAlreadyExistsError({ taskId: input.taskId });
      }

      yield* validateDependencies(input.taskId, input.dependsOnTaskIds);
      const now = yield* Clock.currentTimeMillis;
      const dependencies = yield* Effect.forEach(input.dependsOnTaskIds, (dependencyId) =>
        store.getTask(dependencyId).pipe(Effect.map((task) => ({ dependencyId, task }))),
      );
      const blockedDependency = dependencies.find(
        (dependency) =>
          Option.isSome(dependency.task) && !dependencySatisfied(dependency.task.value.status),
      );
      const initialStatus: CompositionTaskStatus =
        blockedDependency === undefined ? "queued" : "blocked";
      const agentId = yield* Effect.gen(function* () {
        if (input.assigneeKind === "agent") return input.assigneeId;
        const squad = yield* store.getSquad(input.assigneeId);
        if (Option.isNone(squad)) {
          return yield* new CompositionSquadNotFoundError({ squadId: input.assigneeId });
        }
        return squad.value.leaderAgentId;
      });
      const driver = yield* driverRegistry.get(agentId);
      const runtimeId = driver?.runtimeId ?? "unresolved";
      const task: CompositionTask = {
        taskId: input.taskId,
        projectId: input.projectId,
        ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
        ...(input.parentTaskId === undefined ? {} : { parentTaskId: input.parentTaskId }),
        assigneeKind: input.assigneeKind,
        assigneeId: input.assigneeId,
        mode: input.mode,
        status: initialStatus,
        promptDigest: input.promptDigest,
        dependsOnTaskIds: [...input.dependsOnTaskIds],
        createdAtUnixMs: now,
        updatedAtUnixMs: now,
      };
      const setupRun: CompositionTaskRun = {
        runId: input.runId,
        taskId: input.taskId,
        agentId,
        runtimeId,
        status: initialStatus,
        attempt: 1,
        capabilityGrantIds: [],
      };

      if (blockedDependency === undefined && driver !== undefined && runStartStore !== undefined) {
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const setupClaim = yield* claimPersistedRunStart({
              task,
              run: setupRun,
              previousRunId: null,
              driver,
              ...(input.workspaceRootDigest === undefined
                ? {}
                : { workspaceRootDigest: input.workspaceRootDigest }),
              ...(input.model === undefined ? {} : { model: input.model }),
              capabilityIds: input.capabilityIds ?? [],
            });
            if (!setupClaim.claimed) {
              return yield* persistedRunStartWinnerFailure(
                setupClaim.intent,
                `Run ${input.runId} 的初次派发 setup 已由其他 Runtime owner 认领。`,
              );
            }

            const claimedIntent = setupClaim.intent;
            let issuedGrants: ReadonlyArray<CompositionCapabilityGrant> = [];
            let inputSaved = false;
            const cleanupSetup = Effect.gen(function* () {
              const currentOption = yield* runStartStore.getStart(claimedIntent.runId);
              if (Option.isNone(currentOption)) return;
              const current = currentOption.value;
              if (current.state !== "preparing" || current.claimId !== claimedIntent.claimId) {
                return;
              }
              const cleanupSideEffects = Effect.gen(function* () {
                yield* revokeCapabilityGrantIds(issuedGrants.map((grant) => grant.grantId));
                if (inputSaved && inputStore !== undefined) {
                  yield* inputStore.remove(input.taskId);
                }
              });
              const cleanupExit = yield* Effect.exit(cleanupSideEffects);
              const releaseExit = yield* Effect.exit(releasePersistedRunStartPreparation(current));
              if (cleanupExit._tag === "Failure") {
                return yield* Effect.failCause(cleanupExit.cause);
              }
              if (releaseExit._tag === "Failure") {
                return yield* Effect.failCause(releaseExit.cause);
              }
            });

            const setupExit = yield* Effect.exit(
              restore(
                Effect.gen(function* () {
                  if (
                    inputStore !== undefined &&
                    input.prompt !== undefined &&
                    input.workspaceRoot !== undefined
                  ) {
                    yield* inputStore.save({
                      taskId: input.taskId,
                      prompt: input.prompt,
                      workspaceRoot: input.workspaceRoot,
                      ...(input.workspaceRootDigest === undefined
                        ? {}
                        : { workspaceRootDigest: input.workspaceRootDigest }),
                      ...(input.model === undefined ? {} : { model: input.model }),
                      capabilityIds: [...(input.capabilityIds ?? [])],
                    });
                    inputSaved = true;
                  }
                  issuedGrants =
                    grantRegistry === undefined ||
                    input.capabilityIds === undefined ||
                    input.capabilityIds.length === 0
                      ? []
                      : yield* grantRegistry.issue({
                          taskId: input.taskId,
                          agentId,
                          capabilityIds: input.capabilityIds,
                        });
                  const queuedRun: CompositionTaskRun = {
                    ...setupRun,
                    capabilityGrantIds: issuedGrants.map((grant) => grant.grantId),
                  };
                  return yield* store.withTransaction(
                    Effect.gen(function* () {
                      yield* store.upsertTask(task);
                      yield* store.upsertRun(queuedRun);
                      for (const dependency of input.dependsOnTaskIds) {
                        yield* store.upsertDependency({
                          taskId: input.taskId,
                          dependsOnTaskId: dependency,
                          condition: "success",
                          createdAtUnixMs: now,
                        });
                      }
                      yield* store.appendEvent(
                        makeEvent({
                          task,
                          run: queuedRun,
                          sequence: 0,
                          status: initialStatus,
                          eventType: "status",
                          summary: "任务已排队",
                        }),
                      );
                      if (issuedGrants.length > 0) {
                        yield* persistCapabilityGrantProjection({
                          task,
                          run: queuedRun,
                          sourceEventId: `capgrant:${task.taskId}:${queuedRun.runId}:issued`,
                          summary: describeIssuedGrants(issuedGrants),
                        });
                      }
                      const leasedRunOption = yield* prepareRunLease(
                        task,
                        queuedRun,
                        input.workspaceRootDigest,
                      );
                      const dispatchingIntent = yield* runStartStore.markDispatching({
                        runId: claimedIntent.runId,
                        expectedRevision: claimedIntent.revision,
                        claimId: claimedIntent.claimId ?? "",
                        dispatchedAtUnixMs: Math.max(
                          yield* Clock.currentTimeMillis,
                          claimedIntent.updatedAtUnixMs,
                        ),
                      });
                      return {
                        run: Option.getOrElse(leasedRunOption, () => queuedRun),
                        leaseClaimed: Option.isSome(leasedRunOption),
                        dispatchingIntent,
                      };
                    }),
                  );
                }),
              ).pipe(
                Effect.onExit((exit) => (exit._tag === "Success" ? Effect.void : cleanupSetup)),
              ),
            );
            if (setupExit._tag === "Failure") {
              return yield* Effect.failCause(setupExit.cause);
            }

            const preparedStart = setupExit.value;
            const start = preparedStart.leaseClaimed
              ? driver.startTask({
                  task,
                  run: preparedStart.run,
                  ...(input.workspaceRootDigest === undefined
                    ? {}
                    : { workspaceRootDigest: input.workspaceRootDigest }),
                  ...(input.workspaceRoot === undefined
                    ? {}
                    : { workspaceRoot: input.workspaceRoot }),
                  ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
                  ...(input.model === undefined ? {} : { model: input.model }),
                  capabilityGrantIds: preparedStart.run.capabilityGrantIds ?? [],
                })
              : Effect.fail(
                  new CompositionAgentDriverFailure({
                    code: "capacity_exceeded",
                    detail: "工作区已有未过期的 Runtime 租约，拒绝重复派发。",
                  }),
                );
            return yield* restore(
              startPersistedRun({
                task,
                run: preparedStart.run,
                previousRunId: null,
                driver,
                ...(input.workspaceRootDigest === undefined
                  ? {}
                  : { workspaceRootDigest: input.workspaceRootDigest }),
                ...(input.model === undefined ? {} : { model: input.model }),
                capabilityIds: input.capabilityIds ?? [],
                intent: preparedStart.dispatchingIntent,
                start,
                startedSummary: "任务已交给 Agent Driver 执行",
                failedSummary: preparedStart.leaseClaimed
                  ? "Agent Driver 启动失败"
                  : "工作区正由其他 Runtime Run 使用",
                finishTaskOnFailure: false,
              }),
            );
          }),
        );
      }

      if (
        inputStore !== undefined &&
        input.prompt !== undefined &&
        input.workspaceRoot !== undefined
      ) {
        yield* inputStore.save({
          taskId: input.taskId,
          prompt: input.prompt,
          workspaceRoot: input.workspaceRoot,
          ...(input.workspaceRootDigest === undefined
            ? {}
            : { workspaceRootDigest: input.workspaceRootDigest }),
          ...(input.model === undefined ? {} : { model: input.model }),
          capabilityIds: [...(input.capabilityIds ?? [])],
        });
      }
      const issuedGrants =
        grantRegistry === undefined ||
        input.capabilityIds === undefined ||
        input.capabilityIds.length === 0
          ? []
          : yield* grantRegistry.issue({
              taskId: input.taskId,
              agentId,
              capabilityIds: input.capabilityIds,
            });
      const run: CompositionTaskRun = {
        ...setupRun,
        capabilityGrantIds: issuedGrants.map((grant) => grant.grantId),
      };

      yield* store.upsertTask(task);
      yield* store.upsertRun(run);
      for (const dependency of input.dependsOnTaskIds) {
        yield* store.upsertDependency({
          taskId: input.taskId,
          dependsOnTaskId: dependency,
          condition: "success",
          createdAtUnixMs: now,
        });
      }
      yield* store.appendEvent(
        makeEvent({
          task,
          run,
          sequence: 0,
          status: initialStatus,
          eventType: initialStatus === "blocked" ? "blocker" : "status",
          summary: initialStatus === "blocked" ? "等待依赖任务完成" : "任务已排队",
          ...(initialStatus === "blocked" ? { blockerCode: "dependency_pending" } : {}),
        }),
      );
      if (issuedGrants.length > 0) {
        yield* persistCapabilityGrantProjection({
          task,
          run,
          sourceEventId: `capgrant:${task.taskId}:${run.runId}:issued`,
          summary: describeIssuedGrants(issuedGrants),
        });
      }

      if (blockedDependency !== undefined) {
        return { task, run };
      }

      if (driver === undefined) {
        const failedAt = yield* Clock.currentTimeMillis;
        const failedTask: CompositionTask = {
          ...task,
          status: "failed",
          updatedAtUnixMs: failedAt,
        };
        const failedRun: CompositionTaskRun = {
          ...run,
          status: "failed",
          finishedAtUnixMs: failedAt,
          failureCode: "agent_driver_unavailable",
          resultSummary: "未找到可用的 Agent Driver",
        };
        yield* revokeRunCapabilities(driver, failedTask, failedRun);
        yield* store.upsertTask(failedTask);
        yield* store.upsertRun(failedRun);
        const events = yield* store.listEvents(failedTask.taskId, failedRun.runId);
        yield* store.appendEvent(
          makeEvent({
            task: failedTask,
            run: failedRun,
            sequence: events.length,
            status: "failed",
            eventType: "status",
            summary: "Agent Driver 不可用",
          }),
        );
        return { task: failedTask, run: failedRun };
      }

      const leasedRunOption = yield* prepareRunLease(task, run, input.workspaceRootDigest);
      if (Option.isNone(leasedRunOption)) {
        return yield* persistFailedStart({
          task,
          run,
          driver,
          failure: new CompositionAgentDriverFailure({
            code: "capacity_exceeded",
            detail: "工作区已有未过期的 Runtime 租约，拒绝重复派发。",
          }),
          summary: "工作区正由其他 Runtime Run 使用",
          finishTask: false,
        });
      }
      const leasedRun = leasedRunOption.value;

      return yield* startPersistedRun({
        task,
        run: leasedRun,
        previousRunId: null,
        driver,
        ...(input.workspaceRootDigest === undefined
          ? {}
          : { workspaceRootDigest: input.workspaceRootDigest }),
        ...(input.model === undefined ? {} : { model: input.model }),
        capabilityIds: input.capabilityIds ?? [],
        start: driver.startTask({
          task,
          run: leasedRun,
          ...(input.workspaceRootDigest === undefined
            ? {}
            : { workspaceRootDigest: input.workspaceRootDigest }),
          ...(input.workspaceRoot === undefined ? {} : { workspaceRoot: input.workspaceRoot }),
          ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
          ...(input.model === undefined ? {} : { model: input.model }),
          capabilityGrantIds: leasedRun.capabilityGrantIds ?? [],
        }),
        startedSummary: "任务已交给 Agent Driver 执行",
        failedSummary: "Agent Driver 启动失败",
        finishTaskOnFailure: false,
      });
    });

  const cancelTask: CompositionOrchestrator["cancelTask"] = (input) =>
    Effect.gen(function* () {
      const taskOption = yield* store.getTask(input.taskId);
      const runOption = yield* store.getRun(input.runId);
      if (Option.isNone(taskOption) || Option.isNone(runOption)) {
        return yield* new CompositionTaskNotFoundError({
          taskId: input.taskId,
          runId: input.runId,
        });
      }
      const task = taskOption.value;
      const run = runOption.value;
      if (terminalStatuses.has(task.status)) {
        return { task, run, status: "already_terminal" as const };
      }
      const driver = yield* driverRegistry.get(run.agentId);
      if (driver !== undefined) {
        const driverResult = yield* driver.cancelTask({ task, run, reason: input.reason });
        if (driverResult.status === "already_terminal") {
          return { task, run, status: "already_terminal" as const };
        }
        if (driverResult.status === "cancel_requested") {
          const now = yield* Clock.currentTimeMillis;
          const requestedTask: CompositionTask = {
            ...task,
            updatedAtUnixMs: now,
          };
          const requestedRun: CompositionTaskRun = {
            ...run,
            cancelRequestedAtUnixMs: run.cancelRequestedAtUnixMs ?? now,
          };
          yield* store.upsertTask(requestedTask);
          yield* store.upsertRun(requestedRun);
          const priorEvents = yield* store.listEvents(input.taskId, input.runId);
          yield* store.appendEvent({
            taskId: task.taskId,
            runId: run.runId,
            ...(task.parentTaskId === undefined ? {} : { parentTaskId: task.parentTaskId }),
            agentId: run.agentId,
            runtimeId: run.runtimeId,
            status: requestedTask.status,
            sequence: priorEvents.length,
            eventType: "message",
            summary: "取消请求已提交，等待 Runtime 确认",
          });
          return { task: requestedTask, run: requestedRun, status: "cancel_requested" as const };
        }
      }
      const now = yield* Clock.currentTimeMillis;
      const cancelledTask: CompositionTask = {
        ...task,
        status: "cancelled",
        updatedAtUnixMs: now,
        finishedAtUnixMs: now,
      };
      const cancelledRun: CompositionTaskRun = {
        ...run,
        status: "cancelled",
        finishedAtUnixMs: now,
        resultSummary: input.reason,
      };
      yield* revokeRunCapabilities(driver, cancelledTask, cancelledRun);
      yield* store.upsertTask(cancelledTask);
      yield* store.upsertRun(cancelledRun);
      const priorEvents = yield* store.listEvents(input.taskId, input.runId);
      yield* store.appendEvent(
        makeEvent({
          task: cancelledTask,
          run: cancelledRun,
          sequence: priorEvents.length,
          status: "cancelled",
          eventType: "status",
          summary: "任务已取消",
        }),
      );
      yield* releaseRunLease(cancelledRun);
      return { task: cancelledTask, run: cancelledRun, status: "cancelled" as const };
    });

  const reviewTask: CompositionOrchestrator["reviewTask"] = (input) =>
    Effect.gen(function* () {
      const taskOption = yield* store.getTask(input.taskId);
      const runOption = yield* store.getRun(input.runId);
      if (Option.isNone(taskOption) || Option.isNone(runOption)) {
        return yield* new CompositionTaskNotFoundError({
          taskId: input.taskId,
          runId: input.runId,
        });
      }
      const task = taskOption.value;
      const run = runOption.value;
      if (task.status !== "in_review" || run.status !== "in_review") {
        return yield* new CompositionTaskNotInReviewError({
          taskId: input.taskId,
          runId: input.runId,
          status: `${task.status}/${run.status}`,
        });
      }
      const now = yield* Clock.currentTimeMillis;
      const approved = input.decision === "approve";
      const nextStatus: CompositionTaskStatus = approved ? "completed" : "failed";
      const nextTask: CompositionTask = {
        ...task,
        status: nextStatus,
        updatedAtUnixMs: now,
        finishedAtUnixMs: now,
      };
      const nextRun: CompositionTaskRun = {
        ...run,
        status: nextStatus,
        finishedAtUnixMs: now,
        ...(approved ? {} : { failureCode: "review_rejected" }),
        resultSummary: input.reason,
      };
      yield* store.upsertTask(nextTask);
      yield* store.upsertRun(nextRun);
      const priorEvents = yield* store.listEvents(input.taskId, input.runId);
      yield* store.appendEvent({
        taskId: nextTask.taskId,
        runId: nextRun.runId,
        ...(nextTask.parentTaskId === undefined ? {} : { parentTaskId: nextTask.parentTaskId }),
        agentId: nextRun.agentId,
        runtimeId: nextRun.runtimeId,
        status: nextStatus,
        sequence: priorEvents.length,
        eventType: "status",
        summary: approved ? `审核通过：${input.reason}` : `审核拒绝：${input.reason}`,
      });
      yield* releaseRunLease(nextRun);
      return {
        task: nextTask,
        run: nextRun,
        status: approved ? "approved" : "rejected",
      };
    });

  const resumeTask: CompositionOrchestrator["resumeTask"] = (input) =>
    Effect.gen(function* () {
      if (resumingRunIds.has(input.runId)) {
        return yield* new CompositionTaskResumeInvalidError({
          taskId: input.taskId,
          runId: input.runId,
          reason: "resume_in_progress",
        });
      }
      resumingRunIds.add(input.runId);

      return yield* Effect.gen(function* () {
        const taskOption = yield* store.getTask(input.taskId);
        const runOption = yield* store.getRun(input.runId);
        if (Option.isNone(taskOption) || Option.isNone(runOption)) {
          return yield* new CompositionTaskNotFoundError({
            taskId: input.taskId,
            runId: input.runId,
          });
        }
        const initialTask = taskOption.value;
        const initialRun = runOption.value;
        const driver = yield* driverRegistry.get(initialRun.agentId);
        if (driver === undefined) {
          return yield* new CompositionAgentDriverFailure({
            code: "agent_driver_unavailable",
            detail: `未找到 Agent Driver：${initialRun.agentId}`,
          });
        }
        if (driver.resumeTask === undefined) {
          return yield* new CompositionAgentDriverFailure({
            code: "agent_driver_resume_unsupported",
            detail: `Agent Driver 未提供 Runtime Resume：${initialRun.agentId}`,
          });
        }

        const leaseRecovered = yield* Clock.currentTimeMillis.pipe(
          Effect.flatMap((nowUnixMs) =>
            recoverCompositionRuntimeLease(store, {
              task: initialTask,
              run: initialRun,
              nowUnixMs,
            }),
          ),
        );
        if (Option.isNone(leaseRecovered)) {
          return yield* new CompositionAgentDriverFailure({
            code: "capacity_exceeded",
            detail: "Runtime Run 无法恢复其工作区租约，拒绝恢复执行。",
          });
        }

        const requested = yield* store.withTransaction(
          Effect.gen(function* () {
            const taskOption = yield* store.getTask(input.taskId);
            const runOption = yield* store.getRun(input.runId);
            const latestRunOption = yield* store.getLatestRun(input.taskId);
            if (Option.isNone(taskOption) || Option.isNone(runOption)) {
              return yield* new CompositionTaskNotFoundError({
                taskId: input.taskId,
                runId: input.runId,
              });
            }
            const task = taskOption.value;
            const run = runOption.value;
            const invalid = (reason: string) =>
              new CompositionTaskResumeInvalidError({
                taskId: input.taskId,
                runId: input.runId,
                reason,
              });
            if (run.taskId !== task.taskId) return yield* invalid("run_task_mismatch");
            if (Option.isNone(latestRunOption) || latestRunOption.value.runId !== run.runId) {
              return yield* invalid("run_is_not_latest");
            }
            if (terminalStatuses.has(task.status))
              return yield* invalid(`task_status_${task.status}`);
            if (terminalStatuses.has(run.status)) return yield* invalid(`run_status_${run.status}`);
            if (task.status === "in_review") return yield* invalid("task_status_in_review");
            if (run.status === "in_review") return yield* invalid("run_status_in_review");
            if (run.cancelRequestedAtUnixMs !== undefined) {
              return yield* invalid("cancel_requested");
            }
            if (run.runtimeTaskId === undefined) return yield* invalid("runtime_task_id_missing");

            const now = yield* Clock.currentTimeMillis;
            const resumingTask: CompositionTask = {
              ...task,
              status: "resuming",
              updatedAtUnixMs: now,
            };
            const resumingRun: CompositionTaskRun = {
              ...run,
              status: "resuming",
            };
            yield* store.upsertTask(resumingTask);
            yield* store.upsertRun(resumingRun);
            const events = yield* store.listEvents(input.taskId, input.runId);
            yield* store.appendEvent(
              makeEvent({
                task: resumingTask,
                run: resumingRun,
                sequence: events.length,
                status: "resuming",
                eventType: "status",
                summary: `Runtime 已请求恢复：${input.reason}`,
              }),
            );
            return {
              task: resumingTask,
              run: resumingRun,
              previousTaskStatus: task.status,
              previousRunStatus: run.status,
            };
          }),
        );

        const restore = (summary: string) =>
          store.withTransaction(
            Effect.gen(function* () {
              const taskOption = yield* store.getTask(input.taskId);
              const runOption = yield* store.getRun(input.runId);
              if (Option.isNone(taskOption) || Option.isNone(runOption)) {
                return yield* new CompositionTaskNotFoundError({
                  taskId: input.taskId,
                  runId: input.runId,
                });
              }
              const task = taskOption.value;
              const run = runOption.value;
              if (
                terminalStatuses.has(task.status) ||
                terminalStatuses.has(run.status) ||
                task.status === "in_review" ||
                run.status === "in_review" ||
                run.cancelRequestedAtUnixMs !== undefined ||
                task.status !== "resuming" ||
                run.status !== "resuming"
              ) {
                return { task, run };
              }
              const now = yield* Clock.currentTimeMillis;
              const restoredTask: CompositionTask = {
                ...task,
                status: requested.previousTaskStatus,
                updatedAtUnixMs: now,
              };
              const restoredRun: CompositionTaskRun = {
                ...run,
                status: requested.previousRunStatus,
              };
              yield* store.upsertTask(restoredTask);
              yield* store.upsertRun(restoredRun);
              const events = yield* store.listEvents(input.taskId, input.runId);
              yield* store.appendEvent(
                makeEvent({
                  task: restoredTask,
                  run: restoredRun,
                  sequence: events.length,
                  status: restoredTask.status,
                  eventType: "status",
                  summary,
                }),
              );
              return { task: restoredTask, run: restoredRun };
            }),
          );

        const result = yield* Effect.result(
          driver.resumeTask({ task: requested.task, run: requested.run, reason: input.reason }),
        );
        if (result._tag === "Failure") {
          yield* restore(`Runtime 恢复请求失败：${result.failure.code}`);
          return yield* result.failure;
        }
        if (result.success.status === "already_terminal") {
          const restored = yield* restore("Runtime 已反馈终态，等待可信终态事件");
          return { ...restored, status: "already_terminal" as const };
        }

        return yield* store.withTransaction(
          Effect.gen(function* () {
            const taskOption = yield* store.getTask(input.taskId);
            const runOption = yield* store.getRun(input.runId);
            if (Option.isNone(taskOption) || Option.isNone(runOption)) {
              return yield* new CompositionTaskNotFoundError({
                taskId: input.taskId,
                runId: input.runId,
              });
            }
            const task = taskOption.value;
            const run = runOption.value;
            if (
              terminalStatuses.has(task.status) ||
              terminalStatuses.has(run.status) ||
              task.status === "in_review" ||
              run.status === "in_review" ||
              run.cancelRequestedAtUnixMs !== undefined ||
              task.status !== "resuming" ||
              run.status !== "resuming"
            ) {
              return { task, run, status: result.success.status };
            }
            const now = yield* Clock.currentTimeMillis;
            const runningTask: CompositionTask = {
              ...task,
              status: "running",
              updatedAtUnixMs: now,
            };
            const runningRun: CompositionTaskRun = {
              ...run,
              status: "running",
            };
            yield* store.upsertTask(runningTask);
            yield* store.upsertRun(runningRun);
            const events = yield* store.listEvents(input.taskId, input.runId);
            yield* store.appendEvent(
              makeEvent({
                task: runningTask,
                run: runningRun,
                sequence: events.length,
                status: "running",
                eventType: "status",
                summary: "Runtime 已确认恢复运行",
              }),
            );
            return { task: runningTask, run: runningRun, status: result.success.status };
          }),
        );
      }).pipe(Effect.ensuring(Effect.sync(() => resumingRunIds.delete(input.runId))));
    });

  const retryTask: CompositionOrchestrator["retryTask"] = (input) =>
    Effect.gen(function* () {
      const taskOption = yield* store.getTask(input.taskId);
      const previousRunOption = yield* store.getRun(input.previousRunId);
      if (Option.isNone(taskOption) || Option.isNone(previousRunOption)) {
        return yield* new CompositionTaskNotFoundError({
          taskId: input.taskId,
          runId: input.previousRunId,
        });
      }
      const task = taskOption.value;
      const previousRun = previousRunOption.value;
      const latestRunOption = yield* store.getLatestRun(input.taskId);
      const existingRunOption = yield* store.getRun(input.runId);
      if (Option.isNone(latestRunOption)) {
        return yield* new CompositionTaskRetryInvalidError({
          taskId: input.taskId,
          previousRunId: input.previousRunId,
          reason: "latest_run_missing",
        });
      }
      if (task.status !== "failed" && task.status !== "timed_out") {
        return yield* new CompositionTaskRetryInvalidError({
          taskId: input.taskId,
          previousRunId: input.previousRunId,
          reason: `task_status_${task.status}`,
        });
      }
      if (previousRun.status !== "failed" && previousRun.status !== "timed_out") {
        return yield* new CompositionTaskRetryInvalidError({
          taskId: input.taskId,
          previousRunId: input.previousRunId,
          reason: `run_status_${previousRun.status}`,
        });
      }
      if (latestRunOption.value.runId !== input.previousRunId) {
        return yield* new CompositionTaskRetryInvalidError({
          taskId: input.taskId,
          previousRunId: input.previousRunId,
          reason: "previous_run_is_not_latest",
        });
      }
      if (input.runId === input.previousRunId || Option.isSome(existingRunOption)) {
        return yield* new CompositionTaskRetryInvalidError({
          taskId: input.taskId,
          previousRunId: input.previousRunId,
          reason: "run_id_conflict",
        });
      }
      if (input.capabilityIds.length === 0) {
        return yield* new CompositionTaskRetryInvalidError({
          taskId: input.taskId,
          previousRunId: input.previousRunId,
          reason: "capability_ids_required",
        });
      }
      if (inputStore === undefined) {
        return yield* new CompositionTaskRetryInvalidError({
          taskId: input.taskId,
          previousRunId: input.previousRunId,
          reason: "recovery_input_store_unavailable",
        });
      }
      const recoveryInput = yield* inputStore.get(input.taskId);
      if (Option.isNone(recoveryInput)) {
        return yield* new CompositionTaskRetryInvalidError({
          taskId: input.taskId,
          previousRunId: input.previousRunId,
          reason: "recovery_input_missing",
        });
      }
      const targetAgentId = input.agentId ?? previousRun.agentId;
      const previousDriver = yield* driverRegistry.get(previousRun.agentId);
      const targetDriver =
        targetAgentId === previousRun.agentId
          ? previousDriver
          : yield* driverRegistry.get(targetAgentId);
      if (targetDriver === undefined) {
        return yield* new CompositionAgentDriverFailure({
          code: "agent_driver_unavailable",
          detail: `未找到目标 Agent Driver：${targetAgentId}`,
        });
      }
      const queuedAt = yield* Clock.currentTimeMillis;
      const { finishedAtUnixMs: _finishedAtUnixMs, ...taskWithoutFinishedAt } = task;
      const queuedTask: CompositionTask = {
        ...taskWithoutFinishedAt,
        assigneeId: targetAgentId,
        status: "queued",
        updatedAtUnixMs: queuedAt,
      };
      const setupRun: CompositionTaskRun = {
        runId: input.runId,
        taskId: input.taskId,
        agentId: targetAgentId,
        runtimeId: targetDriver.runtimeId,
        status: "queued",
        attempt: previousRun.attempt + 1,
        capabilityGrantIds: [],
      };
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const setupClaim =
            runStartStore === undefined
              ? undefined
              : yield* claimPersistedRunStart({
                  task: queuedTask,
                  run: setupRun,
                  previousRunId: input.previousRunId,
                  driver: targetDriver,
                  ...(recoveryInput.value.workspaceRootDigest === undefined
                    ? {}
                    : { workspaceRootDigest: recoveryInput.value.workspaceRootDigest }),
                  ...(recoveryInput.value.model === undefined
                    ? {}
                    : { model: recoveryInput.value.model }),
                  capabilityIds: input.capabilityIds,
                });
          if (setupClaim !== undefined && !setupClaim.claimed) {
            return yield* persistedRunStartWinnerFailure(
              setupClaim.intent,
              `Run ${input.runId} 的 retry setup 已由其他 Runtime owner 认领。`,
            );
          }
          const claimedIntent = setupClaim?.intent;
          let issuedGrants: ReadonlyArray<CompositionCapabilityGrant> = [];
          const cleanupSetup = () =>
            runStartStore === undefined || claimedIntent === undefined
              ? revokeCapabilityGrantIds(issuedGrants.map((grant) => grant.grantId))
              : Effect.gen(function* () {
                  const currentOption = yield* runStartStore.getStart(claimedIntent.runId);
                  if (Option.isNone(currentOption)) return;
                  const current = currentOption.value;
                  if (current.state !== "preparing" || current.claimId !== claimedIntent.claimId) {
                    return;
                  }
                  yield* revokeCapabilityGrantIds(issuedGrants.map((grant) => grant.grantId));
                  yield* releasePersistedRunStartPreparation(current);
                });

          const setupExit = yield* Effect.exit(
            restore(
              Effect.gen(function* () {
                // 先撤销旧 Run 的 grant，避免 CapabilityGrantRegistry 按 task/agent 复用旧授权。
                yield* revokeRunCapabilities(previousDriver, task, previousRun);
                yield* releaseRunLease(previousRun);
                issuedGrants =
                  grantRegistry === undefined
                    ? []
                    : yield* grantRegistry.issue({
                        taskId: input.taskId,
                        agentId: targetAgentId,
                        capabilityIds: input.capabilityIds,
                      });
                const capabilityGrantIds = issuedGrants.map((grant) => grant.grantId);
                const queuedRun: CompositionTaskRun = {
                  ...setupRun,
                  capabilityGrantIds,
                };
                return yield* store.withTransaction(
                  Effect.gen(function* () {
                    yield* store.upsertTask(queuedTask);
                    yield* store.upsertRun(queuedRun);
                    yield* store.appendEvent(
                      makeEvent({
                        task: queuedTask,
                        run: queuedRun,
                        sequence: 0,
                        status: "queued",
                        eventType: "status",
                        summary:
                          targetAgentId === previousRun.agentId
                            ? `任务已请求重试：${input.reason}`
                            : `任务已从 Agent ${previousRun.agentId} 重派至 ${targetAgentId}：${input.reason}`,
                      }),
                    );
                    if (issuedGrants.length > 0) {
                      yield* persistCapabilityGrantProjection({
                        task: queuedTask,
                        run: queuedRun,
                        sourceEventId: `capgrant:${queuedTask.taskId}:${queuedRun.runId}:issued`,
                        summary: describeIssuedGrants(issuedGrants),
                      });
                    }
                    const leasedRunOption = yield* prepareRunLease(
                      queuedTask,
                      queuedRun,
                      recoveryInput.value.workspaceRootDigest,
                    );
                    const dispatchingIntent =
                      runStartStore === undefined || claimedIntent === undefined
                        ? undefined
                        : yield* runStartStore.markDispatching({
                            runId: claimedIntent.runId,
                            expectedRevision: claimedIntent.revision,
                            claimId: claimedIntent.claimId ?? "",
                            dispatchedAtUnixMs: Math.max(
                              yield* Clock.currentTimeMillis,
                              claimedIntent.updatedAtUnixMs,
                            ),
                          });
                    return {
                      run: Option.getOrElse(leasedRunOption, () => queuedRun),
                      leaseClaimed: Option.isSome(leasedRunOption),
                      dispatchingIntent,
                    };
                  }),
                );
              }),
            ).pipe(
              Effect.onExit((exit) => (exit._tag === "Success" ? Effect.void : cleanupSetup())),
            ),
          );
          if (setupExit._tag === "Failure") {
            return yield* Effect.failCause(setupExit.cause);
          }
          const preparedStart = setupExit.value;
          const start = preparedStart.leaseClaimed
            ? targetDriver.startTask({
                task: queuedTask,
                run: preparedStart.run,
                prompt: recoveryInput.value.prompt,
                workspaceRoot: recoveryInput.value.workspaceRoot,
                ...(recoveryInput.value.workspaceRootDigest === undefined
                  ? {}
                  : { workspaceRootDigest: recoveryInput.value.workspaceRootDigest }),
                ...(recoveryInput.value.model === undefined
                  ? {}
                  : { model: recoveryInput.value.model }),
                capabilityGrantIds: preparedStart.run.capabilityGrantIds,
              })
            : Effect.fail(
                new CompositionAgentDriverFailure({
                  code: "capacity_exceeded",
                  detail: "工作区已有未过期的 Runtime 租约，拒绝重复派发。",
                }),
              );
          return yield* restore(
            startPersistedRun({
              task: queuedTask,
              run: preparedStart.run,
              previousRunId: input.previousRunId,
              driver: targetDriver,
              ...(recoveryInput.value.workspaceRootDigest === undefined
                ? {}
                : { workspaceRootDigest: recoveryInput.value.workspaceRootDigest }),
              ...(recoveryInput.value.model === undefined
                ? {}
                : { model: recoveryInput.value.model }),
              capabilityIds: input.capabilityIds,
              ...(preparedStart.dispatchingIntent === undefined
                ? {}
                : { intent: preparedStart.dispatchingIntent }),
              start,
              startedSummary: "重试任务已交给 Agent Driver 执行",
              failedSummary: preparedStart.leaseClaimed
                ? "重试任务启动失败"
                : "重试任务未获得工作区租约",
              finishTaskOnFailure: true,
            }),
          );
        }),
      );
    });

  const resumeReadyTasks: CompositionOrchestrator["resumeReadyTasks"] = () =>
    Effect.gen(function* () {
      if (inputStore === undefined) return [];
      const tasks = yield* store.listTasks();
      const resumed: Array<CompositionDispatchResult> = [];

      for (const task of tasks) {
        if (task.status !== "blocked" || resumingTaskIds.has(task.taskId)) continue;
        const dependencies = yield* Effect.forEach(task.dependsOnTaskIds, (dependencyId) =>
          store.getTask(dependencyId),
        );
        if (
          dependencies.length !== task.dependsOnTaskIds.length ||
          dependencies.some(
            (dependency: Option.Option<CompositionTask>) =>
              Option.isNone(dependency) || !dependencySatisfied(dependency.value.status),
          )
        ) {
          continue;
        }

        const recoveryInput = yield* inputStore.get(task.taskId);
        if (Option.isNone(recoveryInput)) continue;
        const runOption = yield* store.getLatestRun(task.taskId);
        if (Option.isNone(runOption)) continue;
        const run = runOption.value;
        const driver = yield* driverRegistry.get(run.agentId);
        if (driver === undefined) continue;
        const recoveryCapabilityIds = recoveryInput.value.capabilityIds;
        if (runStartStore !== undefined && recoveryCapabilityIds === undefined) {
          yield* quarantineUnknownRecoveryCapabilities({
            task,
            run,
            driver,
            ...(recoveryInput.value.workspaceRootDigest === undefined
              ? {}
              : { workspaceRootDigest: recoveryInput.value.workspaceRootDigest }),
            ...(recoveryInput.value.model === undefined
              ? {}
              : { model: recoveryInput.value.model }),
          });
          continue;
        }
        const capabilityIds = recoveryCapabilityIds ?? [];

        if (runStartStore === undefined) {
          const leasedRunOption = yield* prepareRunLease(
            task,
            run,
            recoveryInput.value.workspaceRootDigest,
          );
          if (Option.isNone(leasedRunOption)) continue;
          const leasedRun = leasedRunOption.value;
          resumingTaskIds.add(task.taskId);
          const result = yield* startPersistedRun({
            task,
            run: leasedRun,
            previousRunId: null,
            driver,
            ...(recoveryInput.value.workspaceRootDigest === undefined
              ? {}
              : { workspaceRootDigest: recoveryInput.value.workspaceRootDigest }),
            ...(recoveryInput.value.model === undefined
              ? {}
              : { model: recoveryInput.value.model }),
            capabilityIds,
            start: driver.startTask({
              task,
              run: leasedRun,
              prompt: recoveryInput.value.prompt,
              workspaceRoot: recoveryInput.value.workspaceRoot,
              ...(recoveryInput.value.workspaceRootDigest === undefined
                ? {}
                : { workspaceRootDigest: recoveryInput.value.workspaceRootDigest }),
              ...(recoveryInput.value.model === undefined
                ? {}
                : { model: recoveryInput.value.model }),
              capabilityGrantIds: leasedRun.capabilityGrantIds,
            }),
            startedSummary: "依赖完成后已恢复任务",
            failedSummary: "恢复任务启动失败",
            finishTaskOnFailure: true,
          }).pipe(Effect.ensuring(Effect.sync(() => resumingTaskIds.delete(task.taskId))));
          resumed.push(result);
          continue;
        }

        const resultOption = yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const setupClaim = yield* claimPersistedRunStart({
              task,
              run,
              previousRunId: null,
              driver,
              ...(recoveryInput.value.workspaceRootDigest === undefined
                ? {}
                : { workspaceRootDigest: recoveryInput.value.workspaceRootDigest }),
              ...(recoveryInput.value.model === undefined
                ? {}
                : { model: recoveryInput.value.model }),
              capabilityIds,
            });
            if (!setupClaim.claimed) {
              return yield* persistedRunStartWinnerFailure(
                setupClaim.intent,
                `Run ${run.runId} 的 blocked-ready setup 已由其他 Runtime owner 认领。`,
              );
            }

            const claimedIntent = setupClaim.intent;
            let leasedRun: CompositionTaskRun | undefined;
            const cleanupSetup = Effect.gen(function* () {
              const currentOption = yield* runStartStore.getStart(claimedIntent.runId);
              if (Option.isNone(currentOption)) return;
              const current = currentOption.value;
              if (current.state !== "preparing" || current.claimId !== claimedIntent.claimId) {
                return;
              }
              const releaseLease =
                leasedRun === undefined ? Effect.void : releaseRunLease(leasedRun);
              const leaseExit = yield* Effect.exit(releaseLease);
              const preparationExit = yield* Effect.exit(
                releasePersistedRunStartPreparation(current),
              );
              if (leaseExit._tag === "Failure") {
                return yield* Effect.failCause(leaseExit.cause);
              }
              if (preparationExit._tag === "Failure") {
                return yield* Effect.failCause(preparationExit.cause);
              }
            });

            resumingTaskIds.add(task.taskId);
            return yield* restore(
              Effect.gen(function* () {
                const leasedRunOption = yield* prepareRunLease(
                  task,
                  run,
                  recoveryInput.value.workspaceRootDigest,
                );
                if (Option.isNone(leasedRunOption)) {
                  yield* cleanupSetup;
                  return Option.none<CompositionDispatchResult>();
                }
                leasedRun = leasedRunOption.value;
                return Option.some(
                  yield* startPersistedRun({
                    task,
                    run: leasedRun,
                    previousRunId: null,
                    driver,
                    ...(recoveryInput.value.workspaceRootDigest === undefined
                      ? {}
                      : { workspaceRootDigest: recoveryInput.value.workspaceRootDigest }),
                    ...(recoveryInput.value.model === undefined
                      ? {}
                      : { model: recoveryInput.value.model }),
                    capabilityIds,
                    intent: claimedIntent,
                    start: driver.startTask({
                      task,
                      run: leasedRun,
                      prompt: recoveryInput.value.prompt,
                      workspaceRoot: recoveryInput.value.workspaceRoot,
                      ...(recoveryInput.value.workspaceRootDigest === undefined
                        ? {}
                        : { workspaceRootDigest: recoveryInput.value.workspaceRootDigest }),
                      ...(recoveryInput.value.model === undefined
                        ? {}
                        : { model: recoveryInput.value.model }),
                      capabilityGrantIds: leasedRun.capabilityGrantIds,
                    }),
                    startedSummary: "依赖完成后已恢复任务",
                    failedSummary: "恢复任务启动失败",
                    finishTaskOnFailure: true,
                  }),
                );
              }),
            ).pipe(
              Effect.onExit((exit) => (exit._tag === "Success" ? Effect.void : cleanupSetup)),
              Effect.ensuring(Effect.sync(() => resumingTaskIds.delete(task.taskId))),
            );
          }),
        );
        if (Option.isSome(resultOption)) resumed.push(resultOption.value);
      }

      return resumed;
    });

  return { dispatchTask, cancelTask, resumeTask, reviewTask, retryTask, resumeReadyTasks };
};

export const makeCompositionOrchestrator = (
  store: CompositionTaskStoreShape,
  driverRegistry: CompositionAgentDriverRegistry,
  grantRegistry?: Pick<CapabilityGrantRegistry.CapabilityGrantRegistryShape, "issue"> &
    Partial<Pick<CapabilityGrantRegistry.CapabilityGrantRegistryShape, "revoke">>,
  inputStore?: CompositionTaskInputStoreShape,
  runStartStore?: CompositionRunStartExecutionStoreShape,
): CompositionOrchestrator =>
  makeOrchestrator(store, driverRegistry, grantRegistry, inputStore, runStartStore);
