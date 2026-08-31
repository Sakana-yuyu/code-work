import type { CompositionTaskRetryRequest } from "@codework/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type {
  CompositionRunStartIntent,
  CompositionRunStartPageCursor,
  CompositionRunStartState,
} from "../persistence/Services/CompositionRunStartStore.ts";
import { CompositionRunStartStore } from "../persistence/Services/CompositionRunStartStore.ts";
import { CompositionTaskInputStore } from "../persistence/Services/CompositionTaskInputStore.ts";
import { CompositionTaskStore } from "../persistence/Services/CompositionTaskStore.ts";
import { CompositionOrchestratorService } from "./CompositionOrchestratorService.ts";

export class CompositionRunStartStartupRecoveryError extends Schema.TaggedErrorClass<CompositionRunStartStartupRecoveryError>()(
  "CompositionRunStartStartupRecoveryError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Run Start 启动恢复失败。";
  }
}

export type CompositionRunStartStartupRecoveryReceipt = {
  readonly type: "composition.run_starts.recovered";
  readonly recoveredAtUnixMs: number;
  readonly recoveredCount: number;
  readonly runIds: ReadonlyArray<string>;
};

export interface CompositionRunStartStartupRecoveryShape {
  readonly awaitRecovered: Effect.Effect<
    CompositionRunStartStartupRecoveryReceipt,
    CompositionRunStartStartupRecoveryError
  >;
}

/** 允许在启动阶段自动恢复的持久 Run Start 状态；settled/indeterminate 永不重派。 */
const RECOVERABLE_RUN_START_STATES: ReadonlySet<CompositionRunStartState> = new Set([
  "prepared",
  "dispatching",
  "accepted",
] satisfies ReadonlyArray<CompositionRunStartState>);

const RECOVERY_PAGE_LIMIT = 200;

export interface CompositionRunStartStartupRecoveryOptions {
  readonly store: Pick<typeof CompositionTaskStore.Service, "listRunsByTaskAttempt">;
  readonly runStartStore: Pick<typeof CompositionRunStartStore.Service, "listActiveStarts">;
  readonly inputStore: Pick<typeof CompositionTaskInputStore.Service, "get">;
  readonly orchestrator: Pick<
    typeof CompositionOrchestratorService.Service,
    "recoverRunStart"
  >;
  readonly recoveredAtUnixMs: number;
}

type CandidateOutcome =
  | { readonly _tag: "Recovered"; readonly runId: string }
  | {
      readonly _tag: "Skipped";
      readonly runId: string;
      readonly code: string;
      readonly detail: string;
    };

const skipCandidate = (runId: string, code: string, detail: string): CandidateSkip => ({
  _tag: "Skipped",
  runId,
  code,
  detail,
});

type CandidateSkip = Extract<CandidateOutcome, { readonly _tag: "Skipped" }>;

/**
 * 单个持久 Run Start 意图对应的重试请求。previousRunId 由同 Task 的
 * attempt-1 唯一候选 Run 推导；无法唯一确定时不得猜测。
 */
const makeCandidateRequest = (
  options: CompositionRunStartStartupRecoveryOptions,
  intent: CompositionRunStartIntent,
): Effect.Effect<
  { readonly _tag: "Request"; readonly request: CompositionTaskRetryRequest } | CandidateSkip,
  CompositionRunStartStartupRecoveryError
> =>
  Effect.gen(function* () {
    if (intent.attempt <= 1) {
      return skipCandidate(
        intent.runId,
        "run_start_recovery_previous_run_missing",
        `Run Start ${intent.runId} 是首次启动（attempt=1），缺少可推导的 previous Run，等待下一次扫描。`,
      );
    }
    const previousRunOptions = yield* Effect.mapError(
      options.store.listRunsByTaskAttempt(intent.taskId, intent.attempt - 1),
      (cause) => new CompositionRunStartStartupRecoveryError({ cause }),
    );
    const previousRuns = previousRunOptions.filter((run) => run.runId !== intent.runId);
    if (previousRuns.length !== 1) {
      return skipCandidate(
        intent.runId,
        previousRuns.length === 0
          ? "run_start_recovery_previous_run_missing"
          : "run_start_recovery_previous_run_ambiguous",
        `Run Start ${intent.runId} 的 attempt=${intent.attempt - 1} 命中 ${previousRuns.length} 个候选 Run，拒绝猜测。`,
      );
    }
    const previousRun = previousRuns[0];
    if (previousRun === undefined) {
      return skipCandidate(
        intent.runId,
        "run_start_recovery_previous_run_missing",
        `Run Start ${intent.runId} 的前一 Run 候选不可用。`,
      );
    }
    const recoveryInputOption = yield* Effect.mapError(
      options.inputStore.get(intent.taskId),
      (cause) => new CompositionRunStartStartupRecoveryError({ cause }),
    );
    const capabilityIds = Option.isSome(recoveryInputOption)
      ? (recoveryInputOption.value.capabilityIds ?? [])
      : [];
    return {
      _tag: "Request" as const,
      request: {
        taskId: intent.taskId,
        previousRunId: previousRun.runId,
        runId: intent.runId,
        reason: "服务器重启后恢复未落定的 Run Start",
        capabilityIds: [...capabilityIds],
      },
    } as const;
  });

const recoverCandidate = (
  options: CompositionRunStartStartupRecoveryOptions,
  intent: CompositionRunStartIntent,
): Effect.Effect<CandidateOutcome> =>
  Effect.gen(function* () {
    const candidate = yield* makeCandidateRequest(options, intent);
    if (candidate._tag === "Skipped") return candidate;
    const recovered = yield* options.orchestrator.recoverRunStart(candidate.request);
    return { _tag: "Recovered" as const, runId: recovered.run.runId };
  }).pipe(
    // 单个候选失败（Driver 缺失、receipt 不完整、隔离、存储错误等）只影响自身，
    // 隔离后继续处理其他恢复项；中断与缺陷不在此捕获，保持向上传播。
    Effect.catch((error) =>
      Effect.succeed(
        skipCandidate(
          intent.runId,
          "run_start_recovery_candidate_failed",
          `Run Start ${intent.runId} 恢复候选处理失败（${error._tag}），已隔离当前候选并继续处理其他恢复项。`,
        ),
      ),
    ),
  );

export const recoverCompositionRunStarts = (
  options: CompositionRunStartStartupRecoveryOptions,
): Effect.Effect<
  CompositionRunStartStartupRecoveryReceipt,
  CompositionRunStartStartupRecoveryError
> =>
  Effect.gen(function* () {
    const recoveredRunIds: string[] = [];
    const seenRunIds = new Set<string>();
    let after: CompositionRunStartPageCursor | undefined;
    while (true) {
      const page = yield* Effect.mapError(
        options.runStartStore.listActiveStarts({
          limit: RECOVERY_PAGE_LIMIT,
          ...(after === undefined ? {} : { after }),
        }),
        (cause) => new CompositionRunStartStartupRecoveryError({ cause }),
      );
      const pending = page.filter(
        (intent) => RECOVERABLE_RUN_START_STATES.has(intent.state) && !seenRunIds.has(intent.runId),
      );
      for (const intent of pending) {
        seenRunIds.add(intent.runId);
        const outcome = yield* recoverCandidate(options, intent);
        if (outcome._tag === "Recovered") {
          recoveredRunIds.push(outcome.runId);
        } else {
          yield* Effect.logWarning("Run Start 启动恢复候选被跳过", {
            runId: outcome.runId,
            code: outcome.code,
            detail: outcome.detail,
          });
        }
      }
      if (page.length < RECOVERY_PAGE_LIMIT) break;
      const last = page[page.length - 1];
      if (last === undefined) break;
      if (
        after !== undefined &&
        last.updatedAtUnixMs <= after.updatedAtUnixMs &&
        last.runId <= after.runId
      ) {
        break;
      }
      after = { updatedAtUnixMs: last.updatedAtUnixMs, runId: last.runId };
    }
    return {
      type: "composition.run_starts.recovered" as const,
      recoveredAtUnixMs: options.recoveredAtUnixMs,
      recoveredCount: recoveredRunIds.length,
      runIds: recoveredRunIds,
    } as const;
  });

export class CompositionRunStartStartupRecovery extends Context.Service<
  CompositionRunStartStartupRecovery,
  CompositionRunStartStartupRecoveryShape
>()("codework/composition/CompositionRunStartStartupRecovery") {
  static readonly layer = Layer.effect(
    CompositionRunStartStartupRecovery,
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const inputStore = yield* CompositionTaskInputStore;
      const orchestrator = yield* CompositionOrchestratorService;
      const recoveredAtUnixMs = yield* Clock.currentTimeMillis;
      const recoveryResult = yield* Effect.result(
        recoverCompositionRunStarts({
          store,
          runStartStore,
          inputStore,
          orchestrator,
          recoveredAtUnixMs,
        }),
      );
      return CompositionRunStartStartupRecovery.of({
        awaitRecovered: Effect.fromResult(recoveryResult),
      });
    }),
  );
}
