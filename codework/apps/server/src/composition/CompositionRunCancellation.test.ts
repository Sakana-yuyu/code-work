import { expect, it } from "@effect/vitest";
import type { CompositionTask, CompositionTaskRun } from "@codework/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import { CompositionAgentDriverFailure } from "./CompositionOrchestrator.ts";
import {
  cancelCompositionRun,
  makeCompositionCancellationReceipt,
} from "./CompositionRunCancellation.ts";
import { CompositionTaskRuntimeWaitError } from "./CompositionTaskRuntimeProjectionService.ts";

const task: CompositionTask = {
  taskId: "task-1",
  projectId: "project-1",
  assigneeKind: "agent",
  assigneeId: "agent-1",
  mode: "serial",
  status: "running",
  promptDigest: "sha256:prompt",
  dependsOnTaskIds: [],
  createdAtUnixMs: 1,
  updatedAtUnixMs: 1,
};

const run: CompositionTaskRun = {
  runId: "run-1",
  taskId: task.taskId,
  agentId: task.assigneeId,
  runtimeId: "runtime-1",
  status: "running",
  attempt: 1,
  capabilityGrantIds: [],
};

const makeOptions = (overrides?: {
  readonly getTask?: () => Effect.Effect<Option.Option<CompositionTask>, Error>;
  readonly getRun?: () => Effect.Effect<Option.Option<CompositionTaskRun>, Error>;
  readonly cancelTask?: () => Effect.Effect<
    {
      readonly task: CompositionTask;
      readonly run: CompositionTaskRun;
      readonly status: "cancelled" | "cancel_requested" | "already_terminal";
    },
    Error
  >;
  readonly awaitTaskCompletion?: () => Effect.Effect<CompositionTaskRun, Error>;
  readonly matchesPersistedIdentity?: (task: CompositionTask, run: CompositionTaskRun) => boolean;
  readonly timeoutMs?: number;
}) => ({
  taskId: task.taskId,
  runId: run.runId,
  reason: "测试取消",
  timeoutMs: overrides?.timeoutMs ?? 20,
  ownership: "candidate" as const,
  getTask: overrides?.getTask ?? (() => Effect.succeed(Option.some(task))),
  getRun: overrides?.getRun ?? (() => Effect.succeed(Option.some(run))),
  matchesPersistedIdentity: overrides?.matchesPersistedIdentity ?? (() => true),
  cancelTask:
    overrides?.cancelTask ??
    (() =>
      Effect.succeed({
        task: { ...task, status: "cancelled" as const, finishedAtUnixMs: 2 },
        run: { ...run, status: "cancelled" as const, finishedAtUnixMs: 2 },
        status: "cancelled" as const,
      })),
  awaitTaskCompletion:
    overrides?.awaitTaskCompletion ??
    (() => Effect.succeed({ ...run, status: "cancelled" as const, finishedAtUnixMs: 2 })),
});

it.effect("匹配的非终态 Run 取消成功后返回 terminal 并聚合为 complete", () =>
  Effect.gen(function* () {
    const receipt = yield* cancelCompositionRun(makeOptions());

    expect(receipt).toEqual({
      taskId: "task-1",
      runId: "run-1",
      outcome: "terminal",
      terminalStatus: "cancelled",
    });
    expect(makeCompositionCancellationReceipt([receipt])).toEqual({
      runs: [receipt],
      complete: true,
    });
  }),
);

it.effect("已确认归属的 Run 不依赖 Store 查询即可直接取消", () =>
  Effect.gen(function* () {
    let cancelCalls = 0;
    const receipt = yield* cancelCompositionRun({
      taskId: task.taskId,
      runId: run.runId,
      reason: "测试已确认归属取消",
      timeoutMs: 20,
      ownership: "confirmed",
      matchesPersistedIdentity: (candidateTask, candidateRun) =>
        candidateTask.taskId === task.taskId &&
        candidateRun.runId === run.runId &&
        candidateRun.taskId === task.taskId,
      cancelTask: () =>
        Effect.sync(() => {
          cancelCalls += 1;
          return {
            task: { ...task, status: "cancelled" as const, finishedAtUnixMs: 2 },
            run: { ...run, status: "cancelled" as const, finishedAtUnixMs: 2 },
            status: "cancelled" as const,
          };
        }),
      awaitTaskCompletion: () => Effect.die("同步取消成功后不应等待终态"),
    });

    expect(cancelCalls).toBe(1);
    expect(receipt).toEqual({
      taskId: task.taskId,
      runId: run.runId,
      outcome: "terminal",
      terminalStatus: "cancelled",
    });
  }),
);

it.effect("取消响应与取消确认返回 foreign terminal 时拒绝伪造完成回执", () =>
  Effect.gen(function* () {
    const foreignTask: CompositionTask = {
      ...task,
      taskId: "foreign-task",
      assigneeId: "foreign-agent",
      status: "cancelled",
    };
    const foreignRun: CompositionTaskRun = {
      ...run,
      runId: "foreign-run",
      taskId: foreignTask.taskId,
      agentId: foreignTask.assigneeId,
      status: "cancelled",
      finishedAtUnixMs: 2,
    };
    const foreignConfirmationRun: CompositionTaskRun = {
      ...run,
      runtimeId: "foreign-runtime",
      status: "cancelled",
      attempt: 99,
      finishedAtUnixMs: 2,
    };
    const matchesPersistedIdentity = (
      candidateTask: CompositionTask,
      candidateRun: CompositionTaskRun,
    ) =>
      candidateTask.taskId === task.taskId &&
      candidateTask.assigneeId === task.assigneeId &&
      candidateRun.runId === run.runId &&
      candidateRun.taskId === task.taskId &&
      candidateRun.agentId === run.agentId;

    const cancelResponseReceipt = yield* cancelCompositionRun({
      ...makeOptions({ matchesPersistedIdentity }),
      ownership: "confirmed",
      cancelTask: () =>
        Effect.succeed({
          task: foreignTask,
          run: foreignRun,
          status: "cancelled" as const,
        }),
      awaitTaskCompletion: () => Effect.die("直接终态响应不应等待确认"),
    });
    const confirmationReceipt = yield* cancelCompositionRun({
      ...makeOptions({ matchesPersistedIdentity }),
      ownership: "confirmed",
      cancelTask: () => Effect.succeed({ task, run, status: "cancel_requested" as const }),
      awaitTaskCompletion: () => Effect.succeed(foreignConfirmationRun),
    });

    expect(cancelResponseReceipt).toMatchObject({
      outcome: "ownership_unverified",
      failureCode: "cancel_response_identity_mismatch",
    });
    expect(confirmationReceipt).toMatchObject({
      outcome: "ownership_unverified",
      failureCode: "cancel_confirmation_identity_mismatch",
    });
    expect(makeCompositionCancellationReceipt([cancelResponseReceipt]).complete).toBe(false);
    expect(makeCompositionCancellationReceipt([confirmationReceipt]).complete).toBe(false);
  }),
);

it.effect("不存在或不匹配当前身份的稳定 Run 返回 not_owned 且不调用取消", () =>
  Effect.gen(function* () {
    let cancelCalls = 0;
    for (const overrides of [
      {
        getTask: () => Effect.succeed(Option.none<CompositionTask>()),
        getRun: () => Effect.succeed(Option.none<CompositionTaskRun>()),
      },
      { matchesPersistedIdentity: () => false },
    ]) {
      const receipt = yield* cancelCompositionRun(
        makeOptions({
          ...overrides,
          cancelTask: () =>
            Effect.sync(() => {
              cancelCalls += 1;
              return { task, run, status: "cancelled" as const };
            }),
        }),
      );
      expect(receipt.outcome).toBe("not_owned");
      expect(makeCompositionCancellationReceipt([receipt]).complete).toBe(true);
    }
    expect(cancelCalls).toBe(0);
  }),
);

it.effect("查询、取消、确认与超时失败只返回稳定受控的不完整回执", () =>
  Effect.gen(function* () {
    const cases = [
      {
        expected: ["ownership_unverified", "ownership_lookup_failed"],
        overrides: {
          getTask: () =>
            Effect.fail(
              new CompositionAgentDriverFailure({
                code: "third_party_secret_lookup",
                detail: "third-party-secret-lookup",
              }),
            ),
        },
      },
      {
        expected: ["cancel_failed", "cancel_failed"],
        overrides: {
          cancelTask: () =>
            Effect.fail(
              new CompositionAgentDriverFailure({
                code: "third_party_secret_code",
                detail: "third-party-secret-cancel",
              }),
            ),
        },
      },
      {
        expected: ["pending", "cancel_confirmation_failed"],
        overrides: {
          cancelTask: () => Effect.succeed({ task, run, status: "cancel_requested" as const }),
          awaitTaskCompletion: () =>
            Effect.fail(
              new CompositionTaskRuntimeWaitError({
                taskId: task.taskId,
                runId: run.runId,
                reason: "third-party-secret-confirmation",
              }),
            ),
        },
      },
      {
        expected: ["timeout", "cancel_timeout"],
        overrides: {
          cancelTask: () => Effect.never,
          timeoutMs: 5,
        },
      },
    ] as const;

    for (const currentCase of cases) {
      const effect = cancelCompositionRun(makeOptions(currentCase.overrides));
      const receipt =
        currentCase.expected[0] === "timeout"
          ? yield* Effect.gen(function* () {
              const fiber = yield* Effect.forkChild(effect);
              yield* TestClock.adjust("5 millis");
              return yield* Fiber.join(fiber);
            })
          : yield* effect;
      expect(receipt).toMatchObject({
        outcome: currentCase.expected[0],
        failureCode: currentCase.expected[1],
      });
      expect(makeCompositionCancellationReceipt([receipt]).complete).toBe(false);
      expect(Object.values(receipt).map(String).join("\n")).not.toContain("third-party-secret");
    }
  }),
);
