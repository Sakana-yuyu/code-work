import * as NodeCrypto from "node:crypto";

import { expect, it } from "@effect/vitest";
import {
  isCompositionSquadExecutionStatusTransitionAllowed,
  validateCompositionSquadExecution,
  type CompositionSquad,
  type CompositionSquadExecution,
  type CompositionSquadExecutionStatus,
  type CompositionTask,
  type CompositionTaskDispatchResult,
  type CompositionTaskRun,
} from "@codework/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as References from "effect/References";

import { PersistenceDecodeError, PersistenceSqlError } from "../persistence/Errors.ts";
import {
  type CompositionSquadExecutionClaimResult,
  type CompositionSquadExecutionStoreError,
  CompositionSquadExecutionStoreDomainError,
  type CompositionSquadExecutionStoreShape,
} from "../persistence/Services/CompositionSquadExecutionStore.ts";
import { encodeCompositionSquadPlanOutput } from "./CompositionSquadPlan.ts";
import {
  CompositionSquadPlannerError,
  makeCompositionSquadPlanner,
} from "./CompositionSquadPlanner.ts";
import {
  compileCompositionSquadGraph,
  makeCompositionSquadRunner,
  type CompositionSquadExecutionInput,
} from "./CompositionSquadRunner.ts";
import {
  CompositionTaskGraphExecutionError,
  makeCompositionTaskGraphExecutor,
  type CompositionTaskGraphExecutionInput,
  type CompositionTaskGraphExecutionResult,
} from "./CompositionTaskGraphExecutor.ts";
import { CompositionAgentDriverFailure } from "./CompositionOrchestrator.ts";
import { CompositionTaskRuntimeWaitError } from "./CompositionTaskRuntimeProjectionService.ts";
import type {
  CompositionSquadModelBindingResolverShape,
  ResolvedCompositionSquadMemberModel,
} from "./CompositionSquadModelBindingResolver.ts";

const baseSquad: CompositionSquad = {
  squadId: "squad-core",
  name: "核心协同组",
  leaderAgentId: "agent-leader",
  memberAgentIds: ["agent-leader", "agent-worker", "agent-reviewer", "agent-critic"],
  instructions: "先实现，再审查，最后由 Leader 汇总。",
  revision: 3,
  collaborationMode: "leader_workers",
  members: [
    {
      agentId: "agent-leader",
      role: "leader",
      order: 0,
      required: true,
      model: "provider/leader-model",
      workspaceRoot: "C:/workspace/leader",
      capabilityIds: ["t3.workspace.read_file"],
      maxConcurrentTasks: 1,
    },
    {
      agentId: "agent-worker",
      role: "worker",
      order: 1,
      required: true,
      model: "provider/worker-model",
      workspaceRoot: "C:/workspace/worker",
      capabilityIds: ["t3.workspace.read_file", "t3.workspace.write_file"],
      maxConcurrentTasks: 2,
    },
    {
      agentId: "agent-reviewer",
      role: "reviewer",
      order: 2,
      required: true,
      model: "provider/reviewer-model",
      workspaceRoot: "C:/workspace/reviewer",
      capabilityIds: ["t3.workspace.read_file"],
      maxConcurrentTasks: 1,
    },
    {
      agentId: "agent-critic",
      role: "critic",
      order: 3,
      required: false,
      model: "provider/critic-model",
      workspaceRoot: "C:/workspace/critic",
      capabilityIds: ["t3.workspace.read_file"],
      maxConcurrentTasks: 1,
    },
  ],
  maxConcurrency: 3,
  maxRetries: 2,
  failurePolicy: "fail_fast",
  partialSuccessPolicy: "reject",
  approvalStages: [],
  createdAtUnixMs: 100,
  updatedAtUnixMs: 300,
};

const baseInput: CompositionSquadExecutionInput = {
  executionId: "execution-1",
  squadId: baseSquad.squadId,
  squadRevision: 3,
  projectId: "project-1",
  threadId: "thread-1",
  goal: "完成多 Agent 协同实现并给出验证证据",
  workspaceRoot: "C:/workspace/default",
};

const sha256 = (value: string): string =>
  `sha256:${NodeCrypto.createHash("sha256").update(value, "utf8").digest("hex")}`;

type RunnerExecutionStore = Pick<
  CompositionSquadExecutionStoreShape,
  "claimExecution" | "getExecution" | "saveTransition"
>;

const makeStoreError = (
  executionId: string,
  detail: string,
  options?: {
    readonly code?:
      | "squad_execution_conflict"
      | "squad_execution_revision_conflict"
      | "squad_execution_status_conflict";
    readonly expectedRevision?: number;
    readonly actualRevision?: number;
  },
) =>
  new CompositionSquadExecutionStoreDomainError({
    code: options?.code ?? "squad_execution_conflict",
    detail,
    executionId,
    ...(options?.expectedRevision === undefined
      ? {}
      : { expectedRevision: options.expectedRevision }),
    ...(options?.actualRevision === undefined ? {} : { actualRevision: options.actualRevision }),
  });

const makeExecutionStoreHarness = (options?: {
  readonly forceClaimedFalse?: boolean;
  readonly failClaim?: boolean;
  readonly failSaveStatus?: CompositionSquadExecutionStatus;
  readonly failSavePersistenceStatus?: CompositionSquadExecutionStatus;
  readonly raceToCancellingAfterSaveStatus?: CompositionSquadExecutionStatus;
  readonly raceToCancelledOnSaveStatus?: CompositionSquadExecutionStatus;
  readonly raceConflictCode?:
    | "squad_execution_revision_conflict"
    | "squad_execution_status_conflict";
  readonly afterClaim?: Effect.Effect<void>;
  readonly pauseClaimedExecution?: boolean;
  readonly beforeSave?: (execution: CompositionSquadExecution) => Effect.Effect<void>;
  readonly afterSave?: (execution: CompositionSquadExecution) => Effect.Effect<void>;
  readonly events?: string[];
}) => {
  let current: CompositionSquadExecution | undefined;
  const snapshots: CompositionSquadExecution[] = [];
  const events = options?.events ?? [];
  let raceApplied = false;
  const expectValidExecution = (execution: CompositionSquadExecution): void => {
    expect(validateCompositionSquadExecution(execution)).toEqual([]);
  };
  const expectAllowedTransition = (
    from: CompositionSquadExecution,
    to: CompositionSquadExecution,
  ): void => {
    const pausedFromStatus =
      to.status === "paused"
        ? to.pausedFromStatus
        : from.status === "paused"
          ? from.pausedFromStatus
          : undefined;
    expect(
      isCompositionSquadExecutionStatusTransitionAllowed({
        from: from.status,
        to: to.status,
        ...(pausedFromStatus === undefined ? {} : { pausedFromStatus }),
      }),
    ).toBe(true);
  };
  const store: RunnerExecutionStore = {
    claimExecution: (execution) =>
      Effect.gen(function* () {
        events.push(`store:claim:${execution.status}`);
        expectValidExecution(execution);
        if (options?.failClaim === true) {
          return yield* makeStoreError(execution.executionId, "claim 写入失败");
        }
        if (options?.forceClaimedFalse === true) {
          return {
            execution,
            claimed: false,
          } satisfies CompositionSquadExecutionClaimResult;
        }
        current = execution;
        snapshots.push(execution);
        if (options?.pauseClaimedExecution === true) {
          const paused: CompositionSquadExecution = {
            ...execution,
            status: "paused",
            revision: execution.revision + 1,
            pausedFromStatus: "queued",
            pausedAtUnixMs: execution.updatedAtUnixMs,
          };
          expectAllowedTransition(execution, paused);
          expectValidExecution(paused);
          current = paused;
          snapshots.push(paused);
        }
        if (options?.afterClaim !== undefined) {
          yield* options.afterClaim;
        }
        return {
          execution,
          claimed: true,
        } satisfies CompositionSquadExecutionClaimResult;
      }),
    saveTransition: ({
      execution,
      expectedRevision,
    }): Effect.Effect<CompositionSquadExecution, CompositionSquadExecutionStoreError> =>
      Effect.gen(function* () {
        events.push(`store:save:${execution.status}`);
        expectValidExecution(execution);
        if (current !== undefined) expectAllowedTransition(current, execution);
        if (options?.failSavePersistenceStatus === execution.status) {
          return yield* new PersistenceSqlError({
            operation: "save interrupted squad cancellation",
            detail: "interruption cancellation persistence unavailable",
            cause: new Error("interruption-cancellation-persistence-failed"),
          });
        }
        if (options?.raceToCancelledOnSaveStatus === execution.status && !raceApplied) {
          raceApplied = true;
          const competingCancelled: CompositionSquadExecution = {
            ...execution,
            status: "cancelled",
            revision: execution.revision + 1,
            finishedAtUnixMs: execution.updatedAtUnixMs,
          };
          expectAllowedTransition(execution, competingCancelled);
          expectValidExecution(competingCancelled);
          current = execution;
          snapshots.push(execution);
          current = competingCancelled;
          snapshots.push(competingCancelled);
          return yield* makeStoreError(execution.executionId, "execution 已被竞争写入者收口", {
            code: options?.raceConflictCode ?? "squad_execution_revision_conflict",
            expectedRevision,
            actualRevision: competingCancelled.revision,
          });
        }
        if (options?.failSaveStatus === execution.status) {
          return yield* makeStoreError(execution.executionId, `${execution.status} 写入失败`, {
            code: "squad_execution_revision_conflict",
            expectedRevision,
            actualRevision: expectedRevision + 10,
          });
        }
        if (options?.beforeSave !== undefined) {
          yield* options.beforeSave(execution);
        }
        expect(current?.revision).toBe(expectedRevision);
        current = execution;
        snapshots.push(execution);
        if (options?.raceToCancellingAfterSaveStatus === execution.status && !raceApplied) {
          raceApplied = true;
          const competingCancelling: CompositionSquadExecution = {
            ...execution,
            status: "cancelling",
            revision: execution.revision + 1,
            pendingApprovals: [],
            cancelRequestedAtUnixMs: execution.updatedAtUnixMs,
          };
          expectAllowedTransition(execution, competingCancelling);
          expectValidExecution(competingCancelling);
          current = competingCancelling;
          snapshots.push(competingCancelling);
        }
        if (options?.afterSave !== undefined) {
          yield* options.afterSave(execution);
        }
        return execution;
      }),
    getExecution: () => Effect.succeed(Option.fromNullishOr(current)),
  };
  return {
    events,
    snapshots,
    store,
    read: () => current,
  };
};

const makeSquadLookup = (squad: CompositionSquad, events?: string[]) => ({
  getRunnable: () =>
    Effect.sync(() => {
      events?.push("squad:getRunnable");
      return squad;
    }),
  getRevision: (_squadId: string, _revision: number) =>
    Effect.sync(() => {
      events?.push("squad:getRevision");
      return squad;
    }),
});

const makeGraphResult = (
  input: CompositionTaskGraphExecutionInput,
  status: "completed" | "in_review" = "in_review",
  resultSummary?: string,
): CompositionTaskGraphExecutionResult => ({
  leader: {
    task: {
      taskId: input.leader.taskId,
      projectId: input.leader.projectId,
      assigneeKind: input.leader.assigneeKind,
      assigneeId: input.leader.assigneeId,
      mode: "review",
      status,
      promptDigest: input.leader.promptDigest,
      dependsOnTaskIds: [],
      createdAtUnixMs: 1,
      updatedAtUnixMs: 2,
    },
    run: {
      runId: input.leader.runId,
      taskId: input.leader.taskId,
      agentId: baseSquad.leaderAgentId,
      runtimeId: "runtime-leader",
      status,
      attempt: 1,
      capabilityGrantIds: [],
      ...(resultSummary === undefined ? {} : { resultSummary }),
    },
  },
  children: [],
});

const makeInterruptibleParallelExecutor = (
  childrenReady: Deferred.Deferred<void>,
  cancelled: string[],
  dispatched: string[],
  events?: string[],
  options?: {
    readonly failFirstCancellation?: boolean;
    readonly failFirstChildAfterReady?: boolean;
  },
) => {
  const tasks = new Map<string, CompositionTask>();
  const runs = new Map<string, CompositionTaskRun>();
  let childDispatchCount = 0;
  let cancellationCount = 0;
  let firstChildRunId: string | undefined;
  return makeCompositionTaskGraphExecutor({
    orchestrator: {
      dispatchTask: (input) =>
        Effect.gen(function* () {
          const result = yield* Effect.sync(() => {
            dispatched.push(`${input.taskId}/${input.runId}`);
            const task: CompositionTask = {
              taskId: input.taskId,
              projectId: input.projectId,
              ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
              ...(input.parentTaskId === undefined ? {} : { parentTaskId: input.parentTaskId }),
              assigneeKind: input.assigneeKind,
              assigneeId: input.assigneeId,
              mode: input.mode,
              status: "running",
              promptDigest: input.promptDigest,
              dependsOnTaskIds: [...input.dependsOnTaskIds],
              createdAtUnixMs: 1,
              updatedAtUnixMs: 1,
            };
            const run: CompositionTaskRun = {
              runId: input.runId,
              taskId: input.taskId,
              agentId: input.assigneeId,
              runtimeId: `runtime-${input.assigneeId}`,
              status: "running",
              attempt: 1,
              capabilityGrantIds: [],
            };
            tasks.set(task.taskId, task);
            runs.set(run.runId, run);
            return { task, run } satisfies CompositionTaskDispatchResult;
          });
          if (input.mode === "parallel") {
            firstChildRunId ??= input.runId;
            childDispatchCount += 1;
            if (childDispatchCount === 2) {
              yield* Deferred.succeed(childrenReady, undefined);
            }
          }
          return result;
        }),
      retryTask: () => Effect.die("中断取消测试不应重试"),
      cancelTask: ({ taskId, runId }) => {
        cancelled.push(`${taskId}/${runId}`);
        events?.push(`executor:cancel:${taskId}/${runId}`);
        cancellationCount += 1;
        if (options?.failFirstCancellation === true && cancellationCount === 1) {
          return Effect.fail(
            new CompositionAgentDriverFailure({
              code: "cancel_failed",
              detail: "sensitive child driver cancellation detail",
            }),
          );
        }
        return Effect.sync(() => {
          const task = tasks.get(taskId)!;
          const run = runs.get(runId)!;
          const cancelledTask = { ...task, status: "cancelled" as const };
          const cancelledRun = { ...run, status: "cancelled" as const };
          tasks.set(taskId, cancelledTask);
          runs.set(runId, cancelledRun);
          return {
            task: cancelledTask,
            run: cancelledRun,
            status: "cancelled" as const,
          };
        });
      },
    },
    store: {
      getTask: (taskId) => Effect.succeed(Option.fromNullishOr(tasks.get(taskId))),
      getRun: (runId) => Effect.succeed(Option.fromNullishOr(runs.get(runId))),
    },
    runtime: {
      awaitTaskCompletion: ({ taskId, runId }) =>
        options?.failFirstChildAfterReady === true && runId === firstChildRunId
          ? Deferred.await(childrenReady).pipe(
              Effect.flatMap(() =>
                Effect.fail(
                  new CompositionTaskRuntimeWaitError({
                    taskId,
                    runId,
                    reason: "business runtime wait failed",
                  }),
                ),
              ),
            )
          : Effect.never,
    },
  });
};

const makeRealPlannerHarness = (
  planningStarted: Deferred.Deferred<void>,
  options?: {
    readonly cancelFails?: boolean;
    readonly runtimeFails?: boolean;
  },
) => {
  const tasks = new Map<string, CompositionTask>();
  const runs = new Map<string, CompositionTaskRun>();
  const cancelled: string[] = [];
  const planner = makeCompositionSquadPlanner({
    orchestrator: {
      dispatchTask: (input) =>
        Effect.sync(() => {
          const task: CompositionTask = {
            taskId: input.taskId,
            projectId: input.projectId,
            ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
            assigneeKind: input.assigneeKind,
            assigneeId: input.assigneeId,
            mode: input.mode,
            status: "running",
            promptDigest: input.promptDigest,
            dependsOnTaskIds: [...input.dependsOnTaskIds],
            createdAtUnixMs: 1,
            updatedAtUnixMs: 1,
          };
          const run: CompositionTaskRun = {
            runId: input.runId,
            taskId: input.taskId,
            agentId: input.assigneeId,
            runtimeId: "runtime-planner",
            status: "running",
            attempt: 1,
            capabilityGrantIds: [],
          };
          tasks.set(task.taskId, task);
          runs.set(run.runId, run);
          return { task, run } satisfies CompositionTaskDispatchResult;
        }).pipe(Effect.tap(() => Deferred.succeed(planningStarted, undefined))),
      cancelTask: ({ taskId, runId }) => {
        cancelled.push(`${taskId}/${runId}`);
        if (options?.cancelFails === true) {
          return Effect.fail(
            new CompositionAgentDriverFailure({
              code: "planner_cancel_failed",
              detail: "sensitive planner cancellation detail",
            }),
          );
        }
        return Effect.sync(() => {
          const task = { ...tasks.get(taskId)!, status: "cancelled" as const };
          const run = { ...runs.get(runId)!, status: "cancelled" as const };
          tasks.set(taskId, task);
          runs.set(runId, run);
          return { task, run, status: "cancelled" as const };
        });
      },
    },
    store: {
      getTask: (taskId) => Effect.succeed(Option.fromNullishOr(tasks.get(taskId))),
      getRun: (runId) => Effect.succeed(Option.fromNullishOr(runs.get(runId))),
      listEvents: () => Effect.succeed([]),
    },
    runtime: {
      awaitTaskCompletion: ({ taskId, runId }) =>
        Effect.suspend(() => {
          if (options?.runtimeFails === true) {
            return Effect.fail(
              new CompositionTaskRuntimeWaitError({
                taskId,
                runId,
                reason: "planner runtime wait failed",
              }),
            );
          }
          const run = runs.get(runId)!;
          return run.status === "cancelled" ? Effect.succeed(run) : Effect.never;
        }),
    },
    cancelTimeoutMs: 50,
  });
  return { planner, cancelled };
};

const compile = (
  collaborationMode: CompositionSquad["collaborationMode"],
  input: CompositionSquadExecutionInput = baseInput,
) =>
  compileCompositionSquadGraph({
    squad: { ...baseSquad, collaborationMode },
    input,
  });

it.effect("把 Squad 成员模型、工作目录、能力和重试策略编译进真实 Graph 节点", () =>
  Effect.gen(function* () {
    const graph = yield* compile("leader_workers");

    expect(graph.maxConcurrency).toBe(3);
    expect(graph.schedule).toBe("parallel");
    expect(graph.failurePolicy).toBe("fail_fast");
    expect(graph.partialSuccessPolicy).toBe("reject");
    expect(graph.leader).toMatchObject({
      assigneeKind: "squad",
      assigneeId: baseSquad.squadId,
      model: "provider/leader-model",
      workspaceRoot: "C:/workspace/leader",
      capabilityIds: ["t3.workspace.read_file"],
    });
    expect(graph.children.map((node) => node.assigneeId)).toEqual([
      "agent-worker",
      "agent-reviewer",
      "agent-critic",
    ]);
    expect(graph.children[0]).toMatchObject({
      model: "provider/worker-model",
      workspaceRoot: "C:/workspace/worker",
      capabilityIds: ["t3.workspace.read_file", "t3.workspace.write_file"],
      maxAttempts: 3,
    });
  }),
);

it.effect("把团队默认、成员覆盖和接管候选的结构化模型快照编译进 Graph", () =>
  Effect.gen(function* () {
    const structuredSquad: CompositionSquad = {
      ...baseSquad,
      defaultModelBinding: {
        kind: "byok",
        providerInstanceId: "byok-team",
        adapterId: "adapter-leader",
        modelId: "leader-model",
      },
      members: baseSquad.members?.map((item) => {
        if (item.role === "leader") {
          return { ...item, model: undefined, modelBinding: { kind: "team_default" as const } };
        }
        if (item.agentId === "agent-reviewer") {
          return {
            ...item,
            model: undefined,
            modelBinding: { kind: "runtime_native" as const, modelId: "review-model" },
          };
        }
        if (item.agentId === "agent-critic") {
          return {
            ...item,
            model: undefined,
            modelBinding: { kind: "runtime_native" as const, modelId: "critic-model" },
          };
        }
        return item;
      }),
    };
    const resolvedByAgent = new Map<string, ResolvedCompositionSquadMemberModel>([
      [
        "agent-leader",
        {
          model: "adapter-leader",
          modelSnapshot: {
            kind: "byok",
            providerInstanceId: "byok-team",
            adapterId: "adapter-leader",
            modelId: "leader-model",
            adapterConfigDigest: "sha256:leader-v1",
          },
        },
      ],
      [
        "agent-worker",
        {
          model: "provider/worker-model",
          modelSnapshot: { kind: "legacy", modelId: "provider/worker-model" },
        },
      ],
      [
        "agent-reviewer",
        {
          model: "review-model",
          modelSnapshot: { kind: "runtime_native", modelId: "review-model" },
        },
      ],
      [
        "agent-critic",
        {
          model: "critic-model",
          modelSnapshot: { kind: "runtime_native", modelId: "critic-model" },
        },
      ],
    ]);
    const modelBindings: Pick<CompositionSquadModelBindingResolverShape, "resolveMember"> = {
      resolveMember: ({ member }) => Effect.succeed(resolvedByAgent.get(member.agentId) ?? {}),
    };

    const graph = yield* compileCompositionSquadGraph({
      squad: { ...structuredSquad, collaborationMode: "review_critic" },
      input: {
        ...baseInput,
        plan: [
          {
            nodeId: "review-only",
            agentId: "agent-reviewer",
            prompt: "审查实现证据",
            dependsOnNodeIds: [],
          },
        ],
      },
      modelBindings,
    });

    expect(graph.leader).toMatchObject({
      model: "adapter-leader",
      modelSnapshot: {
        kind: "byok",
        providerInstanceId: "byok-team",
        adapterId: "adapter-leader",
        modelId: "leader-model",
        adapterConfigDigest: "sha256:leader-v1",
      },
    });
    expect(graph.children[0]).toMatchObject({
      assigneeId: "agent-reviewer",
      model: "review-model",
      modelSnapshot: { kind: "runtime_native", modelId: "review-model" },
      failoverCandidates: [
        {
          assigneeId: "agent-critic",
          model: "critic-model",
          modelSnapshot: { kind: "runtime_native", modelId: "critic-model" },
        },
      ],
    });
  }),
);

it.effect("为节点编译同角色且能力不降级的有序接管候选", () =>
  Effect.gen(function* () {
    const squad: CompositionSquad = {
      ...baseSquad,
      memberAgentIds: [
        ...baseSquad.memberAgentIds,
        "agent-worker-backup",
        "agent-worker-underqualified",
      ],
      members: [
        ...baseSquad.members!,
        {
          agentId: "agent-worker-backup",
          role: "worker",
          order: 4,
          required: false,
          model: "provider/backup-model",
          workspaceRoot: "C:/workspace/backup",
          capabilityIds: ["t3.workspace.read_file", "t3.workspace.write_file", "t3.git.status"],
          maxConcurrentTasks: 1,
        },
        {
          agentId: "agent-worker-underqualified",
          role: "worker",
          order: 5,
          required: false,
          model: "provider/underqualified-model",
          workspaceRoot: "C:/workspace/underqualified",
          capabilityIds: ["t3.workspace.read_file"],
          maxConcurrentTasks: 1,
        },
      ],
    };

    const graph = yield* compileCompositionSquadGraph({
      squad,
      input: {
        ...baseInput,
        plan: [
          {
            nodeId: "primary-work",
            agentId: "agent-worker",
            prompt: "完成主实现",
            dependsOnNodeIds: [],
          },
        ],
      },
    });

    expect(graph.children.find((node) => node.assigneeId === "agent-worker")).toMatchObject({
      failoverCandidates: [
        {
          assigneeId: "agent-worker-backup",
          model: "provider/backup-model",
          workspaceRoot: "C:/workspace/backup",
          capabilityIds: ["t3.workspace.read_file", "t3.workspace.write_file"],
        },
      ],
    });
  }),
);

it.effect("Reviewer 与 Critic 在评审角色池内互相接管", () =>
  Effect.gen(function* () {
    const graph = yield* compileCompositionSquadGraph({
      squad: { ...baseSquad, collaborationMode: "review_critic" },
      input: {
        ...baseInput,
        plan: [
          {
            nodeId: "review-only",
            agentId: "agent-reviewer",
            prompt: "审查实现证据",
            dependsOnNodeIds: [],
          },
        ],
      },
    });

    expect(graph.children[0]).toMatchObject({
      assigneeId: "agent-reviewer",
      failoverCandidates: [
        {
          assigneeId: "agent-critic",
          capabilityIds: ["t3.workspace.read_file"],
        },
      ],
    });
  }),
);

it.effect("已达到计划并发上限的成员不进入接管候选", () =>
  Effect.gen(function* () {
    const backup = {
      agentId: "agent-worker-backup",
      role: "worker" as const,
      order: 4,
      required: false,
      workspaceRoot: "C:/workspace/backup",
      capabilityIds: ["t3.workspace.read_file", "t3.workspace.write_file"],
      maxConcurrentTasks: 1,
    };
    const squad: CompositionSquad = {
      ...baseSquad,
      memberAgentIds: [...baseSquad.memberAgentIds, backup.agentId],
      members: [...baseSquad.members!, backup],
    };
    const graph = yield* compileCompositionSquadGraph({
      squad,
      input: {
        ...baseInput,
        plan: [
          {
            nodeId: "primary-work",
            agentId: "agent-worker",
            prompt: "完成主实现",
            dependsOnNodeIds: [],
          },
          {
            nodeId: "backup-own-work",
            agentId: backup.agentId,
            prompt: "完成备用成员自己的任务",
            dependsOnNodeIds: [],
          },
        ],
      },
    });

    expect(graph.children.find((node) => node.nodeId === "primary-work")?.failoverCandidates).toBe(
      undefined,
    );
  }),
);

it.effect("五种协同模式生成各自的调度与依赖语义", () =>
  Effect.gen(function* () {
    const serial = yield* compile("serial");
    const parallel = yield* compile("parallel");
    const reviewCritic = yield* compile("review_critic");
    const leaderWorkers = yield* compile("leader_workers");
    const dependencyGraph = yield* compile("dependency_graph", {
      ...baseInput,
      plan: [
        {
          nodeId: "implement",
          agentId: "agent-worker",
          prompt: "完成实现",
          dependsOnNodeIds: [],
        },
        {
          nodeId: "review",
          agentId: "agent-reviewer",
          prompt: "审查实现",
          dependsOnNodeIds: ["implement"],
        },
      ],
    });

    expect(serial.schedule).toBe("serial");
    expect(serial.children.map((node) => node.dependsOnNodeIds)).toEqual([
      [],
      [serial.children[0]!.nodeId],
      [serial.children[1]!.nodeId],
    ]);
    expect(parallel.children.every((node) => node.dependsOnNodeIds?.length === 0)).toBe(true);
    expect(
      reviewCritic.children.find((node) => node.assigneeId === "agent-reviewer"),
    ).toMatchObject({ dependsOnNodeIds: ["member:1:agent-worker"] });
    const reviewer = reviewCritic.children.find((node) => node.assigneeId === "agent-reviewer")!;
    const critic = reviewCritic.children.find((node) => node.assigneeId === "agent-critic")!;
    expect(reviewer.prompt).toContain("Reviewer");
    expect(reviewer.prompt).toContain("允许请求重做的 nodeId：member:1:agent-worker");
    expect(reviewer.prompt).toContain('"decision":"reject"');
    expect(critic).toMatchObject({ dependsOnNodeIds: ["member:1:agent-worker"] });
    expect(critic.prompt).toContain("Critic");
    expect(critic.prompt).toContain('"decision":"approve"');
    expect(reviewCritic.review).toEqual({
      reviewerNodeIds: ["member:2:agent-reviewer", "member:3:agent-critic"],
      reworkableNodeIds: ["member:1:agent-worker"],
      maxRevisions: 2,
    });
    expect(leaderWorkers.schedule).toBe("parallel");
    expect(dependencyGraph.children.map((node) => node.dependsOnNodeIds)).toEqual([
      [],
      ["implement"],
    ]);
  }),
);

it.effect("dependency_graph 没有显式计划时拒绝猜测依赖", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(compile("dependency_graph"));
    expect(error).toMatchObject({ code: "squad_plan_required" });
  }),
);

it.effect("拒绝计划把任务分派给 Squad 之外的 Agent", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      compile("dependency_graph", {
        ...baseInput,
        plan: [
          {
            nodeId: "foreign",
            agentId: "agent-foreign",
            prompt: "越权任务",
            dependsOnNodeIds: [],
          },
        ],
      }),
    );
    expect(error).toMatchObject({ code: "squad_member_missing", nodeId: "foreign" });
  }),
);

it.effect("Runner 固定 revision 后调用现有 TaskGraphExecutor", () =>
  Effect.gen(function* () {
    let captured: CompositionTaskGraphExecutionInput | undefined;
    const events: string[] = [];
    const executionStore = makeExecutionStoreHarness({ events });
    const runner = makeCompositionSquadRunner({
      squads: makeSquadLookup(baseSquad, events),
      executions: executionStore.store,
      now: (() => {
        let current = 1_000;
        return () => current++;
      })(),
      planner: {
        plan: () =>
          Effect.sync(() => {
            events.push("planner:plan");
            return [
              {
                nodeId: "planned-worker",
                agentId: "agent-worker",
                prompt: "由 Leader 拆解后的实现任务",
                dependsOnNodeIds: [],
              },
            ];
          }),
      },
      executor: {
        execute: (input) =>
          Effect.sync(() => {
            events.push("executor:execute");
            captured = input;
            return makeGraphResult(input);
          }),
      },
    });

    const result = yield* runner.run(baseInput);

    expect(result.squadId).toBe(baseSquad.squadId);
    expect(result.squadRevision).toBe(3);
    expect(captured?.children[0]).toMatchObject({
      nodeId: "planned-worker",
      assigneeId: "agent-worker",
    });
    expect(executionStore.read()).toMatchObject({
      status: "in_review",
      revision: 4,
      nodes: [
        {
          nodeId: "planned-worker",
          agentId: "agent-worker",
          taskId: captured?.children[0]?.taskId,
          runId: captured?.children[0]?.runId,
          promptDigest: captured?.children[0]?.promptDigest,
          dependsOnNodeIds: [],
        },
      ],
    });
    expect(executionStore.read()).not.toHaveProperty("planDigest");
    expect(executionStore.read()?.nodes?.[0]).not.toHaveProperty("prompt");
    expect(events).toEqual([
      "squad:getRunnable",
      "store:claim:queued",
      "store:save:planning",
      "squad:getRevision",
      "planner:plan",
      "store:save:running",
      "executor:execute",
      "store:save:in_review",
    ]);
  }),
);

it.effect("显式用户计划绕过 Leader 自动规划", () =>
  Effect.gen(function* () {
    let captured: CompositionTaskGraphExecutionInput | undefined;
    const executionStore = makeExecutionStoreHarness();
    const explicitPlan = [
      {
        nodeId: "explicit-worker",
        agentId: "agent-worker",
        prompt: "执行用户明确给出的任务",
        dependsOnNodeIds: [],
      },
    ];
    const runner = makeCompositionSquadRunner({
      squads: makeSquadLookup(baseSquad),
      executions: executionStore.store,
      planner: { plan: () => Effect.die("显式计划不应调用 Leader Planner") },
      executor: {
        execute: (graph) =>
          Effect.sync(() => {
            captured = graph;
            return makeGraphResult(graph);
          }),
      },
    });

    yield* runner.run({ ...baseInput, plan: explicitPlan });

    expect(captured?.children[0]).toMatchObject({
      nodeId: "explicit-worker",
      assigneeId: "agent-worker",
    });
    expect(executionStore.snapshots[0]?.planDigest).toBeDefined();
    expect(executionStore.snapshots[0]?.goalTaskId).toBe(
      "execution-1:squad:squad-core:r3:task:leader-plan",
    );
    expect(executionStore.snapshots[0]?.planDigest).toBe(
      sha256(
        `composition-squad-explicit-plan:v1\n${encodeCompositionSquadPlanOutput(explicitPlan)}`,
      ),
    );
  }),
);

it.effect("Runner 拒绝用陈旧 revision 启动运行", () =>
  Effect.gen(function* () {
    const executionStore = makeExecutionStoreHarness();
    const runner = makeCompositionSquadRunner({
      squads: makeSquadLookup(baseSquad),
      executions: executionStore.store,
      planner: { plan: () => Effect.die("revision 冲突时不应规划") },
      executor: { execute: () => Effect.die("revision 冲突时不应执行") },
    });

    const error = yield* Effect.flip(runner.run({ ...baseInput, squadRevision: 2 }));

    expect(error).toMatchObject({
      code: "squad_revision_conflict",
      expectedRevision: 2,
      actualRevision: 3,
    });
  }),
);

it.effect("Leader 完成时持久化结果摘要与终态时间", () =>
  Effect.gen(function* () {
    const executionStore = makeExecutionStoreHarness();
    const runner = makeCompositionSquadRunner({
      squads: makeSquadLookup(baseSquad),
      executions: executionStore.store,
      now: (() => {
        let current = 2_000;
        return () => current++;
      })(),
      planner: {
        plan: () =>
          Effect.succeed([
            {
              nodeId: "completed-worker",
              agentId: "agent-worker",
              prompt: "完成实现并提供证据",
              dependsOnNodeIds: [],
            },
          ]),
      },
      executor: {
        execute: (input) =>
          Effect.succeed(makeGraphResult(input, "completed", "全部节点已验证通过")),
      },
    });

    yield* runner.run({ ...baseInput, executionId: "execution-completed" });

    expect(executionStore.read()).toMatchObject({
      status: "completed",
      revision: 4,
      resultSummary: "全部节点已验证通过",
      finishedAtUnixMs: 2_003,
    });
  }),
);

it.effect("claim 已落盘但 planning 尚未开始时中断仍收口 queued execution", () =>
  Effect.gen(function* () {
    const claimPersisted = yield* Deferred.make<void>();
    const releaseClaim = yield* Deferred.make<void>();
    const events: string[] = [];
    const executionStore = makeExecutionStoreHarness({
      events,
      afterClaim: Deferred.succeed(claimPersisted, undefined).pipe(
        Effect.andThen(Deferred.await(releaseClaim)),
      ),
    });
    const times = [4_000, 4_100];
    let timeIndex = 0;
    const runner = makeCompositionSquadRunner({
      squads: makeSquadLookup(baseSquad),
      executions: executionStore.store,
      now: () => times[timeIndex++] ?? 4_100,
      planner: { plan: () => Effect.die("claim 后立即中断不应进入 Planner") },
      executor: { execute: () => Effect.die("claim 后立即中断不应派发 Task Graph") },
    });
    const fiber = yield* Effect.forkChild(
      runner.run({ ...baseInput, executionId: "execution-interrupted-after-claim" }),
    );

    yield* Deferred.await(claimPersisted);
    const interruptFiber = yield* Effect.forkChild(Fiber.interrupt(fiber), {
      startImmediately: true,
    });
    yield* Deferred.succeed(releaseClaim, undefined);
    yield* Fiber.join(interruptFiber);
    const exit = yield* Fiber.await(fiber);

    expect(executionStore.snapshots.map((snapshot) => snapshot.status)).toEqual([
      "queued",
      "cancelled",
    ]);
    expect(executionStore.read()).toMatchObject({
      status: "cancelled",
      revision: 2,
      cancelRequestedAtUnixMs: 4_100,
      finishedAtUnixMs: 4_100,
      updatedAtUnixMs: 4_100,
    });
    expect(events).not.toContain("store:save:planning");
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(Cause.hasFails(exit.cause)).toBe(false);
      expect(Cause.hasDies(exit.cause)).toBe(false);
      expect(Cause.interruptors(exit.cause).size).toBeGreaterThan(0);
    }
  }),
);

it.effect("pausedFromStatus=queued 中断时直接取消且不写入 startedAtUnixMs", () =>
  Effect.gen(function* () {
    const claimPersisted = yield* Deferred.make<void>();
    const releaseClaim = yield* Deferred.make<void>();
    const executionStore = makeExecutionStoreHarness({
      pauseClaimedExecution: true,
      afterClaim: Deferred.succeed(claimPersisted, undefined).pipe(
        Effect.andThen(Deferred.await(releaseClaim)),
      ),
    });
    const times = [4_200, 4_300];
    let timeIndex = 0;
    const runner = makeCompositionSquadRunner({
      squads: makeSquadLookup(baseSquad),
      executions: executionStore.store,
      now: () => times[timeIndex++] ?? 4_300,
      planner: { plan: () => Effect.die("paused queued execution 不应进入 Planner") },
      executor: { execute: () => Effect.die("paused queued execution 不应派发 Task Graph") },
    });
    const fiber = yield* Effect.forkChild(
      runner.run({ ...baseInput, executionId: "execution-paused-after-claim" }),
    );

    yield* Deferred.await(claimPersisted);
    const interruptFiber = yield* Effect.forkChild(Fiber.interrupt(fiber), {
      startImmediately: true,
    });
    yield* Deferred.succeed(releaseClaim, undefined);
    yield* Fiber.join(interruptFiber);
    const exit = yield* Fiber.await(fiber);

    expect(executionStore.snapshots.map((snapshot) => snapshot.status)).toEqual([
      "queued",
      "paused",
      "cancelled",
    ]);
    const finalExecution = executionStore.read();
    expect(finalExecution).toMatchObject({
      status: "cancelled",
      revision: 3,
      cancelRequestedAtUnixMs: 4_300,
      finishedAtUnixMs: 4_300,
      updatedAtUnixMs: 4_300,
    });
    expect(finalExecution).not.toHaveProperty("startedAtUnixMs");
    expect(finalExecution).not.toHaveProperty("pausedFromStatus");
    expect(finalExecution).not.toHaveProperty("pausedAtUnixMs");
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(Cause.hasFails(exit.cause)).toBe(false);
      expect(Cause.hasDies(exit.cause)).toBe(false);
      expect(Cause.interruptors(exit.cause).size).toBeGreaterThan(0);
    }
  }),
);

it.effect("running 已落盘但 v1 Executor 尚未获得派发权时可无回执安全取消", () =>
  Effect.gen(function* () {
    const runningPersisted = yield* Deferred.make<void>();
    const releaseRunningSave = yield* Deferred.make<void>();
    const executionStore = makeExecutionStoreHarness({
      afterSave: (execution) =>
        execution.status === "running"
          ? Deferred.succeed(runningPersisted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseRunningSave)),
            )
          : Effect.void,
    });
    let executorCalled = false;
    const runner = makeCompositionSquadRunner({
      squads: makeSquadLookup(baseSquad),
      executions: executionStore.store,
      planner: { plan: () => Effect.die("显式计划不应调用 Planner") },
      executor: {
        cancellationScopeProtocol: "v1",
        execute: () =>
          Effect.sync(() => {
            executorCalled = true;
          }).pipe(Effect.andThen(Effect.die("取消应发生在 Executor 调用前"))),
      },
    });
    const fiber = yield* Effect.forkChild(
      runner.run({
        ...baseInput,
        executionId: "execution-v1-before-scope-ready",
        plan: [
          {
            nodeId: "v1-pre-ready-worker",
            agentId: "agent-worker",
            prompt: "等待 Executor 获得派发权",
            dependsOnNodeIds: [],
          },
        ],
      }),
    );

    yield* Deferred.await(runningPersisted);
    const interruptFiber = yield* Effect.forkChild(Fiber.interrupt(fiber), {
      startImmediately: true,
    });
    yield* Deferred.succeed(releaseRunningSave, undefined);
    yield* Fiber.join(interruptFiber);
    const exit = yield* Fiber.await(fiber);

    expect(executorCalled).toBe(false);
    expect(executionStore.snapshots.map((snapshot) => snapshot.status)).toEqual([
      "queued",
      "planning",
      "running",
      "cancelling",
      "cancelled",
    ]);
    expect(executionStore.read()).toMatchObject({ status: "cancelled", revision: 5 });
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(Cause.hasFails(exit.cause)).toBe(false);
      expect(Cause.hasDies(exit.cause)).toBe(false);
      expect(Cause.interruptors(exit.cause).size).toBeGreaterThan(0);
    }
  }),
);

it.effect("外部中断并行 Squad 时取消真实子 Run 并持久化 execution 终态", () =>
  Effect.gen(function* () {
    const childrenReady = yield* Deferred.make<void>();
    const cancelled: string[] = [];
    const dispatched: string[] = [];
    const events: string[] = [];
    const executionStore = makeExecutionStoreHarness({ events });
    const squad: CompositionSquad = {
      ...baseSquad,
      memberAgentIds: [...baseSquad.memberAgentIds, "agent-worker-b"],
      members: [
        ...(baseSquad.members ?? []),
        {
          agentId: "agent-worker-b",
          role: "worker",
          order: 4,
          required: true,
          model: "provider/worker-model-b",
          workspaceRoot: "C:/workspace/worker-b",
          capabilityIds: ["t3.workspace.read_file"],
          maxConcurrentTasks: 1,
        },
      ],
      maxConcurrency: 2,
    };
    const times = [1_000, 1_100, 1_200, 1_300, 1_400];
    let timeIndex = 0;
    const runner = makeCompositionSquadRunner({
      squads: makeSquadLookup(squad),
      executions: executionStore.store,
      now: () => times[timeIndex++] ?? 1_400,
      planner: { plan: () => Effect.die("显式并行计划不应调用 Planner") },
      executor: makeInterruptibleParallelExecutor(childrenReady, cancelled, dispatched, events),
    });
    const fiber = yield* Effect.forkChild(
      runner.run({
        ...baseInput,
        executionId: "execution-interrupted-running",
        plan: [
          {
            nodeId: "interrupt-worker-a",
            agentId: "agent-worker",
            prompt: "持续执行并行任务 A",
            dependsOnNodeIds: [],
          },
          {
            nodeId: "interrupt-worker-b",
            agentId: "agent-worker-b",
            prompt: "持续执行并行任务 B",
            dependsOnNodeIds: [],
          },
        ],
      }),
    );

    yield* Deferred.await(childrenReady);
    yield* Fiber.interrupt(fiber);
    yield* Fiber.interrupt(fiber);
    const exit = yield* Fiber.await(fiber);

    expect(dispatched).toHaveLength(2);
    expect(cancelled.sort()).toEqual(dispatched.sort());
    const cancellingSaveIndex = events.indexOf("store:save:cancelling");
    const childCancelIndexes = events.flatMap((event, index) =>
      event.startsWith("executor:cancel:") ? [index] : [],
    );
    expect(childCancelIndexes).toHaveLength(2);
    expect(cancellingSaveIndex).toBeGreaterThan(Math.max(...childCancelIndexes));
    expect(executionStore.snapshots.map((snapshot) => snapshot.status)).toEqual([
      "queued",
      "planning",
      "running",
      "cancelling",
      "cancelled",
    ]);
    expect(executionStore.read()).toMatchObject({
      status: "cancelled",
      revision: 5,
      cancelRequestedAtUnixMs: 1_300,
      finishedAtUnixMs: 1_400,
      updatedAtUnixMs: 1_400,
    });
    expect(executionStore.read()).not.toHaveProperty("failureCode");
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(Cause.hasFails(exit.cause)).toBe(false);
      expect(Cause.hasDies(exit.cause)).toBe(false);
      expect(Cause.interruptors(exit.cause).size).toBeGreaterThan(0);
    }
  }),
);

it.effect("运行态 Executor 未发布取消回执时失败关闭并停留在 cancelling", () =>
  Effect.gen(function* () {
    const executorStarted = yield* Deferred.make<void>();
    const executionStore = makeExecutionStoreHarness();
    const runner = makeCompositionSquadRunner({
      squads: makeSquadLookup(baseSquad),
      executions: executionStore.store,
      now: (() => {
        let current = 1_500;
        return () => current++;
      })(),
      planner: {
        plan: () =>
          Effect.succeed([
            {
              nodeId: "missing-receipt-worker",
              agentId: "agent-worker",
              prompt: "等待外部中断",
              dependsOnNodeIds: [],
            },
          ]),
      },
      executor: {
        execute: () =>
          Deferred.succeed(executorStarted, undefined).pipe(Effect.andThen(Effect.never)),
      },
    });
    const fiber = yield* Effect.forkChild(
      runner.run({ ...baseInput, executionId: "execution-missing-cancellation-receipt" }),
    );

    yield* Deferred.await(executorStarted);
    yield* Fiber.interrupt(fiber);
    const exit = yield* Fiber.await(fiber);

    expect(executionStore.snapshots.map((snapshot) => snapshot.status)).toEqual([
      "queued",
      "planning",
      "running",
      "cancelling",
    ]);
    expect(executionStore.read()).toMatchObject({ status: "cancelling", revision: 4 });
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(Cause.hasFails(exit.cause)).toBe(true);
      expect(Cause.hasDies(exit.cause)).toBe(false);
      expect(Cause.interruptors(exit.cause).size).toBeGreaterThan(0);
      expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toMatchObject({
        code: "squad_execution_cancellation_receipt_missing",
        detail: "Squad execution 中断后未收到子 Run 取消回执，已停留在 cancelling。",
      });
    }
  }),
);

it.effect("v1 Executor 已发布 scope ready 但缺少取消回执时仍停留在 cancelling", () =>
  Effect.gen(function* () {
    const executorReady = yield* Deferred.make<void>();
    const executionStore = makeExecutionStoreHarness();
    const runner = makeCompositionSquadRunner({
      squads: makeSquadLookup(baseSquad),
      executions: executionStore.store,
      planner: {
        plan: () =>
          Effect.succeed([
            {
              nodeId: "v1-ready-missing-receipt-worker",
              agentId: "agent-worker",
              prompt: "等待 scope ready 后中断",
              dependsOnNodeIds: [],
            },
          ]),
      },
      executor: {
        cancellationScopeProtocol: "v1",
        execute: (_input, hooks) =>
          (hooks?.onCancellationScopeReady?.() ?? Effect.void).pipe(
            Effect.andThen(Deferred.succeed(executorReady, undefined)),
            Effect.andThen(Effect.never),
          ),
      },
    });
    const fiber = yield* Effect.forkChild(
      runner.run({ ...baseInput, executionId: "execution-v1-ready-missing-receipt" }),
    );

    yield* Deferred.await(executorReady);
    yield* Fiber.interrupt(fiber);
    const exit = yield* Fiber.await(fiber);

    expect(executionStore.snapshots.map((snapshot) => snapshot.status)).toEqual([
      "queued",
      "planning",
      "running",
      "cancelling",
    ]);
    expect(executionStore.read()).toMatchObject({ status: "cancelling", revision: 4 });
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(Cause.hasFails(exit.cause)).toBe(true);
      expect(Cause.interruptors(exit.cause).size).toBeGreaterThan(0);
      expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toMatchObject({
        code: "squad_execution_cancellation_receipt_missing",
      });
    }
  }),
);

it.effect("真实 Executor 子 Run 取消失败时 parent 只收口到 cancelling 并保留 mixed Cause", () =>
  Effect.gen(function* () {
    const childrenReady = yield* Deferred.make<void>();
    const cancelled: string[] = [];
    const dispatched: string[] = [];
    const events: string[] = [];
    const executionStore = makeExecutionStoreHarness({ events });
    const squad: CompositionSquad = {
      ...baseSquad,
      memberAgentIds: [...baseSquad.memberAgentIds, "agent-worker-b"],
      members: [
        ...(baseSquad.members ?? []),
        {
          agentId: "agent-worker-b",
          role: "worker",
          order: 4,
          required: true,
          model: "provider/worker-model-b",
          workspaceRoot: "C:/workspace/worker-b",
          capabilityIds: ["t3.workspace.read_file"],
          maxConcurrentTasks: 1,
        },
      ],
      maxConcurrency: 2,
    };
    const runner = makeCompositionSquadRunner({
      squads: makeSquadLookup(squad),
      executions: executionStore.store,
      planner: { plan: () => Effect.die("显式计划不应调用 Planner") },
      executor: makeInterruptibleParallelExecutor(childrenReady, cancelled, dispatched, events, {
        failFirstCancellation: true,
      }),
    });
    const fiber = yield* Effect.forkChild(
      runner.run({
        ...baseInput,
        executionId: "execution-incomplete-child-cancellation",
        plan: [
          {
            nodeId: "incomplete-worker-a",
            agentId: "agent-worker",
            prompt: "持续执行任务 A",
            dependsOnNodeIds: [],
          },
          {
            nodeId: "incomplete-worker-b",
            agentId: "agent-worker-b",
            prompt: "持续执行任务 B",
            dependsOnNodeIds: [],
          },
        ],
      }),
    );

    yield* Deferred.await(childrenReady);
    yield* Fiber.interrupt(fiber);
    const exit = yield* Fiber.await(fiber);

    expect(cancelled.sort()).toEqual(dispatched.sort());
    expect(executionStore.snapshots.map((snapshot) => snapshot.status)).toEqual([
      "queued",
      "planning",
      "running",
      "cancelling",
    ]);
    expect(executionStore.read()).toMatchObject({ status: "cancelling", revision: 4 });
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(Cause.hasFails(exit.cause)).toBe(true);
      expect(Cause.hasDies(exit.cause)).toBe(false);
      expect(Cause.interruptors(exit.cause).size).toBeGreaterThan(0);
      expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toMatchObject({
        code: "child_cancel_cleanup_incomplete",
        detail: "Task Graph 中断清理未确认所有子 Run 已进入终态。",
      });
      expect(Cause.pretty(exit.cause)).not.toContain("sensitive child driver cancellation detail");
    }
  }),
);

it.effect("真实 Executor 业务失败且兄弟 Run 清理不完整时 parent 停留在 cancelling", () =>
  Effect.gen(function* () {
    const childrenReady = yield* Deferred.make<void>();
    const cancelled: string[] = [];
    const dispatched: string[] = [];
    const executionStore = makeExecutionStoreHarness();
    const squad: CompositionSquad = {
      ...baseSquad,
      memberAgentIds: [...baseSquad.memberAgentIds, "agent-worker-b"],
      members: [
        ...(baseSquad.members ?? []),
        {
          agentId: "agent-worker-b",
          role: "worker",
          order: 4,
          required: true,
          model: "provider/worker-model-b",
          workspaceRoot: "C:/workspace/worker-b",
          capabilityIds: ["t3.workspace.read_file"],
          maxConcurrentTasks: 1,
        },
      ],
      maxConcurrency: 2,
    };
    const runner = makeCompositionSquadRunner({
      squads: makeSquadLookup(squad),
      executions: executionStore.store,
      planner: { plan: () => Effect.die("显式计划不应调用 Planner") },
      executor: makeInterruptibleParallelExecutor(childrenReady, cancelled, dispatched, undefined, {
        failFirstCancellation: true,
        failFirstChildAfterReady: true,
      }),
    });

    const exit = yield* Effect.exit(
      runner.run({
        ...baseInput,
        executionId: "execution-business-failure-cleanup-incomplete",
        plan: [
          {
            nodeId: "business-failure-worker-a",
            agentId: "agent-worker",
            prompt: "先失败以触发兄弟清理",
            dependsOnNodeIds: [],
          },
          {
            nodeId: "business-failure-worker-b",
            agentId: "agent-worker-b",
            prompt: "持续运行等待兄弟失败",
            dependsOnNodeIds: [],
          },
        ],
      }),
    );

    expect(cancelled.sort()).toEqual(dispatched.sort());
    expect(executionStore.snapshots.map((snapshot) => snapshot.status)).toEqual([
      "queued",
      "planning",
      "running",
      "cancelling",
    ]);
    expect(executionStore.read()).toMatchObject({ status: "cancelling", revision: 4 });
    expect(executionStore.read()).not.toHaveProperty("failureCode");
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const rendered = Cause.prettyErrors(exit.cause)
        .map((error) => error.message)
        .join("\n");
      expect(rendered).toContain("business runtime wait failed");
      expect(rendered).toContain("取消其他子任务未全部确认终态");
      expect(rendered).not.toContain("sensitive child driver cancellation detail");
    }
  }),
);

it.effect("真实 Executor 业务失败且清理完整时仍持久化 failed 并保留原 Cause", () =>
  Effect.gen(function* () {
    const childrenReady = yield* Deferred.make<void>();
    const executionStore = makeExecutionStoreHarness();
    const squad: CompositionSquad = {
      ...baseSquad,
      memberAgentIds: [...baseSquad.memberAgentIds, "agent-worker-b"],
      members: [
        ...(baseSquad.members ?? []),
        {
          agentId: "agent-worker-b",
          role: "worker",
          order: 4,
          required: true,
          model: "provider/worker-model-b",
          workspaceRoot: "C:/workspace/worker-b",
          capabilityIds: ["t3.workspace.read_file"],
          maxConcurrentTasks: 1,
        },
      ],
      maxConcurrency: 2,
    };
    const runner = makeCompositionSquadRunner({
      squads: makeSquadLookup(squad),
      executions: executionStore.store,
      planner: { plan: () => Effect.die("显式计划不应调用 Planner") },
      executor: makeInterruptibleParallelExecutor(childrenReady, [], [], undefined, {
        failFirstChildAfterReady: true,
      }),
    });

    const exit = yield* Effect.exit(
      runner.run({
        ...baseInput,
        executionId: "execution-business-failure-cleanup-complete",
        plan: [
          {
            nodeId: "business-complete-worker-a",
            agentId: "agent-worker",
            prompt: "失败并完成清理",
            dependsOnNodeIds: [],
          },
          {
            nodeId: "business-complete-worker-b",
            agentId: "agent-worker-b",
            prompt: "等待被安全取消",
            dependsOnNodeIds: [],
          },
        ],
      }),
    );

    expect(executionStore.read()).toMatchObject({
      status: "failed",
      revision: 4,
    });
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const rendered = Cause.prettyErrors(exit.cause)
        .map((error) => error.message)
        .join("\n");
      expect(rendered).toContain("business runtime wait failed");
      expect(rendered).not.toContain("取消其他子任务未全部确认终态");
    }
  }),
);

it.effect("终态落盘后立即中断不会把 completed 反向收口为 cancelled", () =>
  Effect.gen(function* () {
    const completedPersisted = yield* Deferred.make<void>();
    const events: string[] = [];
    const executionStore = makeExecutionStoreHarness({
      events,
      afterSave: (execution) =>
        execution.status === "completed"
          ? Deferred.succeed(completedPersisted, undefined).pipe(Effect.andThen(Effect.never))
          : Effect.void,
    });
    const times = [5_000, 5_100, 5_200, 5_300];
    let timeIndex = 0;
    const runner = makeCompositionSquadRunner({
      squads: makeSquadLookup(baseSquad),
      executions: executionStore.store,
      now: () => times[timeIndex++] ?? 5_300,
      planner: {
        plan: () =>
          Effect.succeed([
            {
              nodeId: "completed-before-interrupt",
              agentId: "agent-worker",
              prompt: "完成后停在终态写入返回窗口",
              dependsOnNodeIds: [],
            },
          ]),
      },
      executor: {
        execute: (input) => Effect.succeed(makeGraphResult(input, "completed", "终态已落盘")),
      },
    });
    const fiber = yield* Effect.forkChild(
      runner.run({ ...baseInput, executionId: "execution-interrupted-after-completed" }),
    );

    yield* Deferred.await(completedPersisted);
    yield* Fiber.interrupt(fiber);
    const exit = yield* Fiber.await(fiber);

    expect(executionStore.snapshots.map((snapshot) => snapshot.status)).toEqual([
      "queued",
      "planning",
      "running",
      "completed",
    ]);
    expect(executionStore.read()).toMatchObject({
      status: "completed",
      revision: 4,
      resultSummary: "终态已落盘",
      finishedAtUnixMs: 5_300,
      updatedAtUnixMs: 5_300,
    });
    expect(events).not.toContain("store:save:cancelling");
    expect(events).not.toContain("store:save:cancelled");
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(Cause.hasFails(exit.cause)).toBe(false);
      expect(Cause.hasDies(exit.cause)).toBe(false);
      expect(Cause.interruptors(exit.cause).size).toBeGreaterThan(0);
    }
  }),
);

it.effect("Executor 已 settled 但最终状态尚未落盘时中断不再要求取消回执", () =>
  Effect.gen(function* () {
    const finalSaveStarted = yield* Deferred.make<void>();
    const releaseFinalSave = yield* Deferred.make<void>();
    const executionStore = makeExecutionStoreHarness({
      beforeSave: (execution) =>
        execution.status === "completed"
          ? Deferred.succeed(finalSaveStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseFinalSave)),
            )
          : Effect.void,
    });
    const runner = makeCompositionSquadRunner({
      squads: makeSquadLookup(baseSquad),
      executions: executionStore.store,
      planner: {
        plan: () =>
          Effect.succeed([
            {
              nodeId: "settled-before-final-save",
              agentId: "agent-worker",
              prompt: "Executor 已完成，等待最终状态持久化",
              dependsOnNodeIds: [],
            },
          ]),
      },
      executor: {
        execute: (input) => Effect.succeed(makeGraphResult(input, "completed", "已完成")),
      },
    });
    const fiber = yield* Effect.forkChild(
      runner.run({ ...baseInput, executionId: "execution-settled-before-final-save" }),
    );

    yield* Deferred.await(finalSaveStarted);
    const interruptFiber = yield* Effect.forkChild(Fiber.interrupt(fiber), {
      startImmediately: true,
    });
    yield* Deferred.succeed(releaseFinalSave, undefined);
    yield* Fiber.join(interruptFiber);
    const exit = yield* Fiber.await(fiber);

    expect(executionStore.snapshots.map((snapshot) => snapshot.status)).toEqual([
      "queued",
      "planning",
      "running",
      "cancelling",
      "cancelled",
    ]);
    expect(executionStore.read()).toMatchObject({ status: "cancelled", revision: 5 });
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(Cause.hasFails(exit.cause)).toBe(false);
      expect(Cause.hasDies(exit.cause)).toBe(false);
      expect(Cause.interruptors(exit.cause).size).toBeGreaterThan(0);
    }
  }),
);

it.effect("真实 Planner 中断时先取消规划 Run 再把 parent 收口为 cancelled", () =>
  Effect.gen(function* () {
    const planningStarted = yield* Deferred.make<void>();
    const executionStore = makeExecutionStoreHarness();
    const plannerHarness = makeRealPlannerHarness(planningStarted);
    const runner = makeCompositionSquadRunner({
      squads: makeSquadLookup(baseSquad),
      executions: executionStore.store,
      planner: plannerHarness.planner,
      executor: { execute: () => Effect.die("规划中断不应执行 Task Graph") },
    });
    const fiber = yield* Effect.forkChild(
      runner.run({ ...baseInput, executionId: "execution-real-planner-interrupted" }),
    );

    yield* Deferred.await(planningStarted);
    yield* Fiber.interrupt(fiber);
    const exit = yield* Fiber.await(fiber);

    expect(plannerHarness.cancelled).toHaveLength(1);
    expect(plannerHarness.cancelled[0]).toContain("leader-plan");
    expect(executionStore.snapshots.map((snapshot) => snapshot.status)).toEqual([
      "queued",
      "planning",
      "cancelling",
      "cancelled",
    ]);
    expect(executionStore.read()).toMatchObject({ status: "cancelled", revision: 4 });
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(Cause.hasFails(exit.cause)).toBe(false);
      expect(Cause.hasDies(exit.cause)).toBe(false);
      expect(Cause.interruptors(exit.cause).size).toBeGreaterThan(0);
    }
  }),
);

it.effect("真实 Planner 业务失败且规划 Run 清理不完整时 parent 停留在 cancelling", () =>
  Effect.gen(function* () {
    const planningStarted = yield* Deferred.make<void>();
    const executionStore = makeExecutionStoreHarness();
    const plannerHarness = makeRealPlannerHarness(planningStarted, {
      cancelFails: true,
      runtimeFails: true,
    });
    const runner = makeCompositionSquadRunner({
      squads: makeSquadLookup(baseSquad),
      executions: executionStore.store,
      planner: plannerHarness.planner,
      executor: { execute: () => Effect.die("规划失败不应执行 Task Graph") },
    });

    const exit = yield* Effect.exit(
      runner.run({ ...baseInput, executionId: "execution-real-planner-cleanup-incomplete" }),
    );

    expect(plannerHarness.cancelled).toHaveLength(1);
    expect(executionStore.snapshots.map((snapshot) => snapshot.status)).toEqual([
      "queued",
      "planning",
      "cancelling",
    ]);
    expect(executionStore.read()).toMatchObject({ status: "cancelling", revision: 3 });
    expect(executionStore.read()).not.toHaveProperty("failureCode");
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const rendered = Cause.prettyErrors(exit.cause)
        .map((error) => error.message)
        .join("\n");
      expect(rendered).toContain("planner runtime wait failed");
      expect(rendered).toContain("Leader 规划清理未确认关联 Run 已进入终态");
      expect(rendered).not.toContain("sensitive planner cancellation detail");
    }
  }),
);

it.effect("自动 Planner 已进入但未发布取消回执时停留在 cancelling", () =>
  Effect.gen(function* () {
    const plannerStarted = yield* Deferred.make<void>();
    const events: string[] = [];
    const executionStore = makeExecutionStoreHarness({ events });
    const times = [2_000, 2_100, 2_200, 2_300];
    let timeIndex = 0;
    const runner = makeCompositionSquadRunner({
      squads: makeSquadLookup(baseSquad, events),
      executions: executionStore.store,
      now: () => times[timeIndex++] ?? 2_300,
      planner: {
        plan: () => Deferred.succeed(plannerStarted, undefined).pipe(Effect.andThen(Effect.never)),
      },
      executor: { execute: () => Effect.die("规划阶段中断不应派发 Task Graph") },
    });
    const fiber = yield* Effect.forkChild(
      runner.run({ ...baseInput, executionId: "execution-interrupted-planning" }),
    );

    yield* Deferred.await(plannerStarted);
    yield* Fiber.interrupt(fiber);
    const exit = yield* Fiber.await(fiber);

    expect(executionStore.snapshots.map((snapshot) => snapshot.status)).toEqual([
      "queued",
      "planning",
      "cancelling",
    ]);
    expect(executionStore.snapshots[1]).toMatchObject({
      status: "planning",
      revision: 2,
      startedAtUnixMs: 2_100,
      updatedAtUnixMs: 2_100,
    });
    expect(executionStore.snapshots[1]?.nodes).toBeUndefined();
    expect(executionStore.read()).toMatchObject({
      status: "cancelling",
      revision: 3,
      cancelRequestedAtUnixMs: 2_200,
      updatedAtUnixMs: 2_200,
    });
    expect(events).toEqual([
      "squad:getRunnable",
      "store:claim:queued",
      "store:save:planning",
      "squad:getRevision",
      "store:save:cancelling",
    ]);
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(Cause.hasFails(exit.cause)).toBe(true);
      expect(Cause.hasDies(exit.cause)).toBe(false);
      expect(Cause.interruptors(exit.cause).size).toBeGreaterThan(0);
      expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toMatchObject({
        code: "squad_execution_cancellation_receipt_missing",
      });
    }
  }),
);

it.effect("Planner 已进入且竞态状态为 cancelling 时缺少回执仍保持失败关闭", () =>
  Effect.gen(function* () {
    const plannerStarted = yield* Deferred.make<void>();
    const events: string[] = [];
    const executionStore = makeExecutionStoreHarness({
      events,
      raceToCancellingAfterSaveStatus: "planning",
    });
    const times = [6_000, 6_100, 6_200];
    let timeIndex = 0;
    const runner = makeCompositionSquadRunner({
      squads: makeSquadLookup(baseSquad, events),
      executions: executionStore.store,
      now: () => times[timeIndex++] ?? 6_200,
      planner: {
        plan: () => Deferred.succeed(plannerStarted, undefined).pipe(Effect.andThen(Effect.never)),
      },
      executor: { execute: () => Effect.die("pre-dispatch cancelling 不应派发 Task Graph") },
    });
    const fiber = yield* Effect.forkChild(
      runner.run({ ...baseInput, executionId: "execution-resume-pre-dispatch-cancelling" }),
    );

    yield* Deferred.await(plannerStarted);
    yield* Fiber.interrupt(fiber);
    const exit = yield* Fiber.await(fiber);

    expect(executionStore.snapshots.map((snapshot) => snapshot.status)).toEqual([
      "queued",
      "planning",
      "cancelling",
    ]);
    expect(executionStore.snapshots[2]).toMatchObject({
      status: "cancelling",
      revision: 3,
      startedAtUnixMs: 6_100,
      cancelRequestedAtUnixMs: 6_100,
    });
    expect(executionStore.snapshots[2]?.nodes).toBeUndefined();
    expect(executionStore.read()).toMatchObject({
      status: "cancelling",
      revision: 3,
      startedAtUnixMs: 6_100,
      cancelRequestedAtUnixMs: 6_100,
      updatedAtUnixMs: 6_100,
    });
    expect(events).toEqual([
      "squad:getRunnable",
      "store:claim:queued",
      "store:save:planning",
      "squad:getRevision",
    ]);
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(Cause.hasFails(exit.cause)).toBe(true);
      expect(Cause.hasDies(exit.cause)).toBe(false);
      expect(Cause.interruptors(exit.cause).size).toBeGreaterThan(0);
      expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toMatchObject({
        code: "squad_execution_cancellation_receipt_missing",
      });
    }
  }),
);

it.effect("中断 finalizer 仅重试 revision/status conflict 且终态竞争保持幂等", () =>
  Effect.gen(function* () {
    for (const conflictCode of [
      "squad_execution_revision_conflict",
      "squad_execution_status_conflict",
    ] as const) {
      const plannerStarted = yield* Deferred.make<void>();
      const executionStore = makeExecutionStoreHarness({
        raceToCancelledOnSaveStatus: "cancelling",
        raceConflictCode: conflictCode,
      });
      const times = [3_000, 3_100, 3_200];
      let timeIndex = 0;
      const runner = makeCompositionSquadRunner({
        squads: makeSquadLookup(baseSquad),
        executions: executionStore.store,
        now: () => times[timeIndex++] ?? 3_200,
        planner: {
          plan: () =>
            Deferred.succeed(plannerStarted, undefined).pipe(Effect.andThen(Effect.never)),
        },
        executor: { execute: () => Effect.die("竞争取消测试不应派发") },
      });
      const fiber = yield* Effect.forkChild(
        runner.run({
          ...baseInput,
          executionId: `execution-interrupted-race-${conflictCode}`,
        }),
      );

      yield* Deferred.await(plannerStarted);
      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);

      expect(executionStore.snapshots.map((snapshot) => snapshot.status)).toEqual([
        "queued",
        "planning",
        "cancelling",
        "cancelled",
      ]);
      expect(executionStore.read()).toMatchObject({
        status: "cancelled",
        revision: 4,
        cancelRequestedAtUnixMs: 3_200,
        finishedAtUnixMs: 3_200,
      });
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(Cause.hasFails(exit.cause)).toBe(false);
        expect(Cause.hasDies(exit.cause)).toBe(false);
      }
    }
  }),
);

it.effect("中断取消状态持久化失败时在 interrupt Cause 中暴露脱敏错误", () =>
  Effect.gen(function* () {
    const plannerStarted = yield* Deferred.make<void>();
    const events: string[] = [];
    const executionStore = makeExecutionStoreHarness({
      failSavePersistenceStatus: "cancelling",
      events,
    });
    const runner = makeCompositionSquadRunner({
      squads: makeSquadLookup(baseSquad),
      executions: executionStore.store,
      planner: {
        plan: () => Deferred.succeed(plannerStarted, undefined).pipe(Effect.andThen(Effect.never)),
      },
      executor: { execute: () => Effect.die("取消持久化失败测试不应派发") },
    });
    const fiber = yield* Effect.forkChild(
      runner.run({ ...baseInput, executionId: "execution-interrupted-persistence-failed" }),
    );

    yield* Deferred.await(plannerStarted);
    yield* Fiber.interrupt(fiber);
    const exit = yield* Fiber.await(fiber);

    expect(executionStore.read()).toMatchObject({ status: "planning", revision: 2 });
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(Cause.hasFails(exit.cause)).toBe(true);
      expect(Cause.hasDies(exit.cause)).toBe(false);
      expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toMatchObject({
        code: "squad_execution_persistence_failed",
        detail: "Squad execution 状态暂时无法安全持久化，请稍后重试。",
      });
      const rendered = Cause.pretty(exit.cause);
      expect(rendered).not.toContain("save interrupted squad cancellation");
      expect(rendered).not.toContain("interruption cancellation persistence unavailable");
      expect(rendered).not.toContain("interruption-cancellation-persistence-failed");
    }
    expect(events.filter((event) => event === "store:save:cancelling")).toHaveLength(1);
    expect(events).not.toContain("store:save:cancelled");
  }),
);

it.effect("未实现审批协调器时持久化失败并阻止 Planner 与 Executor", () =>
  Effect.gen(function* () {
    const events: string[] = [];
    const executionStore = makeExecutionStoreHarness({ events });
    const squad = { ...baseSquad, approvalStages: ["before_finalize" as const] };
    const runner = makeCompositionSquadRunner({
      squads: makeSquadLookup(squad, events),
      executions: executionStore.store,
      planner: { plan: () => Effect.die("审批未实现时不应调用 Planner") },
      executor: { execute: () => Effect.die("审批未实现时不应调用 Executor") },
    });

    const error = yield* Effect.flip(
      runner.run({ ...baseInput, executionId: "execution-approval-unsupported" }),
    );

    expect(error).toMatchObject({ code: "squad_approval_not_supported" });
    expect(executionStore.read()).toMatchObject({
      status: "failed",
      revision: 3,
      failureCode: "squad_approval_not_supported",
    });
    expect(events).toEqual([
      "squad:getRunnable",
      "store:claim:queued",
      "store:save:planning",
      "squad:getRevision",
      "store:save:failed",
    ]);
  }),
);

it.effect("Planner 与 Graph 编译失败都从 planning 状态收口为 failed", () =>
  Effect.gen(function* () {
    const plannerStore = makeExecutionStoreHarness();
    const plannerRunner = makeCompositionSquadRunner({
      squads: makeSquadLookup(baseSquad),
      executions: plannerStore.store,
      planner: {
        plan: (_input, hooks) =>
          (
            hooks?.onCancellationReceipt?.({
              trigger: "business_failure",
              receipt: { complete: true, runs: [] },
            }) ?? Effect.void
          ).pipe(
            Effect.andThen(
              Effect.fail(
                new CompositionSquadPlannerError({
                  code: "leader_plan_failed",
                  detail: "Leader 未生成有效计划",
                  squadId: baseSquad.squadId,
                }),
              ),
            ),
          ),
      },
      executor: { execute: () => Effect.die("规划失败时不应执行") },
    });
    const plannerError = yield* Effect.flip(
      plannerRunner.run({ ...baseInput, executionId: "execution-planner-failed" }),
    );
    expect(plannerError).toMatchObject({ code: "leader_plan_failed" });
    expect(plannerStore.read()).toMatchObject({
      status: "failed",
      revision: 3,
      failureCode: "leader_plan_failed",
    });

    const compileStore = makeExecutionStoreHarness();
    const compileRunner = makeCompositionSquadRunner({
      squads: makeSquadLookup(baseSquad),
      executions: compileStore.store,
      planner: {
        plan: () =>
          Effect.succeed([
            {
              nodeId: "foreign-worker",
              agentId: "agent-foreign",
              prompt: "不应被派发",
              dependsOnNodeIds: [],
            },
          ]),
      },
      executor: { execute: () => Effect.die("编译失败时不应执行") },
    });
    const compileError = yield* Effect.flip(
      compileRunner.run({ ...baseInput, executionId: "execution-compile-failed" }),
    );
    expect(compileError).toMatchObject({ code: "squad_member_missing" });
    expect(compileStore.read()).toMatchObject({
      status: "failed",
      revision: 3,
      failureCode: "squad_member_missing",
    });
  }),
);

it.effect("Executor 失败从 running 状态收口并保留节点索引", () =>
  Effect.gen(function* () {
    const executionStore = makeExecutionStoreHarness();
    const runner = makeCompositionSquadRunner({
      squads: makeSquadLookup(baseSquad),
      executions: executionStore.store,
      planner: {
        plan: () =>
          Effect.succeed([
            {
              nodeId: "executor-worker",
              agentId: "agent-worker",
              prompt: "进入执行后失败",
              dependsOnNodeIds: [],
            },
          ]),
      },
      executor: {
        execute: () =>
          Effect.fail(
            new CompositionTaskGraphExecutionError({
              code: "runtime_unavailable",
              detail: "没有可用 Runtime",
              nodeId: "executor-worker",
            }),
          ),
      },
    });

    const error = yield* Effect.flip(
      runner.run({ ...baseInput, executionId: "execution-executor-failed" }),
    );

    expect(error).toMatchObject({ code: "runtime_unavailable", nodeId: "executor-worker" });
    expect(executionStore.read()).toMatchObject({
      status: "failed",
      revision: 4,
      failureCode: "runtime_unavailable",
      nodes: [{ nodeId: "executor-worker", agentId: "agent-worker" }],
    });
  }),
);

it.effect("claim 与状态 CAS 失败时停止后续派发", () =>
  Effect.gen(function* () {
    const claimEvents: string[] = [];
    const claimStore = makeExecutionStoreHarness({ failClaim: true, events: claimEvents });
    const claimRunner = makeCompositionSquadRunner({
      squads: makeSquadLookup(baseSquad, claimEvents),
      executions: claimStore.store,
      planner: { plan: () => Effect.die("claim 失败时不应规划") },
      executor: { execute: () => Effect.die("claim 失败时不应执行") },
    });
    const claimError = yield* Effect.flip(
      claimRunner.run({ ...baseInput, executionId: "execution-claim-failed" }),
    );
    expect(claimError).toMatchObject({ code: "squad_execution_conflict" });
    expect(claimEvents).toEqual(["squad:getRunnable", "store:claim:queued"]);

    const planningEvents: string[] = [];
    const planningStore = makeExecutionStoreHarness({
      failSaveStatus: "planning",
      events: planningEvents,
    });
    const planningRunner = makeCompositionSquadRunner({
      squads: makeSquadLookup(baseSquad, planningEvents),
      executions: planningStore.store,
      planner: { plan: () => Effect.die("planning CAS 失败时不应规划") },
      executor: { execute: () => Effect.die("planning CAS 失败时不应执行") },
    });
    const planningError = yield* Effect.flip(
      planningRunner.run({ ...baseInput, executionId: "execution-planning-cas-failed" }),
    );
    expect(planningError).toMatchObject({
      code: "squad_execution_revision_conflict",
      expectedRevision: 1,
      actualRevision: 11,
    });
    expect(planningEvents).toEqual([
      "squad:getRunnable",
      "store:claim:queued",
      "store:save:planning",
    ]);

    const runningEvents: string[] = [];
    const runningStore = makeExecutionStoreHarness({
      failSaveStatus: "running",
      events: runningEvents,
    });
    const runningRunner = makeCompositionSquadRunner({
      squads: makeSquadLookup(baseSquad, runningEvents),
      executions: runningStore.store,
      planner: {
        plan: () =>
          Effect.sync(() => {
            runningEvents.push("planner:plan");
            return [
              {
                nodeId: "running-cas-worker",
                agentId: "agent-worker",
                prompt: "只允许规划，不允许派发",
                dependsOnNodeIds: [],
              },
            ];
          }),
      },
      executor: { execute: () => Effect.die("running CAS 失败时不应执行") },
    });
    const runningError = yield* Effect.flip(
      runningRunner.run({ ...baseInput, executionId: "execution-running-cas-failed" }),
    );
    expect(runningError).toMatchObject({
      code: "squad_execution_revision_conflict",
      expectedRevision: 2,
      actualRevision: 12,
    });
    expect(runningEvents).toEqual([
      "squad:getRunnable",
      "store:claim:queued",
      "store:save:planning",
      "squad:getRevision",
      "planner:plan",
      "store:save:running",
    ]);
  }),
);

it.effect("claim 返回 claimed:false 时失败关闭且不规划或派发", () =>
  Effect.gen(function* () {
    const events: string[] = [];
    const executionStore = makeExecutionStoreHarness({ forceClaimedFalse: true, events });
    const replayRunner = makeCompositionSquadRunner({
      squads: makeSquadLookup(baseSquad, events),
      executions: executionStore.store,
      planner: { plan: () => Effect.die("重复 execution 不应重新规划") },
      executor: { execute: () => Effect.die("重复 execution 不应重新派发") },
    });
    const error = yield* Effect.flip(
      replayRunner.run({ ...baseInput, executionId: "execution-replay" }),
    );

    expect(error).toMatchObject({ code: "squad_execution_replay_unavailable" });
    expect(events).toEqual(["squad:getRunnable", "store:claim:queued"]);
  }),
);

it.effect("claim 后始终读取固定 revision 的历史 Squad 配置", () =>
  Effect.gen(function* () {
    const events: string[] = [];
    const executionStore = makeExecutionStoreHarness({ events });
    const historicalSquad = { ...baseSquad, instructions: "固定 revision 的历史协同说明" };
    let plannedWithInstructions: string | undefined;
    let revisionLookup: readonly [string, number] | undefined;
    const runner = makeCompositionSquadRunner({
      squads: {
        getRunnable: () =>
          Effect.sync(() => {
            events.push("squad:getRunnable");
            return baseSquad;
          }),
        getRevision: (squadId, revision) =>
          Effect.sync(() => {
            events.push("squad:getRevision");
            revisionLookup = [squadId, revision];
            return historicalSquad;
          }),
      },
      executions: executionStore.store,
      planner: {
        plan: ({ squad }) =>
          Effect.sync(() => {
            plannedWithInstructions = squad.instructions;
            return [
              {
                nodeId: "historical-worker",
                agentId: "agent-worker",
                prompt: "使用固定 revision 规划",
                dependsOnNodeIds: [],
              },
            ];
          }),
      },
      executor: { execute: (input) => Effect.succeed(makeGraphResult(input)) },
    });

    yield* runner.run({ ...baseInput, executionId: "execution-fixed-revision" });

    expect(plannedWithInstructions).toBe("固定 revision 的历史协同说明");
    expect(revisionLookup).toEqual([baseInput.squadId, baseInput.squadRevision]);
    expect(events.slice(0, 4)).toEqual([
      "squad:getRunnable",
      "store:claim:queued",
      "store:save:planning",
      "squad:getRevision",
    ]);
  }),
);

it.effect("显式 plan 摘要基于规范编码且保留有业务意义的数组顺序", () =>
  Effect.gen(function* () {
    const digestFor = (
      executionId: string,
      plan: NonNullable<CompositionSquadExecutionInput["plan"]>,
    ) => {
      const executionStore = makeExecutionStoreHarness();
      const runner = makeCompositionSquadRunner({
        squads: makeSquadLookup(baseSquad),
        executions: executionStore.store,
        planner: { plan: () => Effect.die("显式计划不应自动规划") },
        executor: { execute: (input) => Effect.succeed(makeGraphResult(input)) },
      });
      return runner
        .run({ ...baseInput, executionId, plan })
        .pipe(Effect.map(() => executionStore.snapshots[0]?.planDigest));
    };
    const canonicalPlan = [
      {
        nodeId: "worker",
        agentId: "agent-worker",
        prompt: "完成实现",
        dependsOnNodeIds: [],
      },
      {
        nodeId: "review",
        agentId: "agent-reviewer",
        prompt: "审查实现",
        dependsOnNodeIds: ["worker"],
      },
    ];
    const equivalentPlan = [
      {
        dependsOnNodeIds: [],
        prompt: "  完成实现  ",
        agentId: "  agent-worker  ",
        nodeId: "  worker  ",
      },
      {
        dependsOnNodeIds: ["  worker  "],
        prompt: "  审查实现  ",
        agentId: "agent-reviewer",
        nodeId: "review",
      },
    ];
    const changedPrompt = [
      canonicalPlan[0]!,
      { ...canonicalPlan[1]!, prompt: "审查实现与测试日志" },
    ];
    const reorderedNodes = [canonicalPlan[1]!, canonicalPlan[0]!];

    const [canonical, equivalent, changed, reordered] = yield* Effect.all(
      [
        digestFor("execution-plan-canonical", canonicalPlan),
        digestFor("execution-plan-equivalent", equivalentPlan),
        digestFor("execution-plan-changed", changedPrompt),
        digestFor("execution-plan-reordered", reorderedNodes),
      ],
      { concurrency: 1 },
    );

    expect(canonical).toBeDefined();
    expect(equivalent).toBe(canonical);
    expect(changed).not.toBe(canonical);
    expect(reordered).not.toBe(canonical);
  }),
);

it.effect("空显式计划在 claim 前被拒绝", () =>
  Effect.gen(function* () {
    const executionStore = makeExecutionStoreHarness();
    const runner = makeCompositionSquadRunner({
      squads: makeSquadLookup(baseSquad),
      executions: executionStore.store,
      planner: { plan: () => Effect.die("空显式计划不应自动规划") },
      executor: { execute: () => Effect.die("空显式计划不应执行") },
    });

    const error = yield* Effect.flip(
      runner.run({ ...baseInput, executionId: "execution-empty-plan", plan: [] }),
    );

    expect(error).toMatchObject({ code: "squad_plan_output_invalid" });
    expect(executionStore.snapshots).toEqual([]);
  }),
);

it.effect("Leader completed 缺少摘要时从 running 收口为 failed", () =>
  Effect.gen(function* () {
    const executionStore = makeExecutionStoreHarness();
    const runner = makeCompositionSquadRunner({
      squads: makeSquadLookup(baseSquad),
      executions: executionStore.store,
      planner: {
        plan: () =>
          Effect.succeed([
            {
              nodeId: "missing-summary-worker",
              agentId: "agent-worker",
              prompt: "执行完成但 Leader 未给摘要",
              dependsOnNodeIds: [],
            },
          ]),
      },
      executor: { execute: (input) => Effect.succeed(makeGraphResult(input, "completed")) },
    });

    const error = yield* Effect.flip(
      runner.run({ ...baseInput, executionId: "execution-missing-summary" }),
    );

    expect(error).toMatchObject({ code: "squad_execution_result_invalid" });
    expect(executionStore.read()).toMatchObject({
      status: "failed",
      revision: 4,
      failureCode: "squad_execution_result_invalid",
      nodes: [{ nodeId: "missing-summary-worker" }],
    });
  }),
);

it.effect("最终 CAS 失败时保留 running 状态且不伪造 failed", () =>
  Effect.gen(function* () {
    const events: string[] = [];
    const executionStore = makeExecutionStoreHarness({
      failSaveStatus: "completed",
      events,
    });
    const runner = makeCompositionSquadRunner({
      squads: makeSquadLookup(baseSquad, events),
      executions: executionStore.store,
      planner: {
        plan: () =>
          Effect.succeed([
            {
              nodeId: "final-cas-worker",
              agentId: "agent-worker",
              prompt: "完成后触发最终 CAS 失败",
              dependsOnNodeIds: [],
            },
          ]),
      },
      executor: {
        execute: (input) => Effect.succeed(makeGraphResult(input, "completed", "已完成")),
      },
    });

    const error = yield* Effect.flip(
      runner.run({ ...baseInput, executionId: "execution-final-cas-failed" }),
    );

    expect(error).toMatchObject({
      code: "squad_execution_revision_conflict",
      expectedRevision: 3,
      actualRevision: 13,
    });
    expect(executionStore.read()).toMatchObject({ status: "running", revision: 3 });
    expect(events.at(-1)).toBe("store:save:completed");
    expect(events).not.toContain("store:save:failed");
  }),
);

it.effect("failed 状态保存失败时保留当前状态并写入脱敏审计", () => {
  const logs: Array<{ readonly message: string; readonly annotations: Record<string, unknown> }> =
    [];
  const logger = Logger.make<unknown, void>(({ fiber, message }) => {
    logs.push({
      message: String(message),
      annotations: { ...fiber.getRef(References.CurrentLogAnnotations) },
    });
  });
  const events: string[] = [];
  const executionStore = makeExecutionStoreHarness({ failSaveStatus: "failed", events });
  const runner = makeCompositionSquadRunner({
    squads: makeSquadLookup(baseSquad, events),
    executions: executionStore.store,
    planner: {
      plan: (_input, hooks) =>
        (
          hooks?.onCancellationReceipt?.({
            trigger: "business_failure",
            receipt: { complete: true, runs: [] },
          }) ?? Effect.void
        ).pipe(
          Effect.andThen(
            Effect.fail(
              new CompositionSquadPlannerError({
                code: "leader_planning_failed",
                detail: "敏感规划失败详情 secret-plan",
                squadId: baseSquad.squadId,
              }),
            ),
          ),
        ),
    },
    executor: { execute: () => Effect.die("规划失败时不应执行") },
  });

  return Effect.gen(function* () {
    const exit = yield* Effect.exit(
      runner.run({
        ...baseInput,
        executionId: "execution-failed-save-audit",
        goal: "敏感目标 secret-goal",
      }),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const errors = Cause.prettyErrors(exit.cause);
      expect(
        errors.some((error) => "code" in error && error.code === "leader_planning_failed"),
      ).toBe(true);
      expect(
        errors.some(
          (error) =>
            "code" in error &&
            error.code === "squad_execution_revision_conflict" &&
            "expectedRevision" in error &&
            error.expectedRevision === 2 &&
            "actualRevision" in error &&
            error.actualRevision === 12,
        ),
      ).toBe(true);
    }
    expect(executionStore.read()).toMatchObject({ status: "planning", revision: 2 });
    expect(events.at(-1)).toBe("store:save:failed");
    const audit = logs.find((entry) => entry.message.includes("失败状态持久化失败"));
    expect(audit?.annotations).toEqual({
      executionId: "execution-failed-save-audit",
      currentStatus: "planning",
      originalErrorCode: "leader_planning_failed",
    });
    const loggedText = [
      audit?.message ?? "",
      ...Object.values(audit?.annotations ?? {}).map(String),
    ].join("\n");
    expect(loggedText).not.toContain("secret-goal");
    expect(loggedText).not.toContain("secret-plan");
    expect(loggedText).not.toContain("failed 写入失败");
  }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
});

it.effect("SQL 与解码类持久化错误对 RPC 返回稳定脱敏信息", () =>
  Effect.gen(function* () {
    const runFailure = (
      executionId: string,
      error: PersistenceSqlError | PersistenceDecodeError,
    ) => {
      const runner = makeCompositionSquadRunner({
        squads: makeSquadLookup(baseSquad),
        executions: {
          claimExecution: () => Effect.fail(error),
          getExecution: () => Effect.die("claim 失败后不应读取 execution"),
          saveTransition: () => Effect.die("claim 失败后不应保存状态"),
        },
        planner: { plan: () => Effect.die("claim 失败后不应规划") },
        executor: { execute: () => Effect.die("claim 失败后不应执行") },
      });
      return Effect.flip(runner.run({ ...baseInput, executionId }));
    };
    const errors = yield* Effect.all(
      [
        runFailure(
          "execution-sql-redaction",
          new PersistenceSqlError({
            operation: "INSERT secret_execution_table",
            detail: "SELECT token FROM private_credentials",
            cause: new Error("plaintext-sql-secret"),
          }),
        ),
        runFailure(
          "execution-decode-redaction",
          new PersistenceDecodeError({
            operation: "DECODE secret_execution_payload",
            issue: "secret-schema-issue",
            cause: new Error("plaintext-decode-secret"),
          }),
        ),
      ],
      { concurrency: 1 },
    );

    for (const error of errors) {
      expect(error).toMatchObject({ code: "squad_execution_persistence_failed" });
      expect(error.detail).not.toContain("secret_execution");
      expect(error.detail).not.toContain("private_credentials");
      expect(error.detail).not.toContain("secret-schema-issue");
      expect(error.detail).not.toContain("plaintext-sql-secret");
      expect(error.detail).not.toContain("plaintext-decode-secret");
    }
  }),
);
