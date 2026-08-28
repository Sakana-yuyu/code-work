import * as NodeCrypto from "node:crypto";

import {
  BYOK_DELEGATION_PROJECT_ID,
  type ByokDelegationStatus,
  type CompositionTask,
  type CompositionTaskRun,
  type CompositionTaskStatus,
} from "@codework/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type {
  CompositionTaskStoreError,
  CompositionTaskStoreShape,
} from "../persistence/Services/CompositionTaskStore.ts";

/** BYOK 委派投影行的统一 sourceEventId 前缀（幂等去重锚点，同 goalloop / byok-restore 前缀模式）。 */
export const byokDelegationEventPrefix = (taskId: string, runId: string): string =>
  `byok-delegation:${taskId}:${runId}`;

/** 进程死亡后 in-flight 委派收口时写入的稳定 failureCode。 */
export const BYOK_DELEGATION_INTERRUPTED_FAILURE_CODE = "byok_delegation_interrupted";

export type ByokDelegationLedgerStorePort = Pick<
  CompositionTaskStoreShape,
  "appendEventIfNew" | "getTask" | "getRun" | "upsertTask" | "upsertRun"
>;

/** 单个委派在 Composition 台账中的稳定投影身份。 */
export type ByokDelegationProjectionScope = {
  readonly instanceId: string;
  /** 调度器进程内自增 ID（delegation-N），跨重启会复用，只作展示与 runtimeTaskId。 */
  readonly delegationId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly runtimeId: string;
  /** 委派原文只以摘要形式进入台账，原文永不落账。 */
  readonly promptDigest: string;
};

const sha256 = (value: string): string =>
  `sha256:${NodeCrypto.createHash("sha256").update(value, "utf8").digest("hex")}`;

/**
 * 构造委派投影身份：uniqueKey 必须全局唯一（如 randomUUID），因为调度器的
 * delegation-N 计数在进程重启或配置指纹变化后会复用，不能直接当台账主键。
 * agentId 沿用 Supplier 投影的 `provider:<instanceId>` 约定。
 */
export const makeByokDelegationProjectionScope = (input: {
  readonly instanceId: string;
  readonly delegationId: string;
  readonly uniqueKey: string;
  readonly taskText: string;
}): ByokDelegationProjectionScope => ({
  instanceId: input.instanceId,
  delegationId: input.delegationId,
  taskId: `byok-delegation-${input.uniqueKey}`,
  runId: `byok-delegation-run-${input.uniqueKey}`,
  agentId: `provider:${input.instanceId}`,
  runtimeId: `byok-delegation:${input.instanceId}`,
  promptDigest: sha256(input.taskText),
});

/** 委派状态迁移的投影输入；只接受计数与错误码，杜绝原始输出/prompt 文本进台账。 */
export type ByokDelegationProjectionTransition = {
  readonly status: ByokDelegationStatus;
  readonly errorCode?: string;
  readonly resultChars?: number;
};

const mapDelegationStatus = (status: ByokDelegationStatus): CompositionTaskStatus => {
  switch (status) {
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "succeeded":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "queue_timed_out":
    case "execution_timed_out":
      return "timed_out";
  }
};

const delegationRank = (status: ByokDelegationStatus): number =>
  status === "queued" ? 0 : status === "running" ? 1 : 2;

const compositionRank = (status: CompositionTaskStatus): number => {
  switch (status) {
    case "queued":
    case "dispatched":
      return 0;
    case "completed":
    case "failed":
    case "cancelled":
    case "timed_out":
      return 2;
    default:
      return 1;
  }
};

const eventSuffix = (status: ByokDelegationStatus): string =>
  status === "queued" || status === "running" ? status : `terminal:${status}`;

const truncate = (text: string, limit: number): string =>
  text.length > limit ? `${text.slice(0, limit)}…` : text;

const failureCodeOf = (transition: ByokDelegationProjectionTransition): string | undefined => {
  switch (transition.status) {
    case "failed":
      return truncate(transition.errorCode ?? "delegation_failed", 100);
    case "queue_timed_out":
      return "delegation_queue_timed_out";
    case "execution_timed_out":
      return "delegation_execution_timed_out";
    default:
      return undefined;
  }
};

const describeTransition = (
  scope: ByokDelegationProjectionScope,
  transition: ByokDelegationProjectionTransition,
): string => {
  const id = scope.delegationId;
  switch (transition.status) {
    case "queued":
      return `BYOK 委派已排队（${id}）`;
    case "running":
      return `BYOK 委派开始执行（${id}）`;
    case "succeeded":
      return `BYOK 委派完成（${id}${
        transition.resultChars === undefined ? "" : `，输出 ${transition.resultChars} 字符`
      }）`;
    case "failed":
      return `BYOK 委派失败（${id}，错误码 ${truncate(transition.errorCode ?? "unknown", 60)}）`;
    case "cancelled":
      return `BYOK 委派已取消（${id}）`;
    case "queue_timed_out":
      return `BYOK 委派排队超时（${id}）`;
    case "execution_timed_out":
      return `BYOK 委派执行超时（${id}）`;
  }
};

/**
 * 把 ByokDelegationService 调度器的一次状态迁移以幂等事件行投影进 Composition
 * 任务台账，并把 Task/Run 状态收敛为可查询的单一状态源：
 * - 事件行 sourceEventId 形如 `byok-delegation:<taskId>:<runId>:<queued|running|terminal:*>`，
 *   重复投影（重放）不重复落行；
 * - 事件行首次落账后才 upsert Task/Run；迟到的低阶状态（如终态后重放 queued）
 *   不会把 Task/Run 回退到早期状态；
 * - 摘要只含委派 ID、状态、错误码与输出字符数；委派原文与输出文本不进台账。
 * 返回 true 表示本次迁移为首次投影。
 */
export const projectByokDelegationTransition = (options: {
  readonly store: ByokDelegationLedgerStorePort;
  readonly scope: ByokDelegationProjectionScope;
  readonly transition: ByokDelegationProjectionTransition;
  readonly nowUnixMs: number;
}): Effect.Effect<boolean, CompositionTaskStoreError> =>
  Effect.gen(function* () {
    const { store, scope, transition, nowUnixMs } = options;
    const status = mapDelegationStatus(transition.status);
    const inserted = yield* store.appendEventIfNew({
      taskId: scope.taskId,
      runId: scope.runId,
      agentId: scope.agentId,
      runtimeId: scope.runtimeId,
      sourceEventId: `${byokDelegationEventPrefix(scope.taskId, scope.runId)}:${eventSuffix(transition.status)}`,
      status,
      sequence: 0,
      eventType: "status",
      summary: describeTransition(scope, transition),
    });
    if (!inserted) return false;

    const rank = delegationRank(transition.status);
    const existingRun = yield* store.getRun(scope.runId);
    if (Option.isSome(existingRun) && compositionRank(existingRun.value.status) > rank) {
      // 迟到的低阶状态只补事件行，不回退已推进的 Task/Run 状态。
      return true;
    }
    const existingTask = yield* store.getTask(scope.taskId);
    const terminal = rank === 2;
    const failureCode = failureCodeOf(transition);
    const startedAtUnixMs =
      Option.isSome(existingRun) && existingRun.value.startedAtUnixMs !== undefined
        ? existingRun.value.startedAtUnixMs
        : transition.status === "running"
          ? nowUnixMs
          : undefined;

    yield* store.upsertRun({
      runId: scope.runId,
      taskId: scope.taskId,
      agentId: scope.agentId,
      runtimeId: scope.runtimeId,
      runtimeTaskId: scope.delegationId,
      status,
      attempt: 1,
      capabilityGrantIds: [],
      ...(startedAtUnixMs === undefined ? {} : { startedAtUnixMs }),
      ...(terminal ? { finishedAtUnixMs: nowUnixMs } : {}),
      ...(failureCode === undefined ? {} : { failureCode }),
    } satisfies CompositionTaskRun);
    yield* store.upsertTask({
      taskId: scope.taskId,
      projectId: BYOK_DELEGATION_PROJECT_ID,
      assigneeKind: "agent",
      assigneeId: scope.agentId,
      mode: "serial",
      status,
      promptDigest: scope.promptDigest,
      dependsOnTaskIds: [],
      createdAtUnixMs: Option.isSome(existingTask) ? existingTask.value.createdAtUnixMs : nowUnixMs,
      updatedAtUnixMs: nowUnixMs,
      ...(terminal ? { finishedAtUnixMs: nowUnixMs } : {}),
    } satisfies CompositionTask);
    return true;
  });
