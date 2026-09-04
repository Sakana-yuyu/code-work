import type {
  CompositionTask,
  CompositionTaskSnapshot,
  CompositionTaskRun,
  SpecWorkflowCapability,
  SpecWorkflowCommand,
  SpecWorkflowIntentName,
  SpecWorkflowState,
  SpecWorkflowStateEvent,
  SpecWorkflowStage,
  SpecWorkflowRoute,
  SpecWorkflowLoopConfig,
} from "@codework/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type {
  CompositionDispatchInput,
  CompositionDispatchResult,
} from "../composition/CompositionOrchestrator.ts";
import type { CompositionTaskStoreError } from "../persistence/Services/CompositionTaskStore.ts";
import type { CompositionOrchestratorServiceShape } from "../composition/CompositionOrchestratorService.ts";
import { SpecWorkflowTransitionError, transitionSpecWorkflowState } from "./SpecWorkflowDecider.ts";
import { routeSpecWorkflowIntent } from "./SpecWorkflowRouter.ts";

export const SpecWorkflowCompositionBridgeErrorCode = Schema.Literals([
  "not-enabled",
  "identity-conflict",
  "stage-not-dispatchable",
  "independent-verifier-required",
  "idempotency-conflict",
  "composition-unavailable",
]);
export type SpecWorkflowCompositionBridgeErrorCode =
  typeof SpecWorkflowCompositionBridgeErrorCode.Type;

export class SpecWorkflowCompositionBridgeError extends Schema.TaggedErrorClass<SpecWorkflowCompositionBridgeError>()(
  "SpecWorkflowCompositionBridgeError",
  {
    code: SpecWorkflowCompositionBridgeErrorCode,
    detail: Schema.String,
    workflowId: Schema.String,
  },
) {
  override get message(): string {
    return `Spec Workflow Composition 适配失败：${this.code}: ${this.detail}`;
  }
}

export type SpecWorkflowCompositionDispatchInput = {
  readonly capability: SpecWorkflowCapability;
  readonly state: SpecWorkflowState;
  readonly intent: SpecWorkflowIntentName;
  readonly now: number;
  readonly projectId: string;
  readonly threadId: string;
  readonly workspaceRoot: string;
  readonly assigneeId: string;
  readonly prompt: string;
  readonly promptDigest: string;
  readonly model?: string;
  readonly capabilityIds?: ReadonlyArray<string>;
  /** verify 阶段必须使用与实施不同的执行者。 */
  readonly implementationAssigneeId?: string;
  readonly independentVerifierId?: string;
};

export type SpecWorkflowCompositionDispatchResult = {
  readonly route: SpecWorkflowRoute;
  readonly stateEvent: SpecWorkflowStateEvent;
  readonly task: CompositionTask;
  readonly run: CompositionTaskRun;
};

export type SpecWorkflowCompositionControlResult = {
  readonly event: SpecWorkflowStateEvent;
};

const dispatchableStages: ReadonlySet<SpecWorkflowStage> = new Set(["apply", "verify"]);

const taskIdentity = (state: SpecWorkflowState, stage: SpecWorkflowStage) => ({
  taskId: `spec-workflow:${state.workflowId}:${stage}:${state.revision + 1}`,
  runId: `spec-workflow:${state.workflowId}:${stage}:${state.revision + 1}:run`,
});

const loopIdentity = (state: SpecWorkflowState) => ({
  taskId: `spec-workflow:${state.workflowId}:loop:${state.revision + 1}`,
  runId: `spec-workflow:${state.workflowId}:loop:${state.revision + 1}:run`,
});

const matchesDispatch = (
  snapshot: CompositionTaskSnapshot,
  input: CompositionDispatchInput,
): boolean =>
  snapshot.task.taskId === input.taskId &&
  snapshot.task.projectId === input.projectId &&
  snapshot.task.threadId === input.threadId &&
  snapshot.task.assigneeId === input.assigneeId &&
  snapshot.task.promptDigest === input.promptDigest &&
  snapshot.latestRun?.runId === input.runId &&
  snapshot.latestRun.agentId === input.assigneeId;

const reuseExisting = (
  orchestrator: CompositionOrchestratorServiceShape,
  input: CompositionDispatchInput,
): Effect.Effect<
  CompositionDispatchResult,
  CompositionTaskStoreError | SpecWorkflowCompositionBridgeError
> =>
  orchestrator.listTaskSnapshots(input.projectId).pipe(
    Effect.flatMap((snapshots) => {
      const existing = snapshots.find((snapshot) => matchesDispatch(snapshot, input));
      if (existing === undefined) {
        return Effect.fail(
          new SpecWorkflowCompositionBridgeError({
            code: "idempotency-conflict",
            detail: "稳定 Composition Task 已存在，但任务快照与本次请求不一致。",
            workflowId: input.taskId,
          }),
        );
      }
      const latestRun = existing.latestRun;
      if (latestRun === undefined) {
        return Effect.fail(
          new SpecWorkflowCompositionBridgeError({
            code: "idempotency-conflict",
            detail: "稳定 Composition Task 已存在，但其 Run 身份不完整或与本次请求不一致。",
            workflowId: input.taskId,
          }),
        );
      }
      return Effect.succeed({ task: existing.task, run: latestRun });
    }),
  );

const dispatchOrReuse = (
  orchestrator: CompositionOrchestratorServiceShape,
  input: CompositionDispatchInput,
): Effect.Effect<
  CompositionDispatchResult,
  | Effect.Error<ReturnType<CompositionOrchestratorServiceShape["dispatchTask"]>>
  | SpecWorkflowCompositionBridgeError
> =>
  orchestrator
    .dispatchTask(input)
    .pipe(
      Effect.catchTag("CompositionTaskAlreadyExistsError", () =>
        reuseExisting(orchestrator, input),
      ),
    );

/**
 * 把路由、状态转换与 Composition 派发收敛到一个边界。
 * 调用方负责持久化返回的 stateEvent；这里不绕过 Decider，也不直接修改快照。
 */
export const dispatchSpecWorkflowStage = (
  orchestrator: CompositionOrchestratorServiceShape,
  input: SpecWorkflowCompositionDispatchInput,
) =>
  Effect.gen(function* () {
    if (!input.capability.enabled) {
      return yield* new SpecWorkflowCompositionBridgeError({
        code: "not-enabled",
        detail: "Spec Workflow 能力未显式启用，Composition 不得被调用。",
        workflowId: input.state.workflowId,
      });
    }
    if (input.projectId !== input.state.projectId || input.threadId !== input.state.threadId) {
      return yield* new SpecWorkflowCompositionBridgeError({
        code: "identity-conflict",
        detail: "Composition 派发的项目或线程身份与工作流快照不一致。",
        workflowId: input.state.workflowId,
      });
    }

    const route = routeSpecWorkflowIntent({
      capability: input.capability,
      state: input.state,
      intent: input.intent,
    });
    if (
      route.action !== "advance" ||
      route.targetStage === null ||
      !dispatchableStages.has(route.targetStage)
    ) {
      return yield* new SpecWorkflowCompositionBridgeError({
        code: "stage-not-dispatchable",
        detail: `当前路由 ${route.action}/${route.targetStage ?? "none"} 不允许派发 Composition Task。`,
        workflowId: input.state.workflowId,
      });
    }

    if (route.targetStage === "verify") {
      if (
        input.independentVerifierId === undefined ||
        input.implementationAssigneeId === undefined ||
        input.independentVerifierId === input.implementationAssigneeId ||
        input.assigneeId !== input.independentVerifierId
      ) {
        return yield* new SpecWorkflowCompositionBridgeError({
          code: "independent-verifier-required",
          detail: "独立验证必须指定不同于实施者的验证执行者。",
          workflowId: input.state.workflowId,
        });
      }
    }

    const identity = taskIdentity(input.state, route.targetStage);
    const stateEvent = transitionSpecWorkflowState(
      input.state,
      {
        type: "advance",
        to: route.targetStage,
        activeTaskId: identity.taskId,
        expectedRevision: input.state.revision,
      },
      input.now,
    );
    const dispatch: CompositionDispatchInput = {
      ...identity,
      projectId: input.projectId,
      threadId: input.threadId,
      assigneeKind: "agent",
      assigneeId: input.assigneeId,
      mode: "serial",
      promptDigest: input.promptDigest,
      prompt:
        route.targetStage === "verify"
          ? `【独立验证】不得复用实施者结论；请基于工作区与验收标准独立检查。\n${input.prompt}`
          : input.prompt,
      workspaceRoot: input.workspaceRoot,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.capabilityIds === undefined ? {} : { capabilityIds: [...input.capabilityIds] }),
      dependsOnTaskIds: [],
    };
    const result = yield* dispatchOrReuse(orchestrator, dispatch);
    return {
      route,
      stateEvent,
      task: result.task,
      run: result.run,
    };
  });

export type SpecWorkflowLoopPreparationInput = {
  readonly capability: SpecWorkflowCapability;
  readonly state: SpecWorkflowState;
  readonly intent: SpecWorkflowIntentName;
  readonly loopConfig: SpecWorkflowLoopConfig;
  readonly now: number;
  readonly projectId: string;
  readonly threadId: string;
};

export type SpecWorkflowLoopPreparationResult = {
  readonly route: SpecWorkflowRoute;
  readonly stateEvent: SpecWorkflowStateEvent;
  readonly taskId: string;
  readonly runId: string;
};

/** 只准备受服务端门禁保护的 Loop 身份与状态事件，实际循环复用现有 Runner。 */
export const prepareSpecWorkflowLoop = (
  input: SpecWorkflowLoopPreparationInput,
): Effect.Effect<
  SpecWorkflowLoopPreparationResult,
  SpecWorkflowCompositionBridgeError | SpecWorkflowTransitionError
> =>
  Effect.gen(function* () {
    if (!input.capability.enabled) {
      return yield* new SpecWorkflowCompositionBridgeError({
        code: "not-enabled",
        detail: "Spec Workflow 能力未显式启用，Goal Loop 不得被调用。",
        workflowId: input.state.workflowId,
      });
    }
    if (input.projectId !== input.state.projectId || input.threadId !== input.state.threadId) {
      return yield* new SpecWorkflowCompositionBridgeError({
        code: "identity-conflict",
        detail: "Goal Loop 的项目或线程身份与工作流快照不一致。",
        workflowId: input.state.workflowId,
      });
    }
    const route = routeSpecWorkflowIntent({
      capability: input.capability,
      state: input.state,
      intent: input.intent,
      loopConfig: input.loopConfig,
    });
    if (route.action !== "advance" || route.targetStage !== "apply") {
      return yield* new SpecWorkflowCompositionBridgeError({
        code: "stage-not-dispatchable",
        detail: `当前路由 ${route.action}/${route.targetStage ?? "none"} 不允许启动 Goal Loop。`,
        workflowId: input.state.workflowId,
      });
    }
    const identity = loopIdentity(input.state);
    const stateEvent = transitionSpecWorkflowState(
      input.state,
      {
        type: "advance",
        to: "apply",
        activeTaskId: identity.taskId,
        loopConfig: input.loopConfig,
        expectedRevision: input.state.revision,
      },
      input.now,
    );
    return { route, stateEvent, ...identity };
  });

/** 暂停/恢复也必须经过闭闸和 Decider，供服务层原子持久化同一状态事件。 */
export const transitionSpecWorkflowControl = (input: {
  readonly capability: SpecWorkflowCapability;
  readonly state: SpecWorkflowState;
  readonly command: SpecWorkflowCommand;
  readonly now: number;
}): Effect.Effect<
  SpecWorkflowCompositionControlResult,
  SpecWorkflowCompositionBridgeError | SpecWorkflowTransitionError
> =>
  Effect.gen(function* () {
    if (!input.capability.enabled) {
      return yield* new SpecWorkflowCompositionBridgeError({
        code: "not-enabled",
        detail: "Spec Workflow 能力未显式启用，不能修改工作流状态。",
        workflowId: input.state.workflowId,
      });
    }
    return { event: transitionSpecWorkflowState(input.state, input.command, input.now) };
  });
