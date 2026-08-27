import { describe, expect } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { GOAL_COMPLETE_MARKER, runCompositionGoalLoop } from "./CompositionGoalLoop.ts";
import {
  makeByokGoalLoopAttempt,
  makeMulticaGoalLoopAttempt,
} from "./CompositionGoalLoopAttemptAdapters.ts";
import { CompositionAgentServiceError } from "./CompositionAgentService.ts";
import type { MulticaDaemonProtocol } from "./MulticaDaemonProtocol.ts";

describe("makeByokGoalLoopAttempt", () => {
  effectIt.effect("BYOK attempt 接入 Goal Loop：两轮后出现完成标记即收敛", () =>
    Effect.gen(function* () {
      const prompts: string[] = [];
      const outputs = ["第一轮仍在整理", `发布说明已完成 ${GOAL_COMPLETE_MARKER}`];
      const attempt = makeByokGoalLoopAttempt({
        agentService: {
          run: (input) =>
            Effect.sync(() => {
              prompts.push(input.prompt);
              return { text: outputs[prompts.length - 1] };
            }) as unknown as Effect.Effect<{ text: string }, CompositionAgentServiceError>,
        },
        providerInstanceId: "provider-1",
        runtimeId: "runtime-1",
        modelId: "model-1",
        taskId: "task-byok",
        runId: "run-byok",
        agentId: "agent-byok",
        workspaceRoot: "C:/workspace",
        goal: "整理发布说明",
      });
      const result = yield* runCompositionGoalLoop({
        maxAttempts: 5,
        attempt: (round, context) => attempt(round, context),
      });
      expect(result.status).toBe("completed");
      expect(result.rounds).toBe(2);
      expect(result.costUnitsUsed).toBe(2);
      expect(prompts).toHaveLength(2);
      expect(prompts[0]).toContain("整理发布说明");
      expect(prompts[0]).toContain("第 1 轮");
      expect(prompts[1]).toContain("第 2 轮");
      expect(prompts[0]).toContain(GOAL_COMPLETE_MARKER);
    }),
  );

  effectIt.effect("模型循环失败原样上抛 CompositionAgentServiceError", () =>
    Effect.gen(function* () {
      const attempt = makeByokGoalLoopAttempt({
        agentService: {
          run: () =>
            Effect.fail(
              new CompositionAgentServiceError({
                code: "provider_offline",
                detail: "Provider 不在线",
              }),
            ),
        },
        providerInstanceId: "provider-1",
        runtimeId: "runtime-1",
        modelId: "model-1",
        taskId: "task-byok-fail",
        runId: "run-byok-fail",
        agentId: "agent-byok",
        workspaceRoot: "C:/workspace",
        goal: "任意目标",
      });
      const failure = yield* attempt(1).pipe(Effect.flip);
      expect(failure._tag).toBe("CompositionAgentServiceError");
      expect(failure.code).toBe("provider_offline");
    }),
  );
});

describe("makeMulticaGoalLoopAttempt", () => {
  const makeProtocol = (handler: {
    readonly onCreate?: (taskId: string) => void;
    readonly status: (pollCount: number) => string;
  }): Pick<MulticaDaemonProtocol, "quickCreateTask" | "getTaskStatus"> => {
    let pollCount = 0;
    return {
      quickCreateTask: (_input) =>
        Effect.sync(() => {
          handler.onCreate?.("remote-task-1");
          return { taskId: "remote-task-1" };
        }),
      getTaskStatus: (_taskId: string) =>
        Effect.sync(() => {
          pollCount += 1;
          return { status: handler.status(pollCount) };
        }),
    } as unknown as Pick<MulticaDaemonProtocol, "quickCreateTask" | "getTaskStatus">;
  };

  effectIt.effect("轮询到 completed 并取回带完成标记的输出，attempt 收敛为 completed", () =>
    Effect.gen(function* () {
      const created: Array<{ prompt: string; agentId?: string; workspaceId: string }> = [];
      let pollCount = 0;
      const protocol = makeProtocol({
        status: () => {
          pollCount += 1;
          return pollCount === 1 ? "in_progress" : "completed";
        },
      });
      const wrappedProtocol: Pick<MulticaDaemonProtocol, "quickCreateTask" | "getTaskStatus"> = {
        quickCreateTask: (input) =>
          Effect.map(protocol.quickCreateTask(input), (response) => {
            created.push(input as { prompt: string; agentId?: string; workspaceId: string });
            return response;
          }),
        getTaskStatus: protocol.getTaskStatus,
      };
      const attempt = makeMulticaGoalLoopAttempt<string | undefined>({
        protocol: wrappedProtocol,
        workspaceId: "workspace-1",
        agentId: "agent-remote",
        goal: "完成数据迁移",
        pollIntervalMs: 1,
        sleep: () => Effect.void,
        fetchOutput: () => Effect.succeed(`迁移完成 [[GOAL_COMPLETE: 全部表已迁移]]`),
      });
      const decision = yield* attempt(1);
      expect(decision.costUnits).toBe(1);
      expect(decision.outputText).toContain("[[GOAL_COMPLETE: 全部表已迁移]]");
      expect(pollCount).toBe(2);
      expect(created).toHaveLength(1);
      expect(created[0]?.agentId).toBe("agent-remote");
      expect(created[0]?.workspaceId).toBe("workspace-1");
      expect(created[0]?.prompt).toContain("完成数据迁移");
      expect(created[0]?.prompt).toContain("第 1 轮");
    }),
  );

  effectIt.effect("远端失败态显式报错；轮询超时亦显式报错", () =>
    Effect.gen(function* () {
      const failedAttempt = makeMulticaGoalLoopAttempt({
        protocol: makeProtocol({ status: () => "failed" }),
        workspaceId: "workspace-1",
        squadId: "squad-1",
        goal: "任意目标",
        sleep: () => Effect.void,
      });
      const failedError = yield* failedAttempt(1).pipe(Effect.flip);
      expect(failedError._tag).toBe("CompositionGoalLoopAttemptError");
      expect(failedError.code).toBe("multica_round_failed");

      let clock = 0;
      const timeoutAttempt = makeMulticaGoalLoopAttempt({
        protocol: makeProtocol({ status: () => "in_progress" }),
        workspaceId: "workspace-1",
        agentId: "agent-remote",
        goal: "任意目标",
        pollIntervalMs: 1,
        pollTimeoutMs: 100,
        now: () => {
          clock += 60;
          return clock;
        },
        sleep: () => Effect.void,
      });
      const timeoutError = yield* timeoutAttempt(1).pipe(Effect.flip);
      expect(timeoutError._tag).toBe("CompositionGoalLoopAttemptError");
      expect(timeoutError.code).toBe("multica_round_timeout");
    }),
  );

  effectIt.effect("agentId 与 squadId 同时指定或同时缺失显式拒绝", () =>
    Effect.gen(function* () {
      const protocol = makeProtocol({ status: () => "completed" });
      const both = makeMulticaGoalLoopAttempt({
        protocol,
        workspaceId: "workspace-1",
        agentId: "agent-remote",
        squadId: "squad-1",
        goal: "任意目标",
      });
      const bothError = yield* both(1).pipe(Effect.flip);
      expect(bothError.code).toBe("multica_round_input_invalid");

      const neither = makeMulticaGoalLoopAttempt({
        protocol,
        workspaceId: "workspace-1",
        goal: "任意目标",
      });
      const neitherError = yield* neither(1).pipe(Effect.flip);
      expect(neitherError.code).toBe("multica_round_input_invalid");
    }),
  );

  effectIt.effect("Multica attempt 接入 Goal Loop：远端第二轮回传完成标记后收敛", () =>
    Effect.gen(function* () {
      const outputs = ["第一轮迁移进行中", `迁移完成 [[GOAL_COMPLETE: 目标达成]]`];
      let attemptIndex = 0;
      const protocol = makeProtocol({ status: () => "completed" });
      const attempt = makeMulticaGoalLoopAttempt<string | undefined>({
        protocol,
        workspaceId: "workspace-1",
        agentId: "agent-remote",
        goal: "完成数据迁移",
        fetchOutput: () =>
          Effect.sync(() => {
            const text = outputs[Math.min(attemptIndex, outputs.length - 1)];
            attemptIndex += 1;
            return text;
          }),
      });
      const result = yield* runCompositionGoalLoop({
        maxAttempts: 5,
        attempt: (loopRound) => attempt(loopRound),
      });
      expect(result.status).toBe("completed");
      expect(result.rounds).toBe(2);
      expect(result.costUnitsUsed).toBe(2);
      expect(result.completion?.reason).toBe("目标达成");
    }),
  );
});
