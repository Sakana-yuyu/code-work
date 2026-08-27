import type { ByokAgentTool } from "./ByokAgentLoop.ts";
import type {
  CompositionAgentServiceError,
  CompositionAgentServiceShape,
} from "./CompositionAgentService.ts";
import { GOAL_COMPLETE_MARKER, type CompositionGoalLoopDecision } from "./CompositionGoalLoop.ts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type {
  MulticaDaemonProtocol,
  MulticaDaemonProtocolFailure,
} from "./MulticaDaemonProtocol.ts";

const composeRoundPrompt = (goal: string, round: number): string =>
  `${goal}\n\n[Goal Loop 第 ${round} 轮] 请继续推进该目标；若目标已完全达成，在回复中输出 ` +
  `${GOAL_COMPLETE_MARKER} 或带原因的 [[GOAL_COMPLETE: 原因]]。`;

/** Goal Loop attempt 的统一失败合同（Multica 路径的轮询/终止/入参错误）。 */
export class CompositionGoalLoopAttemptError extends Data.TaggedError(
  "CompositionGoalLoopAttemptError",
)<{
  readonly code: "multica_round_input_invalid" | "multica_round_failed" | "multica_round_timeout";
  readonly detail: string;
}> {}

/**
 * BYOK 生产派发路径的 attempt：每轮 = 一次 CompositionAgentService 模型循环调用
 * （与 BYOK Driver 同一生产入口）。轮产物即模型最终文本，costUnits 计 1。
 */
export const makeByokGoalLoopAttempt =
  (options: {
    readonly agentService: Pick<CompositionAgentServiceShape, "run">;
    readonly providerInstanceId: string;
    readonly runtimeId: string;
    readonly modelId: string;
    readonly taskId: string;
    readonly runId: string;
    readonly agentId: string;
    readonly workspaceRoot: string;
    readonly goal: string;
    readonly capabilityGrantIds?: ReadonlyArray<string>;
    readonly tools?: ReadonlyArray<ByokAgentTool>;
    /** 单次模型循环内部的最大轮数；缺省 4。 */
    readonly maxRoundsPerAttempt?: number;
  }) =>
  (
    round: number,
  ): Effect.Effect<CompositionGoalLoopDecision<string>, CompositionAgentServiceError> =>
    options.agentService
      .run({
        providerInstanceId: options.providerInstanceId,
        runtimeId: options.runtimeId,
        modelId: options.modelId,
        taskId: options.taskId,
        runId: options.runId,
        agentId: options.agentId,
        workspaceRoot: options.workspaceRoot,
        prompt: composeRoundPrompt(options.goal, round),
        capabilityGrantIds: options.capabilityGrantIds ?? [],
        tools: options.tools ?? [],
        maxRounds: options.maxRoundsPerAttempt ?? 4,
      })
      .pipe(
        Effect.map((result) => ({
          value: result.text,
          outputText: result.text,
          costUnits: 1,
        })),
      );

const DEFAULT_COMPLETED_STATES = ["completed", "done"];
const DEFAULT_FAILED_STATES = ["failed", "cancelled", "canceled"];

/**
 * Multica 生产派发路径的 attempt：每轮 = 一次 quick-create 远端派发，
 * 随后轮询 getTaskStatus 直到远端终态。远端协议当前只回状态不回输出，
 * 完成文本依赖可选 fetchOutput 钩子（真实 daemon 的输出查询能力就绪后接入）；
 * 未提供时轮产物为空文本（参与停滞判定），costUnits 计 1。
 */
export const makeMulticaGoalLoopAttempt =
  <E>(options: {
    readonly protocol: Pick<MulticaDaemonProtocol, "quickCreateTask" | "getTaskStatus">;
    readonly workspaceId: string;
    readonly agentId?: string;
    readonly squadId?: string;
    readonly projectId?: string;
    readonly goal: string;
    readonly pollIntervalMs?: number;
    readonly pollTimeoutMs?: number;
    readonly now?: () => number;
    readonly sleep?: (ms: number) => Effect.Effect<void, never>;
    readonly completedStates?: ReadonlyArray<string>;
    readonly failedStates?: ReadonlyArray<string>;
    readonly fetchOutput?: (remoteTaskId: string) => Effect.Effect<string | undefined, E>;
  }) =>
  (
    round: number,
  ): Effect.Effect<
    CompositionGoalLoopDecision<string>,
    MulticaDaemonProtocolFailure | CompositionGoalLoopAttemptError | E
  > =>
    Effect.gen(function* () {
      if ((options.agentId === undefined) === (options.squadId === undefined)) {
        return yield* new CompositionGoalLoopAttemptError({
          code: "multica_round_input_invalid",
          detail: "Goal Loop 远端派发必须且只能指定 agentId 或 squadId。",
        });
      }
      const response = yield* options.protocol.quickCreateTask({
        workspaceId: options.workspaceId,
        ...(options.agentId === undefined ? {} : { agentId: options.agentId }),
        ...(options.squadId === undefined ? {} : { squadId: options.squadId }),
        ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
        prompt: composeRoundPrompt(options.goal, round),
      });
      const now = options.now ?? Date.now;
      const sleep = options.sleep ?? ((ms: number) => Effect.sleep(ms));
      const intervalMs = options.pollIntervalMs ?? 1_000;
      const timeoutMs = options.pollTimeoutMs ?? 600_000;
      const completedStates = new Set(options.completedStates ?? DEFAULT_COMPLETED_STATES);
      const failedStates = new Set(options.failedStates ?? DEFAULT_FAILED_STATES);
      const startedAt = now();
      for (;;) {
        const status = yield* options.protocol.getTaskStatus(response.taskId);
        if (completedStates.has(status.status)) {
          const output =
            options.fetchOutput === undefined
              ? undefined
              : yield* options.fetchOutput(response.taskId);
          return {
            value: output ?? "",
            ...(output === undefined ? {} : { outputText: output }),
            costUnits: 1,
          };
        }
        if (failedStates.has(status.status)) {
          return yield* new CompositionGoalLoopAttemptError({
            code: "multica_round_failed",
            detail: `远端任务 ${response.taskId} 以状态 ${status.status} 终止。`,
          });
        }
        if (now() - startedAt >= timeoutMs) {
          return yield* new CompositionGoalLoopAttemptError({
            code: "multica_round_timeout",
            detail: `等待远端任务 ${response.taskId} 超过 ${timeoutMs}ms。`,
          });
        }
        yield* sleep(intervalMs);
      }
    });
