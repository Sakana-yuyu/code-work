import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { ProjectId, ThreadId } from "@codework/contracts";

import type { CompositionOrchestratorServiceShape } from "../composition/CompositionOrchestratorService.ts";
import { CompositionTaskAlreadyExistsError } from "../composition/CompositionOrchestrator.ts";
import {
  dispatchSpecWorkflowStage,
  prepareSpecWorkflowLoop,
  transitionSpecWorkflowControl,
} from "./SpecWorkflowCompositionBridge.ts";

const capability = {
  threadId: ThreadId.make("thread-spec"),
  enabled: true,
  revision: 1,
  updatedAt: 1,
} as const;

const baseState = {
  workflowId: "workflow-spec",
  projectId: ProjectId.make("project-spec"),
  threadId: ThreadId.make("thread-spec"),
  changeName: "native-feature",
  mode: "full" as const,
  stage: "awaitingApproval" as const,
  status: "active" as const,
  revision: 4,
  tbdCount: 0,
  proposalStatus: "approved" as const,
  implementationCompleted: false,
  verificationStatus: "pending" as const,
  acceptanceStatus: "pending" as const,
  activeTaskId: null,
  lastError: null,
  updatedAt: 4,
};

const makeResult = (input: {
  taskId: string;
  runId: string;
  projectId: string;
  threadId?: string;
  assigneeId: string;
  promptDigest: string;
}) => ({
  task: {
    taskId: input.taskId,
    projectId: input.projectId,
    ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
    assigneeKind: "agent" as const,
    assigneeId: input.assigneeId,
    mode: "serial" as const,
    status: "running" as const,
    promptDigest: input.promptDigest,
    dependsOnTaskIds: [],
    createdAtUnixMs: 10,
    updatedAtUnixMs: 10,
  },
  run: {
    runId: input.runId,
    taskId: input.taskId,
    agentId: input.assigneeId,
    runtimeId: "runtime-spec",
    status: "running" as const,
    attempt: 0,
    capabilityGrantIds: [],
  },
});

const makeOrchestrator = (options?: {
  readonly dispatch?: CompositionOrchestratorServiceShape["dispatchTask"];
  readonly snapshots?: CompositionOrchestratorServiceShape["listTaskSnapshots"];
}) =>
  ({
    dispatchTask: options?.dispatch ?? ((input) => Effect.succeed(makeResult(input))),
    listTaskSnapshots: options?.snapshots ?? (() => Effect.succeed([])),
  }) as unknown as CompositionOrchestratorServiceShape;

describe("Spec Workflow Composition bridge", () => {
  it("批准后派发真实 apply Task，并返回可持久化的状态事件", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* dispatchSpecWorkflowStage(makeOrchestrator(), {
          capability,
          state: baseState,
          intent: "apply",
          now: 10,
          projectId: "project-spec",
          threadId: "thread-spec",
          workspaceRoot: "C:/workspace/spec",
          assigneeId: "implementer",
          prompt: "执行 proposal.md 中的任务。",
          promptDigest: "sha256:apply",
        });

        expect(result.route.targetStage).toBe("apply");
        expect(result.stateEvent.state.stage).toBe("apply");
        expect(result.task.taskId).toBe("spec-workflow:workflow-spec:apply:5");
        expect(result.run.runId).toBe("spec-workflow:workflow-spec:apply:5:run");
      }),
    );
  });

  it("verify 强制独立执行者，并将独立验证要求写入派发 prompt", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const dispatches: string[] = [];
        const result = yield* dispatchSpecWorkflowStage(
          makeOrchestrator({
            dispatch: (input) => {
              dispatches.push(input.prompt ?? "");
              return Effect.succeed(makeResult(input));
            },
          }),
          {
            capability,
            state: { ...baseState, stage: "apply", implementationCompleted: true },
            intent: "verify",
            now: 10,
            projectId: "project-spec",
            threadId: "thread-spec",
            workspaceRoot: "C:/workspace/spec",
            assigneeId: "verifier",
            implementationAssigneeId: "implementer",
            independentVerifierId: "verifier",
            prompt: "检查实现与测试。",
            promptDigest: "sha256:verify",
          },
        );

        expect(result.stateEvent.state.stage).toBe("verify");
        expect(dispatches[0]).toContain("【独立验证】");
        expect(result.run.agentId).toBe("verifier");
      }),
    );
  });

  it("重复派发在 Composition 已存在时按稳定身份复用，不产生第二个任务", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        let dispatchCount = 0;
        const orchestrator = makeOrchestrator({
          dispatch: (input) => {
            dispatchCount += 1;
            return Effect.fail(new CompositionTaskAlreadyExistsError({ taskId: input.taskId }));
          },
          snapshots: () =>
            Effect.succeed([
              {
                task: makeResult({
                  taskId: "spec-workflow:workflow-spec:apply:5",
                  runId: "spec-workflow:workflow-spec:apply:5:run",
                  projectId: "project-spec",
                  threadId: "thread-spec",
                  assigneeId: "implementer",
                  promptDigest: "sha256:apply",
                }).task,
                latestRun: makeResult({
                  taskId: "spec-workflow:workflow-spec:apply:5",
                  runId: "spec-workflow:workflow-spec:apply:5:run",
                  projectId: "project-spec",
                  threadId: "thread-spec",
                  assigneeId: "implementer",
                  promptDigest: "sha256:apply",
                }).run,
              },
            ]),
        });

        const result = yield* dispatchSpecWorkflowStage(orchestrator, {
          capability,
          state: baseState,
          intent: "apply",
          now: 10,
          projectId: "project-spec",
          threadId: "thread-spec",
          workspaceRoot: "C:/workspace/spec",
          assigneeId: "implementer",
          prompt: "执行 proposal.md 中的任务。",
          promptDigest: "sha256:apply",
        });

        expect(dispatchCount).toBe(1);
        expect(result.task.taskId).toBe("spec-workflow:workflow-spec:apply:5");
      }),
    );
  });

  it("未启用时不调用 Composition，暂停/恢复保持 Decider 门禁", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        let dispatchCount = 0;
        const disabled = yield* Effect.exit(
          dispatchSpecWorkflowStage(
            makeOrchestrator({
              dispatch: () => {
                dispatchCount += 1;
                return Effect.die("disabled workflow must not dispatch");
              },
            }),
            {
              capability: { ...capability, enabled: false },
              state: baseState,
              intent: "apply",
              now: 10,
              projectId: "project-spec",
              threadId: "thread-spec",
              workspaceRoot: "C:/workspace/spec",
              assigneeId: "implementer",
              prompt: "不应执行。",
              promptDigest: "sha256:disabled",
            },
          ),
        );
        expect(disabled._tag).toBe("Failure");
        expect(dispatchCount).toBe(0);

        const paused = yield* transitionSpecWorkflowControl({
          capability,
          state: baseState,
          command: { type: "pause", expectedRevision: 4 },
          now: 11,
        });
        expect(paused.event.state.status).toBe("paused");

        const resumed = yield* transitionSpecWorkflowControl({
          capability,
          state: paused.event.state,
          command: { type: "resume", expectedRevision: 5 },
          now: 12,
        });
        expect(resumed.event.state.status).toBe("active");
      }),
    );
  });

  it("Loop 只准备稳定身份和状态事件，实际执行交给现有 Runner", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* prepareSpecWorkflowLoop({
          capability,
          state: baseState,
          intent: "loop",
          loopConfig: { maxAttempts: 3 },
          now: 10,
          projectId: "project-spec",
          threadId: "thread-spec",
        });

        expect(result.route.targetStage).toBe("apply");
        expect(result.taskId).toBe("spec-workflow:workflow-spec:loop:5");
        expect(result.runId).toBe("spec-workflow:workflow-spec:loop:5:run");
        expect(result.stateEvent.state.activeTaskId).toBe(result.taskId);
        expect(result.stateEvent.state.loopConfig).toEqual({ maxAttempts: 3 });
      }),
    );
  });
});
