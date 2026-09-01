import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

/** 显式完成标记：attempt 输出中出现该 token 即视为 goal 已达成；可带原因 `[[GOAL_COMPLETE: reason]]`。 */
export const GOAL_COMPLETE_MARKER = "[[GOAL_COMPLETE]]";
const GOAL_COMPLETE_PREFIX = "[[GOAL_COMPLETE";

export const GOAL_CANCEL_MARKER = "[[GOAL_CANCELLED]]";

export type CompositionGoalLoopStatus =
  | "completed"
  | "budget_exhausted"
  | "deadline_exceeded"
  | "cancelled"
  | "pivot_required";

export class CompositionGoalLoopInvalidError extends Data.TaggedError(
  "CompositionGoalLoopInvalidError",
)<{ readonly detail: string }> {}

export type CompositionGoalLoopDecision<A> = {
  /** 本轮的业务产物，原样透传给调用方。 */
  readonly value: A;
  /** 本轮模型输出文本；用于完成标记扫描。 */
  readonly outputText?: string;
  /** 本轮消耗的成本单元（工具调用次数、token 折算等），计入总预算。 */
  readonly costUnits?: number;
};

/** 验证子代理收到的完成声明上下文；history 含当前轮在内的全部轮次值快照。 */
export type CompositionGoalValidationInput<A> = {
  readonly round: number;
  readonly value: A;
  readonly cleanText: string;
  readonly reason: string | undefined;
  readonly history: ReadonlyArray<{ readonly round: number; readonly value: A }>;
};

/** 验证子代理的裁决；accepted=false 时附 detail 说明拒绝原因。 */
export type CompositionGoalValidationVerdict = {
  readonly accepted: boolean;
  readonly detail?: string;
};

export type CompositionGoalLoopOptions<A, E = never> = {
  readonly maxAttempts: number;
  /** 成本上限；省略表示本轮循环不计成本。 */
  readonly maxCostUnits?: number;
  /** 墙钟截止（Unix 毫秒）；省略表示不限时。需要配合注入 now 才可测。 */
  readonly deadlineUnixMs?: number;
  readonly now?: () => number;
  /** 轮与轮之间检查的外部取消条件。 */
  readonly isCancelled?: () => boolean;
  /**
   * 连续 N 轮无进展输出后按 `pivot_required` 收敛。进度 = attempt 的 outputText
   * 归一化（压缩空白后去首尾）文本；与上一轮不同视为有进展并重置计数。
   * 不产出 outputText 的 attempt 按空文本参与比较，连续空转同样触发 pivot。
   */
  readonly stalePivotRounds?: number;
  /**
   * 完成标记出现时的验证子代理入口：accepted=false 则本轮不收敛、继续循环，
   * 拒绝记录进入 rejectedCompletions 并参与停滞判定；缺省表示信任完成标记。
   * 真实"再派一个 agent 校验"的子代理实现后续接入，本合同只定义接入点。
   */
  readonly validateCompletion?: (
    input: CompositionGoalValidationInput<A>,
  ) => Effect.Effect<CompositionGoalValidationVerdict, E>;
  readonly attempt: (
    round: number,
    context: {
      readonly remainingAttempts: number;
      readonly remainingCostUnits: number | undefined;
    },
  ) => Effect.Effect<CompositionGoalLoopDecision<A>, E>;
};

export type CompositionGoalLoopResult<A> = {
  readonly status: CompositionGoalLoopStatus;
  /** 实际执行的 attempt 轮数。 */
  readonly rounds: number;
  readonly costUnitsUsed: number;
  /** 只有 completed 时存在：去掉完成标记后的最后一轮输出文本与解析出的原因。 */
  readonly completion:
    | {
        readonly cleanText: string;
        readonly reason: string | undefined;
      }
    | undefined;
  /** 只有 pivot_required 时存在：连续无进展轮数与最后一轮归一化输出文本。 */
  readonly pivot:
    | {
        readonly staleRounds: number;
        readonly lastCleanText: string;
      }
    | undefined;
  /** validateCompletion 拒绝过的完成声明（round + 拒绝原因），供审计与测试断言。 */
  readonly rejectedCompletions: ReadonlyArray<{
    readonly round: number;
    readonly detail: string | undefined;
  }>;
  /** 每轮的值快照，供持久化/审计侧自行取舍。 */
  readonly history: ReadonlyArray<{ readonly round: number; readonly value: A }>;
};

/**
 * 解析输出中的显式完成标记；返回 cleaned 文本与可选 reason。
 * 程序化判定通过 `forceComplete` 表达，不依赖文本标记。
 */
export const parseGoalCompletion = (
  outputText: string | undefined,
): {
  readonly complete: boolean;
  readonly cleanText: string;
  readonly reason: string | undefined;
} => {
  if (outputText === undefined) return { complete: false, cleanText: "", reason: undefined };
  // 兼容无原因的完整标记与带原因的 `[[GOAL_COMPLETE: 原因]]` 形式。
  const index = outputText.indexOf(GOAL_COMPLETE_PREFIX);
  if (index === -1) return { complete: false, cleanText: outputText, reason: undefined };
  let cursor = index + GOAL_COMPLETE_PREFIX.length;
  let reason: string | undefined;
  if (outputText[cursor] === ":") {
    const close = outputText.indexOf("]", cursor);
    if (close !== -1) {
      reason = outputText.slice(cursor + 1, close).trim() || undefined;
      cursor = close;
    }
  }
  // 吞掉收尾的 `]]`（无原因标记天然匹配；带原因形式上面已消费到第一个 `]`）。
  const rest = outputText.slice(cursor);
  let end = cursor;
  if (rest.startsWith("]]")) end = cursor + 2;
  else if (rest.startsWith("]")) end = cursor + 1;
  const cleaned = (outputText.slice(0, index) + outputText.slice(end)).replace(/\s+/g, " ").trim();
  return { complete: true, cleanText: cleaned, reason };
};

const invalid = (detail: string) => new CompositionGoalLoopInvalidError({ detail });

const normalizeProgressText = (outputText: string | undefined): string =>
  (outputText ?? "").replace(/\s+/g, " ").trim();

/**
 * Goal Loop：重复执行 attempt 直到出现显式完成标记；轮数、成本与墙钟三类预算任一
 * 耗尽即按对应终态收敛，外部取消优先于预算判定。启用 stalePivotRounds 后，连续
 * 无进展输出会按 pivot_required 提前收敛；同一轮输出中出现完成/取消标记时仍以标记为准。
 * 提供 validateCompletion 时，完成标记需经验证子代理接受才收敛为 completed，
 * 被拒绝的声明记录在 rejectedCompletions 中并继续循环。
 *
 * 不在本切片范围内：真实子代理驱动的 validator 实现和跨重启 supervisor。
 */
export const runCompositionGoalLoop = <A, E>(
  options: CompositionGoalLoopOptions<A, E>,
): Effect.Effect<CompositionGoalLoopResult<A>, CompositionGoalLoopInvalidError | E> =>
  Effect.gen(function* () {
    const maxAttempts = options.maxAttempts;
    if (!Number.isInteger(maxAttempts) || maxAttempts <= 0) {
      return yield* invalid(`maxAttempts 必须为正整数，收到 ${String(options.maxAttempts)}。`);
    }
    const maxCost = options.maxCostUnits;
    if (maxCost !== undefined && !(maxCost >= 0)) {
      return yield* invalid(`maxCostUnits 不能为负数，收到 ${String(maxCost)}。`);
    }
    const stalePivotRounds = options.stalePivotRounds;
    if (
      stalePivotRounds !== undefined &&
      (!Number.isInteger(stalePivotRounds) || stalePivotRounds <= 0)
    ) {
      return yield* invalid(`stalePivotRounds 必须为正整数，收到 ${String(stalePivotRounds)}。`);
    }
    const now = options.now ?? Date.now;

    const history: Array<{ round: number; value: A }> = [];
    let costUsed = 0;
    let rounds = 0;
    let previousProgressKey: string | undefined;
    let staleStreak = 0;
    let final: CompositionGoalLoopResult<A>["completion"];
    let pivot: CompositionGoalLoopResult<A>["pivot"];
    let status: CompositionGoalLoopStatus;
    const rejectedCompletions: Array<{ round: number; detail: string | undefined }> = [];

    for (;;) {
      const isCancelledBeforeRound = options.isCancelled?.() ?? false;
      if (isCancelledBeforeRound) {
        status = "cancelled";
        break;
      }
      if (options.deadlineUnixMs !== undefined && now() >= options.deadlineUnixMs) {
        status = "deadline_exceeded";
        break;
      }
      if (rounds >= maxAttempts) {
        status = "budget_exhausted";
        break;
      }
      if (maxCost !== undefined && costUsed >= maxCost) {
        status = "budget_exhausted";
        break;
      }

      const decision = yield* options.attempt(rounds + 1, {
        remainingAttempts: maxAttempts - rounds,
        remainingCostUnits: maxCost === undefined ? undefined : Math.max(0, maxCost - costUsed),
      });
      rounds += 1;
      costUsed += decision.costUnits ?? 0;
      history.push({ round: rounds, value: decision.value });

      const parsed = parseGoalCompletion(decision.outputText);
      if (parsed.complete) {
        // 快照 history，避免验证方持有可变引用看到后续轮次。
        const verdict =
          options.validateCompletion === undefined
            ? undefined
            : yield* options.validateCompletion({
                round: rounds,
                value: decision.value,
                cleanText: parsed.cleanText,
                reason: parsed.reason,
                history: history.slice(),
              });
        if (verdict === undefined || verdict.accepted) {
          status = "completed";
          final = { cleanText: parsed.cleanText, reason: parsed.reason };
          break;
        }
        rejectedCompletions.push({ round: rounds, detail: verdict.detail });
      }
      if ((decision.outputText ?? "").includes(GOAL_CANCEL_MARKER)) {
        status = "cancelled";
        break;
      }

      const progressKey = normalizeProgressText(decision.outputText);
      staleStreak = progressKey === previousProgressKey ? staleStreak + 1 : 1;
      previousProgressKey = progressKey;
      if (stalePivotRounds !== undefined && staleStreak >= stalePivotRounds) {
        status = "pivot_required";
        pivot = { staleRounds: staleStreak, lastCleanText: progressKey };
        break;
      }
    }

    return {
      status,
      rounds,
      costUnitsUsed: costUsed,
      completion: final,
      pivot,
      rejectedCompletions,
      history,
    };
  });
