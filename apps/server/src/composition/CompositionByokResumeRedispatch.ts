import type { CompositionTask, CompositionTaskRun } from "@codework/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type {
  CompositionTaskStoreError,
  CompositionTaskStoreShape,
} from "../persistence/Services/CompositionTaskStore.ts";
import type {
  CompositionTaskInputStoreError,
  CompositionTaskInputStoreShape,
} from "../persistence/Services/CompositionTaskInputStore.ts";
import {
  recoverPersistedCheckpointText,
  type ByokCheckpointRecoveryError,
  type RecoveredCompositionByokOutput,
} from "./CompositionByokCheckpointRecovery.ts";

export class CompositionByokResumeRedispatchError extends Data.TaggedError(
  "CompositionByokResumeRedispatchError",
)<{
  readonly code:
    | "byok_resume_redispatch_task_missing"
    | "byok_resume_redispatch_run_missing"
    | "byok_resume_redispatch_not_latest"
    | "byok_resume_redispatch_run_terminal"
    | "byok_resume_redispatch_task_terminal"
    | "byok_resume_redispatch_already_settled"
    | "byok_resume_redispatch_input_missing";
  readonly detail: string;
}> {}

/** BYOK 恢复重派台账行的统一 sourceEventId 前缀（幂等去重锚点）。 */
export const byokResumeRedispatchEventPrefix = (taskId: string, runId: string): string =>
  `byok-redispatch:${taskId}:${runId}`;

/** 恢复上下文块的显式标记；重派前会剥离旧块，防止多次重派后 prompt 无界增长。 */
export const BYOK_RESUME_CONTEXT_BEGIN_MARKER = "[[BYOK_RESUME_CONTEXT]]";
export const BYOK_RESUME_CONTEXT_END_MARKER = "[[/BYOK_RESUME_CONTEXT]]";

const DEFAULT_MAX_RECOVERED_PROMPT_CHARS = 2_000;

const stripResumeContextBlocks = (prompt: string): string => {
  let text = prompt;
  for (;;) {
    const begin = text.indexOf(BYOK_RESUME_CONTEXT_BEGIN_MARKER);
    if (begin === -1) return text;
    const end = text.indexOf(BYOK_RESUME_CONTEXT_END_MARKER, begin);
    const sliceEnd = end === -1 ? text.length : end + BYOK_RESUME_CONTEXT_END_MARKER.length;
    text = `${text.slice(0, begin)}${text.slice(sliceEnd)}`;
  }
};

/**
 * 组装重派新 Run 的 prompt：原始 prompt + 显式标记包裹的恢复输出上下文。
 * 恢复文本超长时只保留结尾（续跑最需要的是中断前的最后进展），并先剥离
 * 旧的恢复上下文块，保证多次「恢复→重派」不会让 prompt 无界增长。
 */
export const composeByokResumeRedispatchPrompt = (input: {
  readonly basePrompt: string;
  readonly recoveredText: string;
  readonly previousRunId: string;
  readonly maxRecoveredChars?: number;
}): string => {
  const limit = input.maxRecoveredChars ?? DEFAULT_MAX_RECOVERED_PROMPT_CHARS;
  const base = stripResumeContextBlocks(input.basePrompt).trimEnd();
  const recovered = input.recoveredText.trim();
  const bounded = recovered.length > limit ? `…${recovered.slice(-limit)}` : recovered;
  return [
    base,
    "",
    BYOK_RESUME_CONTEXT_BEGIN_MARKER,
    `上一个 Run（${input.previousRunId}）中断前已持久化以下部分输出（超长时仅保留结尾 ${limit} 字符）：`,
    bounded.length === 0 ? "（空输出）" : bounded,
    "请在上述已完成部分的基础上继续完成任务，不要重复已产出的内容。",
    BYOK_RESUME_CONTEXT_END_MARKER,
  ].join("\n");
};

export type CompositionByokResumeRedispatchStorePort = Pick<
  CompositionTaskStoreShape,
  | "listEvents"
  | "appendEventIfNew"
  | "getTask"
  | "getRun"
  | "getLatestRun"
  | "upsertRun"
  | "upsertTask"
>;

export type CompositionByokResumeRedispatchOptions<E> = {
  readonly taskId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly parentTaskId?: string;
  readonly runtimeId?: string;
  readonly store: CompositionByokResumeRedispatchStorePort;
  /** retryTask 读取重派 prompt 的同一持久化输入源；本函数会把恢复上下文写回其中。 */
  readonly inputStore: Pick<CompositionTaskInputStoreShape, "get" | "save">;
  /** 结算落定时间戳，写入 run.finishedAtUnixMs 与 task.updatedAtUnixMs。 */
  readonly nowUnixMs: number;
  /** 结算说明，截断后进入结算行摘要。 */
  readonly note?: string;
  /** 注入新 prompt 的恢复文本字符上限；缺省 2000。 */
  readonly maxRecoveredPromptChars?: number;
  /**
   * 实际重派执行，通常包装 orchestrator.retryTask（创建新 Run 并重新派发）。
   * 仅在恢复校验、幂等结算与 prompt 写回全部成功后调用。
   */
  readonly redispatch: (args: {
    readonly previousRunId: string;
    readonly recoveredChunkCount: number;
    readonly recoveredUtf8Bytes: number;
  }) => Effect.Effect<void, E>;
};

const RUN_TERMINAL_STATUSES: ReadonlySet<CompositionTaskRun["status"]> = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);

const truncate = (text: string, limit: number): string => {
  const trimmed = text.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
};

/**
 * BYOK resume 恢复成功后的编排层自动重派接线：
 * 1. 纯校验（失败零副作用）——task/run 存在、run 是最新 Run（已有新 Run 显式拒绝）、
 *    task/run 未终态、尚无结算行、checkpoint 链可完整恢复（`CompositionByokCheckpointRecovery`）、
 *    恢复输入存在；
 * 2. 幂等结算——落 `byok-redispatch:<task>:<run>:settle` 行（重复触发或写入被抢占报
 *    already_settled），把陈旧 run/task 落 failed（failureCode=byok_resume_interrupted，
 *    满足 retryTask 仅失败可重试门槛）；
 * 3. 把恢复出的部分输出以截断上下文块写回恢复输入的 prompt；
 * 4. 调用 redispatch 回调（真实 orchestrator.retryTask 创建新 Run 续跑）。
 * 结算行摘要只含段数/字节数与说明，恢复的原始输出文本不进入台账摘要。
 */
export const settleAndRedispatchRecoveredByokRun = <E>(
  options: CompositionByokResumeRedispatchOptions<E>,
): Effect.Effect<
  {
    readonly recovered: RecoveredCompositionByokOutput;
    readonly run: CompositionTaskRun;
    readonly task: CompositionTask;
  },
  | E
  | ByokCheckpointRecoveryError
  | CompositionByokResumeRedispatchError
  | CompositionTaskStoreError
  | CompositionTaskInputStoreError
> =>
  Effect.gen(function* () {
    const runOption = yield* options.store.getRun(options.runId);
    if (Option.isNone(runOption) || runOption.value.taskId !== options.taskId) {
      return yield* new CompositionByokResumeRedispatchError({
        code: "byok_resume_redispatch_run_missing",
        detail: `Run ${options.runId} 不存在或不属于 Task ${options.taskId}，无法重派。`,
      });
    }
    const taskOption = yield* options.store.getTask(options.taskId);
    if (Option.isNone(taskOption)) {
      return yield* new CompositionByokResumeRedispatchError({
        code: "byok_resume_redispatch_task_missing",
        detail: `Task ${options.taskId} 不存在，无法重派。`,
      });
    }
    const latestRunOption = yield* options.store.getLatestRun(options.taskId);
    if (Option.isNone(latestRunOption) || latestRunOption.value.runId !== options.runId) {
      return yield* new CompositionByokResumeRedispatchError({
        code: "byok_resume_redispatch_not_latest",
        detail: `Run ${options.runId} 不是 Task ${options.taskId} 的最新 Run（已有新 Run），拒绝重派。`,
      });
    }
    // 重复触发优先按幂等语义拒绝：已有结算行时无论 run 当前状态一律 already_settled。
    const settleSourceEventId = `${byokResumeRedispatchEventPrefix(options.taskId, options.runId)}:settle`;
    const events = yield* options.store.listEvents(options.taskId, options.runId);
    if (events.some((event) => event.sourceEventId === settleSourceEventId)) {
      return yield* new CompositionByokResumeRedispatchError({
        code: "byok_resume_redispatch_already_settled",
        detail: "该 Run 的恢复重派已结算过，重复触发被拒绝。",
      });
    }
    if (RUN_TERMINAL_STATUSES.has(runOption.value.status)) {
      return yield* new CompositionByokResumeRedispatchError({
        code: "byok_resume_redispatch_run_terminal",
        detail: `Run ${options.runId} 已处于终态 ${runOption.value.status}，拒绝重派。`,
      });
    }
    if (RUN_TERMINAL_STATUSES.has(taskOption.value.status)) {
      return yield* new CompositionByokResumeRedispatchError({
        code: "byok_resume_redispatch_task_terminal",
        detail: `Task ${options.taskId} 已处于终态 ${taskOption.value.status}，拒绝重派。`,
      });
    }

    // 恢复校验失败（摘要被篡改、偏移缺口、空集）在此处零副作用上抛，不重派。
    const recovered = yield* recoverPersistedCheckpointText(events);

    const recoveryInputOption = yield* options.inputStore.get(options.taskId);
    if (Option.isNone(recoveryInputOption)) {
      return yield* new CompositionByokResumeRedispatchError({
        code: "byok_resume_redispatch_input_missing",
        detail: `Task ${options.taskId} 没有持久化的恢复输入（prompt/workspaceRoot），无法组装重派 prompt。`,
      });
    }

    const inserted = yield* options.store.appendEventIfNew({
      taskId: options.taskId,
      runId: options.runId,
      agentId: options.agentId,
      ...(options.parentTaskId === undefined ? {} : { parentTaskId: options.parentTaskId }),
      ...(options.runtimeId === undefined ? {} : { runtimeId: options.runtimeId }),
      sourceEventId: settleSourceEventId,
      status: "blocked",
      sequence: 0,
      eventType: "status",
      summary: `BYOK 恢复重派：已校验恢复 ${recovered.chunkCount} 段 / ${recovered.utf8Bytes} 字节部分输出，准备创建新 Run 续跑${
        options.note === undefined ? "" : `：${truncate(options.note, 120)}`
      }`,
    });
    if (!inserted) {
      return yield* new CompositionByokResumeRedispatchError({
        code: "byok_resume_redispatch_already_settled",
        detail: "结算行写入被其他投影者抢占，说明已有恢复重派结算。",
      });
    }

    // 把陈旧的非终态 run/task 收口为 failed，满足 retryTask 的失败重试门槛。
    const failedRun: CompositionTaskRun = {
      ...runOption.value,
      status: "failed",
      failureCode: "byok_resume_interrupted",
      finishedAtUnixMs: options.nowUnixMs,
    };
    yield* options.store.upsertRun(failedRun);
    const failedTask: CompositionTask = {
      ...taskOption.value,
      status: "failed",
      updatedAtUnixMs: options.nowUnixMs,
      finishedAtUnixMs: options.nowUnixMs,
    };
    yield* options.store.upsertTask(failedTask);

    const recoveryInput = recoveryInputOption.value;
    yield* options.inputStore.save({
      ...recoveryInput,
      prompt: composeByokResumeRedispatchPrompt({
        basePrompt: recoveryInput.prompt,
        recoveredText: recovered.text,
        previousRunId: options.runId,
        ...(options.maxRecoveredPromptChars === undefined
          ? {}
          : { maxRecoveredChars: options.maxRecoveredPromptChars }),
      }),
    });

    yield* options.redispatch({
      previousRunId: options.runId,
      recoveredChunkCount: recovered.chunkCount,
      recoveredUtf8Bytes: recovered.utf8Bytes,
    });

    return { recovered, run: failedRun, task: failedTask };
  });
